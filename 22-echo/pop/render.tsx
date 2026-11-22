"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraFar,
  cameraNear,
  cameraPosition,
  clamp,
  cross,
  dot,
  exp,
  float,
  fract,
  length,
  max,
  min,
  mix,
  modelWorldMatrix,
  mx_noise_float,
  mx_noise_vec3,
  normalize,
  perspectiveDepthToViewZ,
  positionGeometry,
  positionView,
  positionWorld,
  pow,
  reflect,
  screenUV,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";
import { lehmer } from "../../shared/engine/random";
import { filmTable, SCALE, studio } from "./film";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// How fast the hole's rim races across the film, in the shape's units a second: slowed down, as filmed at high speed.
export const SPEED = 4.2;
// The echoes: how many, and how far apart in seconds. Each throws a ghost of the shape outward as it sounds.
export const ECHOES = 4;
export const DELAY = 0.46;

export const u = {
  clock: uniform(0) as any,
  // Seconds since the film tore, for the film itself (below zero: whole), and for what it threw off.
  tear: uniform(-1) as any,
  since: uniform(-1) as any,
  // Where it tore, in the shape's own space, and where the shape stood then.
  at: uniform(new THREE.Vector3()) as any,
  frame: uniform(new THREE.Matrix4()) as any,
  centre: uniform(new THREE.Vector3()) as any,
  // Each echo's age, by echo; below zero not yet.
  echoes: uniform(new THREE.Vector4(-1, -1, -1, -1)) as any,
  pump: uniform(0) as any,
  wobble: uniform(0) as any,
  vivid: uniform(1) as any,
  focus: uniform(6.6) as any,
  // 1 draws the normals as colour.
  debug: uniform(0) as any
};

const echoAge = (k: number) => (u.echoes as any)[["x", "y", "z", "w"][k]] as any;

// The tear's front is ragged, as a real hole's is: the same noise wherever it is asked.
const ragged = (p: any) => mx_noise_float(p.mul(4.5)).mul(0.09).add(mx_noise_float(p.mul(13).add(3.3)).mul(0.03)) as any;

// How much a ghost has grown, and how bright it is, by echo and age.
const ghostScale = (k: number, age: any) => float(1.01).add(float(0.2 + 0.14 * k).mul(float(1).sub(exp(age.max(0).mul(-3.2))))).add(age.max(0).mul(0.05)) as any;
const ghostStrength = (k: number, age: any) => smoothstep(0, 0.04, age).mul(exp(age.max(0).mul(-1.5))).mul(0.85 * Math.pow(0.7, k)).mul(step(0, age)) as any;
// Where the ghost has dissolved: the noise at a point against a threshold that climbs with age.
const ghostNoise = (p: any, k: number) => mx_noise_float(p.mul(2.3).add(k * 7.13)).mul(0.35).add(mx_noise_float(p.mul(7).add(k * 3.7)).mul(0.15)).add(0.5) as any;
const ghostEdge = (k: number, age: any) => smoothstep(0, 1.1, age).mul(0.9).add(0.1 + 0.08 * k) as any;

// The film's thickness at a point of the shape: drained thin and gold at the top, thicker and blue-green below, marbled
// by a slow swirl; pumping stretches it thinner.
const thickness = (p: any) => {
  const t = u.clock as any;
  const high = clamp(p.y.add(1.15).div(2.3), 0, 1) as any;
  const resting = mix(float(0.72), float(0.19), pow(high, float(1.4))) as any;
  const warp = mx_noise_vec3(p.mul(1.1).add(vec3(t.mul(0.021), t.mul(-0.032), t.mul(0.017)))) as any;
  const swirl = mx_noise_vec3(p.mul(2.6).add(warp.mul(1.6)).add(vec3(0, t.mul(-0.045), t.mul(0.02)))) as any;
  const marble = mx_noise_float(p.mul(2).add(swirl.mul(1.1)))
    .mul(0.12)
    .add(mx_noise_float(p.mul(8).add(swirl.mul(2.4))).mul(0.025)) as any;
  return max(resting.add(marble), float(0.01)).mul(float(1).sub(u.pump.mul(0.42))) as any;
};

export function useFilm() {
  const table = useMemo(() => filmTable(), []);
  useDispose(table.texture);
  return table;
}

// The bubble: its inner walls, then its outer, added over the void as a film reflects and lets the rest through.
export function Bubble({ geometry, table }: { geometry: THREE.BufferGeometry; table: ReturnType<typeof filmTable> }) {
  const materials = useMemo(() => {
    const make = (inside: boolean) => {
      const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: inside ? THREE.BackSide : THREE.FrontSide });
      {
        const built = attribute("position", "vec3") as any;
        const t = u.clock as any;
        const swell = mx_noise_float(built.mul(1.25).add(vec3(0, t.mul(0.42), t.mul(0.27))))
          .mul(u.wobble.mul(0.05).add(0.011))
          .add(u.pump.mul(0.055)) as any;
        m.positionNode = built.add(attribute("normal", "vec3").mul(swell)) as any;
      }
      const rest = varying(attribute("position", "vec3")).toVar() as any;
      const outward = normalize(varying(modelWorldMatrix.mul(vec4(attribute("normal", "vec3"), 0)).xyz)).toVar() as any;
      const normal = inside ? outward.negate() : outward;
      const view = normalize(cameraPosition.sub(positionWorld)).toVar() as any;
      const facing = clamp(dot(normal, view), 0, 1).toVar() as any;
      const bounce = reflect(view.negate(), normal) as any;

      // The tear: gone behind the racing front, a bright thickened rim on it.
      const d = length(rest.sub(u.at)).add(ragged(rest)).toVar() as any;
      const front = u.tear.mul(SPEED) as any;
      const keep = smoothstep(front, front.add(0.012), d) as any;
      const off = d.sub(front).div(0.03) as any;
      const rim = exp(off.mul(off).negate()).mul(step(0, u.tear)).toVar() as any;

      const thick = thickness(rest).add(rim.mul(0.35)).toVar() as any;
      const colour = texture(table.texture, vec2(thick.mul(SCALE / table.most), facing)).rgb as any;
      // Only the lights themselves, not the room's faint fill, so the faces between stay clear.
      const light = max(studio(bounce).sub(0.04), vec3(0)) as any;
      const gain = mix(float(inside ? 1.2 : 2.6), float(1.4), pow(float(1).sub(facing), float(4))).mul(u.vivid) as any;
      const sheen = colour.mul(u.vivid.mul(inside ? 0.012 : 0.018)) as any;
      const lit = light.mul(colour).mul(gain).add(sheen) as any;
      const glow = vec3(1, 0.92, 0.8)
        .mul(inside ? 0.3 : 0.7)
        .add(colour.mul(2.2))
        .mul(rim) as any;
      const shown = lit.add(glow).mul(keep) as any;
      m.colorNode = vec4((mix as any)(shown, inside ? vec3(0) : normal.mul(0.5).add(0.5), u.debug), 1) as any;
      return m;
    };
    return { back: make(true), front: make(false) };
  }, [table]);
  useDispose(materials.back, materials.front);
  return (
    <>
      <mesh geometry={geometry} material={materials.back} renderOrder={1} frustumCulled={false} />
      <mesh geometry={geometry} material={materials.front} renderOrder={2} frustumCulled={false} />
    </>
  );
}

// The ghosts: one per echo, the shape as it stood when it burst, flashing in time with its echo and swelling outward,
// each larger and fainter than the last, eaten away into dust from noise-shaped edges.
export function Ghosts({ geometry, table, meshes }: { geometry: THREE.BufferGeometry; table: ReturnType<typeof filmTable>; meshes: { current: (THREE.Mesh | null)[] } }) {
  const materials = useMemo(
    () =>
      Array.from({ length: ECHOES }, (_, k) => {
        const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
        {
          const age = echoAge(k);
          const built = attribute("position", "vec3") as any;
          const placed = built.mul(ghostScale(k, age)).add(attribute("normal", "vec3").mul(age.max(0).mul(0.05))) as any;
          m.positionNode = u.frame.mul(vec4(placed, 1)).xyz as any;
        }
        const age = echoAge(k);
        const rest = varying(attribute("position", "vec3")).toVar() as any;
        const normal = normalize(varying(u.frame.mul(vec4(attribute("normal", "vec3"), 0)).xyz)) as any;
        const view = normalize(cameraPosition.sub(positionWorld)) as any;
        const facing = clamp(dot(normal, view), 0, 1).toVar() as any;
        const rimLight = pow(float(1).sub(facing), float(2.2)) as any;
        const n = ghostNoise(rest, k);
        const edge = ghostEdge(k, age);
        const mask = smoothstep(edge, edge.add(0.1), n) as any;
        const off = n.sub(edge).div(0.06) as any;
        const burn = exp(off.mul(off).negate()).mul(step(0.08, edge)) as any;
        const thick = mx_noise_float(rest.mul(1.6).add(k * 3.1))
          .mul(0.22)
          .add(0.42 - 0.05 * k) as any;
        const colour = texture(table.texture, vec2(thick.mul(SCALE / table.most), facing)).rgb as any;
        const strength = ghostStrength(k, age);
        const shell = colour.mul(1.7).add(vec3(0.6, 0.68, 0.8).mul(0.1)).mul(rimLight.add(0.025)).mul(mask) as any;
        const ember = vec3(1, 0.9, 0.78).mul(burn).mul(rimLight.mul(0.5).add(0.05)).mul(0.5) as any;
        m.colorNode = vec4(shell.add(ember).mul(strength).mul(u.vivid.mul(0.4).add(0.6)), 1) as any;
        return m;
      }),
    [table]
  );
  useDispose(...materials);
  return (
    <>
      {materials.map((material, k) => (
        <mesh key={k} ref={(mesh) => {
            meshes.current[k] = mesh;
          }} geometry={geometry} material={material} renderOrder={3 + k} frustumCulled={false} />
      ))}
    </>
  );
}

// Camera-facing quads for sprites, built as the bubble version's dust is.
const facingQuad = (centre: any, radius: any) => {
  const toEye = normalize(cameraPosition.sub(centre)) as any;
  const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
  const upward = cross(toEye, right) as any;
  return centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(upward.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
};

function sprites(count: number, attributes: Record<string, [Float32Array, number]>) {
  const quad = new THREE.PlaneGeometry(1, 1);
  for (const [name, [data, size]] of Object.entries(attributes)) quad.setAttribute(name, new THREE.InstancedBufferAttribute(data, size));
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
  const mesh = new THREE.InstancedMesh(quad, material, count);
  const identity = new THREE.Matrix4();
  for (let i = 0; i < count; i++) mesh.setMatrixAt(i, identity);
  mesh.frustumCulled = false;
  mesh.layers.set(OVERLAY_LAYER);
  return { quad, material, mesh };
}

// The spray: as the rim passes each point it sheds a droplet, flung on across the surface and a little off it, falling
// slowly, glinting as it tumbles, fading. And the dust each ghost crumbles into at its dissolving edge.
export function Spray({ points, table }: { points: { at: Float32Array; dir: Float32Array; seeds: Float32Array; count: number }; table: ReturnType<typeof filmTable> }) {
  const parts = useMemo(() => sprites(points.count, { aAt: [points.at, 3], aDir: [points.dir, 3], aSeed: [points.seeds, 4] }), [points]);
  useDispose(parts.quad, parts.material);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
        const droplet = () => {
          const at = attribute("aAt", "vec3") as any;
          const dir = attribute("aDir", "vec3") as any;
          const s = attribute("aSeed", "vec4") as any;
          const away = at.sub(u.at) as any;
          const born = length(away).add(ragged(at)).div(SPEED) as any;
          const age = u.since.sub(born).toVar() as any;
          const life = s.z.mul(1.1).add(0.45) as any;
          const alive = step(0, age).mul(step(age, life)).mul(step(0, u.since)) as any;
          const across = normalize(away.sub(dir.mul(dot(away, dir))).add(dir.mul(0.001))) as any;
          const fling = across.mul(s.x.mul(s.x).mul(2.4).add(0.6)).add(dir.mul(s.y.sub(0.3).mul(1.3))) as any;
          const v = u.frame.mul(vec4(fling, 0)).xyz as any;
          const a = age.max(0) as any;
          const travel = v.mul(float(1).sub(exp(a.mul(-1.1))).div(1.1)) as any;
          const centre = u.frame
            .mul(vec4(at, 1))
            .xyz.add(travel)
            .add(vec3(0, a.mul(a).mul(-0.32), 0)) as any;
          const fade = float(1).sub(a.div(life)).max(0) as any;
          const radius = s.w.mul(s.w).mul(0.008).add(0.003).mul(fade.sqrt()).mul(alive) as any;
          return { s, age: a, fade, radius, centre, alive };
        };
        const p = droplet();
        parts.material.positionNode = facingQuad(p.centre, p.radius);
        const c = droplet();
        const glint = pow(sin(c.age.mul(c.s.y.mul(40).add(14)).add(c.s.x.mul(31))).mul(0.5).add(0.5), float(3))
          .mul(0.8)
          .add(0.35) as any;
        const tint = texture(table.texture, vec2(c.s.z.mul(0.35).add(0.12), 0.9)).rgb.mul(1.6).add(vec3(0.5, 0.48, 0.45)) as any;
        const fresh = exp(c.age.mul(-5)).mul(2.5).add(1) as any;
        const colour = varying(tint.mul(glint).mul(c.fade).mul(fresh).mul(1.3)) as any;
        const r = uv().sub(0.5).length() as any;
        const shape = float(1).sub(smoothstep(0.05, 0.5, r)).pow(2) as any;
        parts.material.colorNode = vec4(colour.mul(shape).mul(step(sceneZ, positionView.z)), 1) as any;
        parts.material.needsUpdate = true;
      }),
    [parts, table]
  );
  return <primitive object={parts.mesh} />;
}

export function Crumbs({ points }: { points: { at: Float32Array; dir: Float32Array; seeds: Float32Array; count: number } }) {
  const parts = useMemo(() => sprites(points.count, { aAt: [points.at, 3], aDir: [points.dir, 3], aSeed: [points.seeds, 4] }), [points]);
  useDispose(parts.quad, parts.material);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
        // Each crumb belongs to one ghost, by its seed.
        const crumb = () => {
          const at = attribute("aAt", "vec3") as any;
          const dir = attribute("aDir", "vec3") as any;
          const s = attribute("aSeed", "vec4") as any;
          let centre: any = vec3(0);
          let light: any = float(0);
          let radius: any = float(0);
          for (let k = 0; k < ECHOES; k++) {
            const mine = step(k / ECHOES, s.w).mul(step(s.w, (k + 1) / ECHOES)) as any;
            const age = echoAge(k);
            const a = age.max(0) as any;
            const drift = mx_noise_vec3(at.mul(2.2).add(a.mul(0.3)).add(k)).mul(a.mul(0.22)) as any;
            const placed = at
              .mul(ghostScale(k, age))
              .add(dir.mul(a.mul(s.x.mul(0.3).add(0.04))))
              .add(drift) as any;
            const off = ghostNoise(at, k).sub(ghostEdge(k, age)).div(0.07) as any;
            const lit = exp(off.mul(off).negate()).mul(ghostStrength(k, age)).mul(5).add(ghostStrength(k, age).mul(0.5)) as any;
            centre = centre.add(u.frame.mul(vec4(placed, 1)).xyz.mul(mine));
            light = light.add(lit.mul(mine));
            radius = radius.add(mine.mul(step(0, age)).mul(float(1).sub(smoothstep(2.2, 3.2, a))));
          }
          return { s, centre, light, radius: radius.mul(s.y.mul(0.006).add(0.003)) };
        };
        const p = crumb();
        parts.material.positionNode = facingQuad(p.centre, p.radius);
        const c = crumb();
        const tint = mix(vec3(1, 0.86, 0.7), vec3(0.75, 0.85, 1), c.s.z) as any;
        const colour = varying(tint.mul(c.light)) as any;
        const r = uv().sub(0.5).length() as any;
        const shape = float(1).sub(smoothstep(0.05, 0.5, r)).pow(1.6) as any;
        parts.material.colorNode = vec4(colour.mul(shape).mul(step(sceneZ, positionView.z)), 1) as any;
        parts.material.needsUpdate = true;
      }),
    [parts]
  );
  return <primitive object={parts.mesh} />;
}

// Fine dust hanging round the letters, and a few big soft discs passing the lens. Each echo's shock runs out through it
// as a swelling shell, pushing the specks on and lighting them as it passes.
export function Dust({ count }: { count: number }) {
  const parts = useMemo(() => {
    const random = lehmer(9173);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) seeds.set([random(), random(), random(), random()], i * 4);
    return sprites(count, { aSeed: [seeds, 4] });
  }, [count]);
  useDispose(parts.quad, parts.material);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
        const place = () => {
          const s = attribute("aSeed", "vec4") as any;
          const t = u.clock as any;
          const lensNear = step(s.w, 0.1) as any;
          const box = vec3(7.5, 6.6, 5) as any;
          const drift = vec3(t.mul(0.008), t.mul(0.011), t.mul(-0.004)).mul(s.w.add(0.4)) as any;
          const wander = mx_noise_vec3(s.xyz.mul(9).add(t.mul(0.03))).mul(0.12) as any;
          const room = fract(s.xyz.add(drift.div(box)))
            .sub(0.5)
            .mul(box)
            .add(wander)
            .add(vec3(0, 0.6, 0)) as any;
          // The echoes' shocks, out from where it burst.
          const out = room.sub(u.centre) as any;
          const far = length(out).max(0.001) as any;
          let push: any = float(0);
          let flare: any = float(0);
          for (let k = 0; k < ECHOES; k++) {
            const age = echoAge(k);
            const a = age.max(0) as any;
            const shell = a.mul(2.9).add(1.1) as any;
            const strength = step(0, age).mul(exp(a.mul(-0.9))).mul(Math.pow(0.7, k)) as any;
            const off = far.sub(shell).div(0.45) as any;
            const band = exp(off.mul(off).negate()) as any;
            // Behind the shell the specks have been carried on.
            push = push.add(float(1).sub(smoothstep(-0.4, 0.6, far.sub(shell))).mul(strength).mul(0.16)).add(band.mul(strength).mul(0.1));
            flare = flare.add(band.mul(strength));
          }
          const shoved = room.add(out.div(far).mul(push)) as any;
          const box2 = 3.2;
          const lens = cameraPosition.add(
            fract(s.xyz.add(drift.div(box2)).sub(cameraPosition.div(box2)))
              .sub(0.5)
              .mul(box2)
          ) as any;
          return { s, centre: mix(shoved, lens, lensNear) as any, lensNear, flare };
        };
        const size = (centre: any, s: any) => {
          const away = length(cameraPosition.sub(centre)) as any;
          const sharp = max(float(0.0018), away.mul(0.0011)).mul(s.y.mul(1.5).add(0.45)) as any;
          const blur = min(abs(away.sub(u.focus)).div(away).mul(0.045), away.mul(0.03)) as any;
          return { sharp, radius: sharp.add(blur), blur };
        };
        const a = place();
        parts.material.positionNode = facingQuad(a.centre, size(a.centre, a.s).radius);

        const b = place();
        const sb = size(b.centre, b.s);
        const spread = pow(sb.sharp.div(sb.radius), 2).max(0.05) as any;
        // Lit from the softbox up to the left.
        const toward = normalize(b.centre.sub(vec3(-3.5, 4.5, 3))) as any;
        const lit = smoothstep(-0.2, 0.9, dot(toward.negate(), normalize(vec3(-0.5, 0.72, 0.48))))
          .mul(0.5)
          .add(0.18) as any;
        const twinkle = sin(u.clock.mul(b.s.y.mul(1.3).add(0.3)).add(b.s.z.mul(40)))
          .mul(0.25)
          .add(0.75) as any;
        const amount = mix(float(1), float(0.12), b.lensNear) as any;
        const tint = mix(vec3(0.85, 0.9, 1), vec3(1, 0.9, 0.78), b.s.x) as any;
        const light = tint.mul(lit.add(b.flare.mul(1.6)).mul(0.42)).mul(twinkle).mul(amount).mul(spread) as any;
        const colour = varying(light) as any;
        const r = uv().sub(0.5).length() as any;
        const soft = varying(smoothstep(0.004, 0.03, sb.blur)) as any;
        const shape = mix(float(1).sub(smoothstep(0.06, 0.5, r)), float(1).sub(smoothstep(0.36, 0.5, r)), soft) as any;
        parts.material.colorNode = vec4(colour.mul(shape).mul(step(sceneZ, positionView.z)), 1) as any;
        parts.material.needsUpdate = true;
      }),
    [parts]
  );
  return <primitive object={parts.mesh} />;
}

// The dark studio itself, barely there, so the bubble hangs in a void with only the faintest sense of the room.
export function Backdrop() {
  const parts = useMemo(() => {
    const sphere = new THREE.SphereGeometry(40, 48, 24);
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
    const dir = normalize(positionWorld.sub(cameraPosition)) as any;
    material.colorNode = vec4(studio(dir, 0.02), 1) as any;
    return { sphere, material };
  }, []);
  useDispose(parts.sphere, parts.material);
  return <mesh geometry={parts.sphere} material={parts.material} renderOrder={-1} frustumCulled={false} />;
}
