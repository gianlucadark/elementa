import * as THREE from 'three';

/**
 * Port of M_Flame (build_scene.py): colour ramp along the flame height, emission strength
 * 6 -> 38 over the lower quarter, silhouette fading to transparent via Layer Weight "Facing"
 * (blend 0.55). Output is scene-linear HDR, so bloom and the view transform treat it like Cycles.
 */
const vertexShader = /* glsl */ `
uniform float flameHeight;
varying float vH;
varying vec3 vN;
varying vec3 vV;
void main() {
  vH = position.y / flameHeight; // lathe profile height in object space (Y-up after export)
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vN = normalize( mat3( modelMatrix ) * normal );
  vV = normalize( cameraPosition - wp.xyz );
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const fragmentShader = /* glsl */ `
uniform float flicker;
varying float vH;
varying vec3 vN;
varying vec3 vV;

vec3 ramp( float t ) {
  // ColorRamp stops (linear interpolation, as in Blender)
  vec3 c0 = vec3( 0.15, 0.25, 1.0 );
  vec3 c1 = vec3( 1.0, 0.30, 0.05 );
  vec3 c2 = vec3( 1.0, 0.78, 0.42 );
  vec3 c3 = vec3( 1.0, 0.62, 0.22 );
  vec3 c4 = vec3( 0.9, 0.22, 0.02 );
  if ( t < 0.10 ) return mix( c0, c1, t / 0.10 );
  if ( t < 0.28 ) return mix( c1, c2, ( t - 0.10 ) / 0.18 );
  if ( t < 0.55 ) return mix( c2, c3, ( t - 0.28 ) / 0.27 );
  return mix( c3, c4, clamp( ( t - 0.55 ) / 0.45, 0.0, 1.0 ) );
}

void main() {
  float t = clamp( vH, 0.0, 1.0 );
  float strength = mix( 6.0, 38.0, smoothstep( 0.0, 0.25, t ) );
  // Layer Weight facing, blend 0.55 -> exponent 0.5 / (1 - 0.55)
  float facing = 1.0 - pow( abs( dot( normalize( vN ), normalize( vV ) ) ), 0.5 / 0.45 );
  float transparent = smoothstep( 0.35, 0.95, facing );
  gl_FragColor = vec4( ramp( t ) * strength * ( 1.0 - transparent ) * flicker, 1.0 );
}
`;

export function createFlameMaterial(flameHeight: number) {
  return new THREE.ShaderMaterial({
    uniforms: { flameHeight: { value: flameHeight }, flicker: { value: 1 } },
    vertexShader,
    fragmentShader,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    toneMapped: false,
  });
}
