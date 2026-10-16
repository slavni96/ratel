# `src/`

The code that ships: the Rust engine, the language SDKs that embed it, the framework adapters
built on the TypeScript SDK, and the telemetry vocabulary they all emit. What is not a code module
lives at the repo root: the catalog-source contract (`protocol/`), the cross-SDK checks (`e2e/`),
the examples and the release tooling (`scripts/`).

## Layout

```
core/        ratel-ai-core: the Rust retrieval engine (crates.io)
sdk/         @ratel-ai/sdk (TypeScript, NAPI-RS) and ratel-ai (Python, PyO3), both embedding core/
adapters/    @ratel-ai/vercel-ai-sdk and @ratel-ai/mastra, framework adapters over the TypeScript SDK
telemetry/   the OpenTelemetry conventions and the ratel.* vocabulary packages for crates.io, npm and PyPI
```

Each folder's README covers its own layout and commands: [`core/`](core/README.md),
[`sdk/`](sdk/README.md), [`adapters/`](adapters/README.md), [`telemetry/`](telemetry/README.md).
How the SDKs bind the engine is [ADR-0006](../docs/adr/0006-native-ffi-bindings.md), the adapter
SPI is [ADR-0013](../docs/adr/0013-framework-adapter-spi.md), and the telemetry split is
[ADR-0007](../docs/adr/0007-telemetry-two-streams.md). Every package is its own release unit
([ADR-0008](../docs/adr/0008-release-engineering.md), [`RELEASING.md`](../RELEASING.md)).
