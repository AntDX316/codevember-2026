/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { uniform, uniformArray } from "three/tsl";

// Taps remembered at once: as many as the most the panel can ask for before it opens.
export const MAX_TAPS = 12;
// The creature's wings, each drawn on both sides.
export const WINGS = 3;
// Seconds the wings take to come apart into light, tip first.
export const DISSOLVE = 2.6;

// Everything the shaders read that changes as it is played with, made once per visit and set each frame.
export function makeLive() {
  return {
    // The scene's own clock, so taps and ripples share one time.
    now: uniform(0),
    // The heartbeat, 0 to about 1.5 at each beat.
    beat: uniform(0),
    // Seconds since the shell broke, run backwards as it reforms; 0 while whole.
    shardT: uniform(0),
    // 1 while sealed; down to 0 as it opens, when the glow inside goes out.
    intact: uniform(1),
    // Multiplies every crack: 1 normally, fading to 0 as a reformed shell heals.
    heal: uniform(1),
    // 1 while any crack shows, so the search for the seams can be skipped on a whole shell.
    cracked: uniform(0),
    // Every seam blazing at once, at the moment it splits and as it knits.
    flare: uniform(0),
    // The camera, in the pod's own space, for looking into it.
    camPod: uniform(new THREE.Vector3(0, 0, 6)),
    // Each tap: where on the pod (pod space) and when. Unused ones sit far in the past.
    taps: uniformArray(
      Array.from({ length: MAX_TAPS }, () => new THREE.Vector4(0, 0, 0, -1000)),
      "vec4"
    ) as any,
    skin: uniform(new THREE.Color()),
    mottle: uniform(new THREE.Color()),
    absorb: uniform(new THREE.Vector3(1, 1, 1)),
    glow: uniform(new THREE.Color()),
    strength: uniform(1),
    seam: uniform(new THREE.Color()),
    gold: uniform(new THREE.Color()),
    wing: uniform(new THREE.Color()),
    // The creature: where it hangs in the world, how far it is turned, each wing's hinge and how open it is (w), each
    // wing's turn as a quaternion, how much it breathes, and when it began to come apart.
    origin: uniform(new THREE.Vector3(0, 0.2, 0)),
    yaw: uniform(0),
    wingPose: uniformArray(
      Array.from({ length: WINGS }, () => new THREE.Vector4()),
      "vec4"
    ) as any,
    wingTurn: uniformArray(
      Array.from({ length: WINGS }, () => new THREE.Vector4(0, 0, 0, 1)),
      "vec4"
    ) as any,
    flap: uniform(0),
    dissolveAt: uniform(1e6),
    // The whole creature, 0 hidden to 1.
    shown: uniform(0)
  };
}

export type Live = ReturnType<typeof makeLive>;
