"""A contended `register` waits instead of raising "registry busy".

Mirrors `src/sdk/ts/src/register-waits.test.ts`. In-flight work is made
deterministic with `controlled_embedding_endpoint`, which holds every embedding
request until the test sets `send_response`; nothing here sleeps for a duration.
"""

from __future__ import annotations

import asyncio
import gc
import sys
import threading
import warnings
from collections.abc import Awaitable

import pytest

import ratel_ai
from ratel_ai import (
    ExecutableTool,
    RegistryBusyError,
    Skill,
    SkillCatalog,
    Tool,
    ToolCatalog,
    ToolRegistry,
)
from ratel_ai.experimental import Fact, FactCatalog

_BUSY = "registry busy; await the active operation"

Endpoint = tuple[str, threading.Event, threading.Event]


def _tool(tool_id: str, description: str) -> ExecutableTool:
    return ExecutableTool(
        id=tool_id, name=tool_id, description=description, execute=lambda args: {}
    )


READ_FILE = _tool("read_file", "Read a file from local disk and return its contents.")
SEND_EMAIL = _tool("send_email", "Send an email message to a recipient.")


def _semantic(endpoint: str) -> dict[str, str]:
    return {"url": endpoint, "model": "test-model"}


async def _held(request_started: threading.Event) -> None:
    """Wait, off the loop, until the endpoint is holding a request."""
    assert await asyncio.to_thread(request_started.wait, 5)


async def _spin() -> None:
    """Let every ready callback run a few times over."""
    for _ in range(20):
        await asyncio.sleep(0)


async def _semantic_tool_catalog(endpoint: Endpoint) -> ToolCatalog:
    url, _request_started, send_response = endpoint
    catalog = ToolCatalog(method="semantic", embedding=_semantic(url))
    send_response.set()
    await catalog.register(READ_FILE)
    send_response.clear()
    return catalog


async def test_register_waits_for_an_in_flight_dense_search(
    controlled_embedding_endpoint: Endpoint,
) -> None:
    _url, request_started, send_response = controlled_embedding_endpoint
    catalog = await _semantic_tool_catalog(controlled_embedding_endpoint)
    request_started.clear()

    search = asyncio.create_task(catalog.search_async("read a file", 5))
    await _held(request_started)
    pending = catalog.register(SEND_EMAIL)  # used to raise "registry busy" here
    await _spin()
    assert not catalog.has("send_email")

    send_response.set()
    await asyncio.gather(search, pending)
    assert catalog.has("send_email")
    hits = await catalog.search_async("send an email", 5)
    assert "send_email" in [hit.tool_id for hit in hits]


async def test_register_waits_for_an_in_flight_dense_register(
    controlled_embedding_endpoint: Endpoint,
) -> None:
    url, request_started, send_response = controlled_embedding_endpoint
    catalog = ToolCatalog(method="semantic", embedding=_semantic(url))
    first = asyncio.ensure_future(catalog.register(READ_FILE))
    await _held(request_started)

    second = catalog.register(SEND_EMAIL)
    await _spin()
    assert not catalog.has("send_email")

    send_response.set()
    await asyncio.gather(first, second)
    hits = await catalog.search_async("send an email", 5)
    assert {"read_file", "send_email"} <= {hit.tool_id for hit in hits}


async def test_a_queued_register_runs_without_being_awaited(
    controlled_embedding_endpoint: Endpoint,
) -> None:
    _url, request_started, send_response = controlled_embedding_endpoint
    catalog = await _semantic_tool_catalog(controlled_embedding_endpoint)
    request_started.clear()
    search = asyncio.create_task(catalog.search_async("read a file", 5))
    await _held(request_started)

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        # Dropped at once: scheduled on the running loop, so a forgotten await
        # cannot drop the write, and dropping it is not a mistake to warn about.
        catalog.register(SEND_EMAIL)
        gc.collect()
    assert [str(w.message) for w in caught if issubclass(w.category, RuntimeWarning)] == []
    send_response.set()
    await search
    # Started after the register, so it runs after the write lands.
    hits = await catalog.search_async("send an email", 5, method="bm25")
    assert "send_email" in [hit.tool_id for hit in hits]


async def test_a_contended_register_can_be_wrapped_in_a_task(
    controlled_embedding_endpoint: Endpoint,
) -> None:
    _url, request_started, send_response = controlled_embedding_endpoint
    catalog = await _semantic_tool_catalog(controlled_embedding_endpoint)
    request_started.clear()
    search = asyncio.create_task(catalog.search_async("read a file", 5))
    await _held(request_started)

    pending = catalog.register(SEND_EMAIL)
    assert asyncio.iscoroutine(pending)
    registered = asyncio.create_task(pending)
    await _spin()
    assert not registered.done()
    assert not catalog.has("send_email")

    send_response.set()
    await asyncio.gather(search, registered)
    assert catalog.has("send_email")


@pytest.mark.skipif(sys.version_info < (3, 11), reason="asyncio.TaskGroup is 3.11+")
async def test_a_contended_register_can_run_in_a_task_group(
    controlled_embedding_endpoint: Endpoint,
) -> None:
    _url, request_started, send_response = controlled_embedding_endpoint
    catalog = await _semantic_tool_catalog(controlled_embedding_endpoint)
    request_started.clear()
    search = asyncio.create_task(catalog.search_async("read a file", 5))
    await _held(request_started)

    async with asyncio.TaskGroup() as group:  # type: ignore[attr-defined,unused-ignore]
        group.create_task(catalog.register(SEND_EMAIL))
        group.create_task(catalog.register(_tool("archive", "Archive old messages.")))
        await _spin()
        assert not catalog.has("send_email")
        send_response.set()
    await search
    assert catalog.has("send_email")
    assert catalog.has("archive")


async def test_search_started_while_a_register_is_queued_runs_after_it(
    controlled_embedding_endpoint: Endpoint,
) -> None:
    _url, request_started, send_response = controlled_embedding_endpoint
    catalog = await _semantic_tool_catalog(controlled_embedding_endpoint)
    request_started.clear()

    first = asyncio.create_task(catalog.search_async("read a file", 5))
    await _held(request_started)
    registered = catalog.register(SEND_EMAIL)
    lexical = asyncio.create_task(catalog.search_async("send an email", 5, method="bm25"))
    dense = asyncio.create_task(catalog.search_async("send an email", 5))
    await _spin()
    # BM25 used to run inline here, ahead of the write.
    assert not lexical.done()
    assert not dense.done()

    send_response.set()
    _first, _registered, lexical_hits, dense_hits = await asyncio.gather(
        first, registered, lexical, dense
    )
    assert "send_email" in [hit.tool_id for hit in lexical_hits]
    assert "send_email" in [hit.tool_id for hit in dense_hits]


async def test_cancelling_a_queued_register_writes_nothing_and_frees_the_registry(
    controlled_embedding_endpoint: Endpoint,
) -> None:
    _url, request_started, send_response = controlled_embedding_endpoint
    catalog = await _semantic_tool_catalog(controlled_embedding_endpoint)
    request_started.clear()
    search = asyncio.create_task(catalog.search_async("read a file", 5))
    await _held(request_started)

    # Cancelled before its first step, and once waiting: both drop the write.
    before = asyncio.create_task(catalog.register(SEND_EMAIL))
    before.cancel()
    waiting = asyncio.create_task(catalog.register(_tool("archive", "Archive.")))
    await _spin()
    waiting.cancel()
    for cancelled in (before, waiting):
        with pytest.raises(asyncio.CancelledError):
            await cancelled

    send_response.set()
    await search
    await _spin()
    assert not catalog.has("send_email")
    assert not catalog.has("archive")
    await catalog.register(SEND_EMAIL)
    assert catalog.has("send_email")


class _DenseSearchThread:
    """A dense `search_async` on its own event loop in its own thread.

    Joining it settles the search without yielding to the caller's loop, so a
    test can make the in-flight operation finish before a queued register's
    task has run even once.
    """

    def __init__(self, catalog: ToolCatalog | SkillCatalog, query: str) -> None:
        self.errors: list[BaseException] = []
        self._thread = threading.Thread(target=self._run, args=(catalog, query), daemon=True)
        self._thread.start()

    def _run(self, catalog: ToolCatalog | SkillCatalog, query: str) -> None:
        try:
            asyncio.run(catalog.search_async(query, 5))
        except BaseException as err:  # pragma: no cover - surfaced by join()
            self.errors.append(err)

    def join(self) -> None:
        self._thread.join(timeout=5)
        assert not self._thread.is_alive(), "the dense search did not settle"
        assert self.errors == []


def test_register_from_another_thread_waits_for_a_dense_op_on_another_loop(
    controlled_embedding_endpoint: Endpoint,
) -> None:
    # The dense work and the waiting register run on two event loops in two
    # threads, so the wake-up has to cross threads.
    url, request_started, send_response = controlled_embedding_endpoint
    registry = ToolRegistry(embedding=_semantic(url), method="semantic")
    send_response.set()
    asyncio.run(registry.register(Tool(id="base", name="base", description="Base tool")))
    send_response.clear()
    request_started.clear()

    errors: list[BaseException] = []
    parked = threading.Event()

    def build() -> None:
        try:
            asyncio.run(registry.search_async("base", 5, method="semantic"))
        except BaseException as err:  # pragma: no cover - surfaced by the assert below
            errors.append(err)

    async def register_later() -> None:
        pending = registry.register(Tool(id="later", name="later", description="Later"))
        parked.set()
        await pending

    def register() -> None:
        try:
            asyncio.run(register_later())
        except BaseException as err:  # pragma: no cover - surfaced by the assert below
            errors.append(err)

    dense = threading.Thread(target=build, daemon=True)
    dense.start()
    assert request_started.wait(timeout=5)
    waiting = threading.Thread(target=register, daemon=True)
    waiting.start()
    assert parked.wait(timeout=5)
    assert registry.search("later", 5) == [], "the register should wait, not write under the search"

    send_response.set()
    dense.join(timeout=5)
    waiting.join(timeout=5)
    assert not dense.is_alive() and not waiting.is_alive()
    assert errors == []
    assert registry.search("later", 5)[0].tool_id == "later"


@pytest.mark.parametrize("method", ["bm25", "semantic"])
async def test_a_search_awaited_right_after_an_unawaited_register_sees_it(
    controlled_embedding_endpoint: Endpoint, method: str
) -> None:
    _url, request_started, send_response = controlled_embedding_endpoint
    catalog = await _semantic_tool_catalog(controlled_embedding_endpoint)
    request_started.clear()
    search = asyncio.create_task(catalog.search_async("read a file", 5))
    await _held(request_started)

    pending = catalog.register(SEND_EMAIL)  # contended and not awaited
    send_response.set()
    # Awaited at once: the register's task has not run a single step yet, so
    # the register must already hold its place in line.
    hits = await catalog.search_async("send an email", 5, method=method)  # type: ignore[arg-type]
    assert "send_email" in [hit.tool_id for hit in hits]
    await asyncio.gather(search, pending)


async def test_a_register_made_after_a_queued_one_lands_after_it(
    controlled_embedding_endpoint: Endpoint,
) -> None:
    _url, request_started, send_response = controlled_embedding_endpoint
    catalog = await _semantic_tool_catalog(controlled_embedding_endpoint)
    request_started.clear()
    dense = _DenseSearchThread(catalog, "read a file")
    await _held(request_started)

    first = catalog.register(_tool("send_email", "Send an email message, version one."))
    send_response.set()
    dense.join()  # settled before `first`'s task has started
    second = catalog.register(_tool("send_email", "Send an email message, version two."))
    await asyncio.gather(first, second)

    tool = catalog.get("send_email")
    assert tool is not None
    assert tool.description == "Send an email message, version two."


def test_a_contended_register_outside_a_running_loop_raises(
    controlled_embedding_endpoint: Endpoint,
) -> None:
    # With no running loop there is nothing to schedule the queued write on,
    # and a coroutine a sync caller drops would lose it: refuse, as before.
    url, request_started, send_response = controlled_embedding_endpoint
    catalog = ToolCatalog(method="semantic", embedding=_semantic(url))
    send_response.set()
    asyncio.run(catalog.register(READ_FILE))
    send_response.clear()
    request_started.clear()
    dense = _DenseSearchThread(catalog, "read a file")
    assert request_started.wait(timeout=5)
    try:
        with pytest.raises(RegistryBusyError, match=rf"^{_BUSY}$"):
            catalog.register(SEND_EMAIL)
    finally:
        send_response.set()
        dense.join()
    assert not catalog.has("send_email")
    asyncio.run(catalog.register(SEND_EMAIL))
    assert catalog.has("send_email")


def test_a_waiter_on_a_stopped_loop_does_not_hold_up_other_threads(
    controlled_embedding_endpoint: Endpoint,
) -> None:
    url, request_started, send_response = controlled_embedding_endpoint
    catalog = ToolCatalog(method="semantic", embedding=_semantic(url))
    send_response.set()
    asyncio.run(catalog.register(READ_FILE))
    send_response.clear()
    request_started.clear()
    dense = _DenseSearchThread(catalog, "read a file")
    assert request_started.wait(timeout=5)

    # A register queued on a loop that then stops (not closed) and stays stopped.
    stopped = asyncio.new_event_loop()

    async def queue_on_stopped_loop() -> Awaitable[None]:
        return catalog.register(_tool("archive", "Archive old messages."))

    stranded = stopped.run_until_complete(queue_on_stopped_loop())

    # Another thread's register waits behind it.
    parked = threading.Event()
    errors: list[BaseException] = []

    async def register_elsewhere() -> None:
        pending = catalog.register(SEND_EMAIL)
        parked.set()
        await pending

    def run_elsewhere() -> None:
        try:
            asyncio.run(register_elsewhere())
        except BaseException as err:  # pragma: no cover - surfaced by the assert below
            errors.append(err)

    elsewhere = threading.Thread(target=run_elsewhere, daemon=True)
    elsewhere.start()
    try:
        assert parked.wait(timeout=5)
        send_response.set()
        dense.join()
        elsewhere.join(timeout=5)
        assert not elsewhere.is_alive(), "a waiter on a stopped loop held the registry"
        assert errors == []
        assert catalog.has("send_email")
        assert not catalog.has("archive")

        # Resumed while another search holds the registry, the stranded register
        # finds its turn taken, re-enters the line, and lands once that settles.
        assert asyncio.iscoroutine(stranded)
        send_response.clear()
        request_started.clear()
        busy = _DenseSearchThread(catalog, "send an email")
        assert request_started.wait(timeout=5)

        async def resume() -> None:
            await _spin()
            assert not catalog.has("archive")
            send_response.set()
            await stranded

        stopped.run_until_complete(resume())
        busy.join()
        assert catalog.has("archive")
    finally:
        send_response.set()
        stopped.close()


async def test_skill_register_waits_for_an_in_flight_dense_search(
    controlled_embedding_endpoint: Endpoint,
) -> None:
    url, request_started, send_response = controlled_embedding_endpoint
    catalog = SkillCatalog(method="semantic", embedding=_semantic(url))
    send_response.set()
    await catalog.register(Skill(id="slides", name="slides", description="Build decks."))
    send_response.clear()
    request_started.clear()

    search = asyncio.create_task(catalog.search_async("decks", 5))
    await _held(request_started)
    pending = catalog.register(Skill(id="api", name="api", description="REST API design."))
    await _spin()
    assert not catalog.has("api")

    send_response.set()
    await asyncio.gather(search, pending)
    assert catalog.size() == 2


async def test_fact_register_waits_for_an_in_flight_dense_search(
    controlled_embedding_endpoint: Endpoint, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("RATEL_EXPERIMENTAL_SILENCE", "1")
    url, request_started, send_response = controlled_embedding_endpoint
    catalog = FactCatalog(method="semantic", embedding=_semantic(url))
    send_response.set()
    await catalog.register(
        Fact(id="address", name="address", description="Where the shop is.", body="Baker St")
    )
    send_response.clear()
    request_started.clear()

    search = asyncio.create_task(catalog.search_async("where is the shop", 5))
    await _held(request_started)
    pending = catalog.register(
        Fact(id="hours", name="hours", description="When the shop is open.", body="9 to 7")
    )
    await _spin()
    assert catalog.get("hours") is None

    send_response.set()
    await asyncio.gather(search, pending)
    assert catalog.get("hours") is not None


class TestRegistryBusyError:
    def test_is_exported_and_a_runtime_error(self) -> None:
        from ratel_ai.exceptions import RegistryBusyError as FromExceptions

        assert FromExceptions is RegistryBusyError
        assert ratel_ai.RegistryBusyError is RegistryBusyError
        assert issubclass(RegistryBusyError, RuntimeError)
        assert str(RegistryBusyError()) == _BUSY

    async def test_is_what_a_synchronous_refusal_raises(
        self, controlled_embedding_endpoint: Endpoint
    ) -> None:
        _url, request_started, send_response = controlled_embedding_endpoint
        catalog = await _semantic_tool_catalog(controlled_embedding_endpoint)
        request_started.clear()
        search = asyncio.create_task(catalog.search_async("read a file", 5))
        await _held(request_started)
        try:
            with pytest.raises(RegistryBusyError, match=rf"^{_BUSY}$"):
                catalog._registry.set_trace_sink("noop")
            with pytest.raises(RuntimeError, match=rf"^{_BUSY}$"):
                catalog._registry.set_trace_sink("noop")
        finally:
            send_response.set()
        await search

    async def test_is_what_replace_all_raises_once_the_search_settles_before_the_queued_register(
        self, controlled_embedding_endpoint: Endpoint
    ) -> None:
        url, request_started, send_response = controlled_embedding_endpoint
        catalog = SkillCatalog(method="semantic", embedding=_semantic(url))
        send_response.set()
        await catalog.register(Skill(id="slides", name="slides", description="Build decks."))
        send_response.clear()
        request_started.clear()
        dense = _DenseSearchThread(catalog, "decks")
        await _held(request_started)

        pending = catalog.register(Skill(id="api", name="api", description="REST API design."))
        send_response.set()
        dense.join()  # settled before `pending`'s task has started
        assert catalog._registry._dense_pending == 0
        # Nothing is in flight, but the register made first is still in line.
        with pytest.raises(RegistryBusyError, match=rf"^{_BUSY}$"):
            catalog.replace_all([Skill(id="slides", name="slides", description="Decks.")])
        await pending
        assert catalog.size() == 2

    async def test_is_what_replace_all_raises_while_a_register_is_queued(
        self, controlled_embedding_endpoint: Endpoint
    ) -> None:
        url, request_started, send_response = controlled_embedding_endpoint
        catalog = SkillCatalog(method="semantic", embedding=_semantic(url))
        send_response.set()
        await catalog.register(Skill(id="slides", name="slides", description="Build decks."))
        send_response.clear()
        request_started.clear()
        search = asyncio.create_task(catalog.search_async("decks", 5))
        await _held(request_started)
        pending = catalog.register(Skill(id="api", name="api", description="REST API design."))
        try:
            # Applying the reload now would land it ahead of the register made first.
            with pytest.raises(RegistryBusyError, match=rf"^{_BUSY}$"):
                catalog.replace_all([Skill(id="slides", name="slides", description="Decks.")])
        finally:
            send_response.set()
        await asyncio.gather(search, pending)
        assert catalog.size() == 2
