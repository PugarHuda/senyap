// Drives the built page in a real browser and asserts the circuits ran there.
//
// A successful `vite build` proves the wasm bundled, not that it executes. This
// loads the page, fills, attacks, and fails loudly on any console error.
//
//   npm run build && npm run build:web && npm run verify:web
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const root = fileURLToPath(new URL('..', import.meta.url));  // the repo path has a space in it

// Spawned through node directly rather than `npx ... {shell:true}`. On Windows
// the shell form starts a cmd.exe that owns vite, so server.kill() reaps the
// shell and leaves vite holding the port - the script then hangs on exit and the
// next run silently tests against the stale server.
const server = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
  'preview', '--port', '4173', '--strictPort',
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

// We fix the port, so wait for it to answer rather than scraping the banner -
// vite wraps the port number in ANSI colour codes and a URL regex misses it.
const url = 'http://localhost:4173';
server.stderr.on('data', (d) => process.stderr.write(d));

const ready = await (async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
})();
if (!ready) {
  server.kill();
  throw new Error(`vite preview never answered on ${url}`);
}

const fail = [];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });
  page.on('console', (m) => m.type() === 'error' && fail.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => fail.push(`pageerror: ${e.message}`));

  await page.goto(url, { waitUntil: 'networkidle0' });

  // The app only unhides once the circuits have run once in the page.
  await page.waitForSelector('#app:not([hidden])', { timeout: 60_000 });
  console.log('  boot          circuits ran in the browser');

  const seals = await page.$$eval('#seals li', (n) => n.length);
  console.log(`  ledger        ${seals} sealed quotes, no price rendered`);
  if (seals !== 3) fail.push(`expected 3 sealed quotes, got ${seals}`);

  await page.click('#fill');
  await page.waitForFunction(
    () => !/PROVING/.test(document.getElementById('verdict').textContent),
    { timeout: 60_000 },
  );
  const filled = await page.$eval('#verdict', (n) => n.textContent);
  const print = await page.$eval('#sPrint', (n) => n.textContent);
  console.log(`  fill          ${filled}   ledger print ${print}`);
  if (!filled.startsWith('FILLED @ 995')) fail.push(`fill said "${filled}", expected FILLED @ 995`);
  if (print !== '995') fail.push(`ledger print is "${print}", expected 995`);

  // Attack 3 is "invent a competitor", the soundness one.
  await page.evaluate(() => document.querySelectorAll('#attacks button')[2].click());
  await page.waitForFunction(
    () => !/PROVING/.test(document.getElementById('verdict').textContent),
    { timeout: 60_000 },
  );
  const verdict = await page.$eval('#verdict', (n) => n.textContent);
  const reason = await page.$eval('#reason', (n) => n.textContent);
  console.log(`  attack        ${verdict}  ${reason}`);
  if (verdict !== 'REFUSED') fail.push(`fabricated quote was ${verdict}, expected REFUSED`);

  await page.screenshot({ path: 'docs/screenshot.png', fullPage: true });
  console.log('  screenshot    docs/screenshot.png');
} finally {
  await browser.close();
  server.kill();
}

if (fail.length) {
  console.error('\nFAILED');
  for (const f of fail) console.error(`  ${f}`);
  process.exit(1);
}
console.log('\nweb verified in a real browser');
process.exit(0);
