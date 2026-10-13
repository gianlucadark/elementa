import * as THREE from 'three';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { BloomEffect, EffectComposer, EffectPass, KernelSize, RenderPass } from 'postprocessing';
import { DofPass, type DofState } from './DofPass';
import { loadViewLut, ViewTransformEffect } from '../ViewTransformEffect';
import { SCENE_URL, type SceneMeta } from '../meta';

/** Values the lab (and later the art direction) can override; defaults come from meta.json. */
export interface Look {
  exposure: number;
  bloomIntensity: number;
  bloomRadius: number;
  bloomThreshold: number;
  vignette: boolean;
  lens: boolean;
  dof: boolean;
  /** Not post-processing, but a quality switch of the same kind: table mirror reflection. */
  reflection: boolean;
}

export function defaultLook(meta: SceneMeta, exposure: number): Look {
  const b = meta.compositor.bloom;
  return {
    exposure,
    bloomThreshold: b?.Threshold ?? 1.2,
    // Blender's Glare "Strength" mixes the glare in; postprocessing's intensity is a gain on its
    // mip chain. Calibrated with scripts/lab-score.mjs on Camera_Desktop: best at ~2.7x Strength
    bloomIntensity: (b?.Strength ?? 0.22) * 2.7,
    bloomRadius: b?.Size ?? 0.6,
    vignette: true,
    // Measured: the Cycles renders match best with no distortion at all (any k or fit scale raised
    // ΔE), so Blender's -0.004 is effectively invisible. Kept as an option, off by default.
    lens: false,
    dof: true,
    reflection: true,
  };
}

/**
 * Blender's order: render (with DOF, Cycles does it in camera) -> Glare -> Lens Distortion ->
 * vignette -> view transform. Everything stays scene-linear in half float until the LUT.
 * Renders at priority 1, so R3F's own render is replaced by the composer.
 */
export interface PostQuality {
  multisampling: number;
  dofTaps: number;
}

export function PostPipeline({
  meta,
  look,
  dof,
  quality = { multisampling: 4, dofTaps: 48 },
}: {
  meta: SceneMeta;
  look: Look;
  dof: DofState;
  quality?: PostQuality;
}) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const [lut, setLut] = useState<THREE.Data3DTexture | null>(null);
  const lutMeta = meta.colorManagement.lut;

  useEffect(() => {
    let alive = true;
    loadViewLut(`${SCENE_URL}/${lutMeta.file}`, lutMeta.size).then((t) => alive && setLut(t));
    return () => {
      alive = false;
    };
  }, [lutMeta]);

  const pipeline = useMemo(() => {
    if (!lut) return null;
    const composer = new EffectComposer(gl, { frameBufferType: THREE.HalfFloatType, multisampling: quality.multisampling });
    const dofPass = new DofPass(camera, dof, quality.dofTaps);
    const bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: look.bloomThreshold,
      luminanceSmoothing: 0.05,
      intensity: look.bloomIntensity,
      radius: look.bloomRadius,
      kernelSize: KernelSize.LARGE,
    });
    const vig = meta.compositor.vignette;
    const lens = meta.compositor.lensDistortion;
    const view = new ViewTransformEffect({
      lut,
      lutSize: lutMeta.size,
      lutRange: lutMeta.log2Range,
      exposure: look.exposure,
      vignette: vig && {
        radius: [vig.ellipse[0] / 2, vig.ellipse[1] / 2],
        softness: vig.blurPx[0] / 1920, // Blender blurs the mask by blurPx on the 1920 px frame
        amount: look.vignette ? vig.amount : 0,
      },
      lens: look.lens && lens ? { distortion: lens.Distortion, dispersion: lens.Dispersion, fit: true } : undefined,
    });
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(dofPass);
    composer.addPass(new EffectPass(camera, bloom));
    composer.addPass(new EffectPass(camera, view));
    const result = { composer, dofPass, bloom, view };
    if (import.meta.env.DEV) (window as unknown as { __post: unknown }).__post = result; // inspection
    return result;
    // look values that need a rebuild are listed; the rest is applied in place below
  }, [lut, gl, scene, camera, meta, lutMeta, look.vignette, look.lens, quality.multisampling, quality.dofTaps]);

  useEffect(() => () => pipeline?.composer.dispose(), [pipeline]);

  useLayoutEffect(() => {
    pipeline?.composer.setSize(size.width, size.height);
  }, [pipeline, size]);

  useEffect(() => {
    if (!pipeline) return;
    pipeline.view.exposure = look.exposure;
    pipeline.bloom.intensity = look.bloomIntensity;
    pipeline.bloom.luminanceMaterial.threshold = look.bloomThreshold;
    pipeline.bloom.mipmapBlurPass.radius = look.bloomRadius;
  }, [pipeline, look.exposure, look.bloomIntensity, look.bloomThreshold, look.bloomRadius]);

  useFrame((_, delta) => {
    if (!pipeline) return;
    dof.enabled = look.dof;
    pipeline.composer.render(delta);
  }, 1);

  return null;
}
