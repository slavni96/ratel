"""Admission for one registry's operations, so a contended ``register`` waits.

The Python mirror of ``src/sdk/ts/src/operation-gate.ts``, mixed into
``ToolRegistry``, ``SkillRegistry`` and ``FactRegistry``. The pyo3 binding owns
its registry unlocked, so the facade counts dense work in ``_dense_pending``
(under ``_dense_state``) and refuses a write while it is non-zero. This adds the
waiting on top:

- A ``register`` that finds the registry busy on a running event loop no longer
  raises. It takes its place in line at the call, and a task applies its write
  and dense preparation once the dense operations in flight have finished, so
  the write lands even if the caller forgets to ``await`` it. It returns a
  coroutine over that task (``_QueuedRegister``), so ``asyncio.create_task``
  and ``TaskGroup.create_task`` accept it as they accept an uncontended
  register's. With no running loop there is nothing to schedule that task on,
  so it still raises ``RegistryBusyError``.
- Writer preference, in arrival order: a dense operation, an async BM25
  search or a custom-ranked search started while a write is queued or running
  waits behind it, so a stream of searches cannot starve a write, and a search
  started after ``register(...)`` sees what was registered.
- Dense work runs on worker threads and a registry may be shared by event loops
  on several threads, so every hand-off goes through ``_dense_state`` and wakes
  the waiter on its own loop with ``call_soon_threadsafe``. Nothing polls.
- A woken waiter takes its slot itself, when it resumes on its loop, so a loop
  that stops and never runs again holds nothing. A waiter whose loop is not
  running when its turn comes is dismissed from the line instead of blocking
  everyone behind it; it re-enters, at the back, if its loop resumes.
- Known limit of that dismissal: a dismissed register keeps no place, so its
  write is no longer ordered before later ones. If ``register(v1)`` is queued
  on loop L, L stops, the operation in flight settles (or a newcomer arrives)
  and the waiter is dismissed, a ``register(v2)`` made next finds the line
  empty and writes at once; when L resumes, the older v1 lands after it and,
  for the same id, overwrites v2. It only arises when a caller stops an event
  loop with a register still queued on it.

The uncontended path is unchanged: the write happens synchronously at the call,
and the awaitable it returns drives dense preparation lazily, as before.
"""

from __future__ import annotations

import asyncio
import itertools
import threading
from collections import deque
from collections.abc import Awaitable, Callable, Coroutine, Generator
from typing import Any

from .exceptions import RegistryBusyError


class _Waiter:
    """One parked operation, woken on its own loop when its turn may have come."""

    __slots__ = ("exclusive", "future", "loop", "queued", "woken")

    def __init__(self, exclusive: bool, loop: asyncio.AbstractEventLoop) -> None:
        self.exclusive = exclusive
        self.loop = loop
        self.future: asyncio.Future[None] = loop.create_future()
        # In ``_gate_queue``; a dismissed waiter is not, until it re-enters.
        self.queued = False
        # Notified for its current future, which it has not consumed yet.
        self.woken = False

    def notify(self) -> bool:
        """Wake it on its loop; ``False`` when that loop has closed."""
        self.woken = True
        try:
            self.loop.call_soon_threadsafe(_wake, self.future)
        except RuntimeError:
            return False
        return True

    def rearm(self) -> None:
        """Wait again, on a fresh future, after a turn it could not take."""
        self.future = self.loop.create_future()
        self.woken = False


class _QueuedRegister(Coroutine[Any, Any, None]):
    """What a contended ``register`` returns: a coroutine over its queued task.

    The write is already scheduled as ``task``, so it lands whether or not
    this is awaited. Being a coroutine (``asyncio.iscoroutine`` is true), it
    can be handed to ``asyncio.create_task``, ``TaskGroup.create_task``,
    ``gather`` or ``wait_for`` like an uncontended register's. It is not a
    native coroutine, so dropping it unawaited is not reported as a "coroutine
    was never awaited" ``RuntimeWarning``: here that is no mistake, the write
    still lands. Cancelling whatever awaits it cancels ``task``, which drops
    the write if it has not been applied yet.
    """

    __slots__ = ("_steps", "_task")

    def __init__(self, task: asyncio.Task[None]) -> None:
        self._task = task
        self._steps: Generator[Any, None, None] | None = None

    def __await__(self) -> Generator[Any, None, None]:
        return self._task.__await__()

    def _iterator(self) -> Generator[Any, None, None]:
        if self._steps is None:
            self._steps = self._task.__await__()
        return self._steps

    def send(self, value: Any) -> Any:
        return self._iterator().send(value)

    def throw(self, typ: Any, val: Any = None, tb: Any = None, /) -> Any:
        # A task driving this is cancelled through ``throw`` only before its
        # first step; once it waits on ``task``, its cancel reaches ``task``.
        error = typ if val is None else val
        if isinstance(error, asyncio.CancelledError) or (
            isinstance(error, type) and issubclass(error, asyncio.CancelledError)
        ):
            self._task.cancel()
        if val is None and tb is None:
            return self._iterator().throw(typ)
        return self._iterator().throw(typ, val, tb)

    def close(self) -> None:
        # Detach only: like an unawaited register, the queued write still lands.
        if self._steps is not None:
            self._steps.close()


def _wake(future: asyncio.Future[None]) -> None:
    if not future.done():
        future.set_result(None)


def _running_loop() -> asyncio.AbstractEventLoop | None:
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return None


class _RegistryGate:
    """Writer-preferring, FIFO admission over ``_dense_pending``.

    A shared slot is one ``_dense_pending`` count; the exclusive slot is a queued
    ``register`` applying its write and dense preparation. Subclasses set
    ``_dense_state`` / ``_dense_pending`` and call ``_init_gate`` in
    ``__init__``, and implement ``_schedules_dense`` /
    ``_prepare_dense_held``. The module docstring names the one ordering
    limit: a register queued on a loop that then stops loses its place.
    """

    _dense_state: threading.Lock
    _dense_pending: int

    def _init_gate(self) -> None:
        # Waiters in arrival order, woken or not, until each takes its slot.
        self._gate_queue: deque[_Waiter] = deque()
        # A queued register owns the registry (its write and dense preparation).
        self._gate_writer = False
        # The thread on which that register is applying its write right now, so
        # its own busy check passes while every other caller's is refused.
        self._gate_writing_thread: int | None = None

    # -- hooks the registries implement ------------------------------------

    def _schedules_dense(self, has_items: bool) -> bool:
        """Whether a write of ``has_items`` needs dense preparation."""
        raise NotImplementedError

    async def _prepare_dense_held(self) -> None:
        """Dense preparation for a write that already holds the registry."""
        raise NotImplementedError

    def _build_tracked(self, has_items: bool) -> Awaitable[None]:
        """The lazily driven dense preparation the uncontended path returns."""
        raise NotImplementedError

    # -- shared slots ------------------------------------------------------

    def _queue_dense(self) -> None:
        """Count a dense operation in without waiting (nested or write-owned)."""
        with self._dense_state:
            self._dense_pending += 1

    async def _enter_dense(self) -> None:
        """Count a dense operation in, waiting while a register is queued or running."""
        with self._dense_state:
            if self._admits(exclusive=False):
                self._dense_pending += 1
                return
            waiter = self._park(exclusive=False, loop=asyncio.get_running_loop())
        await self._await_turn(waiter)

    def _finish_dense(self) -> None:
        with self._dense_state:
            self._dense_pending -= 1
            self._drain()

    async def _after_writes(self) -> None:
        """Writer preference for work that takes no dense slot (BM25, custom ranking).

        Returns at once unless a register is queued or running; then returns
        once it has finished.
        """
        with self._dense_state:
            if self._admits(exclusive=False):
                return
            waiter = self._park(exclusive=False, loop=asyncio.get_running_loop())
        await self._await_turn(waiter)
        # The turn counted this in as a shared slot; it needs none.
        self._finish_dense()

    # -- the exclusive slot ------------------------------------------------

    def _write_or_queue(self, write: Callable[[], None], has_items: bool) -> Awaitable[None]:
        """Apply ``write`` now, or queue it behind the operations in flight.

        ``write`` must refuse (via ``_raise_if_busy``) before changing anything.
        Uncontended, it runs here and the lazily driven dense preparation is
        returned, exactly as before. Contended on a running event loop, the
        write takes its place in line here, at the call, and a task applies it
        and its dense preparation once its turn comes; the returned
        ``_QueuedRegister`` is a coroutine over that task, so it can be
        awaited or wrapped in a task like the uncontended result. Contended
        with no running loop, the refusal is raised: there is no loop to run
        the queued write on, and a coroutine a synchronous caller drops would
        lose it.

        Raises:
            RegistryBusyError: when contended and no event loop is running.
        """
        try:
            write()
        except RegistryBusyError:
            loop = _running_loop()
            if loop is None:
                raise
            with self._dense_state:
                waiter = self._park(exclusive=True, loop=loop)
            task = loop.create_task(self._queued_write(write, has_items, waiter))
            # A task cancelled before its first step never runs its body: give
            # its place in line back from here.
            task.add_done_callback(lambda _task: self._abandon(waiter))
            return _QueuedRegister(task)
        return self._build_tracked(has_items)

    async def _queued_write(
        self, write: Callable[[], None], has_items: bool, waiter: _Waiter
    ) -> None:
        await self._await_turn(waiter)
        try:
            self._gate_writing_thread = threading.get_ident()
            try:
                write()
            finally:
                self._gate_writing_thread = None
            if self._schedules_dense(has_items):
                await self._prepare_dense_held()
        finally:
            with self._dense_state:
                self._gate_writer = False
                self._drain()

    def _raise_if_busy(self) -> None:
        """Refuse a synchronous mutation while an operation owns the registry.

        Called under ``_dense_state``.
        """
        if self._dense_pending:
            raise RegistryBusyError()
        if self._gate_writing_thread == threading.get_ident():
            return
        if self._gate_queue:
            self._drain()
        if self._gate_writer or self._gate_queue:
            raise RegistryBusyError()

    # -- queue -------------------------------------------------------------

    def _admits(self, *, exclusive: bool) -> bool:
        """Whether a newcomer may take its slot at once. Called under ``_dense_state``.

        Never while anyone is in line, woken or not, so nothing overtakes a
        waiter during the hop between its wake-up and its resuming.
        """
        if self._gate_queue:
            # A waiter whose loop has stopped must not hold the line.
            self._drain()
        if self._gate_writer or self._gate_queue:
            return False
        return not (exclusive and self._dense_pending)

    def _park(self, *, exclusive: bool, loop: asyncio.AbstractEventLoop) -> _Waiter:
        """Queue a waiter on ``loop``. Called under ``_dense_state``."""
        waiter = _Waiter(exclusive, loop)
        self._gate_queue.append(waiter)
        waiter.queued = True
        # Wakes it at once if nothing ahead of it holds it back.
        self._drain()
        return waiter

    async def _await_turn(self, waiter: _Waiter) -> None:
        """Wait until ``waiter`` holds its slot."""
        while True:
            try:
                await waiter.future
            except asyncio.CancelledError:
                self._abandon(waiter)
                raise
            with self._dense_state:
                if self._claim(waiter):
                    return
                # Taken meanwhile (it had been dismissed): wait for the next turn.
                waiter.rearm()
                if not waiter.queued:
                    self._gate_queue.append(waiter)
                    waiter.queued = True
                self._drain()

    def _claim(self, waiter: _Waiter) -> bool:
        """Take ``waiter``'s slot if it is free for it now. Called under ``_dense_state``."""
        if self._gate_writer:
            return False
        if waiter.queued:
            index = self._gate_queue.index(waiter)
            if waiter.exclusive:
                if index or self._dense_pending:
                    return False
            elif any(ahead.exclusive for ahead in itertools.islice(self._gate_queue, index)):
                return False
            del self._gate_queue[index]
            waiter.queued = False
        elif self._gate_queue or (waiter.exclusive and self._dense_pending):
            # Dismissed while its loop was stopped: it re-enters behind the line.
            return False
        if waiter.exclusive:
            self._gate_writer = True
        else:
            self._dense_pending += 1
        return True

    def _abandon(self, waiter: _Waiter) -> None:
        """Drop a waiter that will not take its turn (cancelled), waking the next."""
        with self._dense_state:
            if waiter.queued:
                self._gate_queue.remove(waiter)
                waiter.queued = False
                self._drain()

    def _drain(self) -> None:
        """Wake the waiters that could take a slot now. Called under ``_dense_state``.

        Consecutive shared waiters at the front can start together; an
        exclusive one only from the front, once no dense operation is in
        flight. Waking hands nothing over: each waiter takes its slot when it
        resumes, so a woken waiter stays in line, ahead of newcomers, until
        then. A waiter whose loop is not running cannot resume, so it is
        dismissed instead: notified, so it re-enters if that loop ever runs
        again, and out of the way of everyone behind it.
        """
        while not self._gate_writer:
            for index, waiter in enumerate(self._gate_queue):
                if waiter.exclusive and (index or self._dense_pending):
                    return
                if not waiter.loop.is_running() or not (waiter.woken or waiter.notify()):
                    del self._gate_queue[index]
                    waiter.queued = False
                    waiter.notify()
                    break  # the line changed: look again from the front
                if waiter.exclusive:
                    return
            else:
                return
