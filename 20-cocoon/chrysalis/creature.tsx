"use client";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  atan,
  attribute,
  cameraPosition,
  cos,
  cross,
  dot,
  exp,
  float,
  fract,
  int,
  length,
  max,
  mix,
  mx_noise_float,
  normalize,
  positionGeometry,
  pow,
  sin,
  smoothstep,
  varying,
  vec3
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import type { QualityTier } from "../../shared/engine/types";
import { DISSOLVE, type Live, WINGS } from "./live";
import { rng } from "./shape";

// What comes out: a creature made of light, three pairs of membranes folded small that open out like wings and petals,
// oil-on-water colours playing over them as they turn, and then come apart from the tips into drifting sparks.

// Each wing: its span and height, and its outline (0 forewing, 1 hindwing, 2 a long trailing streamer).
export const WING_SHAPES = [
  { span: 1.0, height: 0.66, kind: 0 },
  { span: 0.74, height: 0.54, kind: 1 },
  { span: 0.62, height: 0.16, kind: 2 }
];

// Half the wing's height at u along it, as a fraction (the membrane spans -1 to 1 across): rounded at the root,
// widest past the middle, scalloped round the tip. Written for the CPU too, to scatter sparks inside it.
function outlineJs(u: number, kind: number, upper: boolean) {
  if (kind === 2) return Math.pow(Math.max(Math.sin(Math.PI * Math.pow(u, 0.5)), 0), 0.8) * (1 - 0.6 * u);
  const body = Math.pow(Math.max(Math.sin(Math.PI * Math.pow(u, 0.8)), 0), 0.6) * (0.55 + 0.45 * u);
  const scallop = 1 - 0.07 * Math.pow(Math.abs(Math.sin(u * Math.PI * 6)), 2) * u;
  return body * scallop * (upper ? 1 : kind === 0 ? 0.82 : 1.1);
}
function outline(u: any, w: any, kind: any) {
  const body = pow(max(sin(pow(u, float(0.8)).mul(Math.PI)), float(0)), float(0.6)).mul(u.mul(0.45).add(0.55)) as any;
  const scallop = float(1).sub(pow(abs(sin(u.mul(Math.PI * 6))), float(2)).mul(0.07).mul(u)) as any;
  const lower = kind.lessThan(0.5).select(float(0.82), float(1.1)) as any;
  const wing = body.mul(scallop).mul(w.greaterThan(0).select(float(1), lower)) as any;
  const streamer = pow(max(sin(pow(u, float(0.5)).mul(Math.PI)), float(0)), float(0.8)).mul(float(1).sub(u.mul(0.6))) as any;
  return kind.greaterThan(1.5).select(streamer, wing) as any;
}

// Where a point of a wing is, in the wing's own frame (x along it, z out of it), as open as `open` is: folded small,
// pleated like a fan and curled forward; then spread flat with a slight cup, breathing.
function shapeWing(u: any, v: any, span: any, height: any, open: any, breathe: any, now: any, seed: any) {
  const closed = float(1).sub(open) as any;
  const x = u.mul(span).mul(mix(float(0.16), float(1), open)) as any;
  const y = v.sub(0.5).mul(height).mul(mix(float(0.32), float(1), open)) as any;
  const pleat = sin(u.mul(30).add(v.mul(2))).mul(0.045).mul(closed) as any;
  const curl = u.mul(u).mul(span).mul(0.35).mul(closed) as any;
  const cup = sin(u.mul(Math.PI)).mul(span).mul(0.07).mul(open) as any;
  const wave = sin(now.mul(2.1).add(u.mul(3.5)).add(v.mul(2.5)).add(seed)).mul(u).mul(0.05).mul(breathe) as any;
  return vec3(x, y, pleat.add(curl).add(cup).add(wave)) as any;
}

// q turns v.
const rotate = (q: any, v: any) => {
  const t = cross(q.xyz, v).mul(2) as any;
  return v.add(t.mul(q.w)).add(cross(q.xyz, t)) as any;
};

// From a wing's own frame into the world: turned by the wing's hinge, mirrored for the left side, turned with the
// creature, and carried to where it floats.
function place(live: Live, index: any, side: any, local: any) {
  const pose = live.wingPose.element(index) as any;
  const q = live.wingTurn.element(index) as any;
  const onRight = rotate(q, local).add(pose.xyz) as any;
  const mirrored = vec3(onRight.x.mul(side), onRight.y, onRight.z) as any;
  const c = cos(live.yaw) as any;
  const s = sin(live.yaw) as any;
  return vec3(mirrored.x.mul(c).add(mirrored.z.mul(s)), mirrored.y, mirrored.z.mul(c).sub(mirrored.x.mul(s))).add(live.origin) as any;
}

// Where each point of a wing gives way, from 0 to 1: tips first, ragged.
const giveWay = (u: any, v: any, index: any) => u.mul(0.62).add(mx_noise_float(vec3(u.mul(4.5), v.mul(4.5), index.mul(7.1))).mul(0.5).add(0.5).mul(0.38)) as any;

// Oil on water: the colour light takes from a film this many nanometres thick, seen at this angle.
const thinFilm = (nm: any, facing: any) => {
  const path = nm.mul(2.66).mul(facing) as any;
  return vec3(cos(path.div(650).mul(Math.PI * 2)), cos(path.div(530).mul(Math.PI * 2)), cos(path.div(450).mul(Math.PI * 2))).mul(0.5).add(0.5) as any;
};

function buildWings() {
  const across = 40;
  const down = 30;
  const positions: number[] = [];
  const wing: number[] = [];
  const index: number[] = [];
  let base = 0;
  for (let w = 0; w < WINGS * 2; w++) {
    const which = w >> 1;
    const side = w % 2 === 0 ? 1 : -1;
    const shape = WING_SHAPES[which];
    for (let j = 0; j <= down; j++) {
      for (let i = 0; i <= across; i++) {
        positions.push(i / across, j / down, 0);
        wing.push(which, side, shape.span, shape.height);
      }
    }
    for (let j = 0; j < down; j++) {
      for (let i = 0; i < across; i++) {
        const a = base + j * (across + 1) + i;
        const b = a + across + 1;
        index.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    base += (across + 1) * (down + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aWing", new THREE.Float32BufferAttribute(wing, 4));
  geometry.setIndex(index);
  return geometry;
}

function makeWingMaterial(live: Live) {
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: true, fog: false });
  material.alphaTest = 0.01;
  const info = attribute("aWing", "vec4") as any;
  const index = int(info.x) as any;
  const u = positionGeometry.x as any;
  const v = positionGeometry.y as any;
  const open = (live.wingPose.element(index) as any).w;
  const seed = info.x.mul(1.7).add(info.y) as any;
  const at = (du: number, dv: number) => shapeWing(u.add(du), v.add(dv), info.z, info.w, open, live.flap, live.now, seed);
  const here = at(0, 0);
  const world = place(live, index, info.y, here);
  material.positionNode = world;
  // The facing, by stepping a little along and across the wing.
  const alongWorld = place(live, index, info.y, at(0.01, 0)).sub(world) as any;
  const acrossWorld = place(live, index, info.y, at(0, 0.01)).sub(world) as any;
  const normal = varying(normalize(cross(alongWorld, acrossWorld).add(vec3(0, 0, 1e-6)))) as any;
  const worldPos = varying(world) as any;

  const w = v.mul(2).sub(1) as any;
  const kind = info.x as any;
  const edge = outline(u, w, kind) as any;
  const inside = smoothstep(edge, edge.sub(0.04), abs(w)) as any;
  const rim = smoothstep(edge.sub(0.16), edge, abs(w)).mul(inside) as any;
  // Veins fanning from the root, and a ring like an eyespot near the forewing's tip.
  const fan = atan(w.mul(0.5), u.add(0.06)) as any;
  const veins = float(1).sub(smoothstep(0, 0.05, abs(fract(fan.mul(3.2).add(0.5)).sub(0.5)))).mul(smoothstep(0.05, 0.25, u)) as any;
  const eye = kind.lessThan(0.5).select(smoothstep(0.03, 0, abs(length(vec3(u.sub(0.7), w.sub(0.22).mul(0.6), 0)).sub(0.075))), float(0)) as any;

  const toEye = normalize(cameraPosition.sub(worldPos)) as any;
  const facing = abs(dot(normal, toEye)) as any;
  const fresnel = pow(float(1).sub(facing), float(3)) as any;
  const nm = mx_noise_float(vec3(u.mul(3), v.mul(3), seed)).mul(260).add(420).add(u.mul(160)) as any;
  const colours = thinFilm(nm, mix(float(1), facing, 0.85)) as any;
  const hue = mix(colours, live.wing, 0.3) as any;

  const span = live.now.sub(live.dissolveAt).div(DISSOLVE) as any;
  const left = float(1).sub(span) as any;
  const breaking = giveWay(u, v, info.x) as any;
  const kept = smoothstep(0, 0.04, left.sub(breaking)) as any;
  const ember = smoothstep(0.08, 0, abs(left.sub(breaking))).mul(span.greaterThan(0).select(float(1), float(0))) as any;

  const glow = float(0.1).add(fresnel.mul(0.7)).add(veins.mul(0.45)).add(rim.mul(0.9)).add(eye.mul(1.2)) as any;
  const unfolding = smoothstep(0, 0.25, open) as any;
  material.colorNode = hue.mul(glow.mul(kept).add(ember.mul(2.5))).mul(1.8).mul(live.shown).mul(unfolding) as any;
  material.opacityNode = inside.mul(max(kept, ember)).mul(live.shown) as any;
  return material;
}

// Sparks: each belongs to one point on one wing, rides with it unseen, and lets go when that point gives way.
function makeSparks(count: number) {
  const random = rng(7);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const spot = new Float32Array(count * 4);
  const extra = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    // Bigger wings shed more.
    const pick = random();
    const wing = pick < 0.5 ? 0 : pick < 0.85 ? 1 : 2;
    const side = random() < 0.5 ? 1 : -1;
    let u = 0;
    let w = 0;
    for (let tries = 0; tries < 30; tries++) {
      u = random();
      w = random() * 2 - 1;
      if (Math.abs(w) < outlineJs(u, WING_SHAPES[wing].kind, w > 0) * 0.95) break;
    }
    spot.set([wing, side, u, (w + 1) / 2], i * 4);
    extra.set([random(), random(), random(), 0.0025 + random() * random() * random() * 0.009], i * 4);
  }
  geometry.setAttribute("aSpot", new THREE.InstancedBufferAttribute(spot, 4));
  geometry.setAttribute("aExtra", new THREE.InstancedBufferAttribute(extra, 4));
  geometry.instanceCount = count;
  return geometry;
}

function makeSparkMaterial(live: Live) {
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: true, fog: false });
  material.alphaTest = 0.35;
  const spot = attribute("aSpot", "vec4") as any;
  const extra = attribute("aExtra", "vec4") as any;
  const index = int(spot.x) as any;
  const shape = (n: number) => WING_SHAPES[n];
  const span = index.equal(0).select(float(shape(0).span), index.equal(1).select(float(shape(1).span), float(shape(2).span))) as any;
  const height = index.equal(0).select(float(shape(0).height), index.equal(1).select(float(shape(1).height), float(shape(2).height))) as any;
  const open = (live.wingPose.element(index) as any).w;
  const seed = spot.x.mul(1.7).add(spot.y) as any;
  const anchor = place(live, index, spot.y, shapeWing(spot.z, spot.w, span, height, open, live.flap, live.now, seed)) as any;
  const letGo = live.dissolveAt.add(float(1).sub(giveWay(spot.z, spot.w, spot.x)).mul(DISSOLVE)) as any;
  const age = live.now.sub(letGo) as any;
  const a = age.max(0) as any;
  // Out from the middle and up, slowing, wandering on a lazy curl.
  const away = normalize(anchor.sub(live.origin).add(vec3(0, 0.3, 0))) as any;
  const drift = away.mul(float(1).sub(exp(a.mul(-0.7))).mul(extra.x.mul(0.5).add(0.25))).add(vec3(0, a.mul(0.09).add(a.mul(a).mul(0.006)), 0)) as any;
  const wander = vec3(sin(a.mul(0.9).add(extra.y.mul(20))), cos(a.mul(0.7).add(extra.z.mul(20))), sin(a.mul(1.1).add(extra.x.mul(20)))).mul(a.mul(0.05)) as any;
  const centre = anchor.add(drift).add(wander) as any;
  const twinkle = sin(live.now.mul(extra.y.mul(9).add(4)).add(extra.z.mul(40))).mul(0.35).add(0.65) as any;
  const life = smoothstep(0, 0.12, age).mul(float(1).sub(smoothstep(2.5, 6.5, age.add(extra.x.mul(1.5))))) as any;
  const radius = extra.w.mul(mix(float(1.6), float(1), smoothstep(0, 1, a))) as any;
  const toEye = normalize(cameraPosition.sub(centre)) as any;
  const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(1e-5, 0, 0))) as any;
  const up = cross(toEye, right) as any;
  material.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius))).add(up.mul(positionGeometry.y.mul(radius))) as any;
  const r2 = dot(positionGeometry.xy, positionGeometry.xy) as any;
  const disc = float(1).sub(smoothstep(0.55, 1, r2)) as any;
  const film = thinFilm(extra.z.mul(300).add(400), float(0.8)) as any;
  const hue = mix(film, vec3(1, 1, 1), extra.x.mul(extra.x).mul(0.6)).mul(mix(live.wing, vec3(1, 1, 1), 0.5)) as any;
  material.colorNode = hue.mul(exp(r2.mul(-2.5)).mul(2.6)).mul(twinkle).mul(life) as any;
  material.opacityNode = disc.mul(life.greaterThan(0.01).select(float(1), float(0))) as any;
  return material;
}

// A soft light at the creature's heart, and a thin body of light down its middle.
function makeCore(live: Live) {
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const size = float(0.75) as any;
  const centre = live.origin as any;
  const toEye = normalize(cameraPosition.sub(centre)) as any;
  const right = normalize(cross(vec3(0, 1, 0), toEye).add(vec3(1e-5, 0, 0))) as any;
  const up = cross(toEye, right) as any;
  material.positionNode = centre.add(right.mul(positionGeometry.x.mul(size))).add(up.mul(positionGeometry.y.mul(size))) as any;
  const x = positionGeometry.x as any;
  const y = positionGeometry.y as any;
  const halo = exp(dot(positionGeometry.xy, positionGeometry.xy).mul(-9)) as any;
  const spine = exp(x.mul(x).mul(-1800)).mul(smoothstep(0.42, 0.1, abs(y.sub(0.02)))) as any;
  const fade = float(1).sub(smoothstep(0, DISSOLVE, live.now.sub(live.dissolveAt))) as any;
  material.colorNode = live.wing.mul(halo.mul(0.35).add(spine.mul(1.6))).mul(live.shown).mul(fade) as any;
  return material;
}

export function Creature({ live, tier }: { live: Live; tier: QualityTier }) {
  const group = useRef<THREE.Group>(null);
  // Nothing to draw until something has come out.
  // Drawn (to nothing) for the first few frames, so its shaders are built while loading rather than when it hatches.
  const frames = useRef(0);
  useFrame(() => {
    frames.current++;
    if (group.current) group.current.visible = live.shown.value > 0.001 || frames.current < 4;
  });
  const count = tier === "low" ? 900 : tier === "medium" ? 1600 : 2400;
  const wingGeometry = useMemo(() => buildWings(), []);
  const wingMaterial = useMemo(() => makeWingMaterial(live), [live]);
  const sparkGeometry = useMemo(() => makeSparks(count), [count]);
  const sparkMaterial = useMemo(() => makeSparkMaterial(live), [live]);
  const coreGeometry = useMemo(() => new THREE.PlaneGeometry(2, 2), []);
  const coreMaterial = useMemo(() => makeCore(live), [live]);
  useDispose(wingGeometry, wingMaterial, sparkGeometry, sparkMaterial, coreGeometry, coreMaterial);
  return (
    <group ref={group}>
      <mesh geometry={wingGeometry} material={wingMaterial} frustumCulled={false} renderOrder={2} raycast={() => null} />
      <mesh geometry={sparkGeometry} material={sparkMaterial} frustumCulled={false} renderOrder={3} raycast={() => null} />
      <mesh geometry={coreGeometry} material={coreMaterial} frustumCulled={false} renderOrder={4} raycast={() => null} />
    </group>
  );
}
