import * as THREE from "three/webgpu";
import { exp, float, ivec2, length, max, min, texture, textureLoad, uniform, vec2, vec3 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The sound in the garden, as the shaders read it. Every raindrop that lands throws off a small shell of sound that
// grows and fades within a second; a clap throws off a big one that sweeps the whole garden. Nothing is lit by anything
// else: a surface is seen only while a shell is passing over it.

// The small echoes: how fast they grow, how long they last, and so how far they reach.
export const DROP_SPEED = 1.15;
export const DROP_LIFE = 0.8;
export const DROP_REACH = DROP_SPEED * DROP_LIFE;

// The big ones.
export const PING_SPEED = 7.5;
export const PING_LIFE = 5;
export const PINGS = 4;

// The drops' echoes are sorted into a grid of cells a metre across, so each point need only look at the few that can
// reach it: up to SLOTS a cell, newest first.
export const GRID = { x0: -7.5, z0: -10.5, cell: 1, nx: 15, nz: 19 };
export const SLOTS = 16;
const EMPTY = -1e4;

export const gridData = new Float32Array(GRID.nx * SLOTS * GRID.nz * 4);
for (let i = 0; i < gridData.length; i += 4) gridData[i + 3] = EMPTY;
export const gridTexture = new THREE.DataTexture(gridData, GRID.nx * SLOTS, GRID.nz, THREE.RGBAFormat, THREE.FloatType);
gridTexture.magFilter = THREE.NearestFilter;
gridTexture.minFilter = THREE.NearestFilter;
gridTexture.generateMipmaps = false;
gridTexture.needsUpdate = true;

// What the rain has been saying lately, spread over the ground: each landing adds a soft splat, and it all dies away
// within half a second or so. Read smoothly, it lights edges in drifting, flickering patches where the rain is.
export const FIELD = { x0: -7.5, z0: -10.5, cell: 0.2, nx: 75, nz: 93 };
export const fieldEnergy = new Float32Array(FIELD.nx * FIELD.nz);
export const fieldData = new Uint16Array(FIELD.nx * FIELD.nz);
export const fieldTexture = new THREE.DataTexture(fieldData, FIELD.nx, FIELD.nz, THREE.RedFormat, THREE.HalfFloatType);
fieldTexture.magFilter = THREE.LinearFilter;
fieldTexture.minFilter = THREE.LinearFilter;
fieldTexture.generateMipmaps = false;
fieldTexture.needsUpdate = true;

export const echo = {
  time: uniform(0),
  // Each clap: where (xyz), when (w); and how loud.
  pings: Array.from({ length: PINGS }, () => uniform(new THREE.Vector4(0, -50, 0, -100))),
  power: Array.from({ length: PINGS }, () => uniform(0)),
  // A clap being held: where (xyz) and how far it has built (w).
  charge: uniform(new THREE.Vector4(0, -50, 0, 0)),
  // The size of a pixel one metre away, for keeping lines at least a pixel wide.
  pixel: uniform(0.001),
  // For checking by eye in development: 1 draws every surface by its normal instead.
  normals: uniform(0),
  forward: uniform(new THREE.Vector3(0, 0, -1)),
  right: uniform(new THREE.Vector3(1, 0, 0)),
  up: uniform(new THREE.Vector3(0, 1, 0))
};

// The cool white the echoes draw in, and the warmer white of a clap's front.
export const DRIZZLE = vec3(0.42, 0.68, 1.0);
export const CLAP = vec3(0.9, 0.95, 1.0);

const square = (x: any) => x.mul(x);

// The small echoes at a point: the thin rings where their shells cross it, and a soft glow inside each that lights the
// edges and joints around where a drop has just landed.
export function drizzleAt(p: any, px: any) {
  const cell = p.xz.sub(vec2(GRID.x0, GRID.z0)).div(GRID.cell).floor().clamp(vec2(0, 0), vec2(GRID.nx - 1, GRID.nz - 1)) as any;
  const row = cell.y.toInt();
  const first = cell.x.toInt().mul(SLOTS);
  let rings: any = float(0);
  let glow: any = float(0);
  for (let i = 0; i < SLOTS; i++) {
    const drop = textureLoad(gridTexture, ivec2(first.add(i), row)) as any;
    const age = echo.time.sub(drop.w) as any;
    const life = age.div(DROP_LIFE).clamp(0, 1) as any;
    const fade = square(float(1).sub(life)).mul(age.greaterThan(0).select(1, 0)) as any;
    const radius = age.max(0).mul(DROP_SPEED) as any;
    const d = length(p.sub(drop.xyz)) as any;
    // Never thinner than a pixel: wider and dimmer instead.
    const width = max(radius.mul(0.035).add(0.008), px) as any;
    const thin = float(0.012).div(width).min(1) as any;
    rings = rings.add(exp(square(d.sub(radius).div(width)).negate()).mul(fade).mul(thin));
    glow = glow.add(exp(square(d.div(radius.mul(0.9).add(0.06))).negate()).mul(fade));
  }
  return { rings, glow };
}

// The rain's lingering energy at a point.
export function fieldAt(p: any) {
  const uv = p.xz.sub(vec2(FIELD.x0, FIELD.z0)).div(vec2(FIELD.nx * FIELD.cell, FIELD.nz * FIELD.cell)) as any;
  return (texture(fieldTexture, uv) as any).r as any;
}

// The claps at a point: the bright front where the shell is now, and the wake behind it, fading as it goes, with a few
// fainter fronts following like the rings of a sonar sweep. `toward` gives how squarely the surface faces each clap.
export function clapAt(p: any, n: any, px: any) {
  let front: any = float(0);
  let wake: any = float(0);
  let facing: any = float(0);
  let ripples: any = float(0);
  for (let k = 0; k < PINGS; k++) {
    const ping = echo.pings[k] as any;
    const age = echo.time.sub(ping.w) as any;
    const radius = age.max(0).mul(PING_SPEED) as any;
    const toward = ping.xyz.sub(p) as any;
    const d = length(toward) as any;
    const power = echo.power[k].mul(float(1).sub(age.div(PING_LIFE).clamp(0, 1))) as any;
    // Weaker as it spreads, but not as fast as a real one would, so the far roofs still show.
    const spread = power.div(radius.mul(0.05).add(1)) as any;
    const width = max(radius.mul(0.012).add(0.05), px.mul(1.5)) as any;
    const behind = radius.sub(d) as any;
    const f = exp(square(behind.div(width)).negate()).mul(spread) as any;
    // The wake lingers for about a second after the front has passed, wherever that was.
    const w = exp(behind.max(0).div(-PING_SPEED * 0.9)).mul(behind.greaterThan(0).select(1, 0)).mul(spread) as any;
    // Following fronts every 0.55 m, thin, dying out a few metres back.
    const t = behind.div(0.55).fract().sub(0.5).abs().mul(2) as any;
    const rip = exp(square(float(1).sub(t).mul(0.55).div(width)).negate()).mul(exp(behind.mul(-0.6))).mul(w) as any;
    front = front.add(f);
    wake = wake.add(w);
    ripples = ripples.add(rip);
    facing = facing.add(max(n.dot(toward.div(d.max(1e-3))), 0).mul(w));
  }
  // A clap still being held: rings drawing in toward the hand, wider and brighter the longer it is held, round a small
  // bright core, as the sound gathers before it goes.
  const c = echo.charge as any;
  const near = length(c.xyz.sub(p)) as any;
  const reach = c.w.mul(1.1).add(0.25) as any;
  let gather: any = float(0);
  for (let i = 0; i < 3; i++) {
    const phase = echo.time.mul(1.4).add(i / 3).fract() as any;
    const r = float(1).sub(phase).mul(reach) as any;
    gather = gather.add(exp(square(near.sub(r).div(max(px.mul(1.5), 0.018))).negate()).mul(phase.mul(float(1).sub(phase)).mul(4)));
  }
  const core = exp(square(near.div(0.12)).negate()) as any;
  const charge = gather.mul(0.7).add(core.mul(0.5)).mul(c.w) as any;
  return { front, wake, facing, ripples, charge: min(charge, 2) };
}
