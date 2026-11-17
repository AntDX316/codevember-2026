"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { useSetting } from "../shared/engine/settings";
import { sound, useBed, useEvery, useMusic } from "../shared/engine/sound";
import type { DayDefinition } from "../shared/engine/types";
import { Backdrop, Scan, type Framing, type Place } from "./scan";
import { Sea } from "./sea";
import { Birds, Boats, Clouds, Surf } from "./world";

// What shows past the edges of the photograph: the dusk grey of its sky.
const BACKGROUND = "#5d5866";

// The scan: a rusted steel fence post with its chain-link, standing in sand. It came out upside down, about 3.5 units
// tall, so it is turned over and brought down to 1.6.
const POST: Framing = { foot: [-0.28, -0.17, -0.2], radius: 2.2, below: 0.8, above: 4, flip: true, scale: 0.45 };

// The beach behind it, a scan made from one photograph of a sunset over wet sand. Its camera stood about 0.45 of the scan's
// units up and tipped about 6 degrees skyward; at 2.5 times the size it puts the horizon some 350 units off. The photo
// only reaches about 24 degrees above the horizon and 28 to either side, so it is stretched to fill as far as the camera
// may turn. Stretched upward, its eye rises with it to keep the sand at the water, and it sits a metre (1.33 units) higher
// still, which lifts its horizon.
// The sea: a band of water between the photograph's surf and its horizon, set well down so it sits low in the view. It
// starts some way out, so the scanned beach shows in front of it, and thins away before the horizon, so the photograph's
// own sea shows there. Splats write no depth, so wherever the water is drawn it covers them.
const WATER = -5.6;
const SHORE = 50;
const SEA_FADE: [number, number] = [55, 105];

// The most boats the panel allows.
const BOATS_MOST = 50;

const BEACH: Place = { eye: [0, 1.13 * 1.7, 1.5], scale: 2.5, level: 0.1, widen: 2, lift: 1.7 };

// A rusted fence post, scanned from the real thing, out on the dunes with the wind getting through the wire.
// The camera drifts a little, as if held by someone standing on the sand: a slow sway and rise, two or three centimetres, on
// top of wherever it has been put. Last frame's drift is taken off before this frame's goes on, so it never wanders.
function Float() {
  const drift = useMemo(() => ({ last: new THREE.Vector3(), next: new THREE.Vector3(), clock: 0 }), []);
  useFrame(({ camera }, delta) => {
    drift.clock += Math.min(delta, 0.05);
    const t = drift.clock;
    drift.next.set(
      Math.sin(t * 0.31) * 0.026 + Math.sin(t * 0.73 + 1.3) * 0.008,
      Math.sin(t * 0.43 + 0.6) * 0.017 + Math.sin(t * 0.97 + 2.1) * 0.006,
      Math.sin(t * 0.23 + 2.4) * 0.02
    );
    camera.position.sub(drift.last).add(drift.next);
    drift.last.copy(drift.next);
  });
  return null;
}

function Scene() {
  const boats = useSetting<number>("boats");
  useMusic("/codevember/music/where-time-rests.mp3", 0.32);
  useBed("wind", 0.18);
  useEvery(6, 14, () => sound.play("creak", { gain: 0.18, size: 0.6, pan: Math.random() * 2 - 1 }));
  useEvery(4, 10, () => sound.play("rustle", { gain: 0.12, pan: Math.random() * 2 - 1 }));
  // Gulls, high and thin, now one and now a few together, from wherever the flocks are crossing.
  useEvery(3, 9, () => sound.play("caw", { gain: 0.09 + Math.random() * 0.08, pitch: 1.35 + Math.random() * 0.5, pan: Math.random() * 1.6 - 0.8 }));

  return (
    <>
      <Float />
      <Backdrop url="/assets/11-rust/beach.spz" place={BEACH} />
      <Sea shore={SHORE} level={WATER} fade={SEA_FADE} />
      <Clouds />
      <Surf distance={8.8} level={0.02} width={40} />
      <Boats count={boats} most={BOATS_MOST} eye={1.1} dip={3.7} />
      <Birds count={90} near={70} far={220} />
      {/* And more, far out over the horizon, specks: some high, some skimming low over the sea. */}
      <Birds count={110} near={230} far={380} salt={1} />
      <Birds count={90} near={240} far={380} low={0.6} high={2.6} salt={2} />
      <Scan
      url="/assets/11-rust/pipe.spz"
        framing={POST}
        core={{ radius: 0.05, height: 1.4, offset: [0.024, -0.007], color: "#4a2a1e" }}
      />
    </>
  );
}

const rust: DayDefinition = {
  // Opens close on the post, the knotted wire at the right, and stays near there: the beach is one photograph, and only
  // looks right from close to where it was taken.
  camera: { position: [0.138, 1.265, 0.699], target: [-0.043, 1.16, 0.013], fov: 34, limits: { turn: { left: 0, right: 20, up: 8, down: 1 }, move: { left: 0.035, right: 0.185, down: 0.1, up: 0.04, nearer: 0.545, further: 0.22 }, ahead: 0.4, closest: 0.16 }, phone: { position: [0.25, 1.235, 1.03], target: [0.024, 1.1, -0.007] } },
  extents: { centre: [0, 0.8, 0], radius: 8, floor: 0.05, color: "#ffd9b0" },
  // Splats draw without depth, so the depth-based passes have nothing to work with.
  passes: { haze: false, bounce: false, sideBlur: { from: 0.68, to: 0.92, amount: 3.2, left: { from: 0.34, to: 0.04, strength: 0.7 } } },
  look: { background: BACKGROUND, exposure: 1, bloom: 0.15, ao: 0, vignette: 0.5, grain: 0.02 },
  hint: "Drag to look around the post.",
  settings: {
    birds: { type: "range", label: "Birds", min: 0, max: 200, step: 5, value: 100 },
    boats: { type: "range", label: "Boats", min: 0, max: BOATS_MOST, step: 1, value: 22 }
  },
  notes: "A rusted fence post, scanned and drawn as Gaussian splats by three.js's own WebGPU splat renderer.",
  overview: [
    {
      title: "3D capture",
      points: [
        "A real beach post scanned by phone in Polycam; structure from motion solves the camera poses and a sparse point cloud.",
        "3D Gaussian splatting trains soft ellipsoids to match every frame, saved as a 12 MB SPZ of 875,000 Gaussians.",
        "The beach behind is a second splat scene made from a single sunset photograph."
      ]
    },
    {
      title: "Rendering",
      points: [
        "three.js r187's TSL GaussianSplat on WebGPU draws about 1.5 million Gaussians a frame, depth-sorted by a compute counting sort.",
        "The scan is cropped to a faded cylinder, stray sky and blobs culled by colour and size, with a solid core so nothing shows through."
      ]
    },
    {
      title: "Sea and sky",
      points: [
        "Day 7's Tessendorf FFT ocean mirrors the scene and fades into the photo's sea, with foam at its surf line.",
        "Boats and gulls are instanced meshes, gull wings flapped in the vertex shader, under a drifting cloud sheet.",
        "Splats write no depth, so the soft frame edges are a screen-space blur rather than depth of field."
      ]
    }
  ],
  Scene
};

export default rust;
