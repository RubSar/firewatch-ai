import type { Provenance, Provided, Provider } from '@firewatch/contracts/providers'

export function prov(p: Omit<Provenance, 'fetchedAt'> & { fetchedAt?: string }): Provenance {
  return { fetchedAt: new Date().toISOString(), ...p }
}

export const synthetic = (source: string, note: string): Provenance =>
  prov({ source, kind: 'synthetic', nativeResolution: null, observedAt: null, coverage: 1, note })

/**
 * Runs a provider, falling back down its chain on failure.
 *
 * The fallback that actually fires is recorded in `degradedFrom`, so a UI can
 * say "live DEM, procedural fuel" instead of one undifferentiated status string.
 * A provider with an empty chain is a hard dependency (§1 failure table) and its
 * failure propagates.
 */
export async function resolve<Q, T>(
  p: Provider<Q, T>,
  query: Q,
  signal?: AbortSignal
): Promise<Provided<T>> {
  try {
    return await p.fetch(query, signal)
  } catch (err) {
    for (const fb of p.fallbacks) {
      try {
        const got = await resolve(fb, query, signal)
        return {
          data: got.data,
          provenance: { ...got.provenance, degradedFrom: p.id },
        }
      } catch {
        // try the next one
      }
    }
    throw new Error(`${p.id} failed with no usable fallback: ${(err as Error).message}`)
  }
}
