// A contended `register` waits for the operations in flight on its catalog
// instead of failing with "registry busy", and an operation started while a
// register is queued runs after it. In-flight work is made deterministic with
// the delayed embedding server's hold/release barrier, never with sleeps.

import { describe, expect, it } from "vitest";
import { FactCatalog, FactRegistry } from "./experimental.js";
import {
  type ExecutableTool,
  RegistryBusyError,
  type Skill,
  SkillCatalog,
  ToolCatalog,
  ToolRegistry,
} from "./index.js";
import { startDelayedEmbeddingServer } from "./test-support/delayed-embedding-server.js";

const REGISTRY_BUSY = "registry busy; await the active operation before registering more items";

const readFile: ExecutableTool = {
  id: "read_file",
  name: "read_file",
  description: "Read a file from local disk and return its textual contents.",
  inputSchema: {},
  outputSchema: {},
  execute: async () => ({}),
};

const sendEmail: ExecutableTool = {
  id: "send_email",
  name: "send_email",
  description: "Send an email message to a recipient.",
  inputSchema: {},
  outputSchema: {},
  execute: async () => ({}),
};

const slides: Skill = {
  id: "frontend-slides",
  name: "frontend-slides",
  description: "Build animation-rich HTML presentations from scratch.",
  tags: ["frontend", "presentations"],
  body: "# Frontend Slides",
};

const apiDesign: Skill = {
  id: "api-design",
  name: "api-design",
  description: "REST API design patterns: resource naming, status codes, pagination.",
  tags: ["backend", "api"],
  body: "# API Design",
};

/** Push `label` onto `order` when `promise` settles, keeping its outcome. */
function settles<T>(order: string[], label: string, promise: Promise<T>): Promise<T> {
  return promise.then(
    (value) => {
      order.push(label);
      return value;
    },
    (error: unknown) => {
      order.push(`${label} rejected`);
      throw error;
    },
  );
}

/** Let pending promise reactions and native completions run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const toolIds = (hits: { toolId: string }[]) => hits.map((hit) => hit.toolId);

function semanticEmbedding(url: string) {
  return { url, model: "test-model" };
}

describe("ToolCatalog.register under contention", () => {
  it("waits for an in-flight BM25 searchAsync, then registers", async () => {
    const catalog = new ToolCatalog();
    await catalog.register(readFile);

    const search = catalog.searchAsync("send an email", 5);
    const registered = catalog.register(sendEmail);
    // Deferred behind the search rather than refused or applied under it.
    expect(catalog.has("send_email")).toBe(false);
    const [hits] = await Promise.all([search, registered]);

    // The search started first, so it ranked the corpus before the write.
    expect(toolIds(hits)).not.toContain("send_email");
    expect(catalog.has("send_email")).toBe(true);
    expect(toolIds(catalog.search("send an email", 5))).toContain("send_email");
  });

  it("waits for an in-flight dense search, then registers and embeds", async () => {
    const server = await startDelayedEmbeddingServer();
    try {
      const catalog = new ToolCatalog({
        method: "semantic",
        embedding: semanticEmbedding(server.url),
      });
      await catalog.register(readFile);
      await server.armBatchHold(1);

      const order: string[] = [];
      const search = settles(order, "search", catalog.searchAsync("read a file", 5));
      await server.waitForHeld();
      const registered = settles(order, "register", catalog.register(sendEmail));
      await flush();
      // Neither resolved nor refused while the search holds the registry.
      expect(order).toEqual([]);
      expect(catalog.has("send_email")).toBe(false);

      server.releaseHeld();
      await Promise.all([search, registered]);
      expect(order).toEqual(["search", "register"]);
      expect(toolIds(await catalog.searchAsync("send an email", 5))).toContain("send_email");
    } finally {
      await server.close();
    }
  });

  it("runs a search started while a register is queued after it, seeing the new tool", async () => {
    const server = await startDelayedEmbeddingServer();
    try {
      const catalog = new ToolCatalog({
        method: "semantic",
        embedding: semanticEmbedding(server.url),
      });
      await catalog.register(readFile);
      await server.armBatchHold(1);

      const order: string[] = [];
      const first = settles(order, "first search", catalog.searchAsync("read a file", 5));
      await server.waitForHeld();
      const registered = settles(order, "register", catalog.register(sendEmail));
      const dense = settles(order, "dense search", catalog.searchAsync("send an email", 5));
      const lexical = settles(
        order,
        "bm25 search",
        catalog.searchAsync("send an email", 5, { method: "bm25" }),
      );
      server.releaseHeld();

      const [, , denseHits, lexicalHits] = await Promise.all([first, registered, dense, lexical]);
      // Both later searches waited for the write and its embedding: the dense
      // one would otherwise have ranked without the tool or failed with
      // EmbeddingsNotBuilt, the BM25 one would have missed it.
      expect(order.slice(0, 2)).toEqual(["first search", "register"]);
      expect(toolIds(denseHits)).toContain("send_email");
      expect(toolIds(lexicalHits)).toContain("send_email");
    } finally {
      await server.close();
    }
  });

  it("runs a queued search in its caller's turn, not the one that released it", async () => {
    const server = await startDelayedEmbeddingServer();
    try {
      const catalog = new ToolCatalog({
        method: "semantic",
        embedding: semanticEmbedding(server.url),
        trace: { kind: "memory", sessionId: "queued" },
      });
      await catalog.register(readFile);
      await server.armBatchHold(1);

      const first = catalog.searchAsync("read a file", 5);
      await server.waitForHeld();
      const registered = catalog.register(sendEmail);
      const queued = catalog.turn(() => catalog.searchAsync("send an email", 5), {
        id: "queued-turn",
      });
      server.releaseHeld();
      await Promise.all([first, registered, queued]);

      const searches = (catalog.drainTraceEvents() as Array<Record<string, unknown>>).filter(
        (event) => event.type === "search",
      );
      expect(searches.find((event) => event.query === "send an email")?.turn_id).toBe(
        "queued-turn",
      );
      expect(searches.find((event) => event.query === "read a file")?.turn_id).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("queues a second un-awaited register behind the first one's embedding", async () => {
    const server = await startDelayedEmbeddingServer();
    try {
      const catalog = new ToolCatalog({
        method: "semantic",
        embedding: semanticEmbedding(server.url),
      });
      const order: string[] = [];
      const first = settles(order, "first", catalog.register(readFile));
      const second = settles(order, "second", catalog.register(sendEmail));
      // The uncontended register wrote synchronously; the queued one has not.
      expect(catalog.has("read_file")).toBe(true);
      expect(catalog.has("send_email")).toBe(false);

      await Promise.all([first, second]);
      expect(order).toEqual(["first", "second"]);
      expect(toolIds(await catalog.searchAsync("send an email", 5))).toEqual(
        expect.arrayContaining(["read_file", "send_email"]),
      );
    } finally {
      await server.close();
    }
  });

  it("keeps the uncontended register synchronous: an un-awaited register is searchable at once", async () => {
    const catalog = new ToolCatalog();
    const first = catalog.register(readFile);
    const second = catalog.register(sendEmail);
    expect(toolIds(catalog.search("read a file", 5))).toContain("read_file");
    expect(toolIds(catalog.search("send an email", 5))).toContain("send_email");
    await Promise.all([first, second]);
  });

  it("does not wait on a caller's retrieveFn, which holds no native lock", async () => {
    let releaseRanking!: () => void;
    const rankingHeld = new Promise<void>((resolve) => {
      releaseRanking = resolve;
    });
    let rankingStarted!: () => void;
    const rankingReached = new Promise<void>((resolve) => {
      rankingStarted = resolve;
    });
    const catalog = new ToolCatalog({
      method: "custom",
      retrieveFn: async (_query, candidates) => {
        rankingStarted();
        await rankingHeld;
        return candidates.map((candidate) => ({ id: candidate.id, score: 1 }));
      },
    });
    await catalog.register(readFile);

    const search = catalog.searchAsync("read a file", 5);
    await rankingReached;
    await catalog.register(sendEmail);
    expect(catalog.has("send_email")).toBe(true);

    releaseRanking();
    expect(toolIds(await search)).toEqual(["read_file"]);
  });
});

describe("SkillCatalog.register under contention", () => {
  it("waits for an in-flight BM25 searchAsync, then registers", async () => {
    const catalog = new SkillCatalog();
    await catalog.register(slides);

    const search = catalog.searchAsync("rest api pagination", 5);
    const registered = catalog.register(apiDesign);
    expect(catalog.has("api-design")).toBe(false);
    const [hits] = await Promise.all([search, registered]);

    expect(hits.map((hit) => hit.skillId)).not.toContain("api-design");
    expect(catalog.search("rest api pagination", 5).map((hit) => hit.skillId)).toContain(
      "api-design",
    );
  });

  it("waits for an in-flight dense search, then registers and embeds", async () => {
    const server = await startDelayedEmbeddingServer();
    try {
      const catalog = new SkillCatalog({
        method: "semantic",
        embedding: semanticEmbedding(server.url),
      });
      await catalog.register(slides);
      await server.armBatchHold(1);

      const order: string[] = [];
      const search = settles(order, "search", catalog.searchAsync("slides", 5));
      await server.waitForHeld();
      const registered = settles(order, "register", catalog.register(apiDesign));
      await flush();
      expect(order).toEqual([]);

      server.releaseHeld();
      await Promise.all([search, registered]);
      expect(order).toEqual(["search", "register"]);
      const hits = await catalog.searchAsync("api design", 5);
      expect(hits.map((hit) => hit.skillId)).toContain("api-design");
    } finally {
      await server.close();
    }
  });

  it("waits for an in-flight replaceAll embedding pass, then registers", async () => {
    const server = await startDelayedEmbeddingServer();
    try {
      const catalog = new SkillCatalog({
        method: "semantic",
        embedding: semanticEmbedding(server.url),
      });
      await server.armBatchHold(1);
      const reload = catalog.replaceAll([slides]);
      await server.waitForHeld();

      const order: string[] = [];
      const registered = settles(order, "register", catalog.register(apiDesign));
      await flush();
      expect(order).toEqual([]);

      server.releaseHeld();
      await Promise.all([reload, registered]);
      expect(catalog.size()).toBe(2);
    } finally {
      await server.close();
    }
  });
});

describe("FactCatalog.register under contention", () => {
  it("waits for an in-flight dense search, then registers", async () => {
    const server = await startDelayedEmbeddingServer();
    try {
      const catalog = new FactCatalog({
        method: "semantic",
        embedding: semanticEmbedding(server.url),
      });
      await catalog.register({
        id: "address",
        name: "address",
        description: "Where the shop is.",
        body: "12 Baker Street",
      });
      await server.armBatchHold(1);

      const order: string[] = [];
      const search = settles(order, "search", catalog.searchAsync("where is the shop", 5));
      await server.waitForHeld();
      const registered = settles(
        order,
        "register",
        catalog.register({
          id: "hours",
          name: "hours",
          description: "When the shop is open.",
          body: "9am to 7pm",
        }),
      );
      await flush();
      expect(order).toEqual([]);

      server.releaseHeld();
      await Promise.all([search, registered]);
      expect(order).toEqual(["search", "register"]);
    } finally {
      await server.close();
    }
  });

  it("FactRegistry.register waits too", async () => {
    const server = await startDelayedEmbeddingServer();
    try {
      const registry = new FactRegistry(semanticEmbedding(server.url), "semantic");
      await registry.register({ id: "a", name: "a", description: "first fact", body: "a" });
      await server.armBatchHold(1);
      const search = registry.searchWithMethodAsync("first", 5, "direct", "semantic");
      await server.waitForHeld();
      const registered = registry.register({
        id: "b",
        name: "b",
        description: "second fact",
        body: "b",
      });
      server.releaseHeld();
      await expect(Promise.all([search, registered])).resolves.toBeDefined();
      expect(registry.search("second fact", 5).map((hit) => hit.factId)).toContain("b");
    } finally {
      await server.close();
    }
  });
});

describe("ToolRegistry.register under contention", () => {
  it("waits for an in-flight artifact build, then registers", async () => {
    const server = await startDelayedEmbeddingServer();
    try {
      const registry = new ToolRegistry(semanticEmbedding(server.url), "bm25");
      await registry.register(readFile);
      await server.armBatchHold(1);
      const order: string[] = [];
      const build = settles(order, "build", registry.experimentalBuildEmbeddingArtifact());
      await server.waitForHeld();
      const registered = settles(order, "register", registry.register(sendEmail));
      await flush();
      expect(order).toEqual([]);
      expect(toolIds(registry.search("send an email", 5))).not.toContain("send_email");

      server.releaseHeld();
      await Promise.all([build, registered]);
      expect(toolIds(registry.search("send an email", 5))).toContain("send_email");
    } finally {
      await server.close();
    }
  });
});

describe("definition-overlay apply under contention", () => {
  const overlay = new Map([["send_email", "Dispatch outgoing mail."]]);

  /** Whether the catalog took definition-override ownership (private state). */
  const adoptedOverrides = (catalog: SkillCatalog) =>
    (catalog as unknown as { registry: { useDefinitionOverrides: boolean } }).registry
      .useDefinitionOverrides;

  it("does not write a tool's older definition back over a register queued ahead of it", async () => {
    const catalog = new ToolCatalog();
    await catalog.register({
      ...sendEmail,
      description: "Send an email message, version one.",
      execute: async () => ({ version: 1 }),
    });

    const search = catalog.searchAsync("send an email", 5);
    const registered = catalog.register({
      ...sendEmail,
      description: "Send an email message, version two.",
      execute: async () => ({ version: 2 }),
    });
    // Queued behind the register: what it writes must be read when it lands,
    // not now, while version one is still the local definition.
    const applied = catalog.applyDefinitionOverrides(overlay);
    await Promise.all([search, registered, applied]);

    expect(catalog.get("send_email")).toMatchObject({
      description: "Send an email message, version two.",
      experimentalSearchableDescription: "Dispatch outgoing mail.",
    });
    expect(await catalog.invoke("send_email", {})).toEqual({ version: 2 });
    expect(catalog.snapshot().map((tool) => tool.description)).toEqual([
      "Send an email message, version two.",
    ]);
  });

  it("does not write a fact's older definition back over a register queued ahead of it", async () => {
    const catalog = new FactCatalog();
    const fact = { id: "send_email", name: "hours", description: "When the shop is open." };
    await catalog.register({ ...fact, body: "version one" });

    const search = catalog.searchAsync("when is the shop open", 5);
    const registered = catalog.register({ ...fact, body: "version two" });
    const applied = catalog.applyDefinitionOverrides(overlay);
    await Promise.all([search, registered, applied]);

    expect(catalog.get("send_email")).toMatchObject({
      body: "version two",
      experimentalSearchableDescription: "Dispatch outgoing mail.",
    });
  });

  it("refuses a skill overlay instead of landing it ahead of a queued register", async () => {
    const catalog = new SkillCatalog();
    await catalog.register(slides);

    const search = catalog.searchAsync("slides", 5);
    const registered = catalog.register({ ...slides, body: "# Frontend Slides v2" });
    // The skill overlay is a whole-catalog reload, which cannot wait.
    await expect(
      catalog.applyDefinitionOverrides(new Map([[slides.id, "Decks."]])),
    ).rejects.toBeInstanceOf(RegistryBusyError);
    await Promise.all([search, registered]);

    expect(catalog.get(slides.id)?.body).toBe("# Frontend Slides v2");
    // The refused overlay must not reach the register that landed after it.
    expect(catalog.get(slides.id)?.experimentalSearchableDescription).toBeUndefined();
    expect(adoptedOverrides(catalog)).toBe(false);
  });

  it("leaves nothing of a skill overlay the native registry refuses", async () => {
    const server = await startDelayedEmbeddingServer();
    try {
      const catalog = new SkillCatalog({
        method: "semantic",
        embedding: semanticEmbedding(server.url),
      });
      await catalog.register(slides);
      await server.armBatchHold(1);
      const search = catalog.searchAsync("slides", 5);
      await server.waitForHeld();
      // Nothing is queued, so the swap is tried at once and native refuses it.
      await expect(
        catalog.applyDefinitionOverrides(new Map([[slides.id, "Decks."]])),
      ).rejects.toBeInstanceOf(RegistryBusyError);
      server.releaseHeld();
      await search;

      await catalog.register({ ...slides, body: "# Frontend Slides v2" });
      expect(catalog.get(slides.id)?.experimentalSearchableDescription).toBeUndefined();
      expect(adoptedOverrides(catalog)).toBe(false);
    } finally {
      await server.close();
    }
  });
});

describe("RegistryBusyError", () => {
  function expectRegistryBusy(thrown: unknown): void {
    expect(thrown).toBeInstanceOf(RegistryBusyError);
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as RegistryBusyError;
    expect(error.name).toBe("RegistryBusyError");
    expect(error.code).toBe("registry_busy");
    expect(error.message).toBe(REGISTRY_BUSY);
  }

  function thrownBy(call: () => unknown): unknown {
    try {
      call();
    } catch (error) {
      return error;
    }
    throw new Error("expected the call to throw");
  }

  it("is what a synchronous native refusal throws", async () => {
    const server = await startDelayedEmbeddingServer();
    try {
      const registry = new ToolRegistry(semanticEmbedding(server.url), "bm25");
      await registry.register(readFile);
      await server.armBatchHold(1);
      const build = registry.experimentalBuildEmbeddingArtifact();
      await server.waitForHeld();

      expectRegistryBusy(thrownBy(() => registry.registerItems(sendEmail)));
      expectRegistryBusy(thrownBy(() => registry.setTraceSink({ kind: "noop" })));

      server.releaseHeld();
      await build;
    } finally {
      await server.close();
    }
  });

  it("is what SkillCatalog.replaceAll throws while an operation owns the registry", async () => {
    const server = await startDelayedEmbeddingServer();
    try {
      const catalog = new SkillCatalog({
        method: "semantic",
        embedding: semanticEmbedding(server.url),
      });
      await catalog.register(slides);
      await server.armBatchHold(1);
      const search = catalog.searchAsync("slides", 5);
      await server.waitForHeld();

      expectRegistryBusy(thrownBy(() => catalog.replaceAll([apiDesign])));

      server.releaseHeld();
      await search;
      expect(catalog.has("api-design")).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("is what SkillCatalog.replaceAll throws while a register is queued", async () => {
    const server = await startDelayedEmbeddingServer();
    try {
      const catalog = new SkillCatalog({
        method: "semantic",
        embedding: semanticEmbedding(server.url),
      });
      await catalog.register(slides);
      await server.armBatchHold(1);
      const search = catalog.searchAsync("slides", 5);
      await server.waitForHeld();
      const registered = catalog.register(apiDesign);

      // Applying the reload now would land it before the register the caller
      // made first.
      expectRegistryBusy(thrownBy(() => catalog.replaceAll([slides])));

      server.releaseHeld();
      await Promise.all([search, registered]);
      expect(catalog.size()).toBe(2);
    } finally {
      await server.close();
    }
  });
});
