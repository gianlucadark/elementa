import * as THREE from 'three';
import { Pass } from 'postprocessing';

/**
 * Physically based depth of field for a Blender camera.
 *
 * Circle of confusion from the thin-lens model Cycles uses, in pixels:
 *   diameter = A f |z - S| / (z (S - f)) / sensor * imagePx,  A = f / N
 * so the blur follows the f-stop, focal length and focus distance of the shot instead of a tuned
 * "amount".
 *
 * Passes (half resolution unless noted):
 *   1. downsample: colour + signed CoC (nearest of 4 taps, so foreground edges dilate a little)
 *   2. tile max:   max |CoC| per 8x8 block (1/16 res)
 *   3. gather:     Vogel disk of TAPS samples, radius = max CoC of the 3x3 neighbouring tiles, so
 *                  sampling density adapts to the local blur (a fixed spiral doubled edges at
 *                  ~50 px blur on Camera_Detail). Scatter-as-gather weights; a sample behind the
 *                  centre may not spread over it by more than the centre's own blur.
 *   4. composite (full res): tent-filtered blur over the sharp image by the pixel's own CoC, plus
 *                  the near field spilling over sharp pixels behind it.
 */

export interface DofState {
  enabled: boolean;
  lens: number; // mm
  fstop: number;
  sensorWidth: number; // mm, mapped to the larger image dimension (sensor fit AUTO)
  focusDistance: number; // m, along the view axis
}

const TILE = 8;

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4( position.xy, 1.0, 1.0 );
}
`;

const COC = /* glsl */ `
#include <packing>
uniform sampler2D tDepth;
uniform float cameraNear;
uniform float cameraFar;
uniform float focusDistance;
uniform float cocScale; // A f / (S - f) / sensor * imagePx / 2  ->  signed radius in full-res px
float viewDistance( vec2 uv ) {
  return -perspectiveDepthToViewZ( texture2D( tDepth, uv ).r, cameraNear, cameraFar );
}
float signedCoc( float z ) {
  return cocScale * ( z - focusDistance ) / max( z, 1e-3 );
}
`;

const downsampleShader = /* glsl */ `
${COC}
uniform sampler2D tColor;
uniform vec2 texelFull;
uniform float maxRadius;
varying vec2 vUv;
void main() {
  vec2 o = texelFull * 0.5;
  vec2 uv0 = vUv + vec2( -o.x, -o.y ), uv1 = vUv + vec2( o.x, -o.y ), uv2 = vUv + vec2( -o.x, o.y ), uv3 = vUv + vec2( o.x, o.y );
  vec3 c = ( texture2D( tColor, uv0 ).rgb + texture2D( tColor, uv1 ).rgb + texture2D( tColor, uv2 ).rgb + texture2D( tColor, uv3 ).rgb ) * 0.25;
  float z = min( min( viewDistance( uv0 ), viewDistance( uv1 ) ), min( viewDistance( uv2 ), viewDistance( uv3 ) ) );
  gl_FragColor = vec4( c, clamp( signedCoc( z ) * 0.5, -maxRadius, maxRadius ) );
}
`;

const tileMaxShader = /* glsl */ `
uniform sampler2D tCoc;
uniform vec2 texel; // of tCoc
varying vec2 vUv;
void main() {
  // this texel covers TILE x TILE half-res texels starting at its lower-left corner
  vec2 base = vUv - texel * ( float( ${TILE} ) * 0.5 - 0.5 );
  float m = 0.0;
  for ( int y = 0; y < ${TILE}; y ++ )
    for ( int x = 0; x < ${TILE}; x ++ )
      m = max( m, abs( textureLod( tCoc, base + vec2( x, y ) * texel, 0.0 ).a ) );
  gl_FragColor = vec4( m );
}
`;

const gatherShader = (taps: number) => /* glsl */ `
#define TAPS ${taps}
uniform sampler2D tCoc;
uniform sampler2D tTiles;
uniform vec2 texel;      // of tCoc
uniform vec2 tileTexel;  // of tTiles
varying vec2 vUv;
const float GOLDEN_ANGLE = 2.39996323;
void main() {
  vec4 center = textureLod( tCoc, vUv, 0.0 );
  float radius = 0.0;
  for ( int y = -1; y <= 1; y ++ )
    for ( int x = -1; x <= 1; x ++ )
      radius = max( radius, textureLod( tTiles, vUv + vec2( x, y ) * tileTexel, 0.0 ).r );
  if ( radius < 0.5 ) {
    gl_FragColor = center;
    return;
  }
  float centerSize = abs( center.a );
  vec3 color = center.rgb;
  float tot = 1.0;
  // explicit LOD: implicit-derivative fetches inside loops make ANGLE/D3D unroll them
  for ( int i = 0; i < TAPS; i ++ ) {
    float r = sqrt( ( float( i ) + 0.5 ) / float( TAPS ) ) * radius;
    float a = float( i ) * GOLDEN_ANGLE;
    vec4 s = textureLod( tCoc, vUv + vec2( cos( a ), sin( a ) ) * texel * r, 0.0 );
    float sampleSize = abs( s.a );
    if ( s.a > center.a ) sampleSize = min( sampleSize, centerSize * 2.0 );
    // the sample contributes if its own blur disc reaches the centre
    float w = clamp( sampleSize - r + 1.0, 0.0, 1.0 );
    color += s.rgb * w;
    tot += w;
  }
  gl_FragColor = vec4( color / tot, center.a );
}
`;

const compositeShader = /* glsl */ `
${COC}
uniform sampler2D tColor;
uniform sampler2D tBlur;
uniform vec2 blurTexel;
varying vec2 vUv;
void main() {
  vec4 sharp = texture2D( tColor, vUv );
  // 4 bilinear taps half a texel apart = tent filter on the half-res gather (hides its sampling)
  vec2 h = blurTexel * 0.5;
  vec4 blur = 0.25 * ( texture2D( tBlur, vUv + vec2( -h.x, -h.y ) ) + texture2D( tBlur, vUv + vec2( h.x, -h.y ) )
                     + texture2D( tBlur, vUv + vec2( -h.x, h.y ) ) + texture2D( tBlur, vUv + vec2( h.x, h.y ) ) );
  float coc = abs( signedCoc( viewDistance( vUv ) ) );
  // blurred foreground spreading over a sharp pixel behind it
  float near = blur.a < 0.0 ? abs( blur.a ) * 2.0 : 0.0;
  float t = smoothstep( 0.5, 1.5, max( coc, near ) );
  gl_FragColor = vec4( mix( sharp.rgb, blur.rgb, t ), sharp.a );
}
`;

function material(fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

export class DofPass extends Pass {
  state: DofState;
  /** Upper bound of the blur radius in half-res px. */
  maxRadius = 32;

  private viewCamera: THREE.PerspectiveCamera;
  private rtCoc: THREE.WebGLRenderTarget;
  private rtTiles: THREE.WebGLRenderTarget;
  private rtBlur: THREE.WebGLRenderTarget;
  private downMat: THREE.ShaderMaterial;
  private tileMat: THREE.ShaderMaterial;
  private gatherMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private full = new THREE.Vector2(1, 1);

  /** taps: gather samples per half-res pixel (48 desktop, ~24 on phones). */
  constructor(camera: THREE.PerspectiveCamera, state: DofState, taps = 48) {
    super('DofPass');
    this.viewCamera = camera;
    this.state = state;
    this.needsDepthTexture = true;
    const rt = (filter: THREE.MagnificationTextureFilter) =>
      new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        minFilter: filter,
        magFilter: filter,
        depthBuffer: false,
      });
    this.rtCoc = rt(THREE.LinearFilter);
    this.rtTiles = rt(THREE.NearestFilter);
    this.rtBlur = rt(THREE.LinearFilter);
    const cocUniforms = () => ({
      tDepth: { value: null },
      cameraNear: { value: 0.1 },
      cameraFar: { value: 100 },
      focusDistance: { value: 2 },
      cocScale: { value: 0 },
    });
    this.downMat = material(downsampleShader, {
      ...cocUniforms(),
      tColor: { value: null },
      texelFull: { value: new THREE.Vector2() },
      maxRadius: { value: this.maxRadius },
    });
    this.tileMat = material(tileMaxShader, { tCoc: { value: this.rtCoc.texture }, texel: { value: new THREE.Vector2() } });
    this.gatherMat = material(gatherShader(taps), {
      tCoc: { value: this.rtCoc.texture },
      tTiles: { value: this.rtTiles.texture },
      texel: { value: new THREE.Vector2() },
      tileTexel: { value: new THREE.Vector2() },
    });
    this.compMat = material(compositeShader, {
      ...cocUniforms(),
      tColor: { value: null },
      tBlur: { value: this.rtBlur.texture },
      blurTexel: { value: new THREE.Vector2() },
    });
    this.fullscreenMaterial = this.compMat;
  }

  override setDepthTexture(depthTexture: THREE.Texture) {
    this.downMat.uniforms.tDepth.value = depthTexture;
    this.compMat.uniforms.tDepth.value = depthTexture;
  }

  override setSize(width: number, height: number) {
    this.full.set(width, height);
    const hw = Math.max(1, Math.round(width / 2));
    const hh = Math.max(1, Math.round(height / 2));
    const tw = Math.max(1, Math.ceil(hw / TILE));
    const th = Math.max(1, Math.ceil(hh / TILE));
    this.rtCoc.setSize(hw, hh);
    this.rtBlur.setSize(hw, hh);
    this.rtTiles.setSize(tw, th);
    this.downMat.uniforms.texelFull.value.set(1 / width, 1 / height);
    this.tileMat.uniforms.texel.value.set(1 / hw, 1 / hh);
    this.gatherMat.uniforms.texel.value.set(1 / hw, 1 / hh);
    this.gatherMat.uniforms.tileTexel.value.set(1 / tw, 1 / th);
    this.compMat.uniforms.blurTexel.value.set(1 / hw, 1 / hh);
  }

  override render(
    renderer: THREE.WebGLRenderer,
    inputBuffer: THREE.WebGLRenderTarget,
    outputBuffer: THREE.WebGLRenderTarget,
  ) {
    const { lens, fstop, sensorWidth, focusDistance, enabled } = this.state;
    const cam = this.viewCamera;
    const f = lens / 1000;
    const S = Math.max(focusDistance, f * 1.01);
    const imagePx = Math.max(this.full.x, this.full.y);
    const cocScale = enabled ? (((f / fstop) * f) / (S - f) / (sensorWidth / 1000)) * imagePx * 0.5 : 0;
    for (const m of [this.downMat, this.compMat]) {
      m.uniforms.cameraNear.value = cam.near;
      m.uniforms.cameraFar.value = cam.far;
      m.uniforms.focusDistance.value = S;
      m.uniforms.cocScale.value = cocScale;
      m.uniforms.tColor.value = inputBuffer.texture;
    }
    this.downMat.uniforms.maxRadius.value = this.maxRadius;

    if (enabled && cocScale > 0) {
      this.fullscreenMaterial = this.downMat;
      renderer.setRenderTarget(this.rtCoc);
      renderer.render(this.scene, this.camera);
      this.fullscreenMaterial = this.tileMat;
      renderer.setRenderTarget(this.rtTiles);
      renderer.render(this.scene, this.camera);
      this.fullscreenMaterial = this.gatherMat;
      renderer.setRenderTarget(this.rtBlur);
      renderer.render(this.scene, this.camera);
    }
    this.fullscreenMaterial = this.compMat;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);
  }

  override dispose() {
    super.dispose();
    for (const t of [this.rtCoc, this.rtTiles, this.rtBlur]) t.dispose();
    for (const m of [this.downMat, this.tileMat, this.gatherMat, this.compMat]) m.dispose();
  }
}
