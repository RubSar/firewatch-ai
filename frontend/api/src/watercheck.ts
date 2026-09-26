/**
 * Diagnostic: how well does the fuel classifier identify water, worldwide?
 *
 *   npm run watercheck --workspace=@firewatch/api
 *
 * The visible-band classifier was tuned against Armenian imagery and fails
 * badly elsewhere — it once called the Great Salt Lake cropland and the Rio
 * Negro urban, which meant lakes burned. Sentinel-2's Scene Classification
 * Layer now overrides it for water and snow. This script is how that claim
 * stays honest: run it after touching classify.ts or sentinel.ts.
 *
 * Each site is centred on obvious water, so a low water percentage is a bug.
 * The last column is what matters: burnable area over open water is the defect.
 */
import { scenarioAt, buildTerrain } from '@firewatch/sim/terrain'
import { FUELS, Fuel } from '@firewatch/sim/fuels'
import { loadConfig } from './config.ts'
import { imageryFuel } from './providers/tier1.ts'
import { resolve } from './providers/provenance.ts'
import { sentinelLandCover } from './providers/sentinel.ts'

const cfg = loadConfig()

/** name, lat, lng, and why it is hard for a colour-based classifier. */
const SITES: [string, number, number, string][] = [
  ['Lake Sevan (AM)', 40.35, 45.35, 'turquoise — greener than the land'],
  ['Lake Tahoe (US)', 39.10, -120.03, 'deep blue, the easy case'],
  ['Lake Geneva (CH)', 46.42, 6.55, 'steep shores, dense settlement'],
  ['Great Salt Lake (US)', 41.10, -112.50, 'pink/red brine, bright salt flats'],
  ['Lake Nasser (EG)', 23.20, 32.75, 'desert, no vegetation contrast'],
  ['Rio Negro (BR)', -3.10, -60.02, 'blackwater river beside a city'],
]

let failures = 0
console.log('site                    water%  burnable%  source')
for (const [name, lat, lng, why] of SITES) {
  const sc = scenarioAt(lat, lng, 15)
  const base = buildTerrain(sc)
  const grid = { bounds: base.bounds, cols: base.cols, rows: base.rows, cellSize: base.cellSize, crs: 'EPSG:4326' as const }
  try {
    // Wait properly here: this is a diagnostic, not a request path.
    await sentinelLandCover(base.bounds, base.cols, base.rows, cfg, { deadlineMs: 120000 })
    const got = await resolve(imageryFuel(cfg), { grid, scenario: sc })
    const ids = got.data.fuelId
    const water = [...ids].filter((f) => f === Fuel.Water).length / ids.length
    const burnable = [...ids].filter((f) => FUELS[f].load > 0).length / ids.length
    const measured = got.provenance.source.includes('sentinel2-scl')
    if (!measured) failures++
    console.log(
      `${name.padEnd(22)} ${(water * 100).toFixed(1).padStart(5)}  ${(burnable * 100).toFixed(1).padStart(8)}  ` +
      `${measured ? 'Sentinel-2 SCL' : 'RGB proxy only'}   (${why})`
    )
  } catch (err) {
    failures++
    console.log(`${name.padEnd(22)} FAILED: ${(err as Error).message}`)
  }
}
console.log(failures ? `\n${failures} site(s) fell back to the RGB proxy` : '\nall sites classified from Sentinel-2')
