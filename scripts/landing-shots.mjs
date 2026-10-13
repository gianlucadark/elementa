// Screenshots of the landing at given points of the 3D scroll track, in headless Edge (real GPU).
//
//   node scripts/landing-shots.mjs                       desktop 1440x900 + phone 390x844
//   node scripts/landing-shots.mjs --at 0,0.4,0.66,0.95   track progress values
//   node scripts/landing-shots.mjs --out ../blender/bake/shots
//
// Needs the dev server running (npm run dev).
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = { url: 'http://localhost:4321/', at: [0, 0.35, 0.66, 0.95, 1.2], out: 'shots' };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--at') opt.at = args[++i].split(',').map(Number);
  else if (args[i] === '--out') opt.out = args[++i];
  else if (args[i] === '--url') opt.url = args[++i];
}
await fs.mkdir(opt.out, { recursive: true });

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
  },
};

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});

for (const [name, vp] of Object.entries(VIEWPORTS)) {
  const { width, height, ...rest } = vp;
  const ctx = await browser.newContext({ viewport: { width, height }, ...rest });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${name} page error]`, e.message));
  page.on('console', (m) => m.type() === 'error' && console.error(`[${name}]`, m.text().slice(0, 200)));
  const t0 = Date.now();
  await page.goto(opt.url, { waitUntil: 'load' });
  const lcp = await page.evaluate(
    () =>
      new Promise((res) => {
        new PerformanceObserver((l) => {
          const e = l.getEntries();
          res(Math.round(e[e.length - 1].startTime));
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        setTimeout(() => res(null), 3000);
      }),
  );
  const state = await page
    .waitForFunction(() => document.documentElement.dataset.webgl, null, { timeout: 90000 })
    .then((h) => h.jsonValue())
    .catch(() => 'timeout');
  console.log(`${name}: LCP ${lcp} ms, 3D ${state} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  for (const p of opt.at) {
    await page.evaluate((p) => {
      const track = document.getElementById('scrolly');
      const shell = track.querySelector('.scene-shell');
      const top = track.getBoundingClientRect().top + window.scrollY - (parseFloat(getComputedStyle(shell).top) || 0);
      const range = track.offsetHeight - shell.offsetHeight;
      window.scrollTo(0, top + range * p);
    }, p);
    await page.waitForTimeout(1800); // camera damping + ScrollTrigger
    const file = path.join(opt.out, `${name}_${String(p).replace('.', '_')}.png`);
    await page.screenshot({ path: file });
    console.log(`  ${file}`);
  }
  await ctx.close();
}
await browser.close();
