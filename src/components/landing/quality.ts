import { getGPUTier } from 'detect-gpu';
import type { Tier } from '../scene/meta';

export interface Quality {
  tier: Tier; // texture set
  dpr: number;
  reflection: boolean;
  multisampling: number;
  dofTaps: number;
}

const DESKTOP: Quality = { tier: 'desktop', dpr: 1.5, reflection: true, multisampling: 4, dofTaps: 48 };
const MOBILE: Quality = { tier: 'mobile', dpr: 1, reflection: false, multisampling: 0, dofTaps: 24 };

function hasWebGL2() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

/**
 * null = text-only hero (no WebGL2, data saver, or a GPU detect-gpu rates 0).
 * Benchmarks are served by the site (public/gpu-benchmarks), not fetched from unpkg.
 */
export async function chooseQuality(): Promise<Quality | null> {
  if (!hasWebGL2()) return null;
  const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
  if (nav.connection?.saveData) return null;
  let tier = 2;
  let mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  try {
    const gpu = await getGPUTier({ benchmarksURL: '/gpu-benchmarks' });
    tier = gpu.tier;
    mobile = !!gpu.isMobile || mobile;
  } catch {
    // unknown GPU: decide from the device class only
  }
  if (tier === 0) return null;
  if (mobile || tier === 1) return { ...MOBILE };
  return { ...DESKTOP, dpr: Math.min(window.devicePixelRatio || 1, DESKTOP.dpr) };
}

/** One step down when the frame rate does not hold (PerformanceMonitor). */
export function degrade(q: Quality): Quality {
  if (q.reflection) return { ...q, reflection: false };
  if (q.dpr > 1) return { ...q, dpr: 1 };
  if (q.multisampling > 0) return { ...q, multisampling: 0 };
  if (q.dofTaps > 24) return { ...q, dofTaps: 24 };
  if (q.dpr > 0.75) return { ...q, dpr: 0.75 };
  return q;
}
