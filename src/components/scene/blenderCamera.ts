import * as THREE from 'three';

/** Camera as exported by blender/scripts/export_web.py (already converted to Y-up). */
export interface BlenderCamera {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  target: [number, number, number] | null;
  lens: number;
  sensorWidth: number;
  sensorFit: 'AUTO' | 'HORIZONTAL' | 'VERTICAL';
  shiftX: number;
  shiftY: number;
  fstop: number;
  blades: number;
  focus: [number, number, number] | null;
  focusDistance: number;
  resolution: [number, number] | null;
  exposure: number | null;
}

/**
 * Applies a Blender camera to a three.js PerspectiveCamera for a given viewport aspect.
 *
 * Blender (sensor fit AUTO) maps the sensor width to the larger image dimension and expresses
 * lens shift in units of that same dimension. three.js has no lens shift, so it goes into the
 * projection matrix as an off-axis offset (pure translation in NDC, no rotation of the view).
 */
export function applyBlenderCamera(cam: THREE.PerspectiveCamera, bc: BlenderCamera, aspect: number) {
  cam.position.set(...bc.position);
  cam.quaternion.set(...bc.quaternion);
  setBlenderProjection(cam, bc.lens, bc.sensorWidth, bc.shiftX, bc.shiftY, aspect);
}

export function setBlenderProjection(
  cam: THREE.PerspectiveCamera,
  lens: number,
  sensorWidth: number,
  shiftX: number,
  shiftY: number,
  aspect: number,
) {
  const half = Math.atan(sensorWidth / 2 / lens);
  const landscape = aspect >= 1;
  // three wants the vertical FOV in degrees
  const fovY = landscape ? 2 * Math.atan(Math.tan(half) / aspect) : 2 * half;
  cam.fov = THREE.MathUtils.radToDeg(fovY);
  cam.aspect = aspect;
  cam.updateProjectionMatrix();
  // shift is a fraction of the larger dimension; NDC spans 2 units per dimension
  const sx = landscape ? 2 * shiftX : (2 * shiftX) / aspect;
  const sy = landscape ? 2 * shiftY * aspect : 2 * shiftY;
  const e = cam.projectionMatrix.elements;
  // x_ndc = (P00 x + P02 z) / -z, so P02 += s gives x_ndc -= s. A positive Blender shift moves the
  // frame right, i.e. the content left by 2 * shift in NDC (same for y with P12).
  e[8] += sx;
  e[9] += sy;
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
}

/** Distance along the view axis from the camera to a world point (Blender's DOF focus distance). */
export function focusDistance(cam: THREE.Camera, point: THREE.Vector3) {
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  return point.clone().sub(cam.position).dot(fwd);
}
