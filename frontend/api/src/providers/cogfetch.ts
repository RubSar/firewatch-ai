/**
 * A Response-like shim over node:https, for geotiff's range reads.
 *
 * Reading a COG window is many small range requests, and against these S3
 * endpoints the built-in fetch is both slower and more failure-prone: measured
 * 34 s versus 21 s for the same 400x400 window, and enough outright
 * `UND_ERR_CONNECT_TIMEOUT` failures that a four-band dNBR read usually lost at
 * least one. A keep-alive agent with a bounded socket pool fixes both, because
 * the cost is connection setup repeated per range request.
 *
 * Only the surface geotiff actually uses is implemented — ok, status,
 * headers.get, arrayBuffer and abort.
 */
import https from 'node:https'

const agent = new https.Agent({ keepAlive: true, maxSockets: 8 })

export interface MinimalResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}

export function cogFetch(
  url: string,
  opts: { headers?: Record<string, string>; signal?: AbortSignal } = {}
): Promise<MinimalResponse> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { agent, headers: opts.headers ?? {}, timeout: 90000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const b = Buffer.concat(chunks)
          resolve({
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            headers: { get: (k) => res.headers[String(k).toLowerCase()] as string ?? null },
            arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
          })
        })
        res.on('error', reject)
      }
    )
    opts.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
    req.on('timeout', () => req.destroy(new Error('COG read timed out')))
    req.on('error', reject)
  })
}

/**
 * Options for geotiff's `fromUrl`.
 *
 * Cast because `RemoteSourceOptions` does not declare `fetch`, although the
 * runtime honours it — verified by reading the same window through both paths
 * and getting identical pixel values. Without the cast this is a compile error
 * for a feature that demonstrably works.
 */
export const COG_OPTS = { fetch: cogFetch } as unknown as never
