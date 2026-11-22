"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { abs, attribute, cameraPosition, clamp, cross, dot, exp, float, fract, fwidth, length, max, mix, mx_noise_float, normalize, positionGeometry, positionWorld, pow, reflect, sin, smoothstep, step, texture, uniform, uv, varying, vec2, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { lehmer } from "../../shared/engine/random";
import { filmTable, SCALE } from "./film";
import { CEILING, FLOOR } from "./room";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The pop's wave, slowed down so it can be seen: it runs out from the middle, meets the walls, and comes back to the
// middle as an echo, over and over, each time weaker and cooler. Drawn as a sphere bouncing between the middle and the
// room's furthest reach, so each return lands ROUND seconds after the last.
export const SPEED = 36;
export const REACH = 13.5;
export const ROUND = (2 * REACH) / SPEED;
export const BOUNCES = 4;
// How strong, and what colour, the wave is after each reflection.
export const AMP = [1, 0.62, 0.42, 0.28, 0.18];
export const TINT = [new THREE.Color(1, 0.84, 0.66), new THREE.Color(0.32, 0.86, 1), new THREE.Color(0.28, 0.52, 1), new THREE.Color(0.46, 0.38, 1), new THREE.Color(0.66, 0.34, 0.95)];
// How fast the tear runs across the letters, in metres a second: slow motion.
export const TEAR_SPEED = 4.2;

export const u = {
  clock: uniform(0) as any,
  // Seconds since the pop (huge before any), and how hard it was.
  age: uniform(1000) as any,
  strength: uniform(1) as any,
  // How long the scanned lines linger.
  linger: uniform(1) as any,
  // The bubble: its own glow, wobble, and the tear (seconds, below zero when whole) from a point in its own space.
  glow: uniform(1) as any,
  wobble: uniform(0.3) as any,
  tear: uniform(-1) as any,
  tearAt: uniform(new THREE.Vector3()) as any,
  // The echo's ghost of the letters.
  ghost: uniform(0) as any,
  ghostTint: uniform(new THREE.Color(0.3, 0.8, 1)) as any,
  // The front in the air: its radius, strength and colour.
  shell: uniform(0) as any,
  shellLevel: uniform(0) as any,
  shellTint: uniform(new THREE.Color(1, 1, 1)) as any
};

// The bubble's light, roughly the colour the film throws.
const GLOW = vec3(0.62, 0.58, 0.95);

// Every time the wave has passed a point at distance d: when, and after how many reflections.
function passes(d: any) {
  const list: { t: any; e: number }[] = [];
  for (let b = 0; b < BOUNCES; b++) {
    list.push({ t: d.add(2 * b * REACH).div(SPEED), e: b });
    list.push({ t: float(2 * (b + 1) * REACH).sub(d).div(SPEED), e: b + 1 });
  }
  return list;
}

// The concrete's colour: dark grey, mottled and a little stained.
function concrete(p: any) {
  const big = mx_noise_float(p.mul(0.35)) as any;
  const small = mx_noise_float(p.mul(2.7)) as any;
  return float(0.2).add(big.mul(0.07)).add(small.mul(0.035)) as any;
}

export function Room({ geometry }: { geometry: THREE.BufferGeometry }) {
  const material = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial();
    const p = positionWorld as any;
    const n = normalize(varying(attribute("normal", "vec3"))) as any;
    const d = length(p).toVar() as any;
    const toward = max(dot(n, p.negate().div(d)), float(0)).toVar() as any;
    const albedo = concrete(p).toVar() as any;

    // Contour lines: rings of equal distance from where the bubble was, the way a scanner draws a room.
    const spacing = 0.3;
    const fd = fwidth(d) as any;
    const toLine = abs(fract(d.div(spacing).add(0.5)).sub(0.5)).mul(spacing) as any;
    const line = float(1)
      .sub(smoothstep(0.008, fd.mul(1.2).add(0.012), toLine))
      .mul(float(1).sub(smoothstep(spacing * 0.2, spacing * 0.6, fd))) as any;
    // Scan dots on a grid laid along whichever world plane the face is closest to.
    const a = abs(n) as any;
    const flat = a.y.greaterThan(max(a.x, a.z)).select(p.xz, a.x.greaterThan(a.z).select(p.zy, p.xy)) as any;
    const cell = 0.22;
    const fu = length(fwidth(flat)) as any;
    const r = length(fract(flat.div(cell)).sub(0.5)).mul(cell) as any;
    const dots = float(1)
      .sub(smoothstep(0.016, fu.mul(0.9).add(0.02), r))
      .mul(float(1).sub(smoothstep(cell * 0.15, cell * 0.45, fu))) as any;

    let lit = vec3(0) as any;
    for (const { t, e } of passes(d)) {
      const age = u.age.sub(t) as any;
      const lag = age.mul(SPEED) as any;
      const on = smoothstep(-0.06, 0.01, lag) as any;
      // The front itself: a hot thin band with a soft wake, lighting the concrete as it goes.
      const front = exp(lag.max(0).negate().div(0.22)).mul(on) as any;
      const wash = exp(lag.max(0).negate().div(1.6)).mul(on) as any;
      // What it leaves behind: lines that glow on and fade.
      const trail = exp(age.max(0).negate().div(u.linger.mul(e === 0 ? 1.3 : 0.9))).mul(on) as any;
      const pattern = e === 0 ? line : dots.add(line.mul(0.25));
      const tint = vec3(TINT[e].r, TINT[e].g, TINT[e].b) as any;
      lit = lit.add(
        tint.mul(AMP[e]).mul(
          front
            .mul(pattern.mul(2.4).add(albedo.mul(1.6)))
            .add(wash.mul(albedo).mul(0.14))
            .add(trail.mul(pattern).mul(e === 0 ? 0.42 : 0.3))
        )
      );
    }
    // Faces turned to the middle catch more, and the far walls less, as sound spreads.
    const shade = toward.mul(0.7).add(0.3).mul(float(6).div(d.add(4))) as any;
    // The bubble's own light, falling away from the middle.
    const glow = GLOW.mul(u.glow)
      .mul(toward.mul(0.85).add(0.04))
      .mul(albedo)
      .div(d.mul(d).mul(0.09).add(1)) as any;
    m.colorNode = vec4(lit.mul(shade).mul(u.strength).add(glow.mul(1.6)), 1) as any;
    return m;
  }, []);
  useDispose(material);
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}

export function useFilm() {
  const table = useMemo(() => filmTable(), []);
  useDispose(table.texture);
  return table;
}

// The film's thickness at a point of the letters, in the table's units: swirled, drained thinner toward the top.
function thickness(pl: any) {
  const t = u.clock as any;
  const swirl = mx_noise_float(pl.mul(1.3).add(vec3(t.mul(0.07), t.mul(-0.11), t.mul(0.05)))) as any;
  const fine = mx_noise_float(pl.mul(3.6).add(vec3(t.mul(-0.13), t.mul(0.09), 0))) as any;
  return float(0.42).add(swirl.mul(0.22)).add(fine.mul(0.08)).sub(pl.y.mul(0.12)).max(0.02) as any;
}

// How far the tear has gone, and a point's distance from where it began.
const tearReach = () => u.tear.mul(TEAR_SPEED) as any;

// The bubble: the letters' back faces seen through the front, both added over the dark as a film glows.
export function Bubble({ geometry, table }: { geometry: THREE.BufferGeometry; table: ReturnType<typeof filmTable> }) {
  const materials = useMemo(() => {
    const make = (inside: boolean) => {
      const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: inside ? THREE.BackSide : THREE.FrontSide });
      const built = attribute("position", "vec3") as any;
      const bn = attribute("normal", "vec3") as any;
      const t = u.clock as any;
      // A slow wobble over the skin, and the torn edge curling back as it runs.
      const wob = sin(built.x.mul(2.6).add(t.mul(2.1)))
        .mul(sin(built.y.mul(3.1).sub(t.mul(1.7))))
        .mul(u.wobble.mul(0.035)) as any;
      const off = length(built.sub(u.tearAt)).sub(tearReach()) as any;
      const curl = u.tear.greaterThan(0).select(exp(off.max(0).negate().div(0.07)).mul(step(0, off)), float(0)) as any;
      m.positionNode = built.add(bn.mul(wob.add(curl.mul(0.05)))) as any;

      const pl = varying(attribute("position", "vec3")).toVar() as any;
      const n0 = normalize(varying(attribute("normal", "vec3"))) as any;
      const normal = inside ? n0.negate() : n0;
      const view = normalize(cameraPosition.sub(positionWorld)).toVar() as any;
      const facing = clamp(dot(normal, view), 0, 1).toVar() as any;
      const colour = texture(table.texture, vec2(thickness(pl).mul(SCALE / table.most), facing)).rgb as any;
      const rim = pow(float(1).sub(facing), float(2.5)) as any;
      const body = colour.mul(rim.mul(inside ? 1.6 : 2.6).add(inside ? 0.25 : 0.45)).add(GLOW.mul(rim.mul(0.12))) as any;
      // Torn away inside the reach, with a bright racing rim just outside it.
      const fromTear = length(pl.sub(u.tearAt)).sub(tearReach()) as any;
      const torn = u.tear.greaterThan(0) as any;
      const keep = torn.select(smoothstep(0, 0.012, fromTear), float(1)) as any;
      const edge = torn.select(exp(fromTear.max(0).negate().div(0.025)).mul(keep), float(0)) as any;
      // A soft glint, as if the film caught a lamp that is not there: the bubble is the only light.
      const bounce = reflect(view.negate(), normal) as any;
      const glint = pow(max(dot(bounce, vec3(-0.45, 0.75, 0.5).normalize()), float(0)), float(14)).mul(0.22) as any;
      const lit = body.add(vec3(glint.mul(inside ? 0.25 : 1))).mul(u.glow).add(vec3(1, 0.95, 0.9).mul(edge.mul(2.6))) as any;
      m.colorNode = vec4(lit.mul(keep), 1) as any;
      return m;
    };
    return { back: make(true), front: make(false) };
  }, [table]);
  useDispose(materials.back, materials.front);
  return (
    <>
      <mesh geometry={geometry} material={materials.back} renderOrder={2} frustumCulled={false} />
      <mesh geometry={geometry} material={materials.front} renderOrder={3} frustumCulled={false} />
    </>
  );
}

// The letters as the echo draws them when it comes home: an outline and scan lines in the echo's colour.
export function Ghost({ geometry }: { geometry: THREE.BufferGeometry }) {
  const material = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const n = normalize(varying(attribute("normal", "vec3"))) as any;
    const view = normalize(cameraPosition.sub(positionWorld)) as any;
    const rim = pow(float(1).sub(clamp(abs(dot(n, view)), 0, 1)), float(4)) as any;
    const y = positionWorld.y as any;
    const fy = fwidth(y) as any;
    const scan = float(1).sub(smoothstep(0.006, fy.add(0.012), abs(fract(y.mul(12).sub(u.clock.mul(0.4))).sub(0.5)).div(12))) as any;
    m.colorNode = vec4(u.ghostTint.mul(u.ghost).mul(rim.mul(1.8).add(scan.mul(0.15))), 1) as any;
    return m;
  }, []);
  useDispose(material);
  return <mesh geometry={geometry} material={material} renderOrder={4} frustumCulled={false} />;
}

// The wavefront in the air: a sphere seen only edge-on, so it reads as a ring round the middle until it passes the eye.
export function Shell() {
  const parts = useMemo(() => {
    const sphere = new THREE.SphereGeometry(1, 96, 48);
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    m.positionNode = positionGeometry.mul(u.shell) as any;
    const n = normalize(varying(positionGeometry)) as any;
    const view = normalize(cameraPosition.sub(positionWorld)) as any;
    const edge = pow(float(1).sub(clamp(abs(dot(n, view)), 0, 1)), float(4)) as any;
    m.colorNode = vec4(u.shellTint.mul(u.shellLevel).mul(edge.mul(0.7).add(0.002)), 1) as any;
    return { sphere, m };
  }, []);
  useDispose(parts.sphere, parts.m);
  return <mesh geometry={parts.sphere} material={parts.m} renderOrder={5} frustumCulled={false} />;
}

// Droplets thrown off the rim as it tears past them, flying out both sides of the film and falling, in slow motion.
export function Spray({ points, count, table }: { points: { at: Float32Array; dir: Float32Array; seeds: Float32Array }; count: number; table: ReturnType<typeof filmTable> }) {
  const parts = useMemo(() => {
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.setAttribute("aAt", new THREE.InstancedBufferAttribute(points.at, 3));
    quad.setAttribute("aDir", new THREE.InstancedBufferAttribute(points.dir, 3));
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(points.seeds, 4));
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.InstancedMesh(quad, m, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;

    const fly = () => {
      const at = attribute("aAt", "vec3") as any;
      const dir = attribute("aDir", "vec3") as any;
      const s = attribute("aSeed", "vec4") as any;
      const age = u.tear.sub(length(at.sub(u.tearAt)).div(TEAR_SPEED)) as any;
      const life = s.x.mul(1.1).add(0.45) as any;
      const alive = step(0, age).mul(step(age, life)).mul(u.tear.greaterThan(0).select(float(1), float(0))) as any;
      const across = at.sub(u.tearAt) as any;
      const away = normalize(across.sub(dir.mul(dot(across, dir))).add(vec3(0.0001, 0.0002, 0))) as any;
      const side = step(0.5, s.w).mul(2).sub(1) as any;
      const vel = dir.mul(side.mul(s.y.mul(1.1).add(0.15))).add(away.mul(s.z.mul(1.2).add(0.4))) as any;
      const g = vec3(0, -3.2, 0) as any;
      const t = age.max(0) as any;
      const pos = at.add(vel.mul(t)).add(g.mul(t.mul(t).mul(0.5))) as any;
      const v = vel.add(g.mul(t)) as any;
      const fade = float(1).sub(age.div(life)).max(0) as any;
      return { pos, v, s, alive, fade };
    };
    const a = fly();
    const toEye = normalize(cameraPosition.sub(a.pos)) as any;
    const along = normalize(a.v.sub(toEye.mul(dot(a.v, toEye))).add(vec3(0, 0.0001, 0))) as any;
    const across = normalize(cross(along, toEye)) as any;
    const size = a.s.z.mul(0.016).add(0.006).mul(a.alive).mul(a.fade.sqrt()) as any;
    const stretch = length(a.v).mul(0.05).add(1) as any;
    m.positionNode = a.pos.add(along.mul(positionGeometry.y.mul(size.mul(stretch).mul(2)))).add(across.mul(positionGeometry.x.mul(size.mul(2)))) as any;

    const b = fly();
    const tint = texture(table.texture, vec2(b.s.y.mul(0.5).add(0.15).mul(SCALE / table.most), 0.8)).rgb as any;
    const colour = varying(tint.mul(2.2).add(0.15).mul(b.fade)) as any;
    const r = uv().sub(0.5).length() as any;
    m.colorNode = vec4(colour.mul(float(1).sub(smoothstep(0.15, 0.5, r))), 1) as any;
    return { quad, m, mesh };
  }, [points, count, table]);
  useDispose(parts.quad, parts.m);
  return <primitive object={parts.mesh} />;
}

// Dust hanging in the dark hall, seen only in the bubble's glow and flashing as each front passes through it; and a few
// big soft specks drifting by the lens.
export function Motes({ count }: { count: number }) {
  const parts = useMemo(() => {
    const random = lehmer(9001);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) seeds.set([random(), random(), random(), random()], i * 4);
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.InstancedMesh(quad, m, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    mesh.renderOrder = 7;

    const place = () => {
      const s = attribute("aSeed", "vec4") as any;
      const t = u.clock as any;
      const lens = step(s.w, 0.05) as any;
      const room = vec3(s.x.mul(15).sub(7.5), mix(float(FLOOR + 0.3), float(CEILING - 1), s.y), s.z.mul(15).sub(7.5)) as any;
      const drift = vec3(sin(t.mul(0.05).add(s.w.mul(40))).mul(0.4), t.mul(s.w.mul(0.02).add(0.006)), sin(t.mul(0.04).add(s.x.mul(30))).mul(0.4)) as any;
      const box = 3;
      const nearLens = cameraPosition.add(fract(s.xyz.add(drift.mul(0.3).div(box)).sub(cameraPosition.div(box))).sub(0.5).mul(box)) as any;
      const floating = room.add(drift) as any;
      const span = float(CEILING - FLOOR - 1.3) as any;
      const wrapped = (vec3 as any)(floating.x, fract(floating.y.sub(FLOOR + 0.3).div(span)).mul(span).add(FLOOR + 0.3), floating.z) as any;
      return { s, lens, centre: mix(wrapped, nearLens, lens) as any };
    };
    const a = place();
    const away = length(cameraPosition.sub(a.centre)) as any;
    const radius = mix(a.s.y.mul(0.012).add(0.006).max(away.mul(0.0012)), a.s.y.mul(0.02).add(0.025), a.lens) as any;
    const toEye = normalize(cameraPosition.sub(a.centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
    const upward = cross(toEye, right) as any;
    m.positionNode = a.centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(upward.mul(positionGeometry.y.mul(radius.mul(2)))) as any;

    const b = place();
    const d = length(b.centre) as any;
    let flash = vec3(0) as any;
    for (const { t, e } of passes(d)) {
      const age = u.age.sub(t) as any;
      const hit = exp(abs(age).negate().div(0.05)).add(exp(age.max(0).negate().div(0.5)).mul(step(0, age)).mul(0.25)) as any;
      flash = flash.add(vec3(TINT[e].r, TINT[e].g, TINT[e].b).mul(hit.mul(AMP[e])));
    }
    const glow = GLOW.mul(u.glow).mul(0.5).div(d.mul(d).mul(0.25).add(1)) as any;
    const amount = mix(b.s.x.mul(0.7).add(0.3), float(0.12), b.lens) as any;
    const colour = varying(flash.mul(u.strength).mul(mix(float(1.4), float(0.05), b.lens)).add(glow).mul(amount)) as any;
    const r = uv().sub(0.5).length() as any;
    const shape = mix(float(1).sub(smoothstep(0.05, 0.5, r)), float(1).sub(smoothstep(0.38, 0.5, r)), varying(b.lens)) as any;
    m.colorNode = vec4(colour.mul(shape), 1) as any;
    return { quad, m, mesh };
  }, [count]);
  useDispose(parts.quad, parts.m);
  return <primitive object={parts.mesh} />;
}

// The share of the wave's strength for whatever reflection it is on at this moment, its colour, and its radius.
export function front(age: number) {
  if (age < 0) return null;
  const legs = (age * SPEED) / REACH;
  const leg = Math.floor(legs);
  if (leg >= BOUNCES * 2) return null;
  const k = legs - leg;
  const radius = (leg % 2 === 0 ? k : 1 - k) * REACH;
  const e = Math.min(Math.ceil(leg / 2), AMP.length - 1);
  return { radius, e, level: AMP[e] };
}
