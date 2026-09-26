/**
 * Browser smoke test: drives the real app in headless Chromium, exercises every
 * interactive path and fails loudly on any console error or page exception.
 *
 *   npm run dev          # in one shell
 *   node scripts/smoke.mjs
 */
import { chromium } from 'playwright'

const OUT = process.env.SHOT_DIR ?? 'shots'
const URL = process.env.APP_URL ?? 'http://localhost:5173/'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })

const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('requestfailed', (r) => {
  if (r.url().startsWith('http://localhost')) errors.push(`requestfailed: ${r.url()}`)
})

const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` })
const step = (n) => console.log(`\n▸ ${n}`)
const readStat = async (label) =>
  page.locator('.stat', { hasText: label }).first().locator('.v').innerText()

// NOT networkidle: in server mode the page holds a WebSocket streaming at
// 10 Hz for as long as it is open, so the network is never idle and the wait
// can only pass by luck of timing. Wait for the app's own ready signal instead,
// which is deterministic in both transports.
await page.goto(URL, { waitUntil: 'load' })
await page.locator('.map-wrap canvas.fire-canvas').waitFor({ state: 'visible', timeout: 30000 })
// The header chip reads "Loading…"/"Connecting…" until a terrain source settles.
await page
  .locator('.data-chip')
  .filter({ hasNotText: /Loading|Connecting/ })
  .first()
  .waitFor({ timeout: 30000 })
  .catch(() => console.log('  (chip still provisional — continuing on procedural terrain)'))
await page.waitForTimeout(800)
await shot('01-initial')

step('ignite + run at 30 min/s')
const map = await page.locator('.map-wrap').boundingBox()
await page.mouse.click(map.x + map.width * 0.45, map.y + map.height * 0.4)
await page.getByRole('button', { name: '30 min/s' }).click()
await page.waitForTimeout(5000)
await shot('02-burning')
console.log(`  area=${await readStat('Area burnt')} ros=${await readStat('Head-fire spread')} spots=${await readStat('Spot fires')}`)

step('draw a dozer line across the head')
await page.getByRole('button', { name: /Dozer line/ }).click()
await page.mouse.move(map.x + map.width * 0.2, map.y + map.height * 0.25)
await page.mouse.down()
for (let i = 0; i <= 20; i++) {
  await page.mouse.move(map.x + map.width * 0.2, map.y + map.height * (0.25 + (0.5 * i) / 20))
}
await page.mouse.up()
await page.waitForTimeout(1500)
await shot('03-dozer-line')
console.log(`  containment=${await readStat('Containment')}`)

step('retardant drop')
await page.getByRole('button', { name: /Retardant/ }).click()
await page.mouse.move(map.x + map.width * 0.6, map.y + map.height * 0.2)
await page.mouse.down()
for (let i = 0; i <= 12; i++) await page.mouse.move(map.x + map.width * (0.6 + (0.2 * i) / 12), map.y + map.height * 0.2)
await page.mouse.up()
await page.waitForTimeout(800)
await shot('04-retardant')

step('arrival-time isochrones')
await page.getByLabel('Arrival-time isochrones').check()
await page.waitForTimeout(600)
await shot('05-isochrones')
await page.getByLabel('Arrival-time isochrones').uncheck()

step('fuel tint over imagery')
await page.getByLabel('Tint by fuel model').check()
await page.waitForTimeout(800)
await shot('06-fuel-tint')
await page.getByLabel('Tint by fuel model').uncheck()

step('raster layers')
await page.getByRole('button', { name: 'Fuel', exact: true }).click()
await page.waitForTimeout(600)
await shot('07a-fuel-raster')
await page.getByRole('button', { name: 'Terrain', exact: true }).click()
await page.waitForTimeout(600)
await shot('07b-elevation')
await page.getByRole('button', { name: 'Real map' }).click()
await page.waitForTimeout(4000)

step('frame rate with a large fire')
const fps = await page.evaluate(() => new Promise((res) => {
  let n = 0
  const t0 = performance.now()
  const tick = () => { n++; performance.now() - t0 < 3000 ? requestAnimationFrame(tick) : res(Math.round((n * 1000) / (performance.now() - t0))) }
  requestAnimationFrame(tick)
}))
console.log(`  ${fps} fps`)

step('weather preset -> rain band')
await page.getByRole('button', { name: /Rain band/ }).click()
await page.waitForTimeout(4000)
console.log(`  moisture=${await readStat('Dead fuel moisture')} active=${await readStat('Active cells')}`)
await shot('08-rain-knockdown')

step('hourly forecast feed')
await page.getByRole('button', { name: /Foehn/ }).click()
await page.getByLabel('Drive from hourly forecast feed').check()
await page.waitForTimeout(1200)
await shot('09-forecast')

const settled = () =>
  page.locator('.data-chip').filter({ hasNotText: /Loading|Connecting/ }).first().waitFor({ timeout: 40000 })

step('switch scenario -> Dilijan (bookmark)')
await page.locator('.location-current').click()
await page.locator('.location-item', { hasText: 'Dilijan National Park' }).click()
await settled()
await page.getByLabel('Drive from hourly forecast feed').uncheck()
await page.getByRole('button', { name: /Ignite/ }).click()
await page.waitForTimeout(600)
await page.mouse.click(map.x + map.width * 0.5, map.y + map.height * 0.45)
await page.waitForTimeout(5000)
await shot('10-sierra')
console.log(`  area=${await readStat('Area burnt')} flame=${await readStat('Flame length')}`)

step('search anywhere on earth -> Yosemite Valley')
await page.locator('.location-input').click()
await page.locator('.location-input').fill('Yosemite Valley')
await page.locator('.location-menu').waitFor({ timeout: 20000 })
await page.locator('.location-item', { hasText: 'Yosemite' }).first().click({ timeout: 20000 })
await settled()
console.log(`  now simulating: ${(await page.locator('.lc-name').innerText()).trim()} · ${(await page.locator('.lc-span').innerText()).trim()}`)
await page.mouse.click(map.x + map.width * 0.5, map.y + map.height * 0.5)
await page.waitForTimeout(4000)
await shot('11-worldwide')
console.log(`  area=${await readStat('Area burnt')} ros=${await readStat('Head-fire spread')}`)

step('show current fires (NASA FIRMS)')
const firesBox = page.getByLabel('Show current fires')
if (await firesBox.isDisabled()) {
  console.log('  layer disabled in browser-only mode (FIRMS has no CORS) — as designed')
} else {
  await firesBox.check()
  await page.locator('.fires-note').waitFor({ timeout: 20000 })
  // The first pull is a 6 MB global file; wait for it to resolve, not just appear.
  await page.locator('.fires-note').filter({ hasNotText: 'Loading' }).waitFor({ timeout: 90000 })
  console.log(`  ${(await page.locator('.fires-note').innerText()).replace(/\n/g, ' · ')}`)
  await shot('11b-active-fires')
  await firesBox.uncheck()
}

step('resize the area of interest -> 40 km')
await page.locator('.location-current').click()
await page.locator('.span-seg button', { hasText: '40 km' }).click()
await settled()
console.log(`  ${(await page.locator('.lc-span').innerText()).trim()} across`)
await shot('12-wide-area')

step('reset')
await page.getByRole('button', { name: 'Reset' }).click()
await page.waitForTimeout(700)
console.log(`  area after reset=${await readStat('Area burnt')}`)

console.log(`\n${errors.length ? '✗ ERRORS:\n' + errors.join('\n') : '✓ no console errors, no page exceptions'}`)
await browser.close()
process.exit(errors.length ? 1 : 0)
