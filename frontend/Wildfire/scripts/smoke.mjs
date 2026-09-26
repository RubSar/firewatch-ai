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

await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
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

step('switch scenario -> Dilijan')
await page.selectOption('.scenario-select', 'dilijan')
await page.getByLabel('Drive from hourly forecast feed').uncheck()
await page.getByRole('button', { name: /Ignite/ }).click()
await page.waitForTimeout(1200)
await page.mouse.click(map.x + map.width * 0.5, map.y + map.height * 0.45)
await page.waitForTimeout(5000)
await shot('10-sierra')
console.log(`  area=${await readStat('Area burnt')} flame=${await readStat('Flame length')}`)

step('reset')
await page.getByRole('button', { name: 'Reset' }).click()
await page.waitForTimeout(700)
console.log(`  area after reset=${await readStat('Area burnt')}`)

console.log(`\n${errors.length ? '✗ ERRORS:\n' + errors.join('\n') : '✓ no console errors, no page exceptions'}`)
await browser.close()
process.exit(errors.length ? 1 : 0)
