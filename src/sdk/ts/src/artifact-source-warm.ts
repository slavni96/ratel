import { RegistryBusyError } from "./errors.js";

const artifactOperations = new WeakMap<object, number>();

/**
 * Refuse a synchronous corpus mutation while an artifact source resolve/warm
 * is in flight. Asynchronous `register` calls do not reach this: they queue
 * behind the warm in the registry's operation gate.
 *
 * @throws {@link RegistryBusyError} while a warm is in flight.
 */
export function assertNotArtifactBusy(registry: object): void {
  if ((artifactOperations.get(registry) ?? 0) > 0) {
    throw new RegistryBusyError();
  }
}

/**
 * Warm from an artifact whose bytes come from `resolve`. The corpus is closed
 * to synchronous mutation for the whole call, including the asynchronous
 * resolve.
 *
 * @param registry - The registry whose corpus is closed (the guard's key).
 * @param warm - Warms its dense cache; called directly, not through the
 *   registry's gate, since the caller already holds it.
 * @param resolve - Produces the artifact bytes and miss policy.
 */
export async function warmFromEmbeddingArtifactSource(
  registry: object,
  warm: (bytes: Buffer, onMiss: "error" | "embed") => Promise<void>,
  resolve: () => Promise<{ bytes: Buffer; onMiss: "error" | "embed" }>,
): Promise<void> {
  artifactOperations.set(registry, (artifactOperations.get(registry) ?? 0) + 1);
  try {
    const { bytes, onMiss } = await resolve();
    await warm(bytes, onMiss);
  } finally {
    artifactOperations.set(registry, (artifactOperations.get(registry) ?? 1) - 1);
  }
}
