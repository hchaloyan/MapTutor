// Screenshots a page in the installed Chrome: tsx scripts/shot.ts <url> <out.png> [--dark] [--key <key>] [--width 1280] [--height 800]
import { chromium } from 'playwright-core'

const [url, out, ...flags] = process.argv.slice(2)
const option = (name: string) => {
  const i = flags.indexOf(`--${name}`)
  return i >= 0 ? flags[i + 1] : undefined
}

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({
  viewport: { width: Number(option('width') ?? 1280), height: Number(option('height') ?? 800) },
  colorScheme: flags.includes('--dark') ? 'dark' : 'light',
})
const key = option('key')
if (key) await page.addInitScript(k => localStorage.setItem('maptutor.key', k), key)
await page.goto(url, { waitUntil: 'networkidle' })
await page.screenshot({ path: out })
await browser.close()
