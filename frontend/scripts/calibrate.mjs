import { chromium } from 'playwright'
const OUT = process.env.SHOT_DIR ?? 'shots'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1700, height: 1400 } })
page.on('pageerror', (e) => console.log('pageerror:', e.message))
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()) })
await page.goto((process.env.APP_URL ?? 'http://localhost:5173/') + 'calibrate.html')
await page.waitForFunction(() => document.title === 'calibration ready', null, { timeout: 90000 })
await page.waitForTimeout(500)
console.log(await page.locator('#out').innerText())
await page.screenshot({ path: `${OUT}/calibrate.png`, fullPage: true })
await browser.close()
