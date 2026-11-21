"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { abs, attribute, cameraPosition, dot, float, fwidth, max, min, mix, normalize, positionWorld, pow, smoothstep, uniform, uniformArray, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { useSetting } from "../../shared/engine/settings";
import { CONTACTS, GLASS, type Plasma } from "./filaments";
import { slotOf, TIPS } from "./hand-shape";
import { facets, handTemplates, newPose, pose, skin, type Pose } from "./handmesh";
import type { Hand, Hands } from "./hands";
import { glow } from "./render";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// IRL Hands drawn in the scene: each tracked hand as a dark glassy ghost in front of the globe, its fingertips where the
// touches land. The camera picture is mapped onto the screen as a mirror (cropped to fill it), then each hand is drawn
// at a natural size round its own palm, so the hand is where yours is in the picture but the size of a real hand by a
// globe. Fingertips on the glass rest on it; the rest of the hand stands off toward the eye by MediaPipe's own depths.

// A palm (wrist to the middle finger's knuckle) this long in the scene; the globe's radius is 1.
const PALM = 0.5;
// Drawn hands at once.
const DRAWN = 2;
// Room in the buffers for each sculpted hand, laid out triangle by triangle (the template has about 670 triangles).
const MESH_CORNERS = 900 * 3;

// How a touching finger's glow comes and goes: up hard in about a tenth of a second, down in about half a second.
const CHARGE_UP = 0.035;
const CHARGE_DOWN = 0.17;

type MeshParts = {
  meshAt: THREE.BufferAttribute;
  meshNormal: THREE.BufferAttribute;
  meshCharge: THREE.BufferAttribute;
  meshTip: THREE.BufferAttribute;
  meshBary: THREE.BufferAttribute;
  meshCool: THREE.BufferAttribute;
  tips: Float32Array[];
  skinned: Float32Array;
  vertexCharge: Float32Array;
  pose: Pose;
  // Each hand's charge in each finger, and how long each has been touching.
  charge: Float32Array[];
  held: Float32Array[];
};
// One tracked hand's sculpted mesh into its share of the buffers: the left or right template (MediaPipe's own label; as
// the picture is drawn mirrored, the hand it calls left looks like a left hand here), skinned to the landmarks and laid
// out face by face, flat-shaded, with each corner's charge. Collapsed to nothing when the hand is not shown.
function skinHand(parts: MeshParts, h: number, r: RigHand, dt: number, touching: number, flicker: number) {
  const at = parts.meshAt.array as Float32Array;
  const corner = h * MESH_CORNERS;
  // Each finger's charge: up quickly while it touches, more the longer it holds and the more fingers are on the glass,
  // pulsing with the bundle's flicker; down over half a second when let go.
  const charge = parts.charge[h];
  const held = parts.held[h];
  for (let f = 0; f < 5; f++) {
    const on = r.glow[f] > 0.5 && r.fade > 0.5;
    held[f] = on ? held[f] + dt : 0;
    const want = on ? (0.75 + 0.25 * Math.min(1, held[f] / 3)) * (0.8 + 0.2 * Math.min(1, touching / 3)) : 0;
    charge[f] += (want - charge[f]) * (1 - Math.exp(-dt / (want > charge[f] ? CHARGE_UP : CHARGE_DOWN)));
  }
  if (r.fade <= 0.5) {
    at.fill(0, corner * 3, (corner + MESH_CORNERS) * 3);
    return;
  }
  const t = handTemplates()[r.key.startsWith("Left") ? "left" : "right"];
  // One size for the whole hand, the size the rig draws a palm at; the pose keeps the hand's own proportions.
  pose(t, r.world, PALM, parts.pose);
  skin(t, parts.pose.frames, PALM, parts.skinned, 0);
  // Brightest at a touching fingertip, spreading down that finger into the palm; a little of every touching finger's
  // charge reaches the whole hand.
  let all = 0;
  for (let f = 0; f < 5; f++) all += charge[f] / 5;
  const pulse = Math.min(1.6, Math.max(0.5, 1 + (flicker - 1) * 1.6));
  // Pinching, the thumb and index tips glow too (cool, by the shader).
  for (let v = 0; v < t.count; v++) parts.vertexCharge[v] = (charge[t.finger[v]] * Math.pow(t.reach[v], 1.6) + all * 0.25) * pulse + (t.finger[v] < 2 ? r.pinch * t.tip[v] * 0.9 : 0);
  facets(t, parts.skinned, parts.vertexCharge, at, parts.meshNormal.array as Float32Array, parts.meshCharge.array as Float32Array, parts.meshTip.array as Float32Array, parts.meshBary.array as Float32Array, parts.meshCool.array as Float32Array, r.pinch, corner);
  // Where the drawn thumb and index tips are, for the pinch's arc.
  parts.tips[h].set(parts.pose.joints.subarray(12, 15), 0);
  parts.tips[h].set(parts.pose.joints.subarray(24, 27), 3);
  // The rest of this hand's share stays collapsed.
  at.fill(0, (corner + t.index.length) * 3, (corner + MESH_CORNERS) * 3);
}

// Segments in each pinch arc, and each segment's six corners: which end (0 near, 1 far) and which side.
const ARC = 10;
const ARC_CORNERS = [0, -1, 0, 1, 1, 1, 0, -1, 1, 1, 1, -1];
type ArcParts = { arc: THREE.Mesh; arcAt: THREE.BufferAttribute; arcLight: THREE.BufferAttribute; arcScratch: { a: THREE.Vector3; b: THREE.Vector3; p: THREE.Vector3; q: THREE.Vector3; side: THREE.Vector3; along: THREE.Vector3 }; tips: Float32Array[] };
// Each pinching hand's arc, from its drawn thumb tip to its drawn index tip, jagged afresh each frame, facing the eye.
function drawArcs(parts: ArcParts, rig: Rig, eye: THREE.Vector3) {
  const at = parts.arcAt.array as Float32Array;
  const light = parts.arcLight.array as Float32Array;
  const { a, b, p, q, side, along } = parts.arcScratch;
  let any = false;
  for (let h = 0; h < rig.hands.length; h++) {
    const r = rig.hands[h];
    const base = h * ARC * 6;
    const on = r.pinch > 0.01 && r.fade > 0.5;
    if (!on) {
      light.fill(0, base, base + ARC * 6);
      continue;
    }
    any = true;
    a.fromArray(parts.tips[h], 0);
    b.fromArray(parts.tips[h], 3);
    along.subVectors(b, a);
    side.subVectors(eye, a).cross(along).normalize();
    const width = 0.006;
    // The ends stay on the tips; between, each point is kicked sideways at random, most in the middle.
    let kick = 0;
    for (let i = 0; i < ARC; i++) {
      const next = i + 1 === ARC ? 0 : (Math.random() - 0.5) * 0.05 * Math.sin((Math.PI * (i + 1)) / ARC);
      p.copy(a).addScaledVector(along, i / ARC).addScaledVector(side, kick);
      q.copy(a).addScaledVector(along, (i + 1) / ARC).addScaledVector(side, next);
      kick = next;
      for (let c = 0; c < 6; c++) {
        const v = ARC_CORNERS[c * 2] ? q : p;
        const s = ARC_CORNERS[c * 2 + 1];
        const o = (base + i * 6 + c) * 3;
        at[o] = v.x + side.x * width * s;
        at[o + 1] = v.y + side.y * width * s;
        at[o + 2] = v.z + side.z * width * s;
        light[base + i * 6 + c] = r.pinch * (0.7 + 0.3 * Math.random());
      }
    }
  }
  parts.arc.visible = any;
  if (any) {
    parts.arcAt.needsUpdate = true;
    parts.arcLight.needsUpdate = true;
  }
}

export type RigHand = {
  key: string;
  slot: number;
  live: boolean;
  fade: number;
  // Where each landmark is on screen (NDC), and in the scene.
  ndc: Float32Array;
  world: Float32Array;
  // How much each fingertip glows, eased toward whether it is on the glass.
  glow: Float32Array;
  // Pinching (steering the view), how far into the pinch's look it is (eased), where the palm is on screen (NDC) as
  // tracked, and eased each frame (the steer, so the view glides between the tracker's answers instead of stepping);
  // and where the steer was last frame (or NaN), for the drag.
  pinching: boolean;
  pinch: number;
  rawX: number;
  rawY: number;
  pinchX: number;
  pinchY: number;
  lastX: number;
  lastY: number;
};

// How quickly a pinch's steer follows the hand (seconds): the tracker answers ~30 times a second, the screen draws
// up to 120, so without it the view would jump at each answer and hold between.
const STEER_EASE = 0.12;

export function createRig() {
  return {
    hands: Array.from({ length: DRAWN }, (): RigHand => ({ key: "", slot: -1, live: false, fade: 0, ndc: new Float32Array(42), world: new Float32Array(63), glow: new Float32Array(5), pinching: false, pinch: 0, rawX: 0, rawY: 0, pinchX: 0, pinchY: 0, lastX: NaN, lastY: NaN })),
    v: { dir: new THREE.Vector3(), far: new THREE.Vector3() },
    hits: new Float32Array(21),
    // How far a fingertip on the glass stands off it, so the contact's flare on the glass shows round its tip.
    standOff: 0.07,
    dirs: new Float32Array(63)
  };
}
export type Rig = ReturnType<typeof createRig>;

// Where a ray from the eye meets the front of the glass, or -1.
const meet = (o: THREE.Vector3, d: THREE.Vector3) => {
  const b = o.dot(d);
  const h = b * b - (o.lengthSq() - GLASS * GLASS);
  if (h < 0) return -1;
  const t = -b - Math.sqrt(h);
  return t > 0 ? t : -1;
};

// Each frame: every tracked hand onto the screen and into the scene, and faded in or out.
export function placeHands(rig: Rig, hands: Hands | null, camera: THREE.PerspectiveCamera, aspect: number, dt: number) {
  for (const r of rig.hands) r.live = false;
  if (hands) {
    const video = hands.video;
    const va = video.videoWidth / Math.max(1, video.videoHeight) || 4 / 3;
    const eye = camera.position;
    // The front of the glass as seen from here, for the hand's size on screen.
    const front = Math.max(0.5, eye.length() - GLASS * 0.8);
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    for (const [key, h] of hands.skeletons) {
      let r = rig.hands.find((x) => x.key === key);
      if (!r) r = rig.hands.find((x) => !x.live && x.fade < 0.01) ?? rig.hands.find((x) => !x.live);
      if (!r) continue;
      if (r.key !== key) r.glow.fill(0);
      r.key = key;
      r.slot = slotOf(key);
      r.live = true;
      place(rig, r, h, hands, camera, eye, aspect, va, front, tan);
    }
  }
  for (const r of rig.hands) {
    if (!r.live) r.pinching = false;
    r.pinch += ((r.pinching ? 1 : 0) - r.pinch) * Math.min(1, dt / 0.08);
    if (!r.pinching) r.lastX = r.lastY = NaN;
    else if (Number.isNaN(r.lastX)) {
      r.pinchX = r.rawX;
      r.pinchY = r.rawY;
    } else {
      const ease = 1 - Math.exp(-dt / STEER_EASE);
      r.pinchX += (r.rawX - r.pinchX) * ease;
      r.pinchY += (r.rawY - r.pinchY) * ease;
    }
    r.fade += ((r.live ? 1 : 0) - r.fade) * Math.min(1, dt / 0.08);
    if (r.fade < 0.002 && !r.live) r.fade = 0;
  }
}

function place(rig: Rig, r: RigHand, h: Hand, hands: Hands, camera: THREE.PerspectiveCamera, eye: THREE.Vector3, aspect: number, va: number, front: number, tan: number) {
  const p = h.points;
  const n = r.ndc;
  // The picture as a mirror, cropped to fill the screen.
  for (let k = 0; k < 21; k++) {
    const u = 1 - p[k * 2];
    const v = p[k * 2 + 1];
    const x = aspect > va ? u : (u - 0.5) * (va / aspect) + 0.5;
    const y = aspect > va ? (v - 0.5) * (aspect / va) + 0.5 : v;
    n[k * 2] = x * 2 - 1;
    n[k * 2 + 1] = 1 - y * 2;
  }
  // Then drawn at a natural size round the middle of its palm.
  const palm = Math.hypot((n[0] - n[18]) * aspect, n[1] - n[19]);
  const want = PALM / (front * tan);
  const k = THREE.MathUtils.clamp(want / Math.max(1e-4, palm), 0.05, 3);
  const cx = (n[0] + n[18]) / 2;
  const cy = (n[1] + n[19]) / 2;
  for (let i = 0; i < 21; i++) {
    n[i * 2] = cx + (n[i * 2] - cx) * k;
    n[i * 2 + 1] = cy + (n[i * 2 + 1] - cy) * k;
  }

  // The pinch steers by the palm's middle, which holds far steadier than the pinching tips (and is not moved by the
  // scaling above, which is about it).
  r.pinching = h.pinching;
  r.rawX = cx;
  r.rawY = cy;

  // Into the scene along each landmark's ray. Fingertips on the glass rest on it; the rest stands off toward the eye by
  // the hand's own depths. With none on the glass, the index tip hovers just off it.
  const { dir } = rig.v;
  let touching = 0;
  let reach = 0;
  let depth = 0;
  for (let i = 0; i < 21; i++) {
    dir.set(n[i * 2], n[i * 2 + 1], 0.5).unproject(camera).sub(eye).normalize();
    rig.dirs[i * 3] = dir.x;
    rig.dirs[i * 3 + 1] = dir.y;
    rig.dirs[i * 3 + 2] = dir.z;
    rig.hits[i] = meet(eye, dir);
  }
  for (let f = 0; f < 5; f++) {
    const on = hands.onGlass.has(r.slot * 5 + f);
    r.glow[f] += ((on ? 1 : 0) - r.glow[f]) * 0.25;
    const t = rig.hits[TIPS[f]];
    if (on && t > 0) {
      touching++;
      reach += t;
      depth += h.depth[TIPS[f]];
    }
  }
  if (touching > 0) {
    reach = reach / touching - rig.standOff;
    depth /= touching;
  } else {
    const t = rig.hits[8];
    reach = t > 0 ? t - 0.12 : eye.length() - GLASS * 0.5;
    depth = h.depth[8];
  }
  // MediaPipe's depth is on the scale of the picture's width.
  const palmX = Math.hypot(p[0] - p[18], (p[1] - p[19]) / va);
  const scale = PALM / Math.max(1e-4, palmX);
  for (let i = 0; i < 21; i++) {
    let d = reach - (h.depth[i] - depth) * scale;
    if (rig.hits[i] > 0) d = Math.min(d, rig.hits[i] - rig.standOff);
    d = Math.max(0.4, d);
    r.world[i * 3] = eye.x + rig.dirs[i * 3] * d;
    r.world[i * 3 + 1] = eye.y + rig.dirs[i * 3 + 1] * d;
    r.world[i * 3 + 2] = eye.z + rig.dirs[i * 3 + 2] * d;
  }
}

// The hands: one sculpted low-poly hand each (handmesh.ts), drawn solid in the scene, so they hide what is behind them
// (the user's choice); their fingertips stand a little off the glass, so each contact's flare shows round the tip.
export function HandsInScene({ rig, plasma }: { rig: Rig; plasma: Plasma }) {
  const camera = useThree((state) => state.camera);
  const parts = useMemo(() => {
    const contacts = uniformArray(plasma.hands, "vec4");
    // The hand's glow takes the gas's own violet.
    const tint = glow.inner as any;
    const p = positionWorld as any;
    const toEye = normalize(cameraPosition.sub(p)) as any;
    // The light here, from each contact, bright close by; and how bright a touching fingertip glows.
    const lightFrom = (n: any) => {
      // The electrode, from the middle of the globe.
      let light: any = glow.inner.mul(glow.power.mul(0.6).div(dot(p, p).mul(2).add(1))).mul(n ? max(dot(n, normalize(p.negate())), 0).mul(0.8).add(0.2) : float(1));
      for (let k = 0; k < CONTACTS; k++) {
        const c = contacts.element(k) as any;
        const off = c.xyz.mul(GLASS).sub(p) as any;
        const fall = c.w.div(dot(off, off).mul(30).add(1)) as any;
        light = light.add(mix(glow.outer, vec3(1, 0.9, 0.97), 0.25).mul(fall.mul(0.9)).mul(n ? max(dot(n, normalize(off)), 0).mul(0.8).add(0.2) : float(1)));
      }
      return light;
    };
    // Low poly: one continuous sculpted hand (handmesh.ts), chunky and faceted, skinned on the CPU each frame and
    // flat-shaded, each face its own normal; both hands in one buffer and one draw. Stylised as an energy-crystal hand:
    // a dim bisque body glowing by the gas's colour, each facet's edges lit brighter (from each corner's barycentric
    // place in its triangle) and a soft rim. Touching, it blazes: the finger goes pink-white, its edges light up like
    // circuitry, the glow floods down the finger into the palm and pulses with the bundle, for the bloom to catch; facets
    // and edges stay readable at the peak.
    const corners = DRAWN * MESH_CORNERS;
    const meshAt = new THREE.BufferAttribute(new Float32Array(corners * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const meshNormal = new THREE.BufferAttribute(new Float32Array(corners * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const meshCharge = new THREE.BufferAttribute(new Float32Array(corners), 1).setUsage(THREE.DynamicDrawUsage);
    const meshTip = new THREE.BufferAttribute(new Float32Array(corners), 1).setUsage(THREE.DynamicDrawUsage);
    const meshBary = new THREE.BufferAttribute(new Float32Array(corners * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const meshCool = new THREE.BufferAttribute(new Float32Array(corners), 1).setUsage(THREE.DynamicDrawUsage);
    const handGeometry = new THREE.BufferGeometry();
    handGeometry.setAttribute("position", meshAt);
    handGeometry.setAttribute("normal", meshNormal);
    handGeometry.setAttribute("aCharge", meshCharge);
    handGeometry.setAttribute("aTip", meshTip);
    handGeometry.setAttribute("aBary", meshBary);
    handGeometry.setAttribute("aCool", meshCool);
    const handMaterial = new THREE.MeshBasicNodeMaterial();
    const nrm = normalize(attribute("normal", "vec3")) as any;
    const bisque = vec3(0.8, 0.71, 0.59) as any;
    const sky = nrm.y.mul(0.5).add(0.5) as any;
    const facingEye = abs(dot(nrm, toEye)) as any;
    const rim = pow(float(1).sub(facingEye), 2.2) as any;
    const near = lightFrom(null) as any;
    const tipness = attribute("aTip", "float") as any;
    const charged = attribute("aCharge", "float") as any;
    // How near the edge of its facet, a line about a pixel and a half wide whatever the distance.
    const b3 = attribute("aBary", "vec3") as any;
    const edgeDistance = min(b3.x, min(b3.y, b3.z)) as any;
    const edge = float(1).sub(smoothstep(0, fwidth(edgeDistance).mul(1.6), edgeDistance)) as any;
    // A soft key light from above and in front, so the facets read.
    const key = max(dot(nrm, vec3(0.3, 0.75, 0.6).normalize()), 0) as any;
    // More contrast between faces lit by the key and those turned away, so the big facets read.
    const base = bisque.mul(sky.mul(0.08).add(0.06).add(key.mul(0.3))).add(bisque.mul(lightFrom(nrm)).mul(0.35)) as any;
    const hot = mix(glow.outer, vec3(1, 0.95, 1), 0.55) as any;
    // Pinching (steering the view), the hand cools to an icy blue and dims a little, so it reads as another mode.
    const cool = attribute("aCool", "float") as any;
    const energy = mix(mix(tint, hot, charged.min(1)), vec3(0.55, 0.85, 1), cool.mul(0.85)).mul(float(1).sub(cool.mul(0.25))) as any;
    const glowing = energy
      .mul(float(0.12).add(rim.mul(0.5)).add(charged.mul(0.9)))
      .add(energy.mul(edge.mul(float(0.38).add(charged.mul(2.8)))))
      .add(hot.mul(charged.mul(tipness).mul(2.2)))
      .add(near.mul(rim.mul(0.2))) as any;
    // Dev only: normals as colour, to check they point outward.
    const showNormals = uniform(0);
    handMaterial.colorNode = mix(vec4(base.add(glowing).mul(glow.exposure), 1), vec4(nrm.mul(0.5).add(0.5), 1), showNormals) as any;
    // The pinch's arc: a short jagged spark between thumb and index tips, icy white, while a hand steers the view.
    const arcAt = new THREE.BufferAttribute(new Float32Array(DRAWN * ARC * 6 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const arcLight = new THREE.BufferAttribute(new Float32Array(DRAWN * ARC * 6), 1).setUsage(THREE.DynamicDrawUsage);
    const arcGeometry = new THREE.BufferGeometry();
    arcGeometry.setAttribute("position", arcAt);
    arcGeometry.setAttribute("aLight", arcLight);
    const arcMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    arcMaterial.colorNode = vec4(vec3(0.75, 0.93, 1).mul(attribute("aLight", "float").mul(2.4)).mul(glow.exposure), 1) as any;
    const arc = new THREE.Mesh(arcGeometry, arcMaterial);
    arc.frustumCulled = false;
    arc.renderOrder = 7;
    const low = new THREE.Mesh(handGeometry, handMaterial);
    low.frustumCulled = false;
    low.visible = false;
    const handPose = newPose();
    const skinned = new Float32Array(4000 * 3);
    const vertexCharge = new Float32Array(4000);
    const charge = Array.from({ length: DRAWN }, () => new Float32Array(5));
    const held = Array.from({ length: DRAWN }, () => new Float32Array(5));

    return { showNormals, handGeometry, handMaterial, low, meshAt, meshNormal, arc, arcAt, arcLight, arcGeometry, arcMaterial, arcScratch: { a: new THREE.Vector3(), b: new THREE.Vector3(), p: new THREE.Vector3(), q: new THREE.Vector3(), side: new THREE.Vector3(), along: new THREE.Vector3() }, meshCharge, meshTip, meshBary, meshCool, tips: [new Float32Array(6), new Float32Array(6)], skinned, vertexCharge, pose: handPose, charge, held };
  }, [plasma]);
  useDispose(parts.handGeometry, parts.handMaterial, parts.arcGeometry, parts.arcMaterial);
  const desk = useSetting<boolean>("desk");
  // The sculpted hand takes about a tenth of a second to build: built while the page is idle once IRL Hands could be
  // used, never on a phone, and never in the frame a hand first appears.
  useEffect(() => {
    if (!desk) return;
    const idle = window.requestIdleCallback ? window.requestIdleCallback(() => handTemplates(), { timeout: 4000 }) : window.setTimeout(() => handTemplates(), 1500);
    return () => (window.cancelIdleCallback ? window.cancelIdleCallback(idle) : window.clearTimeout(idle));
  }, [desk]);

  useFrame((_, raw) => {
    const dt = Math.min(raw, 1 / 20);
    if (process.env.NODE_ENV !== "production") {
      const dev = (globalThis as { __plasmaHandsOptions?: { normals?: boolean } }).__plasmaHandsOptions;
      parts.showNormals.value = dev?.normals ? 1 : 0;
    }
    // The hand pops in and out with its tracking rather than fading.
    parts.low.visible = rig.hands.some((r) => r.fade > 0.5);
    drawArcs(parts, rig, camera.position);
    if (!rig.hands.some((r) => r.fade > 0)) return;

    // How many fingertips are on the glass, all hands together.
    let touching = 0;
    for (let h = 0; h < rig.hands.length; h++) for (let f = 0; f < 5; f++) if (rig.hands[h].glow[f] > 0.5) touching++;
    for (let h = 0; h < rig.hands.length; h++) skinHand(parts, h, rig.hands[h], dt, touching, plasma.totals.flicker);
    parts.meshAt.needsUpdate = true;
    parts.meshNormal.needsUpdate = true;
    parts.meshCharge.needsUpdate = true;
    parts.meshTip.needsUpdate = true;
    parts.meshBary.needsUpdate = true;
    parts.meshCool.needsUpdate = true;
  });

  return (
    <>
      <primitive object={parts.low} />
      <primitive object={parts.arc} />
    </>
  );
}
