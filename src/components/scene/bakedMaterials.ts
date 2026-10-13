import * as THREE from 'three';

/**
 * Materials that read the Cycles bake (see blender/scripts/export_web.py).
 *
 * radiance texture: diffuse radiance (albedo x direct+indirect light), log-encoded per group
 *   e = log2(1 + radiance / s) / L, linear 8-bit  ->  radiance = s * (2^(e L) - 1)
 *   alpha = cutout (doilies)
 * surface texture (linear): R coat weight, G roughness, B coat roughness, A specular IOR level
 *
 * "lm" keeps three's physical BRDF for the specular part only: the base colour is black, so lights
 * and the environment add no diffuse (Cycles already did that) and the baked radiance goes in as
 * emission. Coat, roughness and specular level drive the real-time reflections.
 */

const DECODE = /* glsl */ `
vec3 decodeRadiance( vec3 e, vec2 enc ) {
  return enc.x * ( exp2( e * enc.y ) - 1.0 );
}
`;

/**
 * Half-float render targets overflow above 65504. A point light a few millimetres from a glossy
 * surface (the candle next to the bottle and the wax) exceeds that in three.js, which has no light
 * radius to soften the peak as Cycles does (6 mm). The resulting Inf turns into NaN in the bloom
 * mips and blacks out the frame, so every lit material clamps its output first.
 */
export const HDR_CLAMP = 2048.0;
const CLAMP_GLSL = `outgoingLight = min( outgoingLight, vec3( ${HDR_CLAMP.toFixed(1)} ) );
#include <opaque_fragment>`;

/**
 * The candle is the only real-time light and three's point lights have no size, while Cycles'
 * candle has a 6 mm radius. A spherical source widens the highlight it makes on glossy surfaces
 * (Karis 2013: alpha' = alpha + radius / (2 distance)); at the ~25 cm between candle and cutlery
 * that is a floor on the roughness the direct light sees. Indirect (probe) lighting is untouched.
 */
export const DIRECT_MIN_ROUGHNESS = { value: 0.22 };
if (import.meta.env.DEV) (globalThis as unknown as { __directMinRoughness: unknown }).__directMinRoughness = DIRECT_MIN_ROUGHNESS;

export function clampHdr(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.uniforms.directMinRoughness = DIRECT_MIN_ROUGHNESS;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float directMinRoughness;')
    .replace(
      '#include <lights_fragment_begin>',
      '#if defined( STANDARD )\nfloat surfaceRoughness = material.roughness;\nmaterial.roughness = max( material.roughness, directMinRoughness );\n#endif\n#include <lights_fragment_begin>',
    )
    .replace(
      '#include <lights_fragment_maps>',
      '#if defined( STANDARD )\nmaterial.roughness = surfaceRoughness;\n#endif\n#include <lights_fragment_maps>',
    )
    .replace('#include <opaque_fragment>', CLAMP_GLSL);
}

/** Plain physical material (glass, metal) with the HDR clamp. */
export function clampedPhysical(params: THREE.MeshPhysicalMaterialParameters) {
  const mat = new THREE.MeshPhysicalMaterial(params);
  mat.onBeforeCompile = clampHdr;
  mat.customProgramCacheKey = () => 'clamped-physical';
  return mat;
}

export interface GroupMeta {
  class: 'lm' | 'unlit' | 'glassbaked';
  radiance: string;
  surface?: string;
  s: number; // noise floor of the log encoding
  L: number; // encoded range in stops
  alphaTest?: boolean;
  aoInAlpha?: boolean; // radiance alpha holds ambient occlusion (specular occlusion)
}

/** Scales the baked radiance near the candle so the flame flicker reaches the baked light too. */
export interface CandleUniforms {
  candlePosition: { value: THREE.Vector3 };
  candleFlicker: { value: number }; // 1 = as baked
}

export function createCandleUniforms(): CandleUniforms {
  return { candlePosition: { value: new THREE.Vector3() }, candleFlicker: { value: 1 } };
}

const CANDLE_GLSL = /* glsl */ `
uniform vec3 candlePosition;
uniform float candleFlicker;
varying vec3 vBakedWorldPos;
// share of the baked light coming from the candle: ~1 within a few cm, fading out across the table
float candleShare() {
  float d = distance( vBakedWorldPos, candlePosition );
  return clamp( 0.06 / ( d * d + 0.06 ), 0.0, 1.0 );
}
`;

function withWorldPos(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vBakedWorldPos;\nvarying vec3 vBakedWorldNormal;')
    .replace(
      '#include <worldpos_vertex>',
      '#include <worldpos_vertex>\nvBakedWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\nvBakedWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );',
    );
}

/** Real-time mirror image of the scene for a horizontal glossy surface (see planarReflection.ts). */
export interface PlanarUniforms {
  planarMap: { value: THREE.Texture | null };
  planarMatrix: { value: THREE.Matrix4 };
  planarHeight: { value: number };
  planarLod: { value: number }; // blur growth per unit of coat roughness
  planarEnabled: { value: number };
}

const PLANAR_GLSL = /* glsl */ `
uniform sampler2D planarMap;
uniform mat4 planarMatrix;
uniform float planarHeight;
uniform float planarLod;
uniform float planarEnabled;
`;

// after the probe lookups: on the table top the coat reflects the mirrored scene instead of the probe
// Lagarde & de Rousiers 2014 (Frostbite): specular occlusion from ambient occlusion, view angle and
// roughness, applied to the probe reflections of the base layer and of the coat
const SPECULAR_OCCLUSION = /* glsl */ `
{
  float ao = radianceTexel.a;
  float nv = saturate( dot( geometryNormal, geometryViewDir ) );
  radiance *= saturate( pow( nv + ao, exp2( -16.0 * material.roughness - 1.0 ) ) - 1.0 + ao );
  #ifdef USE_CLEARCOAT
    clearcoatRadiance *= saturate( pow( nv + ao, exp2( -16.0 * material.clearcoatRoughness - 1.0 ) ) - 1.0 + ao );
  #endif
}
`;

const PLANAR_APPLY = /* glsl */ `
#include <lights_fragment_maps>
#if defined( USE_CLEARCOAT )
{
  vec4 pc = planarMatrix * vec4( vBakedWorldPos, 1.0 );
  vec2 puv = pc.xy / pc.w;
  float top = step( planarHeight - 0.003, vBakedWorldPos.y ) * smoothstep( 0.97, 0.995, normalize( vBakedWorldNormal ).y );
  float inside = step( 0.0, puv.x ) * step( puv.x, 1.0 ) * step( 0.0, puv.y ) * step( puv.y, 1.0 );
  float lod = log2( 1.0 + material.clearcoatRoughness * planarLod );
  vec3 mirrored = textureLod( planarMap, puv, lod ).rgb;
  clearcoatRadiance = mix( clearcoatRadiance, mirrored, top * inside * planarEnabled );
}
#endif
`;

export function createLightmappedMaterial(
  g: GroupMeta,
  radiance: THREE.Texture,
  surface: THREE.Texture,
  envMap: THREE.Texture | null,
  candle: CandleUniforms,
  planar?: PlanarUniforms,
) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x000000,
    roughness: 1,
    roughnessMap: surface, // .g
    clearcoat: 1,
    clearcoatMap: surface, // .r
    clearcoatRoughness: 1,
    clearcoatRoughnessMap: surface, // patched to .b below
    specularIntensity: 2, // Blender's "Specular IOR Level" 0.5 == three's 1.0
    specularIntensityMap: surface, // .a
    envMap,
    alphaTest: g.alphaTest ? 0.5 : 0,
    side: g.alphaTest ? THREE.DoubleSide : THREE.FrontSide,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.radianceMap = { value: radiance };
    shader.uniforms.radianceEnc = { value: new THREE.Vector2(g.s, g.L) };
    Object.assign(shader.uniforms, candle);
    withWorldPos(shader);
    clampHdr(shader);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vBakedWorldNormal;');
    if (planar) {
      Object.assign(shader.uniforms, planar);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${PLANAR_GLSL}`)
        .replace('#include <lights_fragment_maps>', PLANAR_APPLY);
    }
    if (g.aoInAlpha) {
      // right after the probe lookups (and before the planar mirror, which has its own occlusion)
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_maps>',
        `#include <lights_fragment_maps>\n${SPECULAR_OCCLUSION}`,
      );
    }
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform sampler2D radianceMap;\nuniform vec2 radianceEnc;\n${DECODE}${CANDLE_GLSL}`,
      )
      // sample once, early: alpha is the cutout (alpha-tested groups) or ambient occlusion (the rest)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>\nvec4 radianceTexel = texture2D( radianceMap, vRoughnessMapUv );\n${g.alphaTest ? 'diffuseColor.a = radianceTexel.a;' : ''}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `vec3 bakedRadiance = decodeRadiance( radianceTexel.rgb, radianceEnc );
totalEmissiveRadiance = bakedRadiance * mix( 1.0, candleFlicker, candleShare() );`,
      )
      .replace(
        '#include <lights_physical_fragment>',
        THREE.ShaderChunk.lights_physical_fragment.replace(
          'vClearcoatRoughnessMapUv ).y',
          'vClearcoatRoughnessMapUv ).z',
        ),
      );
  };
  mat.userData.planar = planar; // tunable from the lab
  mat.customProgramCacheKey = () => `lm-${g.alphaTest ? 1 : 0}-${planar ? 1 : 0}-${g.aoInAlpha ? 1 : 0}`;
  return mat;
}

/** Everything baked (COMBINED): backlit cathedral glass, lampshade, bulb. */
/**
 * Thick, tinted glass (tumblers, bottle, wine): the look Cycles computed (COMBINED bake, i.e. the
 * glow of light travelling through faceted glass) is the emission, and the live part is only the
 * reflection on top: environment with every light (envGlass) and the candle, Fresnel-weighted.
 */
export function createBakedGlassMaterial(g: GroupMeta, radiance: THREE.Texture, envMap: THREE.Texture) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x000000,
    roughness: 0.04,
    metalness: 0,
    ior: 1.5,
    envMap,
    emissive: 0xffffff,
    emissiveMap: radiance,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.radianceEnc = { value: new THREE.Vector2(g.s, g.L) };
    clampHdr(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform vec2 radianceEnc;\n${DECODE}`)
      .replace(
        '#include <emissivemap_fragment>',
        'totalEmissiveRadiance = decodeRadiance( texture2D( emissiveMap, vEmissiveMapUv ).rgb, radianceEnc );',
      );
  };
  mat.customProgramCacheKey = () => 'glass-baked';
  return mat;
}

/**
 * Thin clear glass (wine glasses): seen-through without refraction (walls are ~1 mm, Cycles bends
 * the background imperceptibly) plus live reflections. Blending is (ONE, ONE_MINUS_SRC_ALPHA): the
 * reflection adds, the background is dimmed by the glass absorption + Fresnel. No transmission pass
 * (it would re-render the scene each frame and breaks with an MSAA composer).
 * It writes depth: the DOF pass reads the depth buffer, and without it the glass took the blur of
 * the wall behind and vanished (Camera_Detail). The cost: what is seen through it is not blurred.
 */
export function createThinGlassMaterial(params: { color: THREE.Color; roughness: number; envMap: THREE.Texture; absorption?: number }) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x000000,
    roughness: params.roughness,
    metalness: 0,
    ior: 1.5,
    envMap: params.envMap,
    transparent: true,
    depthWrite: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.glassAbsorption = { value: params.absorption ?? 0.06 };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float glassAbsorption;')
      .replace(
        '#include <opaque_fragment>',
        `float glassF = pow( 1.0 - saturate( dot( normalize( vNormal ), normalize( vViewPosition ) ) ), 5.0 );
gl_FragColor = vec4( min( outgoingLight, vec3( ${HDR_CLAMP.toFixed(1)} ) ), saturate( glassAbsorption + glassF * 0.96 ) );`,
      );
  };
  mat.customProgramCacheKey = () => 'glass-thin';
  return mat;
}

export function createUnlitMaterial(g: GroupMeta, radiance: THREE.Texture) {
  const mat = new THREE.MeshBasicMaterial({ map: radiance });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.radianceEnc = { value: new THREE.Vector2(g.s, g.L) };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform vec2 radianceEnc;\n${DECODE}`)
      .replace(
        '#include <map_fragment>',
        'vec4 radianceTexel = texture2D( map, vMapUv );\ndiffuseColor.rgb = decodeRadiance( radianceTexel.rgb, radianceEnc );',
      );
  };
  mat.customProgramCacheKey = () => 'unlit-baked';
  return mat;
}

/** Baked textures follow the glTF UV convention (no flip) and hold data, not colours: no sRGB decode. */
export function prepareBakedTexture(tex: THREE.Texture, anisotropy: number) {
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = anisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
