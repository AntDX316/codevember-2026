import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";

// The little world: a thundercloud over a still black sea at y = 0, its flat base at about BASE, its anvil near 14.
export const BASE = 5;

// The box the cloud is baked into, in world units. The anvil is blown downwind toward +x.
export const BOX = {
  min: new THREE.Vector3(-12, 3.6, -11),
  max: new THREE.Vector3(14, 19.6, 11)
};

// Where the moon hangs: high behind the cloud from the opening view, out of the frame, so the anvil's top edge is
// silvered while the face of the tower stays dark.
export const MOON = new THREE.Vector3(0.08, 0.6, -0.8).normalize();

// Everything the shaders read about the storm, set each frame by the scene. Lights are in world units.
export const storm = {
  // Seconds on the storm's own clock, which slow motion slows.
  time: uniform(0),
  // Three flashes inside the cloud: where (xyz) and how bright now (w).
  ic: [uniform(new THREE.Vector4(0, 9, 0, 0)), uniform(new THREE.Vector4(0, 9, 0, 0)), uniform(new THREE.Vector4(0, 9, 0, 0))],
  // The channel to the sea: where it leaves the cloud (xyz) and its brightness (w); and where it reaches (xyz) and the
  // glow of the leader still feeling its way down (w).
  top: uniform(new THREE.Vector4(0, BASE, 0, 0)),
  tip: uniform(new THREE.Vector4(0, 0, 0, 0)),
  // The rain: its centre on the sea (x, z), radius (z) and how heavy (w).
  rain: uniform(new THREE.Vector4(0.4, 0.2, 2.6, 1)),
  // How brightly the whole sky is lit by whatever is flashing, for the air and the drops near the lens.
  flash: uniform(0),
  moon: uniform(MOON.clone()),
  // The camera's forward direction and the size of a pixel one unit away, for strips that face it.
  forward: uniform(new THREE.Vector3(0, 0, -1)),
  right: uniform(new THREE.Vector3(1, 0, 0)),
  up: uniform(new THREE.Vector3(0, 1, 0)),
  pixel: uniform(0.001)
};
