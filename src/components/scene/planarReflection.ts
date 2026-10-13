import * as THREE from 'three';

/**
 * Mirror image of the scene about a horizontal plane (the lacquered table top), rendered at reduced
 * resolution into a mip-mapped HDR target. The table's coat samples it instead of the reflection
 * probe, so it reflects the glasses, the candle and the doilies as Cycles does; the coat roughness
 * picks the mip level. Math from three's Reflector (oblique near plane, Lengyel).
 */
export class PlanarReflection {
  readonly target: THREE.WebGLRenderTarget;
  readonly textureMatrix = new THREE.Matrix4();
  /** Fraction of the canvas resolution. */
  resolution = 0.5;

  private camera = new THREE.PerspectiveCamera();
  private plane = new THREE.Plane();
  private normal: THREE.Vector3;
  private point: THREE.Vector3;
  private tmp = {
    cam: new THREE.Vector3(),
    view: new THREE.Vector3(),
    look: new THREE.Vector3(),
    target: new THREE.Vector3(),
    rot: new THREE.Matrix4(),
    clip: new THREE.Vector4(),
    q: new THREE.Vector4(),
    size: new THREE.Vector2(),
  };

  constructor(height: number) {
    this.point = new THREE.Vector3(0, height, 0);
    this.normal = new THREE.Vector3(0, 1, 0);
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });
  }

  /** Renders the reflection; `hidden` objects (the table itself) are left out. */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, hidden: THREE.Object3D[]) {
    const t = this.tmp;
    renderer.getDrawingBufferSize(t.size);
    const w = Math.max(1, Math.round(t.size.x * this.resolution));
    const h = Math.max(1, Math.round(t.size.y * this.resolution));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);

    t.cam.setFromMatrixPosition(camera.matrixWorld);
    t.view.subVectors(this.point, t.cam);
    if (t.view.dot(this.normal) > 0) return; // looking at the plane from below
    t.view.reflect(this.normal).negate().add(this.point);

    t.rot.extractRotation(camera.matrixWorld);
    t.look.set(0, 0, -1).applyMatrix4(t.rot).add(t.cam);
    t.target.subVectors(this.point, t.look).reflect(this.normal).negate().add(this.point);

    const rc = this.camera;
    rc.position.copy(t.view);
    rc.up.set(0, 1, 0).applyMatrix4(t.rot).reflect(this.normal);
    rc.lookAt(t.target);
    rc.near = camera.near;
    rc.far = camera.far;
    rc.updateMatrixWorld();
    rc.projectionMatrix.copy(camera.projectionMatrix); // keeps the lens shift

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse);

    // oblique near plane: nothing below the table top ends up in the reflection
    this.plane.setFromNormalAndCoplanarPoint(this.normal, this.point).applyMatrix4(rc.matrixWorldInverse);
    t.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const p = rc.projectionMatrix.elements;
    t.q.set((Math.sign(t.clip.x) + p[8]) / p[0], (Math.sign(t.clip.y) + p[9]) / p[5], -1, (1 + p[10]) / p[14]);
    t.clip.multiplyScalar(2 / t.clip.dot(t.q));
    p[2] = t.clip.x;
    p[6] = t.clip.y;
    p[10] = t.clip.z + 1;
    p[14] = t.clip.w;
    rc.projectionMatrixInverse.copy(rc.projectionMatrix).invert();

    const visible = hidden.map((o) => o.visible);
    hidden.forEach((o) => (o.visible = false));
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, rc);
    renderer.setRenderTarget(prev);
    hidden.forEach((o, i) => (o.visible = visible[i]));
  }

  dispose() {
    this.target.dispose();
  }
}
