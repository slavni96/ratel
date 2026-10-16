import { AsyncResource } from "node:async_hooks";
import { RegistryBusyError } from "./errors.js";

/** An operation waiting for its turn. */
interface Waiter {
  readonly exclusive: boolean;
  /** Bound to the async context of the call that queued it, so a queued search
   * still reads its caller's turn and span rather than whichever operation's
   * settlement released it. */
  readonly start: () => void;
}

/**
 * Admission for one native registry's asynchronous operations, so a contended
 * `register` waits instead of failing with "registry busy".
 *
 * The native write runs on the JS main thread and must never block on the lock
 * a libuv worker holds, so the waiting happens here, before the native call. A
 * **shared** operation (a search, an embedding pass, an artifact build or warm)
 * runs alongside other shared ones. An **exclusive** one (a corpus write and
 * its dense preparation) runs alone, once every shared operation in flight has
 * settled.
 *
 * Writer preference, in arrival order: an operation that arrives while an
 * exclusive one is running or queued waits behind it, so a stream of searches
 * cannot starve a write, and a search started after `register(...)` sees what
 * was registered (embedded, on a dense catalog).
 *
 * An idle gate starts an operation synchronously, so the uncontended path is
 * unchanged: the native call still happens inside the caller's own tick. The
 * native refusal stays as the safety net for anything the gate does not see.
 *
 * @internal
 */
export class OperationGate {
  #shared = 0;
  #exclusive = false;
  #draining = false;
  readonly #queue: Waiter[] = [];

  /** Whether anything is in flight or waiting. */
  get busy(): boolean {
    return this.#shared > 0 || this.#exclusive || this.#queue.length > 0;
  }

  /** Whether an exclusive operation is running or waiting, so new work would queue. */
  get #writePending(): boolean {
    return this.#exclusive || this.#queue.length > 0;
  }

  /**
   * Run `operation` as a shared operation: now, unless an exclusive operation
   * is running or queued, in which case once that one has finished.
   *
   * @param hold - `false` admits the operation in order without keeping the
   *   gate busy while it runs. For work that holds no native lock across its
   *   awaits (a caller's ranking function), so a write never waits on it.
   */
  shared<T>(operation: () => Promise<T>, hold = true): Promise<T> {
    if (!this.#writePending) return this.#runShared(operation, hold);
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({
        exclusive: false,
        start: AsyncResource.bind(() => {
          this.#runShared(operation, hold).then(resolve, reject);
        }),
      });
    });
  }

  /**
   * Run `operation` as an exclusive operation: now when the gate is idle,
   * otherwise once everything ahead of it has settled. Its synchronous part
   * is the write; the promise it returns, if any, keeps the gate exclusive
   * until it settles.
   */
  exclusive(operation: () => Promise<void> | undefined): Promise<void> {
    if (!this.#writePending && this.#shared === 0) return this.#runExclusive(operation, false);
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({
        exclusive: true,
        start: AsyncResource.bind(() => {
          this.#runExclusive(operation, false).then(resolve, reject);
        }),
      });
    });
  }

  /**
   * Run `operation` exclusively now, or refuse. For a write that must land at
   * the call site (`SkillCatalog.replaceAll` returns its counts synchronously).
   * Throws {@link RegistryBusyError} while an exclusive operation is running
   * or queued, so it never lands ahead of a `register` made before it. Shared
   * operations in flight do not refuse it here; the native registry decides,
   * as before.
   *
   * @throws {@link RegistryBusyError} synchronously while a write is pending;
   *   rethrows `operation`'s own synchronous error.
   */
  exclusiveNow(operation: () => Promise<void> | undefined): Promise<void> {
    if (this.#writePending) throw new RegistryBusyError();
    return this.#runExclusive(operation, true);
  }

  #runShared<T>(operation: () => Promise<T>, hold: boolean): Promise<T> {
    if (!hold) {
      try {
        return operation();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    this.#shared += 1;
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      this.#releaseShared();
      return Promise.reject(error);
    }
    return pending.finally(() => this.#releaseShared());
  }

  #runExclusive(operation: () => Promise<void> | undefined, throwSync: boolean): Promise<void> {
    this.#exclusive = true;
    let pending: Promise<void> | undefined;
    try {
      pending = operation();
    } catch (error) {
      this.#releaseExclusive();
      if (throwSync) throw error;
      return Promise.reject(error);
    }
    if (pending === undefined) {
      this.#releaseExclusive();
      return Promise.resolve();
    }
    return pending.finally(() => this.#releaseExclusive());
  }

  #releaseShared(): void {
    this.#shared -= 1;
    this.#drain();
  }

  #releaseExclusive(): void {
    this.#exclusive = false;
    this.#drain();
  }

  /** Start waiters from the front: consecutive shared ones together, an exclusive one alone. */
  #drain(): void {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (!this.#exclusive) {
        const next = this.#queue[0];
        if (next === undefined || (next.exclusive && this.#shared > 0)) return;
        this.#queue.shift();
        next.start();
      }
    } finally {
      this.#draining = false;
    }
  }
}
