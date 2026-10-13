import type { BlenderCamera } from './blenderCamera';
import type { GroupMeta } from './bakedMaterials';

/** Shape of public/scene/meta.json (written by export_web.py, paths rewritten by optimize.mjs). */
export interface SceneMeta {
  version: number;
  bake: { scale: number; samples: number; date: string };
  colorManagement: {
    view: string;
    look: string;
    exposure: number;
    gamma: number;
    lut: { file: string; size: number; log2Range: [number, number]; middleGrey: number };
  };
  compositor: {
    bloom?: { Threshold: number; Strength: number; Size: number };
    lensDistortion?: { Distortion: number; Dispersion: number };
    vignette?: { ellipse: [number, number]; blurPx: [number, number]; amount: number };
  };
  groups: Record<string, GroupMeta & { res: number }>;
  materials: Record<string, MaterialMeta>;
  cameras: Record<string, BlenderCamera>;
  lights: LightMeta[];
  candle: {
    light: string;
    flame: string;
    energyRange: [number, number];
    jitter: number;
    flameHeight: number;
    flameTop: [number, number, number] | null;
    lightPosition: [number, number, number] | null;
  };
  env?: { file: string; position: [number, number, number]; visibleLights?: string[] };
  envGlass?: { file: string; position: [number, number, number]; visibleLights?: string[] };
  tiers: Record<string, { scale: number }>;
}

export interface MaterialMeta {
  class: 'lm' | 'unlit' | 'glassbaked' | 'glass' | 'metal' | 'flame';
  group?: string;
  color?: [number, number, number] | null;
  roughness?: number | null;
  ior?: number | null;
  metallic?: number | null;
  anisotropy?: number;
  absorption?: { color: [number, number, number]; density: number };
}

export interface LightMeta {
  name: string;
  type: 'POINT' | 'SPOT' | 'AREA' | 'SUN';
  position: [number, number, number];
  direction: [number, number, number];
  color: [number, number, number];
  energy: number;
  radius?: number;
  size?: [number, number];
  spread?: number;
  spotSize?: number;
  spotBlend?: number;
}

export type Tier = 'desktop' | 'mobile';
export const SCENE_URL = '/scene';
