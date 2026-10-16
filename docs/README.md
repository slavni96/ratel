# `docs/`

Project documentation that doesn't belong in a code folder.

## Layout

```
adr/                              Architecture decision records
assets/                           Images and other static assets
baseline-capture-distributed.md   Collecting seeding evidence from a multi-instance host
```

## Guides

[Baseline capture in a distributed host](baseline-capture-distributed.md) — how to collect the evidence for [ADR-0014](adr/0014-adaptive-usage-ranking.md) when the search and the invocation that follows land in different processes. The single-process path is [`examples/configurable-adaptive-ranking-ts`](../examples/configurable-adaptive-ranking-ts/README.md).

## `adr/` — Architecture decision records

The record of cross-cutting choices, kept **minimal and current**. Nygard format (`Status` / `Context` / `Decision` / `Consequences`), numbered sequentially (`NNNN-kebab-title.md`).

Amend in place for small drift; write a superseding ADR for real decision reversals; compact periodically — git history is the archive.

[ADR 0001](adr/0001-record-architecture-decisions.md) is the meta-ADR that carries the full convention. The `.adr-dir` file at the repo root points [adr-tools](https://github.com/npryce/adr-tools) here.

### Index

Accepted unless marked; each record's own `Status` section is the source of truth.
[`scripts/adr-index.test.mjs`](../scripts/adr-index.test.mjs) fails CI when two records share a
number or this list falls out of step with the folder.

- [0001](adr/0001-record-architecture-decisions.md) Record architecture decisions
- [0002](adr/0002-product-split-engine-local-cloud.md) Product split: engine / local / cloud
- [0003](adr/0003-catalog-source-interface.md) Catalog source: pluggable loader interface, auth and scope, sync semantics
- [0004](adr/0004-retrieval-and-tool-selection.md) Retrieval: tool indexing and replace-vs-suggest selection
- [0005](adr/0005-first-class-skills.md) First-class skills: unified capability search, two surfacing paths
- [0006](adr/0006-native-ffi-bindings.md) Native FFI bindings: NAPI-RS for TS, PyO3 for Python
- [0007](adr/0007-telemetry-two-streams.md) Telemetry: core-owned local trace stream, OTel remote conventions
- [0008](adr/0008-release-engineering.md) Release engineering: per-unit versions, one routed workflow, RC-first OIDC
- [0009](adr/0009-licensing.md) Licensing: Apache-2.0 engine, MIT everything else
- [0010](adr/0010-catalog-scope-model.md) Catalog scope model: tenant → project → subject (Proposed)
- [0011](adr/0011-selectable-retrieval-methods.md) Selectable retrieval methods: BM25, semantic, hybrid
- [0012](adr/0012-configurable-embedding-models.md) Configurable embedding models
- [0013](adr/0013-framework-adapter-spi.md) Framework adapter SPI: `ratel(config).adaptTo(adapter)`
- [0014](adr/0014-adaptive-usage-ranking.md) Adaptive usage ranking: an online usage arm over the existing fusion
- [0015](adr/0015-whole-catalog-skill-reload.md) Whole-catalog skill reload: `replaceAll` mutates the catalog in place
- [0016](adr/0016-single-ci-gate.md) Single required `ci-gate`, core-maintainers bypass
- [0017](adr/0017-facts-and-injection-freshness.md) Facts: constant grounding content with a content-presence re-injection gate
- [0018](adr/0018-build-time-embedding-artifacts.md) Build-time embedding artifacts
- [0019](adr/0019-retrieval-experiments.md) Retrieval experiments: deterministic assignment and shadow evaluation
- [0020](adr/0020-runtime-events-lane.md) Runtime events lane: subscribable facts and catalog snapshots
- [0021](adr/0021-catalog-searchable-description-projections.md) Catalog searchable-description projections and tool selection
- [0022](adr/0022-vendor-neutral-definition-overlay-seam.md) Vendor-neutral definition-overlay seam
- [0023](adr/0023-searchable-text-indexes-names-not-schema-prose.md) The searchable-text projection indexes names, not schema prose (Rejected)
- [0024](adr/0024-hybrid-fuses-on-scores.md) Hybrid fuses on normalised scores, not rank positions
- [0025](adr/0025-intent-graph-storage-plugins.md) Intent graph storage plugins (local file, S3)
- [0026](adr/0026-turn-scope.md) Turn scope: one marked request, turn ids by default, external tool calls
- [0027](adr/0027-custom-retriever-and-reranker-functions.md) Custom retriever and reranker functions, and a two-stage reranker (Proposed)
- [0028](adr/0028-adapter-sdk-peer-floor.md) Adapter `@ratel-ai/sdk` peer is a 0.x floor range, not a caret of the current minor
