import * as THREE from 'three';
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree, type RootState } from '@react-three/fiber';
import { ElementaScene } from '../scene/ElementaScene';
import { PostPipeline, defaultLook, type Look } from '../scene/post/PostPipeline';
import type { DofState } from '../scene/post/DofPass';
import { applyBlenderCamera } from '../scene/blenderCamera';
import { SCENE_URL, type SceneMeta, type Tier } from '../scene/meta';

/**
 * Fidelity bench: the WebGL frame locked to a Blender camera at the render's exact resolution,
 * overlaid on the Cycles render. Slider, difference blend, a numeric score (mean |Δ| and CIE76 ΔE on
 * a downsampled frame) and a ΔE grid that says where the error is.
 *
 * window.__labApi (page context) drives it from the console for automated sweeps:
 *   await __labApi.set({ bloomIntensity: 1.2 }); await __labApi.score()
 */

const SHOTS = {
  Camera_Desktop: { poster: '/posters/hero-desktop.webp', size: [1920, 1080] },
  Camera_Detail: { poster: '/posters/detail.webp', size: [1920, 1080] },
  Camera_Mobile: { poster: '/posters/hero-mobile.webp', size: [1080, 1920] },
} as const;
type Shot = keyof typeof SHOTS;
const GRID = [8, 4] as const;

interface Score {
  mad: number;
  deltaE: number;
  grid: number[]; // row-major ΔE per cell, GRID[0] x GRID[1]
}

function LockedCamera({ meta, shot }: { meta: SceneMeta; shot: Shot }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  useLayoutEffect(() => {
    applyBlenderCamera(camera, meta.cameras[shot], size.width / size.height);
  }, [camera, meta, shot, size]);
  return null;
}

function srgbToLinear(c: number) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function toLab(r: number, g: number, b: number) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

async function score(canvas: HTMLCanvasElement, posterUrl: string): Promise<Score> {
  const w = 480;
  const h = Math.round((w * canvas.height) / canvas.width);
  const read = (src: CanvasImageSource) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(src, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  };
  const img = new Image();
  img.src = posterUrl;
  await img.decode();
  const a = read(canvas);
  const b = read(img);
  let mad = 0, de = 0;
  const grid = new Array(GRID[0] * GRID[1]).fill(0);
  const count = new Array(GRID[0] * GRID[1]).fill(0);
  for (let i = 0; i < a.length; i += 4) {
    mad += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    const p = toLab(a[i], a[i + 1], a[i + 2]);
    const q = toLab(b[i], b[i + 1], b[i + 2]);
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    de += d;
    const px = (i / 4) % w, py = Math.floor(i / 4 / w);
    const cell = Math.floor((py / h) * GRID[1]) * GRID[0] + Math.floor((px / w) * GRID[0]);
    grid[cell] += d;
    count[cell]++;
  }
  const n = a.length / 4;
  return { mad: mad / n, deltaE: de / n, grid: grid.map((v, i) => v / count[i]) };
}

/**
 * Renders n frames. rAF stops while the page is hidden (e.g. a background tab), so frames are
 * pushed through R3F's advance() instead: measurements work whether or not anyone is watching.
 */
let r3f: RootState | null = null;
const nextFrames = async (n = 3) => {
  for (let i = 0; i < n; i++) {
    if (r3f) r3f.advance(performance.now());
    await new Promise((r) => setTimeout(r, 0));
  }
};

export default function Lab() {
  const [meta, setMeta] = useState<SceneMeta | null>(null);
  const [shot, setShot] = useState<Shot>('Camera_Desktop');
  const [tier, setTier] = useState<Tier>('desktop');
  const [split, setSplit] = useState(50);
  const [mode, setMode] = useState<'split' | 'difference' | 'webgl' | 'cycles'>('split');
  const [look, setLook] = useState<Look | null>(null);
  const [flicker, setFlicker] = useState(false);
  const [post, setPost] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [result, setResult] = useState<Score | null>(null);
  const [scale, setScale] = useState(0.5);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    fetch(`${SCENE_URL}/meta.json`).then((r) => r.json()).then(setMeta);
  }, []);

  const cam = meta?.cameras[shot];
  useEffect(() => {
    if (meta && cam) setLook(defaultLook(meta, cam.exposure ?? meta.colorManagement.exposure));
  }, [meta, cam]);

  const dof = useMemo<DofState | null>(
    () =>
      cam
        ? { enabled: true, lens: cam.lens, fstop: cam.fstop, sensorWidth: cam.sensorWidth, focusDistance: cam.focusDistance }
        : null,
    [cam],
  );

  const [w, h] = SHOTS[shot].size;
  useEffect(() => {
    const fit = () => setScale(Math.min(1, (window.innerWidth - 32) / w, (window.innerHeight - 160) / h));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [w, h]);

  const poster = SHOTS[shot].poster;
  const measure = async () => {
    await nextFrames(4);
    const s = await score((r3f?.gl.domElement ?? canvasRef.current)!, poster);
    setResult(s);
    return s;
  };

  // console API for automated sweeps (page context)
  useEffect(() => {
    (window as unknown as { __labApi: unknown }).__labApi = {
      set: async (p: Partial<Look>) => {
        setLook((l) => (l ? { ...l, ...p } : l));
        await nextFrames(6);
      },
      reset: async () => {
        if (meta && cam) setLook(defaultLook(meta, cam.exposure ?? meta.colorManagement.exposure));
        await nextFrames(6);
      },
      look: () => look,
      score: measure,
      shot: async (s: Shot) => {
        setShot(s);
        await new Promise((r) => setTimeout(r, 4000));
      },
    };
  });

  if (!meta || !look || !dof) return <p style={{ color: '#ccc', padding: 16 }}>Carico meta.json…</p>;
  const set = (p: Partial<Look>) => setLook({ ...look, ...p });
  const knob = (label: string, key: keyof Look, min: number, max: number, step: number) => (
    <label>
      {label} {(look[key] as number).toFixed(2)}
      <input type="range" min={min} max={max} step={step} value={look[key] as number} onChange={(e) => set({ [key]: +e.target.value })} />
    </label>
  );
  const toggle = (label: string, key: keyof Look) => (
    <label>
      <input type="checkbox" checked={look[key] as boolean} onChange={(e) => set({ [key]: e.target.checked })} /> {label}
    </label>
  );
  const maxCell = result ? Math.max(...result.grid) : 1;

  return (
    <div className="lab">
      <div className="bar">
        <select value={shot} onChange={(e) => setShot(e.target.value as Shot)}>
          {Object.keys(SHOTS).map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select value={tier} onChange={(e) => setTier(e.target.value as Tier)}>
          <option>desktop</option>
          <option>mobile</option>
        </select>
        <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="split">slider</option>
          <option value="difference">differenza</option>
          <option value="webgl">solo WebGL</option>
          <option value="cycles">solo Cycles</option>
        </select>
        {knob('esposizione', 'exposure', -1, 2, 0.05)}
        {knob('bloom', 'bloomIntensity', 0, 4, 0.05)}
        {knob('raggio', 'bloomRadius', 0, 1, 0.01)}
        {knob('soglia', 'bloomThreshold', 0, 4, 0.05)}
      </div>
      <div className="bar">
        {toggle('DOF', 'dof')}
        {toggle('lente', 'lens')}
        {toggle('vignetta', 'vignette')}
        {toggle('riflesso tavolo', 'reflection')}
        <label>
          <input type="checkbox" checked={post} onChange={(e) => setPost(e.target.checked)} /> post
        </label>
        <label>
          <input type="checkbox" checked={flicker} onChange={(e) => setFlicker(e.target.checked)} /> fiamma viva
        </label>
        <label>
          <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> griglia ΔE
        </label>
        <button onClick={measure}>Misura</button>
        {result && (
          <span>
            |Δ| medio {result.mad.toFixed(2)} / 255 · ΔE medio <b>{result.deltaE.toFixed(2)}</b>
          </span>
        )}
        <span className="info">
          bake {meta.bake.date} · scala {meta.bake.scale} · {meta.bake.samples} spp
        </span>
      </div>
      <div className="stage" style={{ width: w * scale, height: h * scale }}>
        <div className="frame" style={{ width: w, height: h, transform: `scale(${scale})` }}>
          <Canvas
            key={`${shot}-${tier}`}
            dpr={1}
            resize={{ offsetSize: true }}
            camera={{ near: 0.05, far: 30 }}
            gl={{ preserveDrawingBuffer: true, antialias: false, toneMapping: THREE.NoToneMapping }}
            onCreated={(state) => {
              canvasRef.current = state.gl.domElement;
              r3f = state;
              (window as unknown as { __lab: unknown }).__lab = state; // inspection from the console
            }}
            style={{ visibility: mode === 'cycles' ? 'hidden' : 'visible' }}
          >
            <Suspense fallback={null}>
              <LockedCamera meta={meta} shot={shot} />
              <ElementaScene meta={meta} tier={tier} flicker={flicker} reflection={look.reflection} />
              {post && <PostPipeline meta={meta} look={look} dof={dof} />}
            </Suspense>
          </Canvas>
          {mode !== 'webgl' && (
            <img
              src={poster}
              alt=""
              className="poster"
              style={{
                clipPath: mode === 'split' ? `inset(0 0 0 ${split}%)` : undefined,
                mixBlendMode: mode === 'difference' ? 'difference' : undefined,
              }}
            />
          )}
          {mode === 'split' && <div className="divider" style={{ left: `${split}%` }} />}
          {result && showGrid && (
            <div className="grid" style={{ gridTemplateColumns: `repeat(${GRID[0]}, 1fr)` }}>
              {result.grid.map((v, i) => (
                <div key={i} style={{ background: `rgba(255, 60, 40, ${(0.45 * v) / maxCell})` }}>
                  {v.toFixed(1)}
                </div>
              ))}
            </div>
          )}
        </div>
        {mode === 'split' && (
          <input
            className="splitter"
            type="range"
            min={0}
            max={100}
            step={0.1}
            value={split}
            onChange={(e) => setSplit(+e.target.value)}
            aria-label="Confine WebGL / Cycles"
          />
        )}
      </div>
      <p className="legend">Sinistra: WebGL · Destra: Cycles · griglia: ΔE medio per zona</p>
    </div>
  );
}
