import * as THREE from "three/webgpu";
import { abs, cos, exp, float, Fn, instanceIndex, int, ivec2, Loop, max, mx_noise_float, sin, textureStore, uniform, vec3, vec4 } from "three/tsl";
import { shellMatter } from "./shell";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The probe and its fan: a sector of scan lines from one point above the shell, each line a pulse sent down and the
// echoes heard back along it. The probe rocks (tilt, about its own long axis) and turns (yaw, about the vertical).
export const APEX = new THREE.Vector3(0, 1.5, 0);
export const HALF = THREE.MathUtils.degToRad(38);
export const NEAR = 0.1;
export const FAR = 3.05;
export const TILT_LIMIT = THREE.MathUtils.degToRad(48);

// The fan's frame for a pose: down the middle line, across it, and out of its plane.
export function fanFrame(tilt: number, yaw: number, down: THREE.Vector3, across: THREE.Vector3, normal: THREE.Vector3) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const turn = (x: number, y: number, z: number, out: THREE.Vector3) => out.set(x * cy + z * sy, y, -x * sy + z * cy);
  turn(0, -Math.cos(tilt), -Math.sin(tilt), down);
  turn(1, 0, 0, across);
  turn(0, -Math.sin(tilt), Math.cos(tilt), normal);
}

// The same in TSL, for shaders given a pose as nodes.
export function fanFrameNode(tilt: any, yaw: any) {
  const cy = cos(yaw) as any;
  const sy = sin(yaw) as any;
  const turn = (x: any, y: any, z: any) => vec3(x.mul(cy).add(z.mul(sy)), y, x.mul(sy).negate().add(z.mul(cy))) as any;
  const ct = cos(tilt) as any;
  const st = sin(tilt) as any;
  return {
    down: turn(float(0), ct.negate(), st.negate()),
    across: turn(float(1), float(0), float(0)),
    normal: turn(float(0), st.negate(), ct)
  };
}

// Every slice is kept as a tile of one big texture: scan lines across, depth down. Tile 0 is the live view; the rest
// are a ring of slices left behind as the beam sweeps.
export type Atlas = { texture: THREE.StorageTexture; lines: number; depth: number; columns: number; rows: number; slots: number };

export function makeAtlas(low: boolean): Atlas {
  const lines = low ? 128 : 192;
  const depth = low ? 200 : 320;
  const columns = low ? 8 : 10;
  const rows = low ? 8 : 10;
  const texture = new THREE.StorageTexture(lines * columns, depth * rows);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return { texture, lines, depth, columns, rows, slots: columns * rows };
}

// The scan: one thread per line, walking its pulse down from the probe. At each step the echo is what the pulse
// meets (a change of material reflects, the inside of a material scatters), shaped by speckle, the grain that real
// ultrasound shows; what is reflected or absorbed is taken from the pulse, so hard shell casts a shadow below it.
// Writes the echo off surfaces (r), the scatter from inside things (g) and the faint scatter of the water itself (b).
export function makeScan(atlas: Atlas, clock: any) {
  const pose = { tilt: uniform(0), yaw: uniform(0), slot: uniform(0) };
  const { lines, depth, columns } = atlas;
  const step = (FAR - NEAR) / depth;
  const node = Fn(() => {
    const line = int(instanceIndex) as any;
    const slot = int(pose.slot) as any;
    const originX = slot.mod(columns).mul(lines) as any;
    const originY = slot.div(columns).mul(depth) as any;
    const frame = fanFrameNode(pose.tilt, pose.yaw);
    const angle = float(line).add(0.5).div(lines).mul(2).sub(1).mul(HALF) as any;
    const dir = frame.down.mul(cos(angle)).add(frame.across.mul(sin(angle))) as any;
    const apex = vec3(APEX.x, APEX.y, APEX.z);
    const energy = float(1).toVar() as any;
    const lastHard = float(0).toVar() as any;
    const lastSoft = float(0).toVar() as any;
    // Speckle runs finer along the beam than across it, as a real probe's does, and is fixed to the probe's pose, so
    // neighbouring slices share their grain.
    const lateral = angle.mul(26) as any;
    const elevation = pose.tilt.mul(26).add(pose.yaw.mul(17)) as any;
    Loop({ start: int(0), end: int(depth), type: "int" }, ({ i }: any) => {
      const range = float(i).add(0.5).mul(step).add(NEAR) as any;
      const p = apex.add(dir.mul(range)) as any;
      const m = shellMatter(p, clock, float(step * 0.9)) as any;
      const q = vec3(range.mul(78), lateral.mul(range.add(0.6)), elevation.mul(range.add(0.6))) as any;
      const a = mx_noise_float(q) as any;
      const b = mx_noise_float(q.add(vec3(17.3, 4.1, 9.7))) as any;
      // Two noises squared and summed: the exponential spread of brightness that fully developed speckle has.
      const speck = a.mul(a).add(b.mul(b)).mul(3.2) as any;
      const impedance = m.hard.add(m.soft.mul(0.32)) as any;
      const reflect = abs(impedance.sub(lastHard.add(lastSoft.mul(0.32)))) as any;
      lastHard.assign(m.hard);
      lastSoft.assign(m.soft);
      const scatter = m.hard.mul(0.55).add(m.soft.mul(0.42)) as any;
      // Depth gain: what the water takes from the pulse is given back, as a sonographer's gain curve does.
      const gainCurve = exp(range.mul(0.35)) as any;
      const edge = energy.mul(reflect.mul(2.4).mul(speck.mul(0.55).add(0.55))).mul(gainCurve) as any;
      const body = energy.mul(scatter.mul(speck)).mul(gainCurve) as any;
      const water = speck.mul(0.05).mul(energy) as any;
      textureStore(atlas.texture, ivec2(originX.add(line), originY.add(i)), vec4(edge.mul(0.5).min(1), body.mul(0.5).min(1), water.min(1), 1)).toWriteOnly();
      energy.mulAssign(exp(m.hard.mul(-5 * step)).mul(exp(m.soft.mul(-1.2 * step))).mul(float(1).sub(reflect.mul(0.1))));
      energy.assign(max(energy, float(0.2)));
    });
  })().compute(lines);
  return { node, pose };
}
