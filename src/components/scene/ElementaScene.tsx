import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import {
  clampedPhysical,
  createBakedGlassMaterial,
  createCandleUniforms,
  createLightmappedMaterial,
  createThinGlassMaterial,
  createUnlitMaterial,
  prepareBakedTexture,
  type PlanarUniforms,
} from './bakedMaterials';
import { createFlameMaterial } from './flameMaterial';
import { PlanarReflection } from './planarReflection';
import { SCENE_URL, type LightMeta, type MaterialMeta, type SceneMeta, type Tier } from './meta';

/**
 * Cycles -> three light units (measured, see blender/LEGGIMI.md): a white Lambertian plane under a sun of
 * strength 1 renders 1/pi in both engines, so point/spot intensity in three = watts / (4 pi).
 */
const wattsToCandela = (w: number) => w / (4 * Math.PI);

function linear(c: [number, number, number] | null | undefined, fallback: [number, number, number] = [1, 1, 1]) {
  const [r, g, b] = c ?? fallback;
  return new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);
}

function glassMaterial(m: MaterialMeta, envMap: THREE.Texture) {
  return createThinGlassMaterial({ color: linear(m.color), roughness: m.roughness ?? 0, envMap });
}

function metalMaterial(m: MaterialMeta, envMap: THREE.Texture) {
  return clampedPhysical({
    color: linear(m.color),
    metalness: 1,
    roughness: m.roughness ?? 0.3,
    envMap,
  });
}

/**
 * The only real-time light. Every other light reaches the materials through the bake (diffuse) and the
 * reflection probes (specular), where Cycles itself drew them with their size and light linking.
 * The candle stays live because it flickers and sits millimetres from the glass: no probe can place it.
 */
function CandleLight({ light, lightRef }: { light: LightMeta; lightRef: React.RefObject<THREE.PointLight | null> }) {
  return (
    <pointLight
      ref={lightRef}
      position={light.position}
      color={linear(light.color)}
      intensity={wattsToCandela(light.energy)}
      decay={2}
      distance={0}
    />
  );
}

/** Smooth pseudo-random flicker in [-1, 1] (sum of incommensurate sines + a slow wobble). */
function flickerNoise(t: number) {
  return (
    0.5 * Math.sin(t * 7.3) * Math.sin(t * 2.1 + 1.3) +
    0.3 * Math.sin(t * 13.7 + 0.7) +
    0.2 * Math.sin(t * 23.1 + 2.9) * Math.sin(t * 0.9)
  );
}

export interface ElementaSceneProps {
  meta: SceneMeta;
  tier: Tier;
  flicker?: boolean;
  /** Real-time mirror reflection on the lacquered table top (one extra half-res scene render). */
  reflection?: boolean;
}

// table top height (build_scene.py TABLE_Z), Y-up
const TABLE_TOP = 0.76;

export function ElementaScene({ meta, tier, flicker = true, reflection = true }: ElementaSceneProps) {
  const gltf = useGLTF(`${SCENE_URL}/elementa.glb`, false, true);
  const gl = useThree((s) => s.gl);

  const groupNames = Object.keys(meta.groups);
  const texUrls = groupNames.flatMap((g) => {
    const info = meta.groups[g];
    return [info.radiance, info.surface].filter(Boolean).map((f) => `${SCENE_URL}/${tier}/${f}`);
  });
  const textures = useLoader(THREE.TextureLoader, texUrls);
  // env: no rim light (table, fabrics); envGlass: every light (glass, metal) - Blender's light linking
  const [env, envGlass] = useLoader(EXRLoader, [
    `${SCENE_URL}/${meta.env?.file ?? 'env.exr'}`,
    `${SCENE_URL}/${meta.envGlass?.file ?? meta.env?.file ?? 'env.exr'}`,
  ]);

  const candle = useMemo(() => createCandleUniforms(), []);
  const planar = useMemo(() => new PlanarReflection(TABLE_TOP), []);
  const planarUniforms = useMemo<PlanarUniforms>(
    () => ({
      planarMap: { value: planar.target.texture },
      planarMatrix: { value: planar.textureMatrix },
      planarHeight: { value: TABLE_TOP },
      planarLod: { value: 48 },
      planarEnabled: { value: 1 },
    }),
    [planar],
  );
  const tableMesh = useRef<THREE.Object3D | null>(null);
  const candleMeta = meta.lights.find((l) => l.name === meta.candle.light)!;
  const candleLight = useRef<THREE.PointLight>(null);
  const flame = useRef<THREE.Object3D | null>(null);
  const flameMat = useMemo(() => createFlameMaterial(meta.candle.flameHeight), [meta]);

  useMemo(() => {
    env.mapping = envGlass.mapping = THREE.EquirectangularReflectionMapping;
    const aniso = Math.min(8, gl.capabilities.getMaxAnisotropy());
    const tex: Record<string, THREE.Texture> = {};
    texUrls.forEach((u, i) => {
      const file = u.split('/').pop()!;
      tex[file] = prepareBakedTexture(textures[i], aniso);
    });
    if (meta.candle.lightPosition) candle.candlePosition.value.set(...meta.candle.lightPosition);

    const cache: Record<string, THREE.Material> = {};
    const materialFor = (name: string): THREE.Material | null => {
      if (cache[name]) return cache[name];
      const m = meta.materials[name];
      if (!m) return null;
      let mat: THREE.Material;
      if (m.class === 'lm' || m.class === 'unlit' || m.class === 'glassbaked') {
        const g = meta.groups[m.group!];
        const rad = tex[g.radiance];
        mat =
          m.class === 'lm'
            ? createLightmappedMaterial(g, rad, tex[g.surface!], env, candle, m.group === 'table' ? planarUniforms : undefined)
            : m.class === 'glassbaked'
              ? createBakedGlassMaterial(g, rad, envGlass)
              : createUnlitMaterial(g, rad);
      } else if (m.class === 'glass') mat = glassMaterial(m, envGlass);
      // metal reflects the probe without the rim light: measured better on Camera_Mobile (the rim's
      // reflection, misplaced by the probe's parallax, flared on the cutlery)
      else if (m.class === 'metal') mat = metalMaterial(m, env);
      else mat = flameMat;
      mat.name = name;
      return (cache[name] = mat);
    };

    gltf.scene.traverse((o) => {
      if (o.name === meta.candle.flame) flame.current = o;
      if (o.name === 'G_table') tableMesh.current = o;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.material as THREE.Material;
      const mat = materialFor(src.name);
      if (!mat) {
        console.warn(`[elementa] no material mapping for ${src.name} (${mesh.name})`);
        return;
      }
      mesh.material = mat;
      // see-through glass after the opaque pass; the flame last, additively
      if (mat.transparent && mat !== flameMat) mesh.renderOrder = 1;
      if (mat === flameMat) mesh.renderOrder = 2;
    });
  }, [gltf, textures, env, envGlass, meta, gl, candle, flameMat, planarUniforms]);

  // before the composer (priority 1): the table material samples this frame's reflection
  useFrame(({ gl: renderer, scene, camera }) => {
    planarUniforms.planarEnabled.value = reflection ? 1 : 0;
    if (!reflection || !tableMesh.current) return;
    planar.update(renderer, scene, camera as THREE.PerspectiveCamera, [tableMesh.current]);
  });

  const flameBase = useRef<THREE.Vector3 | null>(null);
  useFrame(({ clock }) => {
    const [lo, hi] = meta.candle.energyRange;
    const mid = (lo + hi) / 2;
    const n = flicker ? flickerNoise(clock.elapsedTime) : 0;
    const ratio = (mid + ((hi - lo) / 2) * n) / mid; // 1 = as baked
    candle.candleFlicker.value = ratio;
    flameMat.uniforms.flicker.value = 0.85 + 0.15 * ratio;
    const light = candleLight.current;
    if (light) light.intensity = wattsToCandela(candleMeta.energy) * ratio;
    const f = flame.current;
    if (f) {
      flameBase.current ??= f.position.clone();
      const j = flicker ? meta.candle.jitter : 0;
      const t = clock.elapsedTime;
      f.position.set(
        flameBase.current.x + j * Math.sin(t * 9.1) * Math.sin(t * 3.3),
        flameBase.current.y,
        flameBase.current.z + j * Math.sin(t * 7.7 + 1.1),
      );
    }
  });

  useEffect(() => () => flameMat.dispose(), [flameMat]);
  useEffect(() => () => planar.dispose(), [planar]);

  return (
    <>
      <primitive object={gltf.scene} />
      <CandleLight light={candleMeta} lightRef={candleLight} />
    </>
  );
}
