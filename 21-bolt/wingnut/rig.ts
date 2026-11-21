import * as THREE from "three/webgpu";

export const PHONE = typeof window !== "undefined" && window.matchMedia("(max-width: 900px), (hover: none)").matches;

// The bolt hangs in the air tilted so its tip points up and a little toward the eye: on a phone held upright, nearly
// straight up, so the nut flies up the screen. Rig x = 0.45 (between the head and where the nut hovers) sits at the
// origin.
export const RIG = (() => {
  const roll = THREE.MathUtils.degToRad(PHONE ? 68 : 13);
  const yaw = THREE.MathUtils.degToRad(PHONE ? -10 : -12);
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, roll, "YXZ"));
  const position = new THREE.Vector3(0.45, 0, 0).applyQuaternion(quaternion).negate();
  return { quaternion, position };
})();

// A point in the rig's frame, in the world.
export const toWorld = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyQuaternion(RIG.quaternion).add(RIG.position);

// Where the freed nut hovers (about; each thing's own reach moves it a little), which the sunbeam is aimed through.
export const HOVER = toWorld(2.05, 0.22, -0.1);
