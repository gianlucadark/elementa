import * as THREE from 'three';
import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ElementaScene } from '../scene/ElementaScene';
import { PostPipeline, defaultLook } from '../scene/post/PostPipeline';
import type { DofState } from '../scene/post/DofPass';
import { CameraPath } from '../scene/cameraPath';
import { setBlenderProjection } from '../scene/blenderCamera';
import { SCENE_URL, type SceneMeta } from '../scene/meta';
import { chooseQuality, degrade, type Quality } from './quality';

gsap.registerPlugin(ScrollTrigger);

/**
 * A contained editorial scene, driven by #scrolly and ending before the menu.
 * The editorial loader stays visible until the scene has rendered its first frames.
 * Unsupported devices get a text-only hero, never a substitute scene image.
 */

interface Input {
  progress: number; // scroll target, 0..1 over #scrolly
  px: number; // pointer / tilt, -1..1
  py: number;
}

const PARALLAX = { x: 0.035, y: 0.02 }; // metres the camera slides off-axis at full deflection

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function Rig({
  path,
  input,
  dof,
  still,
  onFirstFrames,
  stage,
}: {
  path: CameraPath;
  input: React.RefObject<Input>;
  dof: DofState;
  /** prefers-reduced-motion: the camera stays on the hero shot, only the final fade remains */
  still: boolean;
  onFirstFrames: () => void;
  stage: React.RefObject<HTMLDivElement | null>;
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const setFrameloop = useThree((s) => s.setFrameloop);
  const smooth = useRef({ p: input.current.progress, x: 0, y: 0, frames: 0 });
  const tmp = useMemo(
    () => ({ fwd: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(), target: new THREE.Vector3(), m: new THREE.Matrix4() }),
    [],
  );

  useFrame((state, delta) => {
    const s = smooth.current;
    const k = 1 - Math.exp(-Math.min(delta, 0.1) * 6); // critically damped catch-up
    s.p += (input.current.progress - s.p) * k;
    s.x += (input.current.px - s.x) * k;
    s.y += (input.current.py - s.y) * k;

    const aspect = state.size.width / state.size.height;
    const pose = path.at(still ? 0 : s.p, aspect);

    // parallax: slide off-axis and re-aim at the focus point, so depth separates as with a real move
    tmp.fwd.set(0, 0, -1).applyQuaternion(pose.quaternion);
    tmp.right.set(1, 0, 0).applyQuaternion(pose.quaternion);
    tmp.up.set(0, 1, 0).applyQuaternion(pose.quaternion);
    tmp.target.copy(pose.position).addScaledVector(tmp.fwd, pose.focusDistance);
    camera.position
      .copy(pose.position)
      .addScaledVector(tmp.right, s.x * PARALLAX.x)
      .addScaledVector(tmp.up, -s.y * PARALLAX.y);
    tmp.m.lookAt(camera.position, tmp.target, tmp.up);
    camera.quaternion.setFromRotationMatrix(tmp.m);
    camera.updateMatrixWorld();
    setBlenderProjection(camera, pose.lens, pose.sensorWidth, pose.shiftX, pose.shiftY, aspect);

    dof.lens = pose.lens;
    dof.fstop = pose.fstop;
    dof.sensorWidth = pose.sensorWidth;
    dof.focusDistance = camera.position.distanceTo(tmp.target);

    if (++s.frames === 4) onFirstFrames();
  }, -1);

  // Pause GPU work outside the frame or in a hidden tab; resume on return.
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    let visible = true;
    const sync = () => setFrameloop(visible && !document.hidden ? 'always' : 'never');
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', sync);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', sync);
    };
  }, [setFrameloop, stage]);

  return null;
}

class Boundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    console.warn('[elementa] 3D disabled:', e);
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function Experience() {
  const [meta, setMeta] = useState<SceneMeta | null>(null);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [failed, setFailed] = useState(false);
  const [needsTiltPermission, setNeedsTiltPermission] = useState(false);
  const input = useRef<Input>({ progress: 0, px: 0, py: 0 });
  const stage = useRef<HTMLDivElement>(null);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tiltHandler = useRef<((e: DeviceOrientationEvent) => void) | null>(null);
  const still = useMemo(() => typeof window !== 'undefined' && reducedMotion(), []);

  // Start immediately; the server-rendered loader already covers the frame.
  useEffect(() => {
    let alive = true;
    document.documentElement.dataset.webgl = 'loading';
    loadTimer.current = setTimeout(() => { if (alive) setFailed(true); }, 30000);
    const start = async () => {
      try {
        const q = await chooseQuality();
        if (!alive) return;
        if (!q) return setFailed(true);
        const response = await fetch(`${SCENE_URL}/meta.json`);
        if (!response.ok) throw new Error('Scene metadata unavailable');
        const m: SceneMeta = await response.json();
        if (!alive) return;
        setQuality(q);
        setMeta(m);
      } catch {
        if (alive) setFailed(true);
      }
    };
    void start();
    return () => {
      alive = false;
      if (loadTimer.current) clearTimeout(loadTimer.current);
    };
  }, [still]);

  // scroll progress over #scrolly
  useEffect(() => {
    const track = document.getElementById('scrolly');
    if (!track) return;
    const shell = track.querySelector<HTMLElement>('.scene-shell');
    if (!shell) return;
    const st = ScrollTrigger.create({
      trigger: track,
      start: () => `top ${parseFloat(getComputedStyle(shell).top) || 0}px`,
      end: () => `+=${Math.max(1, track.offsetHeight - shell.offsetHeight)}`,
      onUpdate: (self) => {
        input.current.progress = self.progress;
      },
      onRefresh: (self) => { input.current.progress = self.progress; },
    });
    input.current.progress = st.progress;
    const observer = new ResizeObserver(() => st.refresh());
    observer.observe(shell);
    return () => { observer.disconnect(); st.kill(); };
  }, []);

  // pointer parallax (desktop) and device tilt (phones)
  useEffect(() => {
    if (still) return;
    const frame = document.querySelector('.scene-frame');
    const onPointer = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const rect = frame?.getBoundingClientRect();
      if (!rect) return;
      input.current.px = Math.max(-1, Math.min(1, ((e.clientX - rect.left) / rect.width) * 2 - 1));
      input.current.py = Math.max(-1, Math.min(1, ((e.clientY - rect.top) / rect.height) * 2 - 1));
    };
    const resetPointer = () => { input.current.px = 0; input.current.py = 0; };
    let base: { b: number; g: number } | null = null;
    const onTilt = (e: DeviceOrientationEvent) => {
      if (e.beta == null || e.gamma == null) return;
      base ??= { b: e.beta, g: e.gamma };
      input.current.px = Math.max(-1, Math.min(1, (e.gamma - base.g) / 18));
      input.current.py = Math.max(-1, Math.min(1, (e.beta - base.b) / 18));
    };
    frame?.addEventListener('pointermove', onPointer as EventListener, { passive: true });
    frame?.addEventListener('pointerleave', resetPointer);
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> } | undefined;
    // only iOS asks for permission (and only after a tap); elsewhere the events just arrive
    const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    if (DOE?.requestPermission && iOS) setNeedsTiltPermission(true);
    else window.addEventListener('deviceorientation', onTilt);
    tiltHandler.current = onTilt;
    return () => {
      frame?.removeEventListener('pointermove', onPointer as EventListener);
      frame?.removeEventListener('pointerleave', resetPointer);
      window.removeEventListener('deviceorientation', onTilt);
      tiltHandler.current = null;
    };
  }, [still]);

  const enableTilt = async () => {
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    try {
      if ((await DOE.requestPermission?.()) === 'granted') {
        if (tiltHandler.current) window.addEventListener('deviceorientation', tiltHandler.current);
      }
    } finally {
      setNeedsTiltPermission(false);
    }
  };

  const path = useMemo(() => (meta ? new CameraPath(meta) : null), [meta]);
  const look = useMemo(() => (meta ? { ...defaultLook(meta, meta.colorManagement.exposure) } : null), [meta]);
  const dof = useMemo<DofState>(() => ({ enabled: true, lens: 44, fstop: 1.8, sensorWidth: 36, focusDistance: 2.2 }), []);

  useEffect(() => {
    if (failed) {
      if (loadTimer.current) clearTimeout(loadTimer.current);
      document.documentElement.dataset.webgl = 'off';
      window.dispatchEvent(new Event('elementa:scene'));
    }
  }, [failed]);

  if (failed || !meta || !quality || !path || !look) return null;

  return (
    <>
      <Boundary onError={() => setFailed(true)}><div ref={stage} className="experience" aria-hidden="true">
        <Canvas
          dpr={quality.dpr}
          camera={{ near: 0.05, far: 30 }}
          gl={{ antialias: false, toneMapping: THREE.NoToneMapping, powerPreference: 'high-performance', alpha: false }}
          onCreated={({ gl }) => {
            gl.domElement.addEventListener('webglcontextlost', (e) => {
              e.preventDefault();
              setFailed(true);
            });
          }}
        >
          <Boundary onError={() => setFailed(true)}>
            <Suspense fallback={null}>
              <PerformanceMonitor onDecline={() => setQuality((q) => (q ? degrade(q) : q))} flipflops={3}>
                <Rig
                  path={path}
                  input={input}
                  dof={dof}
                  still={still}
                  stage={stage}
                  onFirstFrames={() => {
                    if (loadTimer.current) clearTimeout(loadTimer.current);
                    document.documentElement.dataset.webgl = 'ready';
                    window.dispatchEvent(new Event('elementa:scene'));
                  }}
                />
                <ElementaScene meta={meta} tier={quality.tier} flicker={!still} reflection={quality.reflection} />
                <PostPipeline
                  meta={meta}
                  look={{ ...look, reflection: quality.reflection }}
                  dof={dof}
                  quality={{ multisampling: quality.multisampling, dofTaps: quality.dofTaps }}
                />
              </PerformanceMonitor>
            </Suspense>
          </Boundary>
        </Canvas>
      </div></Boundary>
      {needsTiltPermission && (
        <button className="tilt-toggle" type="button" onClick={enableTilt}>
          Attiva il movimento
        </button>
      )}
    </>
  );
}
