import * as THREE from 'three';
import type { BlenderCamera } from './blenderCamera';
import type { SceneMeta } from './meta';

/**
 * Camera along the landing's scroll, built from the Blender cameras:
 *
 *   p 0.00 - 0.12  the room waits: hero framing
 *   p 0.12 - 0.45  approach the details, focus racks toward the tumbler
 *   p 0.45 - 0.60  a moment for the small gestures
 *   p 0.60 - 0.90  settle at table height, as a guest about to sit down
 *   p 0.90 - 1.00  hold the invitation; the menu lives outside this sequence
 *
 * Every property a Blender camera has is interpolated (lens, shift, f-stop, focus), so the look at
 * each keyframe is exactly the rendered shot.
 */

export interface CameraPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** point the camera looks at (Blender's look_at target): orientation is rebuilt from it */
  target: THREE.Vector3;
  lens: number;
  sensorWidth: number;
  shiftX: number;
  shiftY: number;
  fstop: number;
  focusDistance: number;
  exposure: number;
}

const ease = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const segment = (p: number, a: number, b: number) => ease(clamp01((p - a) / (b - a)));

function fromBlender(bc: BlenderCamera, exposure: number): CameraPose {
  const position = new THREE.Vector3(...bc.position);
  const quaternion = new THREE.Quaternion(...bc.quaternion);
  const target = bc.target
    ? new THREE.Vector3(...bc.target)
    : position.clone().add(new THREE.Vector3(0, 0, -bc.focusDistance).applyQuaternion(quaternion));
  return {
    position,
    quaternion,
    target,
    lens: bc.lens,
    sensorWidth: bc.sensorWidth,
    shiftX: bc.shiftX,
    shiftY: bc.shiftY,
    fstop: bc.fstop,
    focusDistance: bc.focusDistance,
    exposure: bc.exposure ?? exposure,
  };
}

function lookAt(position: THREE.Vector3, target: THREE.Vector3) {
  const m = new THREE.Matrix4().lookAt(position, target, new THREE.Vector3(0, 1, 0));
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

/**
 * Interpolates two poses. The orientation is not slerped: the camera keeps looking at a target that
 * glides from one subject to the other (slerping lost the table mid-dolly and framed the wall).
 * Focus moves in diopters (1/distance) so a rack focus feels optical.
 */
function mix(a: CameraPose, b: CameraPose, t: number, out: CameraPose) {
  out.position.copy(a.position).lerp(b.position, t);
  out.target.copy(a.target).lerp(b.target, t);
  if (t <= 0) out.quaternion.copy(a.quaternion);
  else if (t >= 1) out.quaternion.copy(b.quaternion);
  else out.quaternion.copy(lookAt(out.position, out.target));
  out.lens = THREE.MathUtils.lerp(a.lens, b.lens, t);
  out.sensorWidth = THREE.MathUtils.lerp(a.sensorWidth, b.sensorWidth, t);
  out.shiftX = THREE.MathUtils.lerp(a.shiftX, b.shiftX, t);
  out.shiftY = THREE.MathUtils.lerp(a.shiftY, b.shiftY, t);
  out.fstop = THREE.MathUtils.lerp(a.fstop, b.fstop, t);
  out.focusDistance = 1 / THREE.MathUtils.lerp(1 / a.focusDistance, 1 / b.focusDistance, t);
  out.exposure = THREE.MathUtils.lerp(a.exposure, b.exposure, t);
  return out;
}

function copyPose(src: CameraPose, out: CameraPose) {
  return mix(src, src, 0, out);
}

function clonePose(p: CameraPose): CameraPose {
  return { ...p, position: p.position.clone(), quaternion: p.quaternion.clone(), target: p.target.clone() };
}

export class CameraPath {
  private desktop: CameraPose;
  private mobile: CameraPose;
  private detail: CameraPose;
  private outro: CameraPose;
  private hero = this.blank();
  private detailFit = this.blank();
  private out = this.blank();
  /** Arc of the dolly: the straight line would skim the chair backs, so the path lifts mid-way. */
  private arcLift = 0.12;

  constructor(meta: SceneMeta) {
    const e = meta.colorManagement.exposure;
    this.desktop = fromBlender(meta.cameras.Camera_Desktop, e);
    this.mobile = fromBlender(meta.cameras.Camera_Mobile, e);
    this.detail = fromBlender(meta.cameras.Camera_Detail, e);
    // Return to a guest's eye level rather than rising out of the room.
    const target = new THREE.Vector3(0.05, 0.86, -0.05);
    const position = new THREE.Vector3(-0.48, 1.16, 1.72);
    this.outro = {
      ...clonePose(this.desktop),
      position,
      target,
      quaternion: lookAt(position, target),
      lens: 36,
      shiftX: 0,
      shiftY: 0,
      fstop: 2.8,
      focusDistance: position.distanceTo(target),
    };
  }

  private blank(): CameraPose {
    return {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      target: new THREE.Vector3(),
      lens: 50,
      sensorWidth: 36,
      shiftX: 0,
      shiftY: 0,
      fstop: 2,
      focusDistance: 2,
      exposure: 0.5,
    };
  }

  /**
   * Pose at scroll progress p for a viewport aspect. Landscape uses the desktop shot (with its lens
   * shift leaving room for the title), portrait the mobile one; tablets get a blend.
   */
  at(p: number, aspect: number): CameraPose {
    mix(this.mobile, this.desktop, ease(clamp01((aspect - 0.75) / 0.6)), this.hero);
    // the close-up is a 55 mm landscape frame: on a portrait screen the sensor maps to the height,
    // so the same lens would crop it to a sliver. Widen it to keep the tumbler and the glass.
    copyPose(this.detail, this.detailFit);
    if (aspect < 1) this.detailFit.lens = this.detail.lens * Math.max(0.55, aspect * 0.9);

    if (p <= 0.12) return copyPose(this.hero, this.out);
    if (p <= 0.45) {
      const t = segment(p, 0.12, 0.45);
      mix(this.hero, this.detailFit, t, this.out);
      this.out.position.y += Math.sin(Math.PI * t) * this.arcLift;
      this.out.quaternion.copy(lookAt(this.out.position, this.out.target));
      return this.out;
    }
    if (p <= 0.60) return copyPose(this.detailFit, this.out);
    mix(this.detailFit, this.outro, segment(p, 0.60, 0.90), this.out);
    if (aspect < 1) this.out.lens *= THREE.MathUtils.lerp(1, 0.82, segment(p, 0.60, 0.90));
    return this.out;
  }
}
