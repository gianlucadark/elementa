// Automated fidelity measurement: opens /lab in headless Edge (real GPU) and prints the WebGL vs
// Cycles score for one or more look variants.
//
//   node scripts/lab-score.mjs                                   default look, Camera_Desktop
//   node scripts/lab-score.mjs --shot Camera_Detail
//   node scripts/lab-score.mjs '{"bloomIntensity":1.2}' '{"bloomIntensity":0.6}'
//   node scripts/lab-score.mjs --save out.png                    also saves the WebGL frame
//   node scripts/lab-score.mjs --eval "window.__lab.scene..."     runs code in the page first (experiments)
//
// Needs the dev server running (npm run dev).
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';

const args = process.argv.slice(2);
const opt = { url: 'http://localhost:4321/lab', shot: 'Camera_Desktop', save: null, evals: [], variants: [] };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--shot') opt.shot = args[++i];
  else if (args[i] === '--url') opt.url = args[++i];
  else if (args[i] === '--save') opt.save = args[++i];
  else if (args[i] === '--eval') opt.evals.push(args[++i]);
  else opt.variants.push(JSON.parse(args[i]));
}
if (!opt.variants.length) opt.variants.push({});

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && console.error('[page]', m.text().slice(0, 300)));
page.on('pageerror', (e) => console.error('[page error]', e.message));
await page.goto(opt.url);
await page.waitForFunction(() => window.__labApi && window.__lab && window.__post, null, { timeout: 120000 });
const renderer = await page.evaluate(() => {
  const gl = window.__lab.gl.getContext();
  const d = gl.getExtension('WEBGL_debug_renderer_info');
  return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
});
console.log(`renderer: ${renderer}`);
if (opt.shot !== 'Camera_Desktop') {
  await page.evaluate((s) => window.__labApi.shot(s), opt.shot);
  await page.waitForFunction(() => window.__lab && window.__post, null, { timeout: 120000 });
}

for (const code of opt.evals) console.log('eval ->', await page.evaluate(code));

const results = [];
for (const v of opt.variants) {
  await page.evaluate(() => window.__labApi.reset());
  await page.evaluate((p) => window.__labApi.set(p), v);
  const s = await page.evaluate(() => window.__labApi.score());
  results.push({ variant: v, deltaE: +s.deltaE.toFixed(3), mad: +s.mad.toFixed(2), grid: s.grid.map((x) => +x.toFixed(1)) });
}
for (const r of results) {
  console.log(`ΔE ${r.deltaE.toFixed(3)}  |Δ| ${r.mad.toFixed(2)}  ${JSON.stringify(r.variant)}`);
  for (let row = 0; row < 4; row++) console.log('   ' + r.grid.slice(row * 8, row * 8 + 8).map((x) => x.toFixed(1).padStart(5)).join(''));
}
if (opt.save) {
  const data = await page.evaluate(() => window.__lab.gl.domElement.toDataURL('image/png'));
  await fs.writeFile(opt.save, Buffer.from(data.split(',')[1], 'base64'));
  console.log(`saved ${opt.save}`);
}
await browser.close();
