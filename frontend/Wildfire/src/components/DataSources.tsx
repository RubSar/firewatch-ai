import { useEffect, useRef } from 'react'
import type { Provenance } from '@firewatch/contracts/providers'
import type { TransportStatus } from '../transport/types.ts'

/**
 * What the model is actually running on, port by port.
 *
 * The header chip can only afford a count; this is the long form behind it.
 * Everything here is read from `Provenance` as the provider returned it —
 * nothing is inferred and nothing is hardcoded per port, so a port added to
 * `registry.ts` shows up here without this file changing.
 */

/** Friendly names for the ports of ARCHITECTURE.md §9. Unknown keys show raw. */
const LABELS: Record<string, string> = {
  elevation: 'Elevation',
  fuel: 'Fuel model',
  canopy: 'Canopy structure',
  barriers: 'Barriers',
  burnHistory: 'Burn history',
  weather: 'Weather',
  wind: 'Wind field',
  moisture: 'Fuel moisture',
  observer: 'Perimeter observations',
  valuesAtRisk: 'Values at risk',
}

/** Measured first, then derived, then the mocks — best evidence at the top. */
const RANK: Record<string, number> = { measured: 0, derived: 1, synthetic: 2 }
const KIND_LABEL: Record<string, string> = {
  measured: 'measured',
  derived: 'derived',
  synthetic: 'mocked',
}

export function DataSources({
  status,
  kind,
  onClose,
}: {
  status: TransportStatus
  kind: 'local' | 'remote' | undefined
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    // Capture, because the app binds its own single-key shortcuts on window.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const ports = Object.entries(status.provenance).sort(
    ([ak, a], [bk, b]) => (RANK[a.kind] ?? 3) - (RANK[b.kind] ?? 3) || ak.localeCompare(bk)
  )
  const real = ports.filter(([, p]) => p.kind !== 'synthetic').length

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal sources"
        role="dialog"
        aria-modal="true"
        aria-label="Data sources"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <h3>Where this data comes from</h3>
            <p className="sub">{subtitle(kind, status)}</p>
          </div>
          <button ref={closeRef} className="btn ghost" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </header>

        {ports.length > 0 ? (
          <>
            <p className="tally">
              <b>{real}</b> of {ports.length} ports carry real data. The rest are stand-ins, listed
              here rather than hidden.
            </p>
            <ul className="port-list">
              {ports.map(([key, p]) => (
                <Port key={key} name={LABELS[key] ?? key} p={p} />
              ))}
            </ul>
          </>
        ) : (
          <div className="empty">
            <p>
              The fire is stepping in this browser, so there are no provider ports to report on.
              Elevation and fuel come from the same public tile services the server uses; the
              weather is a mock forecast, and there are no barriers, canopy or satellite
              observations at all.
            </p>
            <p className="dim">
              Start the API and reload with <code>VITE_API_URL=http://127.0.0.1:8787</code> for the
              per-port breakdown.
            </p>
          </div>
        )}

        <footer>
          <span className="dim">
            Every provider returns its own provenance &mdash; ARCHITECTURE.md &sect;9. &ldquo;Mock
            data presented as live&rdquo; is meant to be a type error.
          </span>
        </footer>
      </div>
    </div>
  )
}

/** The remote chip note already begins "Server ·", so naming the mode twice reads badly. */
function subtitle(kind: 'local' | 'remote' | undefined, status: TransportStatus): string {
  const where = kind === 'remote' ? 'Server mode' : 'Browser-only mode'
  if (status.error) return `${where} · ${status.error}`
  return kind === 'remote' ? status.note : `${where} · ${status.note}`
}

function Port({ name, p }: { name: string; p: Provenance }) {
  const meta: string[] = []
  if (p.nativeResolution) meta.push(`${Math.round(p.nativeResolution)} m native`)
  if (p.observedAt) meta.push(`observed ${p.observedAt.slice(0, 10)}`)
  // Full coverage is the expected case and says nothing; a hole is the news.
  if (p.coverage < 1) meta.push(`${Math.round(p.coverage * 100)}% coverage`)

  return (
    <li className={`port ${p.kind}`}>
      <div className="port-head">
        <span className="port-name">{name}</span>
        <span className={`kind ${p.kind}`}>{KIND_LABEL[p.kind] ?? p.kind}</span>
        <code className="src">{p.source}</code>
      </div>
      <p className="port-note">{p.note}</p>
      {p.degradedFrom && (
        <p className="degraded">Fell back from <code>{p.degradedFrom}</code> — the real source failed.</p>
      )}
      {meta.length > 0 && <p className="meta">{meta.join(' · ')}</p>}
    </li>
  )
}
