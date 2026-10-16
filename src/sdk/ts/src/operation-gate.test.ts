import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { RegistryBusyError } from "./errors.js";
import { OperationGate } from "./operation-gate.js";

/** A promise the test settles by hand, so "in flight" is deterministic. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every queued microtask (and promise reaction chain) run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("OperationGate", () => {
  it("starts shared and exclusive operations synchronously when idle", async () => {
    const gate = new OperationGate();
    const started: string[] = [];
    const shared = gate.shared(async () => {
      started.push("shared");
    });
    expect(started).toEqual(["shared"]);
    await shared;
    const exclusive = gate.exclusive(() => {
      started.push("exclusive");
      return undefined;
    });
    expect(started).toEqual(["shared", "exclusive"]);
    await exclusive;
  });

  it("releases a synchronous exclusive operation at once, so the next one also runs inline", () => {
    const gate = new OperationGate();
    const started: string[] = [];
    void gate.exclusive(() => {
      started.push("first");
      return undefined;
    });
    void gate.exclusive(() => {
      started.push("second");
      return undefined;
    });
    expect(started).toEqual(["first", "second"]);
    expect(gate.busy).toBe(false);
  });

  it("queues an exclusive operation behind in-flight shared ones and runs it once they settle", async () => {
    const gate = new OperationGate();
    const search = deferred<string>();
    const order: string[] = [];
    const reading = gate.shared(() => search.promise.then((value) => order.push(value)));
    const writing = gate.exclusive(() => {
      order.push("write");
      return undefined;
    });
    await flush();
    expect(order).toEqual([]);
    search.resolve("read");
    await Promise.all([reading, writing]);
    expect(order).toEqual(["read", "write"]);
  });

  it("runs a shared operation started while a write is queued after that write", async () => {
    const gate = new OperationGate();
    const first = deferred();
    const order: string[] = [];
    const reading = gate.shared(() => first.promise.then(() => order.push("first read")));
    const writing = gate.exclusive(() => {
      order.push("write");
      return undefined;
    });
    const later = gate.shared(async () => {
      order.push("later read");
    });
    await flush();
    expect(order).toEqual([]);
    first.resolve();
    await Promise.all([reading, writing, later]);
    expect(order).toEqual(["first read", "write", "later read"]);
  });

  it("holds the gate for an exclusive operation's asynchronous part", async () => {
    const gate = new OperationGate();
    const prepare = deferred();
    const order: string[] = [];
    const writing = gate.exclusive(() => {
      order.push("write");
      return prepare.promise.then(() => order.push("prepared"));
    });
    const reading = gate.shared(async () => {
      order.push("read");
    });
    await flush();
    expect(order).toEqual(["write"]);
    prepare.resolve();
    await Promise.all([writing, reading]);
    expect(order).toEqual(["write", "prepared", "read"]);
  });

  it("runs queued exclusive operations one at a time, in call order", async () => {
    const gate = new OperationGate();
    const blocker = deferred();
    const firstPrepare = deferred();
    const order: string[] = [];
    void gate.shared(() => blocker.promise);
    const first = gate.exclusive(() => {
      order.push("first");
      return firstPrepare.promise;
    });
    const second = gate.exclusive(() => {
      order.push("second");
      return undefined;
    });
    blocker.resolve();
    await flush();
    expect(order).toEqual(["first"]);
    firstPrepare.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  it("does not hold the gate for an unheld shared operation, but still admits it in order", async () => {
    const gate = new OperationGate();
    const blocker = deferred();
    const callerFunction = deferred();
    const order: string[] = [];
    void gate.shared(() => blocker.promise);
    const writing = gate.exclusive(() => {
      order.push("write");
      return undefined;
    });
    const unheld = gate.shared(() => {
      order.push("unheld admitted");
      return callerFunction.promise;
    }, false);
    blocker.resolve();
    await flush();
    expect(order).toEqual(["write", "unheld admitted"]);
    // A later write does not wait for the unheld operation to settle.
    const laterWrite = gate.exclusive(() => {
      order.push("later write");
      return undefined;
    });
    await laterWrite;
    expect(order).toEqual(["write", "unheld admitted", "later write"]);
    callerFunction.resolve();
    await Promise.all([writing, unheld]);
  });

  it("releases the gate when an operation throws synchronously or rejects", async () => {
    const gate = new OperationGate();
    await expect(
      gate.shared(() => {
        throw new Error("sync boom");
      }),
    ).rejects.toThrow("sync boom");
    await expect(gate.shared(() => Promise.reject(new Error("async boom")))).rejects.toThrow(
      "async boom",
    );
    await expect(
      gate.exclusive(() => {
        throw new Error("write boom");
      }),
    ).rejects.toThrow("write boom");
    await expect(gate.exclusive(() => Promise.reject(new Error("prepare boom")))).rejects.toThrow(
      "prepare boom",
    );
    expect(gate.busy).toBe(false);
  });

  it("runs the next queued operation after a queued exclusive one fails", async () => {
    const gate = new OperationGate();
    const blocker = deferred();
    void gate.shared(() => blocker.promise);
    const failing = gate.exclusive(() => {
      throw new Error("write boom");
    });
    const after = gate.exclusive(() => undefined);
    blocker.resolve();
    await expect(failing).rejects.toThrow("write boom");
    await expect(after).resolves.toBeUndefined();
    expect(gate.busy).toBe(false);
  });

  it("starts a queued operation in the async context of the call that queued it", async () => {
    const gate = new OperationGate();
    const storage = new AsyncLocalStorage<string>();
    const blocker = deferred();
    const seen: Array<string | undefined> = [];
    const reading = storage.run("first caller", () => gate.shared(() => blocker.promise));
    const writing = storage.run("writer", () =>
      gate.exclusive(() => {
        seen.push(storage.getStore());
        return undefined;
      }),
    );
    const later = storage.run("later caller", () =>
      gate.shared(async () => {
        seen.push(storage.getStore());
      }),
    );
    // Released from inside the first caller's settlement, not from the callers'.
    storage.run("releaser", () => blocker.resolve());
    await Promise.all([reading, writing, later]);
    expect(seen).toEqual(["writer", "later caller"]);
  });

  describe("exclusiveNow", () => {
    it("runs synchronously alongside in-flight shared operations, leaving the refusal to native", async () => {
      const gate = new OperationGate();
      const search = deferred();
      const reading = gate.shared(() => search.promise);
      let ran = false;
      const prepared = gate.exclusiveNow(() => {
        ran = true;
        return undefined;
      });
      expect(ran).toBe(true);
      await prepared;
      search.resolve();
      await reading;
    });

    it("throws RegistryBusyError synchronously while a write is running or queued", async () => {
      const gate = new OperationGate();
      const prepare = deferred();
      const writing = gate.exclusive(() => prepare.promise);
      let ran = false;
      let thrown: unknown;
      try {
        void gate.exclusiveNow(() => {
          ran = true;
          return undefined;
        });
      } catch (error) {
        thrown = error;
      }
      expect(ran).toBe(false);
      expect(thrown).toBeInstanceOf(RegistryBusyError);
      prepare.resolve();
      await writing;
    });

    it("rethrows the operation's synchronous error at the call site and releases the gate", () => {
      const gate = new OperationGate();
      expect(() =>
        gate.exclusiveNow(() => {
          throw new Error("swap refused");
        }),
      ).toThrow("swap refused");
      expect(gate.busy).toBe(false);
    });

    it("holds the gate until its asynchronous part settles", async () => {
      const gate = new OperationGate();
      const prepare = deferred();
      const order: string[] = [];
      const prepared = gate.exclusiveNow(() => prepare.promise.then(() => order.push("prepared")));
      const writing = gate.exclusive(() => {
        order.push("queued write");
        return undefined;
      });
      await flush();
      expect(order).toEqual([]);
      prepare.resolve();
      await Promise.all([prepared, writing]);
      expect(order).toEqual(["prepared", "queued write"]);
    });
  });
});
