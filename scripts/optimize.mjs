// Takes the raw export of blender/scripts/export_web.py (blender/bake/export) and writes the
// web-ready scene into public/scene, plus the Cycles posters into public/posters.
//
//   node scripts/optimize.mjs
//
// public/scene/
//   elementa.glb            meshopt-compressed geometry (shared by every tier)
//   env.exr, env_glass.exr  reflection probes (without / with the rim light, see export_web.py)
//   desktop/*.webp          atlases at bake resolution
//   mobile/*.webp           atlases at half resolution
//   meta.json               meta.json from Blender, texture paths rewritten per tier
import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, weld, quantize } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(WEB, '../blender/bake/export');
const RENDERS = path.resolve(WEB, '../renders');
const DST = path.join(WEB, 'public/scene');
const POSTERS = path.join(WEB, 'public/posters');

const TIERS = { desktop: 1, mobile: 0.5 };
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

async function size(file) {
  return (await fs.stat(file)).size;
}

async function textures(meta) {
  const out = {};
  for (const [tier, scale] of Object.entries(TIERS)) {
    await fs.mkdir(path.join(DST, tier), { recursive: true });
    for (const [g, info] of Object.entries(meta.groups)) {
      for (const key of ['radiance', 'surface']) {
        if (!info[key]) continue;
        const src = path.join(SRC, info[key]);
        const name = `${g}_${key}.webp`;
        const dst = path.join(DST, tier, name);
        const res = Math.round(info.res * scale);
        // radiance carries the lighting: keep it near-lossless to avoid banding in the dark tones
        const quality = key === 'radiance' ? 95 : 85;
        await sharp(src)
          .resize(res, res, { kernel: 'lanczos3' })
          // radiance alpha is soft AO (lossy is fine) except tableware, where it is the doily cutout
          .webp({ quality, alphaQuality: key === 'radiance' && !info.alphaTest ? 70 : 100, smartSubsample: true, effort: 6 })
          .toFile(dst);
        out[`${tier}/${name}`] = await size(dst);
      }
    }
  }
  return out;
}

async function geometry() {
  await MeshoptEncoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(path.join(SRC, 'elementa.glb'));
  await doc.transform(
    // materials are placeholders told apart only by name (the viewer builds them from meta.json):
    // deduplicating them would merge every one into the first
    dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH, PropertyType.TEXTURE] }),
    weld(),
    // keep TEXCOORD_0: it is the bake atlas UV, read by the viewer's materials, not by glTF textures
    prune({ keepAttributes: true }),
    // lightmap UVs need more precision than the default 12 bits on 2K atlases
    quantize({ quantizeTexcoord: 14, quantizeNormal: 10, quantizePosition: 14 }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  const dst = path.join(DST, 'elementa.glb');
  await io.write(dst, doc);
  return size(dst);
}

async function posters() {
  await fs.mkdir(POSTERS, { recursive: true });
  const shots = [
    ['01_Hero_Desktop.png', 'hero-desktop', 1920],
    ['03_Hero_Mobile.png', 'hero-mobile', 1080],
    ['04_Detail_CloseUp.png', 'detail', 1920],
    ['02_Hero_Desktop_Alt.png', 'hero-evening', 1920],
  ];
  const out = {};
  for (const [file, name, width] of shots) {
    const src = path.join(RENDERS, file);
    try {
      await fs.access(src);
    } catch {
      continue;
    }
    for (const [ext, opts] of [['avif', { quality: 60, effort: 6 }], ['webp', { quality: 82, effort: 6 }]]) {
      const dst = path.join(POSTERS, `${name}.${ext}`);
      await sharp(src).resize({ width })[ext](opts).toFile(dst);
      out[`${name}.${ext}`] = await size(dst);
    }
  }
  return out;
}

async function main() {
  const meta = JSON.parse(await fs.readFile(path.join(SRC, 'meta.json'), 'utf8'));
  await fs.rm(DST, { recursive: true, force: true });
  await fs.mkdir(DST, { recursive: true });

  const tex = await textures(meta);
  const glb = await geometry();
  let env = 0;
  for (const probe of [meta.env, meta.envGlass].filter(Boolean)) {
    await fs.copyFile(path.join(SRC, probe.file), path.join(DST, probe.file));
    env += await size(path.join(DST, probe.file));
  }
  const lut = meta.colorManagement?.lut;
  if (lut) await fs.copyFile(path.join(SRC, lut.file), path.join(DST, lut.file));
  const post = await posters();
  // detect-gpu benchmarks served by the site instead of unpkg.com (no third-party request)
  await fs.cp(path.join(WEB, 'node_modules/detect-gpu/dist/benchmarks'), path.join(WEB, 'public/gpu-benchmarks'), { recursive: true });

  // texture paths become tier-relative: the viewer prefixes /scene/<tier>/
  for (const [g, info] of Object.entries(meta.groups)) {
    if (info.radiance) info.radiance = `${g}_radiance.webp`;
    if (info.surface) info.surface = `${g}_surface.webp`;
  }
  meta.tiers = Object.fromEntries(Object.entries(TIERS).map(([t, s]) => [t, { scale: s }]));
  await fs.writeFile(path.join(DST, 'meta.json'), JSON.stringify(meta, null, 2));

  console.log(`glb      ${kb(glb)}`);
  console.log(`env      ${kb(env)}`);
  for (const tier of Object.keys(TIERS)) {
    const files = Object.entries(tex).filter(([k]) => k.startsWith(tier));
    const total = files.reduce((a, [, v]) => a + v, 0);
    console.log(`${tier.padEnd(8)} ${kb(total)} textures, ${kb(total + glb + env)} total`);
    for (const [k, v] of files) console.log(`  ${k.padEnd(32)} ${kb(v)}`);
  }
  for (const [k, v] of Object.entries(post)) console.log(`poster   ${k.padEnd(24)} ${kb(v)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
