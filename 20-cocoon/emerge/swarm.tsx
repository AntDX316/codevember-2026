"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { Fn, attribute, cameraPosition, clamp, cos, dot, float, fract, frontFacing, max, mix, normalWorld, normalize, positionWorld, pow, select, sin, smoothstep, step, time, uniform, uv, vec2, vec3 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { sound } from "../../shared/engine/sound";
import type { QualityTier } from "../../shared/engine/types";
import { sky } from "../../14-tension/backdrop";
import { mulberry32 } from "../../14-tension/web";
import { shakeDew } from "./drops";
import { atlasNode } from "./live";
import { SPECIES, SPECIES_NAMES, type SpeciesName } from "./species";
import { branchPath, branchSurface, makeHold } from "./twig";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Butterflies far off in the garden, soft in the lens: each a few cards cut from the same wing photographs, flapping
// in bouts and gliding, wandering on its own looping path that carries it out of view and back. All on the GPU.

// How far each one travels across the garden, out of view to out of view.
const SPAN = 70;

export function Swarm({ tier }: { tier: QualityTier }) {
  const count = tier === "low" ? 3 : 6;
  const { mesh, material } = useMemo(() => {
    const random = mulberry32(41);
    const geometry = new THREE.InstancedBufferGeometry();
    const pos: number[] = [];
    const corner: number[] = [];
    const wing: number[] = [];
    const index: number[] = [];
    for (let w = 0; w < 4; w++) {
      const base = w * 4;
      for (const [u, v] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1]
      ]) {
        pos.push(0, 0, 0);
        corner.push(u, v);
        wing.push(w);
      }
      if (w % 2 === 0) index.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      else index.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geometry.setAttribute("aCorner", new THREE.Float32BufferAttribute(corner, 2));
    geometry.setAttribute("aWing", new THREE.Float32BufferAttribute(wing, 1));
    geometry.setIndex(index);
    const path: number[] = [];
    const param: number[] = [];
    for (let i = 0; i < count; i++) {
      const kind = i % 4;
      const sp = SPECIES[SPECIES_NAMES[kind]];
      // Each crosses the garden on its own line, at its own depth, height, heading and pace, from out of view on one
      // side to out of view on the other; then, after a while away, comes through again.
      const heading = (random() < 0.5 ? 0 : Math.PI) + (random() - 0.5) * 0.7;
      const pace = (5 + random() * 6) * (kind === 3 ? 0.6 : kind === 2 ? 0.8 : 1);
      path.push((random() - 0.5) * 8, -1 + random() * 7, -17 - random() * 15, heading);
      param.push(pace / SPAN, i / count + random() * 0.1, kind, sp.wing * (0.75 + random() * 0.5));
    }
    geometry.setAttribute("aPath", new THREE.InstancedBufferAttribute(new Float32Array(path), 4));
    geometry.setAttribute("aParam", new THREE.InstancedBufferAttribute(new Float32Array(param), 4));
    geometry.instanceCount = count;

    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    material.alphaTest = 0.4;
    const P = attribute("aPath", "vec4") as any;
    const Q = attribute("aParam", "vec4") as any;
    const c = attribute("aCorner", "vec2") as any;
    const w = attribute("aWing", "float") as any;
    const hind = w.greaterThan(1.5).select(float(1), float(0)) as any;
    const left = w.mod(2).greaterThan(0.5).select(float(-1), float(1)) as any;
    // Each species' wing frames, picked by column.
    const frames = SPECIES_NAMES.map((n) => [SPECIES[n].fore, SPECIES[n].hind]);
    const col = Q.z as any;
    const pickFrame = (k: number) => select(col.lessThan(0.5), vec3(...frames[0][k]), select(col.lessThan(1.5), vec3(...frames[1][k]), select(col.lessThan(2.5), vec3(...frames[2][k]), vec3(...frames[3][k])))) as any;
    const frame = mix(pickFrame(0), pickFrame(1), hind) as any;
    const local = vec2(frame.x.add(c.x.mul(frame.z)), frame.y.sub(c.y.mul(frame.z))) as any;
    // Along its line: always travelling, never hanging in the air.
    const bySpecies = (v: number[]) => select(col.lessThan(0.5), float(v[0]), select(col.lessThan(1.5), float(v[1]), select(col.lessThan(2.5), float(v[2]), float(v[3])))) as any;
    const u = fract((time as any).mul(Q.x).add(Q.y)) as any;
    const along = vec3(cos(P.w), 0, sin(P.w)) as any;
    // Flap, flap, glide: a bout of beats climbing a little, then a glide of a fraction of a second, still moving on
    // and sinking; the glasswing hardly stops beating, the paper kite's glides are the longest.
    const hz = bySpecies(SPECIES_NAMES.map((n) => SPECIES[n].beat));
    const bout = bySpecies(SPECIES_NAMES.map((n) => (SPECIES[n].bout[0] + SPECIES[n].bout[1]) / 2 / SPECIES[n].beat));
    const glideFor = bySpecies(SPECIES_NAMES.map((n) => Math.min(0.9, (SPECIES[n].glideFor[0] + SPECIES[n].glideFor[1]) / 2)));
    const cycle = bout.add(glideFor) as any;
    const inCycle = fract((time as any).div(cycle).add(Q.y.mul(7.3))).mul(cycle) as any;
    const beating = smoothstep(0, 0.05, inCycle).mul(smoothstep(bout, bout.sub(0.05), inCycle)) as any;
    const glided = clamp(inCycle.sub(bout).div(glideFor), 0, 1) as any;
    const climbed = clamp(inCycle.div(bout), 0, 1) as any;
    const sink = mix(climbed.oneMinus(), glided, step(bout, inCycle)).mul(-0.35).mul(Q.w) as any;
    const beat = sin((time as any).mul(hz).mul(Math.PI * 2).add(Q.y.mul(40))) as any;
    const wander = sin(u.mul(9).add(Q.y.mul(20))).mul(0.9) as any;
    const at = P.xyz.add(along.mul(u.sub(0.5).mul(SPAN))).add(vec3(0, wander.add(sink).add(beat.mul(beating).mul(0.07).mul(Q.w)), sin(u.mul(5).add(Q.y.mul(11))).mul(1.5))) as any;
    const vel = normalize(along.add(vec3(0, cos(u.mul(9).add(Q.y.mul(20))).mul(0.12).add(beating.mul(0.1)).sub(beating.oneMinus().mul(0.12)), 0))) as any;
    const flap = mix(float(0.25).add(sin((time as any).mul(31).add(Q.y)).mul(0.02)), beat.mul(0.95).add(0.4), beating) as any;
    // Wing about the body axis (y), then the body turned to its heading and pitched up a little.
    const cf = cos(flap) as any;
    const sf = sin(flap) as any;
    const wx = local.x.mul(cf) as any;
    const wz = local.x.mul(sf) as any;
    const body = vec3(wx.mul(left), local.y, wz).mul(Q.w) as any;
    const forward = vec3(vel.x, vel.y.mul(0.5).add(0.3), vel.z).normalize() as any;
    const right = normalize(vec3(forward.z, 0, forward.x.negate())) as any;
    const up = normalize(right.cross(forward)) as any;
    material.positionNode = at.add(right.mul(body.x)).add(forward.mul(body.y)).add(up.mul(body.z)) as any;
    const row = hind.mul(2).add(select(frontFacing, float(0), float(1))) as any;
    // A hair inside the tile, so no neighbouring tile shows along the card's edge.
    const ci = c.clamp(0.006, 0.994) as any;
    const tex = atlasNode.sample(vec2(col.add(ci.x).div(4), float(1).sub(row.add(ci.y).div(4)))) as any;
    material.opacityNode = tex.a as any;
    material.colorNode = Fn(() => mix(tex.rgb.mul(sky.light.mul(sky.power).mul(0.35).add(sky.horizon.mul(0.35))), sky.horizon.mul(0.6), 0.45))() as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    return { mesh, material };
  }, [count]);
  useDispose(mesh.geometry, material);
  return (
    <>
      <primitive object={mesh} />
      <Visitor tier={tier} />
    </>
  );
}


// A visitor: now and then one of the garden's butterflies comes in out of the distance and settles on the branch for
// a while, well along it from the one that came out here, then goes again. Its wings are the far ones' wings, cards cut
// from the photographs (closed over its back a wing is as flat as a card), with a body, legs and antennae of its own;
// its feet are set on the bark as drawn. Flown as the other flies: a spring toward a point that runs along its way,
// heaved by each stroke, in beats and glides.

// What the scene tells it every frame (index.tsx): whether the one that came out here is busy (coming out, flying up
// or away), where on the branch it is (s; NaN when it is not on it), and its species. Busy until the scene says
// otherwise, so no visitor comes to a scene that does not say.
export const visitGate = { busy: true, heroS: NaN, species: "morpho" as SpeciesName };

// Where it may settle, either side of the chrysalis: nearer in while the branch is its own, further out past where the
// other walks while that one is on it.
const PERCHES: [number, number][] = [
  [-1.95, -1.6],
  [1.45, 1.75],
  [-2.5, -2.3],
  [1.95, 2.2]
];
const AWAY: [number, number] = [60, 130];
// In forewing lengths, in its body's own space (+x its right, +y toward the head, +z its back): where the wings are
// hinged, and how high over the smooth top of the bark it stands.
const ROOT = new THREE.Vector3(0.05, 0.005, 0.046);
const STAND = 0.1;
// The four legs it stands on (the forelegs are folded up out of sight): where each leaves the thorax, and how far
// along and round the bark its foot is set.
const LEGS = [
  { hip: new THREE.Vector3(0.03, 0.035, -0.045), along: 0.085, round: 0.62 },
  { hip: new THREE.Vector3(-0.03, 0.035, -0.045), along: 0.085, round: -0.62 },
  { hip: new THREE.Vector3(0.03, -0.02, -0.045), along: -0.06, round: 0.66 },
  { hip: new THREE.Vector3(-0.03, -0.02, -0.045), along: -0.06, round: -0.66 }
];
// Its wings at rest: closed over its back, the hindwings a hair outside the forewings.
const CLOSED = Math.PI / 2 - 0.03;
const UP = new THREE.Vector3(0, 1, 0);

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// A wing's card, set to a species' tile: its upper side faces its back (+z) when the wing is spread.
function wingCard(left: boolean) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(12), 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  geometry.setIndex(left ? [0, 1, 2, 1, 3, 2] : [0, 2, 1, 1, 2, 3]);
  return geometry;
}
function fitCard(geometry: THREE.BufferGeometry, [x0, y0, size]: readonly number[], left: boolean) {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1]
  ].forEach(([u, v], i) => position.setXYZ(i, (x0 + u * size) * (left ? -1 : 1), y0 - v * size, 0));
  position.needsUpdate = true;
  geometry.computeBoundingSphere();
}

function visitorWing(hind: number, column: any) {
  // (Little of the renderer's own specular, as on the other's wings: edge on, its grazing sheen would flash a pale card.)
  const m = new THREE.MeshPhysicalNodeMaterial({ side: THREE.DoubleSide, roughness: 0.75, metalness: 0, specularIntensity: 0.15 });
  m.alphaTest = 0.5;
  // (A hair inside the tile, as for the far ones.)
  const c = uv().clamp(0.006, 0.994) as any;
  const row = select(frontFacing, float(hind * 2), float(hind * 2 + 1)) as any;
  const tex = atlasNode.sample(vec2(column.add(c.x).div(4), float(1).sub(row.add(c.y).div(4)))) as any;
  m.colorNode = tex.rgb;
  m.opacityNode = tex.a;
  // The light through it, seen against the sun.
  const I = normalize(positionWorld.sub(cameraPosition)) as any;
  m.emissiveNode = tex.rgb.mul(sky.light.mul(sky.power)).mul(pow(max(dot(I, sky.toLight), 0), 3).mul(0.35)) as any;
  return m;
}

// The body turned on a lathe: head, thorax and the tapering abdomen, after the one in body.ts.
function bodyShape() {
  const points: THREE.Vector2[] = [];
  for (let i = 0; i <= 40; i++) {
    const y = 0.212 - (i / 40) * 0.712;
    const head = Math.abs(y - 0.166) < 0.046 ? Math.sqrt(0.046 ** 2 - (y - 0.166) ** 2) : 0;
    const t = (y - 0.012) / 0.12;
    const thorax = Math.abs(t) < 1 ? 0.062 * Math.sqrt(1 - Math.pow(Math.abs(t), 2.5)) : 0;
    const a = (-0.07 - y) / 0.43;
    const abdomen = a > 0 && a < 1 ? 0.046 * (0.6 + 0.4 * smooth(0, 0.24, a)) * (1 - 0.62 * smooth(0.24, 1, a)) * Math.sqrt(Math.min(1, (1 - a) / 0.05)) : 0;
    points.push(new THREE.Vector2(Math.max(head, thorax, y > 0.1 && y < 0.14 ? 0.03 : 0, abdomen, 0.0005), y));
  }
  points[0].x = 0;
  points[points.length - 1].x = 0;
  return new THREE.LatheGeometry(points.reverse(), 14);
}

function makeVisitor() {
  const object = new THREE.Group();
  object.visible = false;
  const column = uniform(0);
  const cards = [wingCard(false), wingCard(true), wingCard(false), wingCard(true)];
  const wingMaterials = [visitorWing(0, column), visitorWing(1, column)];
  // Fore right, fore left, hind right, hind left: each on its hinge.
  const hinges = cards.map((card, i) => {
    const hinge = new THREE.Group();
    hinge.position.set(ROOT.x * (i % 2 ? -1 : 1), ROOT.y, ROOT.z);
    const mesh = new THREE.Mesh(card, wingMaterials[i < 2 ? 0 : 1]);
    mesh.frustumCulled = false;
    hinge.add(mesh);
    object.add(hinge);
    return hinge;
  });
  const coat = uniform(new THREE.Color());
  const fur = uniform(new THREE.Color());
  const bodyMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  bodyMaterial.colorNode = coat as any;
  // Its fur catches the light along its edges.
  const facing = max(dot(normalWorld, normalize(cameraPosition.sub(positionWorld))), 0) as any;
  bodyMaterial.emissiveNode = (fur as any).mul(sky.light.mul(sky.power)).mul(pow(facing.oneMinus(), 3).mul(0.5)) as any;
  const body = new THREE.Mesh(bodyShape(), bodyMaterial);
  object.add(body);
  // Legs (two pieces each) and antennae (shaft and club): one tube, placed again every frame.
  const tube = new THREE.CylinderGeometry(1, 1, 1, 6, 1, false).translate(0, 0.5, 0);
  const limbs = new THREE.InstancedMesh(tube, bodyMaterial, 12);
  limbs.frustumCulled = false;
  object.add(limbs);

  const S = {
    mode: "away" as "away" | "in" | "sit" | "out",
    wait: 40 + Math.random() * 50,
    t: 0,
    T: 5,
    species: "monarch" as SpeciesName,
    FL: 1,
    s: 0,
    side: 1,
    facing: 1,
    hold: makeHold(),
    stand: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
    out: new THREE.Vector3(),
    way: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    // Left over from the flight when it touches down, taken up as it settles; and the settling itself.
    offset: new THREE.Vector3(),
    settle: 0,
    settleV: 0,
    rest: new THREE.Quaternion(),
    heading: new THREE.Vector3(1, 0, 0),
    bank: 0,
    phase: 0,
    flapping: true,
    bout: 0,
    angle: CLOSED,
    angleV: 0,
    // Legs: how far out for the bark (0 tucked up, 1 on it), and where each foot is set.
    reach: 0,
    feet: LEGS.map(() => new THREE.Vector3()),
    // Sitting: how long for, when it next opens its wings a little, and the opening under way.
    stay: 15,
    nextOpen: 4,
    open: -1,
    openFor: 2,
    openTo: 0.8,
    leaveIn: -1,
    rare: 1
  };
  const scratch = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), q: new THREE.Quaternion(), turn: new THREE.Quaternion(), m: new THREE.Matrix4(), right: new THREE.Vector3(), fwd: new THREE.Vector3(), up: new THREE.Vector3(), inv: new THREE.Matrix4(), s: new THREE.Vector3() };

  const dress = (name: SpeciesName) => {
    const sp = SPECIES[name];
    S.species = name;
    S.FL = sp.wing * (0.82 + Math.random() * 0.12);
    column.value = SPECIES_NAMES.indexOf(name);
    coat.value.set(sp.body);
    fur.value.set(sp.fur);
    for (let i = 0; i < 4; i++) fitCard(cards[i], i < 2 ? sp.fore : sp.hind, i % 2 === 1);
  };

  // A smooth way through the four points, as the other's flight to the branch.
  const along = (k: number, out: THREE.Vector3) => {
    const w = S.way;
    const seg = Math.min(2.999, Math.max(0, k) * 3);
    const i = Math.floor(seg);
    const x = seg - i;
    const p0 = i === 0 ? w[0] : w[i - 1];
    const p3 = i === 2 ? w[3] : w[i + 2];
    const x2 = x * x;
    const x3 = x2 * x;
    return out
      .copy(p0)
      .multiplyScalar(-0.5 * x3 + x2 - 0.5 * x)
      .addScaledVector(w[i], 1.5 * x3 - 2.5 * x2 + 1)
      .addScaledVector(w[i + 1], -1.5 * x3 + 2 * x2 + 0.5 * x)
      .addScaledVector(p3, 0.5 * x3 - 0.5 * x2);
  };

  // Its body's turn for a heading (level), a pitch up from it and a bank about its own length.
  const attitude = (heading: THREE.Vector3, pitch: number, bank: number, out: THREE.Quaternion) => {
    const { fwd, up, right, m, q } = scratch;
    fwd.copy(heading).multiplyScalar(Math.cos(pitch)).addScaledVector(UP, Math.sin(pitch));
    up.copy(heading).multiplyScalar(-Math.sin(pitch)).addScaledVector(UP, Math.cos(pitch));
    right.crossVectors(fwd, up);
    out.setFromRotationMatrix(m.makeBasis(right, fwd, up));
    return out.multiply(q.setFromAxisAngle(UP, bank));
  };

  // Whether a point is well inside the view (and clear of where the controls sit, on the right).
  const inView = (p: THREE.Vector3, camera: THREE.Camera, edge = 1, right = 0.6) => {
    const v = scratch.c.copy(p).project(camera);
    return v.z < 1 && v.x > -0.8 * edge && v.x < right * edge && Math.abs(v.y) < 0.8 * edge;
  };

  // In it comes: out of the distance on its own side of the view, round behind the branch and down onto it facing
  // along it toward the chrysalis.
  const come = (camera: THREE.Camera, force = false, side = 0, species?: SpeciesName) => {
    // (Never while the other is busy, even when called for.)
    if (visitGate.busy) return false;
    const hero = visitGate.heroS;
    const others = SPECIES_NAMES.filter((n) => n !== visitGate.species);
    dress(species ?? others[Math.floor(Math.random() * others.length)]);
    // Where it would sit, and the top of its wings closed over it, both in the view (a smaller one if need be).
    const fits = (s: number) => {
      branchPath(s, S.hold);
      if (camera.position.distanceTo(S.hold.point) < 2.2 || !inView(S.hold.point, camera)) return false;
      const most = S.FL;
      for (let k = 1; k >= 0.8; k -= 0.05) {
        S.FL = most * k;
        if (inView(scratch.a.copy(S.hold.point).addScaledVector(S.hold.normal, 1.1 * S.FL), camera, 1.1, 0.6 / 1.1)) return true;
      }
      S.FL = most;
      return false;
    };
    // Nearer in where it is clear of the other (either side, when it is not on the branch), else further out.
    const options = PERCHES.map(([a, b]) => a + Math.random() * (b - a))
      .filter((s) => (side ? Math.sign(s) === side : Number.isNaN(hero) || Math.abs(s - hero) > 1.3))
      .map((s) => ({ s, rank: (Math.abs(s) > 1.9 ? 1 : 0) + Math.random() * 0.5 }))
      .sort((a, b) => a.rank - b.rank);
    const size = S.FL;
    const chosen = options.find((o) => {
      S.FL = size;
      return fits(o.s);
    });
    if (!chosen && !(force && options.length)) return false;
    if (!chosen) S.FL = size;
    S.s = (chosen ?? options[0]).s;
    const FL = S.FL;
    S.side = Math.sign(S.s);
    S.facing = -S.side;
    branchPath(S.s, S.hold);
    S.normal.copy(S.hold.normal);
    S.tangent.copy(S.hold.tangent);
    S.stand.copy(S.hold.point).addScaledVector(S.normal, STAND * FL);
    S.out.set(S.side, 0, 0);
    const [w0, w1, w2, w3] = S.way;
    w3.copy(S.stand);
    w2.copy(S.stand)
      .addScaledVector(S.normal, 0.55 * FL)
      .addScaledVector(S.tangent, -S.facing * 0.4 * FL)
      .add(scratch.a.set(0, 0, -0.2 * FL));
    w1.copy(S.stand).addScaledVector(S.out, 1.5).add(scratch.a.set(0, 0.9, -1.7));
    w0.copy(S.stand).addScaledVector(S.out, 5.5).add(scratch.a.set(0, 2.2, -7));
    // Its feet, where they will be set.
    const { fwd, up, right } = scratch;
    fwd.copy(S.tangent).multiplyScalar(S.facing);
    up.copy(S.normal).addScaledVector(fwd, -S.normal.dot(fwd)).normalize();
    right.crossVectors(fwd, up);
    S.rest.setFromRotationMatrix(scratch.m.makeBasis(right, fwd, up));
    // (A hair nose down, so the abdomen clears the bark.)
    S.rest.multiply(scratch.q.setFromAxisAngle(scratch.a.set(1, 0, 0), -0.05));
    LEGS.forEach((leg, i) => {
      branchSurface(S.s + S.facing * leg.along * FL, leg.round * S.facing, S.hold);
      S.feet[i].copy(S.hold.point);
    });
    S.T = 5.2 + Math.random() * 0.8;
    S.t = 0;
    S.pos.copy(w0);
    along(0.02, S.vel).sub(w0).multiplyScalar(1 / (0.02 * S.T));
    S.heading.set(S.vel.x, 0, S.vel.z).normalize();
    S.bank = 0;
    S.offset.set(0, 0, 0);
    S.reach = 0;
    S.flapping = true;
    S.bout = 0;
    S.angle = 0.6;
    S.angleV = 0;
    S.leaveIn = -1;
    S.mode = "in";
    object.visible = true;
    return true;
  };

  // Off again: up off the bark and away the way it came, out of the view.
  const go = () => {
    if (S.mode === "away" || S.mode === "out") return;
    const FL = S.FL;
    const from = S.mode === "sit";
    const [w0, w1, w2, w3] = S.way;
    w0.copy(S.pos);
    // (Up and on the way it faces, then round and away: never backwards off the bark.)
    w1.copy(S.pos)
      .addScaledVector(S.normal, 0.75 * FL)
      .addScaledVector(S.tangent, S.facing * 0.45 * FL)
      .add(scratch.a.set(0, 0, -0.15 * FL));
    w2.copy(S.stand).addScaledVector(S.out, 1.8).add(scratch.a.set(0, 1.6, -2.0));
    w3.copy(S.stand).addScaledVector(S.out, 6).add(scratch.a.set(0, 3, -8));
    if (from) {
      S.vel.set(0, 0, 0);
      S.heading.copy(S.tangent).multiplyScalar(S.facing).setY(0).normalize();
      shakeDew(0.3, S.stand);
      // (From the top of a stroke, so the first beat lifts it off the bark rather than pressing it down.)
      S.phase = Math.ceil(S.phase);
    }
    S.T = 4.6;
    S.t = 0;
    S.flapping = true;
    S.bout = 0;
    S.mode = "out";
  };

  // The wings: a beat (0 at the top of the stroke) to an angle above level.
  const stroke = (p: number, top: number, bottom: number) => bottom + (top - bottom) * (0.5 + 0.5 * Math.cos(Math.PI * 2 * p));

  const fly = (dt: number, camera: THREE.Camera) => {
    const sp = SPECIES[S.species];
    const FL = S.FL;
    S.t += dt;
    const coming = S.mode === "in";
    const u = Math.min(1, S.t / S.T);
    const brake = coming ? smooth(0.7, 0.97, u) : 0;
    const lift = coming ? 0 : 1 - smooth(0, 0.35, S.t);
    // Quick off the mark and slowing all the way in; from rest and quicker all the way out.
    const k = coming ? 1 - Math.pow(1 - u, 1.7) : Math.pow(u, 1.45);
    const lead = along(k, scratch.a);
    // Beats in bouts with glides between; none in the last of the way in, and a full bout to get off the bark.
    const hz = sp.beat * 0.6 * (1 + 0.3 * brake + 0.25 * lift);
    S.bout -= dt;
    // (Into the landing it beats to brake, whatever it was doing.)
    if (S.bout <= 0 || (!S.flapping && brake > 0.05)) {
      const glides = S.flapping && brake < 0.05 && lift < 0.05 && Math.random() < 0.7;
      S.flapping = !glides;
      S.bout = S.flapping ? (sp.bout[0] + Math.random() * (sp.bout[1] - sp.bout[0])) / hz : sp.glideFor[0] + Math.random() * (sp.glideFor[1] - sp.glideFor[0]);
      if (!coming && S.t < 0.5) S.bout = Math.max(S.bout, 5 / hz);
    }
    // A glide only ends at the top of a stroke, so the next beat starts where the wings are.
    const beating = S.flapping || S.phase % 1 > 0.02;
    if (beating) S.phase += hz * dt;
    else S.phase = Math.ceil(S.phase);
    const p = S.phase % 1;
    const [top, bottom] = sp.stroke;
    // (Shallow strokes into the landing and off the bark, so a wing never sweeps down through it.)
    let want = beating ? stroke(p, top, bottom + (top - bottom) * Math.max(0.45 * brake, 0.6 * lift)) : sp.dihedral;
    if (!coming && S.t < 0.18) want = top;
    const heave = beating ? Math.sin(Math.PI * 2 * p) : 0;
    // The spring, and the stroke's heave.
    const stiff = coming ? 16 + 90 * brake : 22;
    const bob = 0.035 * FL * (Math.PI * 2 * hz) ** 2 * (1 - 0.7 * brake);
    const acc = scratch.b
      .copy(lead)
      .sub(S.pos)
      .multiplyScalar(stiff)
      .addScaledVector(S.vel, -2 * Math.sqrt(stiff) * 0.85);
    acc.y += heave * bob;
    S.vel.addScaledVector(acc, dt);
    S.pos.addScaledVector(S.vel, dt);
    // Its heading follows its way (level), banked into turns; its body steep, reared back to brake.
    scratch.c.set(S.vel.x, 0, S.vel.z);
    const level = scratch.c.length();
    if (level > 0.05) {
      scratch.c.normalize();
      const turn = Math.atan2(S.heading.z * scratch.c.x - S.heading.x * scratch.c.z, S.heading.dot(scratch.c));
      // (Slowly while it is hardly moving, so it does not swing about on the spot.)
      S.heading.lerp(scratch.c, 1 - Math.exp(-dt * 5 * Math.min(1, level / 0.6))).normalize();
      S.bank += (THREE.MathUtils.clamp(-turn * 6, -0.5, 0.5) - S.bank) * (1 - Math.exp(-dt * 4));
    }
    let pitch = 0.6 + 0.45 * brake + 0.25 * lift - heave * 0.06;
    // Near the bark it may only rear up as far as keeps its abdomen clear of it.
    const above = scratch.c.copy(S.pos).sub(S.stand);
    const height = above.dot(S.normal) / FL;
    if (above.addScaledVector(S.normal, -height * FL).length() < 0.8 * FL) pitch = Math.min(pitch, Math.asin(THREE.MathUtils.clamp((height + 0.05) / 0.5, 0, 1)));
    attitude(S.heading, pitch, S.bank, scratch.turn);
    object.quaternion.slerp(scratch.turn, 1 - Math.exp(-dt * 9));
    if (coming) object.quaternion.slerp(S.rest, smooth(0.8, 1, u));
    S.angle = springTo(S.angle, want, coming && u >= 1 ? 22 : 70, dt);
    // Legs: out for the bark as it comes in, drawn up as it leaves.
    S.reach = coming ? smooth(0.72, 0.95, u) : Math.max(0, S.reach - dt * 3);
    object.position.copy(S.pos);
    if (coming && u >= 1 && (S.pos.distanceTo(S.stand) < 0.04 * FL || S.t > S.T + 0.5)) {
      // Down: what is left of the flight is taken up as it settles onto its feet.
      S.mode = "sit";
      S.t = 0;
      S.offset.copy(S.pos).sub(S.stand);
      S.settle = 0;
      S.settleV = -0.45 * Math.min(1, S.vel.length() / 0.5 + 0.4);
      S.stay = 10 + Math.random() * 14;
      S.nextOpen = 2 + Math.random() * 3;
      S.open = -1;
      shakeDew(0.5, S.stand);
      sound.play("tick", { gain: 0.06, pitch: 1.7, pan: THREE.MathUtils.clamp(S.stand.x * 0.25, -0.7, 0.7) });
    }
    if (!coming && (S.t > S.T || (S.t > 1.5 && !inView(S.pos, camera, 1.6, 0.75) && !inView(scratch.c.copy(S.pos).addScaledVector(S.out, -0.6), camera, 1.6, 0.75)))) {
      S.mode = "away";
      object.visible = false;
      S.wait = (AWAY[0] + Math.random() * (AWAY[1] - AWAY[0])) * S.rare;
    }
  };

  const sit = (dt: number) => {
    const FL = S.FL;
    S.t += dt;
    // It settles: down onto its legs and up again, quickly still.
    const w = 15;
    S.settleV += (-w * w * S.settle - 2 * 0.45 * w * S.settleV) * dt;
    S.settle += S.settleV * dt;
    S.offset.multiplyScalar(Math.exp(-dt * 9));
    S.pos.copy(S.stand).add(S.offset).addScaledVector(S.normal, S.settle * FL);
    object.position.copy(S.pos);
    object.quaternion.slerp(S.rest, 1 - Math.exp(-dt * 12));
    object.quaternion.multiply(scratch.q.setFromAxisAngle(scratch.a.set(1, 0, 0), S.settle * 1.2));
    S.reach = 1;
    // Its wings: closed; once or twice opened a little and slowly, and closed again.
    let want = CLOSED;
    if (S.open < 0 && S.t > S.nextOpen && S.t < S.stay - 3) {
      S.open = 0;
      S.openFor = 1.2 + Math.random() * 1.6;
      S.openTo = 0.45 + Math.random() * 0.5;
    }
    if (S.open >= 0) {
      S.open += dt;
      const e = smooth(0, 0.9, S.open) * (1 - smooth(0.9 + S.openFor, 1.8 + S.openFor, S.open));
      want = CLOSED - (CLOSED - S.openTo) * e;
      if (S.open > 1.8 + S.openFor) {
        S.open = -1;
        S.nextOpen = S.t + 3 + Math.random() * 6;
      }
    }
    S.angle = springTo(S.angle, want, S.t < 0.5 ? 18 : 8, dt);
    if (S.t > S.stay) go();
  };

  // Critically damped, toward a moving angle (stepped exactly, so stable at any stiffness).
  const springTo = (x: number, to: number, w: number, dt: number) => {
    const e = Math.exp(-w * dt);
    const d = x - to;
    const k = (S.angleV + w * d) * dt;
    S.angleV = (S.angleV - w * k) * e;
    return to + (d + k) * e;
  };

  // The legs and antennae, from where its feet are.
  const limbsAt = (time: number) => {
    const { a, b, c, m, q, s, inv } = scratch;
    object.updateMatrixWorld();
    inv.copy(object.matrixWorld).invert();
    let n = 0;
    const put = (from: THREE.Vector3, to: THREE.Vector3, r: number) => {
      s.copy(to).sub(from);
      const length = s.length();
      q.setFromUnitVectors(UP, s.multiplyScalar(1 / Math.max(1e-6, length)));
      limbs.setMatrixAt(n++, m.compose(from, q, s.set(r, length, r)));
    };
    LEGS.forEach((leg, i) => {
      const x = Math.sign(leg.hip.x);
      // Tucked up under the thorax, or out to its foot on the bark.
      a.set(leg.hip.x * 1.6, leg.hip.y - 0.03, leg.hip.z - 0.045);
      b.copy(S.feet[i]).applyMatrix4(inv);
      a.lerp(b, smooth(0, 1, S.reach));
      c.copy(leg.hip).lerp(a, 0.45).add(scratch.fwd.set(x * 0.035, 0, 0.04 + 0.03 * (1 - S.reach)));
      put(leg.hip, c, 0.0075);
      put(c, a, 0.0055);
    });
    // Antennae from between the eyes, up and forward and a little apart, swaying a little.
    for (const x of [1, -1]) {
      a.set(x * 0.012, 0.2, 0.025);
      const sway = Math.sin(time * 1.3 + x) * 0.03;
      b.set(x * (0.11 + sway), 0.5, 0.2 + sway).sub(a).normalize();
      c.copy(a).addScaledVector(b, 0.36);
      put(a, c, 0.0032);
      put(c, a.copy(c).addScaledVector(b, 0.06), 0.0068);
    }
    limbs.instanceMatrix.needsUpdate = true;
  };

  const update = (dt: number, time: number, camera: THREE.Camera) => {
    if (S.mode === "away") {
      if (visitGate.busy) return;
      S.wait -= dt;
      if (S.wait <= 0 && !come(camera)) S.wait = 8;
      return;
    }
    // The other one coming near, or setting out, sends it off (with a moment's start if it is sitting).
    const hero = visitGate.heroS;
    const crowded = visitGate.busy || (!Number.isNaN(hero) && Math.abs(hero - S.s) < 1.1);
    if (S.mode === "in" && crowded) go();
    if (S.mode === "sit" && crowded && S.leaveIn < 0) S.leaveIn = 0.3 + Math.random() * 0.9;
    if (S.leaveIn >= 0) {
      S.leaveIn -= dt;
      if (S.leaveIn < 0) go();
    }
    if (S.mode === "sit") sit(dt);
    else fly(dt, camera);
    if ((S.mode as string) === "away") return;
    object.scale.setScalar(S.FL);
    hinges.forEach((hinge, i) => {
      // The hindwings follow the forewings a moment behind, and lie a hair outside them.
      const angle = i < 2 ? S.angle : S.angle - 0.035 - S.angleV * 0.012;
      hinge.rotation.set(0, i % 2 ? angle : -angle, 0);
    });
    limbsAt(time);
  };

  const dispose = () => {
    cards.forEach((c) => c.dispose());
    wingMaterials.forEach((m) => m.dispose());
    bodyMaterial.dispose();
    body.geometry.dispose();
    tube.dispose();
    limbs.dispose();
  };
  return { object, S, come, go, update, dispose };
}

function Visitor({ tier }: { tier: QualityTier }) {
  const camera = useThree((state) => state.camera);
  const visitor = useMemo(() => makeVisitor(), []);
  // Rarer on the lowest tier.
  visitor.S.rare = tier === "low" ? 2 : 1;
  useEffect(() => visitor.dispose, [visitor]);
  useFrame((state, delta) => visitor.update(Math.min(delta, 1 / 20), state.clock.elapsedTime, camera));
  // In development: `__visit()` from the console brings one in now (`__visit(-1, "monarch")`: on the left, a monarch);
  // `__visit.go()` sends it off.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (globalThis as Record<string, unknown>).__visit = Object.assign((side?: number, species?: SpeciesName) => visitor.come(camera, true, side, species), { go: visitor.go, S: visitor.S, object: visitor.object, gate: visitGate });
  }, [visitor, camera]);
  return <primitive object={visitor.object} />;
}
