"use client";

import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  dot,
  float,
  floor,
  Fn,
  fract,
  hash,
  If,
  length,
  max,
  mix,
  mx_noise_float,
  normalize,
  normalLocal,
  normalMap,
  normalView,
  normalWorld,
  positionGeometry,
  positionLocal,
  positionView,
  positionWorld,
  pow,
  reflect,
  reflector,
  sin,
  smoothstep,
  texture,
  uv,
  varying,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { useDispose } from "../shared/engine/dispose";
import type { QualityTier } from "../shared/engine/types";
import { clock, environment, FALLEN, paletteAt, REFLECTED, giantLight, GIANTS, glowAt, groundAt, groundNode, KNOTS, light, LOG, logRadius, logY, logZ, taps } from "./world";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The scans (all CC0; see public/assets/16-spore/CREDITS.txt): mossy leaf litter for the floor, bark for the log and
// moss over its top.
function load(name: string, colour: boolean) {
  const t = new THREE.TextureLoader().load(`/assets/16-spore/${name}.jpg`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

// How much floor one copy of the litter scan covers, in metres, so its leaves are leaf-sized beside the mushrooms.
const LITTER = 0.7;
const FLOOR = 6;

// The forest floor: leaf litter and moss in low swells, its scan pushed up by its own heights, lit by the moon and by
// whatever blooms nearby, and fading into the dark of the woods all round.
// The ground: a scan of decaying leaf litter (Poly Haven, CC0), one copy to the metre, in deep relief, with water standing
// here and there in its hollows.
const GROUND = { scan: "dry_decay_leaves", tile: 1.0, depth: 0.06, wet: 0.25 };

export function Floor({ tier }: { tier: QualityTier }) {
  const camera = useThree((state) => state.camera);
  const { mesh, material, geometry, mirror } = useMemo(() => {
    const G = GROUND;
    const colour = load(`${G.scan}_diff_2k`, true);
    const normal = load(`${G.scan}_nor_gl_2k`, false);
    const height = load(`${G.scan}_disp_2k`, false);
    const rough = load(`${G.scan}_rough_2k`, false);
    const segments = tier === "high" ? 420 : tier === "medium" ? 320 : 200;
    const geometry = new THREE.PlaneGeometry(FLOOR, FLOOR, segments, segments);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
    const flat = positionGeometry.xz as any;
    const scan = flat.div(G.tile) as any;
    // A second, larger and turned copy, mixed in by broad patches, so the repeat never shows.
    const turned = vec2(scan.x.mul(0.6).sub(scan.y.mul(0.8)), scan.x.mul(0.8).add(scan.y.mul(0.6)))
      .mul(0.63)
      .add(vec2(0.37, 0.71)) as any;
    const blend = smoothstep(
      0.35,
      0.65,
      mx_noise_float(vec3(flat.mul(0.9), 1.3))
        .mul(0.5)
        .add(0.5)
    ) as any;
    const h = mix(texture(height, scan).r, texture(height, turned).r, blend) as any;
    // Just after rain: water standing in patches down in the hollows of the litter, the rest only damp. Worked out at
    // the vertices, where it changes slowly.
    const wet = varying(
      smoothstep(
        0.66 - G.wet * 0.3,
        0.78 - G.wet * 0.3,
        mx_noise_float(vec3(flat.mul(1.15), 7.3))
          .mul(0.5)
          .add(0.5)
          .add(mx_noise_float(vec3(flat.mul(3.7), 2.1)).mul(0.12))
      )
    )
      // Only the low places between the leaves hold water; the leaves stand up out of it.
      .mul(smoothstep(0.5 + G.wet * 0.25, 0.4 + G.wet * 0.2, h)) as any;
    // The litter's own heights push it up and down by a few centimetres, so leaves and twigs stand in relief.
    material.positionNode = vec3(positionLocal.x, groundNode(flat).add(h.sub(0.5).mul(G.depth)), positionLocal.z) as any;
    // The scan's relief, and a finer copy of it laid over close to, for the grain of the litter itself.
    const fineNormal = texture(normal, scan.mul(3.1).add(vec2(0.31, 0.77))) as any;
    // Standing water lies flat over it.
    const litter = normalMap(mix(texture(normal, scan), texture(normal, turned), blend).add(fineNormal.sub(0.5).mul(0.35)), vec2(2.2, 2.2)) as any;
    material.normalNode = mix(litter, normalView, wet.mul(0.85)).normalize() as any;
    // Down between the leaves it is darker, as dirt and shade gather there, and damp, catching the moon.
    const hollow = smoothstep(0.55, 0.15, h) as any;
    const far = length(flat) as any;
    const fade = smoothstep(3.0, 1.6, far).mul(0.7).add(0.3) as any;
    // Each texture read once and shared by what needs it.
    const albedo = mix(texture(colour, scan).rgb, texture(colour, turned).rgb, blend) as any;
    // The giants' light changes slowly across the floor, so it is worked out at the vertices.
    const giantGlow = giantLight() as any;
    // The litter darkens close in under the logs, where they shade it and keep it damp; worked out at the vertices.
    const nearLogs = varying(logShade(flat)) as any;
    material.colorNode = albedo
      .mul(0.85)
      .mul(fade)
      .mul(float(1).sub(hollow.mul(0.55)))
      .mul(nearLogs)
      .mul(float(1).sub(wet.mul(0.6))) as any;
    // Matte litter; glassy only where the water stands.
    material.roughnessNode = mix(
      mix(texture(rough, scan).r, texture(rough, turned).r, blend)
        .mul(0.9)
        .mul(float(1).sub(hollow.mul(0.45))),
      float(0.04),
      wet
    ) as any;
    // The puddles' reflection: the scene drawn upside down from under the floor, only what glows, at a fraction of the
    // size, rippled a little; strongest seen at a slant, as water is.
    const mirror = reflector({ resolutionScale: tier === "high" ? 0.35 : tier === "medium" ? 0.28 : 0.2, generateMipmaps: true });
    {
      mirror.target.rotateX(-Math.PI / 2);
      mirror.target.position.y = -0.006;
      const ripple = vec2(mx_noise_float(vec3(flat.mul(26), (clock as any).mul(0.35))), mx_noise_float(vec3(flat.mul(26).add(5.1), (clock as any).mul(0.35))));
      mirror.uvNode = (mirror.uvNode as any).add(ripple.mul(0.008));
    }
    // The blooms' light on the litter, the way a lamp lights the ground round it, brighter on what faces up and with a
    // touch of the scan's own shade.
    material.emissiveNode = Fn(() => {
      const facing = normalize(normalWorld).y.mul(0.5).add(0.5) as any;
      const lit = albedo
        .mul(glowAt(positionWorld).add(giantGlow.mul(0.3)))
        .mul(facing)
        .mul(0.55)
        .mul(fade)
        .toVar() as any;
      // Where the floor is touched, a flash of veins runs out through the litter in a widening ring and fades: the
      // mycelium answering. The veins are only worked out where a ring still glows.
      const answer = taps.reduce((sum: any, tap: any) => {
        const age = (clock as any).sub(tap.z) as any;
        const d = flat.sub(tap.xy).length() as any;
        const front = age.mul(0.42) as any;
        const ring = smoothstep(0.07, 0, abs(d.sub(front)))
          .mul(1.6)
          .add(smoothstep(front, 0, d).mul(0.45)) as any;
        return sum.add(ring.mul(pow(float(0.25), age)).mul(age.greaterThan(0).select(float(1), float(0))));
      }, float(0)) as any;
      const V = normalize(cameraPosition.sub(positionWorld)) as any;
      const fresnel = pow(float(1).sub(max(V.y, 0)), float(5))
        .mul(0.65)
        .add(0.35) as any;
      // Soft, as wet litter reflects: read from a blurred level of the mirror.
      const sheen = (mirror as any).level(2.5).rgb.add(environment(reflect(V.negate(), vec3(0, 1, 0))).mul(0.6)) as any;
      lit.addAssign(sheen.mul(wet).mul(fresnel).mul(fade).mul(0.85));
      // Dew: beads of water on the leaves, each a pin of light where it catches the moon or the blooms, near to only.
      const cells = flat.mul(150) as any;
      const cell = floor(cells) as any;
      const pick = hash(cell.x.add(cell.y.mul(57.13))) as any;
      const spot = fract(cells)
        .sub(0.5)
        .sub(
          vec2(hash(cell.x.mul(1.7).add(cell.y)), hash(cell.y.mul(2.3).add(cell.x)))
            .sub(0.5)
            .mul(0.5)
        ) as any;
      const bead = smoothstep(0.2, 0.04, length(spot)).mul(pick.greaterThan(0.86).select(float(1), float(0))) as any;
      const near = smoothstep(1.6, 0.35, length(cameraPosition.sub(positionWorld))) as any;
      const glint = pow(max(dot(reflect(V.negate(), normalize(normalWorld)), light.toMoon), 0), float(12))
        .mul(1.4)
        .add(0.12) as any;
      lit.addAssign(
        light.moon
          .mul(glint)
          .add(glowAt(positionWorld).mul(1.5))
          .mul(bead)
          .mul(near)
          .mul(float(1).sub(wet.mul(0.7)))
          .mul(0.55)
      );
      If(answer.greaterThan(0.002), () => {
        const veins = pow(float(1).sub(abs(mx_noise_float(vec3(flat.mul(16), 0.3)))), float(14)).add(pow(float(1).sub(abs(mx_noise_float(vec3(flat.mul(37), 1.7)))), float(18)).mul(0.6)) as any;
        lit.addAssign(light.thread.mul(veins.mul(answer).mul(1.6)));
      });
      return lit;
    })() as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = false;
    return { mesh, material, geometry, mirror };
  }, [tier]);
  // The reflection's camera draws only what is on the reflected layer.
  useEffect(() => {
    (mirror as any).reflector.getVirtualCamera(camera).layers.set(REFLECTED);
  }, [mirror, camera]);
  useDispose(geometry, material);
  return (
    <>
      <primitive object={mesh} />
      <primitive object={mirror.target} />
    </>
  );
}

// The floor further off, out under the giants and the trees: the same litter, coarser, lit by the giants and fading
// into the night. It begins under the edge of the near floor, a little lower, so the two never fight.
export function FarFloor() {
  const { mesh, material, geometry } = useMemo(() => {
    const geometry = new THREE.RingGeometry(2.85, 18, 96, 24);
    geometry.rotateX(-Math.PI / 2);
    const colour = load("forest_leaves_02_diffuse_1k", true);
    const normal = load("forest_leaves_02_nor_gl_1k", false);
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
    const flat = positionGeometry.xz as any;
    const scan = flat.div(LITTER * 1.6) as any;
    material.positionNode = vec3(positionLocal.x, groundNode(flat).sub(0.012), positionLocal.z) as any;
    material.normalNode = normalMap(texture(normal, scan), vec2(1.2, 1.2)) as any;
    const away = smoothstep(14, 4, length(flat)) as any;
    material.colorNode = texture(colour, scan).rgb.mul(0.6).mul(away) as any;
    material.emissiveNode = texture(colour, scan).rgb.mul(giantLight()).mul(0.5).mul(away) as any;
    const mesh = new THREE.Mesh(geometry, material);
    return { mesh, material, geometry };
  }, []);
  useDispose(geometry, material);
  return <primitive object={mesh} />;
}

// How much the logs shade the floor at a point on it (x, z): 1 in the open, darker toward where each lies on it.
function logShade(p: any): any {
  const x = p.x as any;
  const tanh = (u: any) => u.mul(2).exp().sub(1).div(u.mul(2).exp().add(1)) as any;
  const z = float(-0.95)
    .sub(x.mul(0.06))
    .add(sin(x.mul(1.3).add(0.4)).mul(0.04))
    .add(tanh(x.sub(0.2).mul(5)).mul(0.05)) as any;
  const r = float(LOG.radius).mul(float(1.12).sub(x.mul(0.1))) as any;
  const along = smoothstep(LOG.to + 0.05, LOG.to - 0.1, x.abs()) as any;
  let shade = float(1).sub(smoothstep(r.add(0.1), r.mul(0.7), p.y.sub(z).abs()).mul(along).mul(0.6)) as any;
  for (const log of FALLEN) {
    const [c, sn] = [Math.cos(log.yaw), Math.sin(log.yaw)];
    const dx = x.sub(log.x) as any;
    const dz = p.y.sub(log.z) as any;
    const u = dx
      .mul(c)
      .sub(dz.mul(sn))
      .abs()
      .sub((log.profile.length * log.scale) / 2)
      .max(0) as any;
    const v = dx.mul(sn).add(dz.mul(c)).abs() as any;
    const d = vec2(u, v).length() as any;
    const half = 0.12 * log.scale * (log.scan === "dead_tree_trunk" ? 1 : 2.2);
    shade = shade.mul(float(1).sub(smoothstep(half + 0.08, half * 0.6, d).mul(0.55)));
  }
  return shade;
}

// How much bark one copy of the scan covers, in metres: the trees' and the log's (round it; twice that along it).
const BARK = 0.3;
const OAK = 0.32;

// How an end of a tube is finished: left open (sunk in something), snapped off in splinters, or rotted hollow.
type End = "open" | "broken" | "rotten";

// A tapering tube along a curve, with the bark scan wrapped round it a whole number of times so it meets itself, and
// running along it as bark grows. `radius` gives its thickness along it (0 to 1); `mark` anything else the shader
// should know there, such as how near a knot (on an end, 1 if snapped); `shape` how far out it bulges at each point round it, for wood that is
// never quite round; `ends` how each end is finished. Its ends are marked for the shader (aEnd 1), with how far out
// from the heart each point lies in uv.x.
function tube(
  points: THREE.Vector3[],
  radius: (t: number) => number,
  sides: number,
  perMetre: number,
  tile: number,
  mark: (t: number) => number = () => 0,
  { shape, ends = ["open", "open"] }: { shape?: (t: number, out: THREE.Vector3) => number; ends?: [End, End] } = {}
) {
  const curve = new THREE.CatmullRomCurve3(points);
  const length = curve.getLength();
  const steps = Math.max(6, Math.round(length * perMetre));
  const frames = curve.computeFrenetFrames(steps, false);
  const around = Math.max(1, Math.round((2 * Math.PI * radius(0)) / tile));
  const position: number[] = [];
  const normal: number[] = [];
  const uvs: number[] = [];
  const marks: number[] = [];
  const index: number[] = [];
  const outward = (i: number, a: number) => frames.normals[i].clone().multiplyScalar(Math.cos(a)).addScaledVector(frames.binormals[i], Math.sin(a));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const at = curve.getPointAt(t);
    const r = radius(t);
    for (let j = 0; j <= sides; j++) {
      const n = outward(i, (j / sides) * Math.PI * 2);
      const k = shape ? shape(t, n) : 1;
      position.push(at.x + n.x * r * k, at.y + n.y * r * k, at.z + n.z * r * k);
      normal.push(n.x, n.y, n.z);
      uvs.push((j / sides) * around, (t * length) / tile);
      marks.push(mark(t));
    }
  }
  for (let i = 0; i < steps; i++)
    for (let j = 0; j < sides; j++) {
      const a = i * (sides + 1) + j;
      const b = a + sides + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute("aMark", new THREE.Float32BufferAttribute(marks, 1));
  g.setAttribute("aEnd", new THREE.Float32BufferAttribute(new Float32Array(marks.length), 1));
  // Wound to face outward whichever way the curve runs: the frames along a curve can turn either way about it, and
  // a tube wound inside out is drawn from within.
  {
    const corner = (k: number) => new THREE.Vector3(position[index[k] * 3], position[index[k] * 3 + 1], position[index[k] * 3 + 2]);
    const face = new THREE.Vector3().crossVectors(corner(1).sub(corner(0)), corner(2).sub(corner(0)));
    const out = new THREE.Vector3(normal[index[0] * 3], normal[index[0] * 3 + 1], normal[index[0] * 3 + 2]);
    if (face.dot(out) < 0) for (let k = 0; k < index.length; k += 3) [index[k + 1], index[k + 2]] = [index[k + 2], index[k + 1]];
  }
  g.setIndex(index);
  if (shape) {
    // Lumpy wood lights by its own lumps; where the tube meets itself round the back, both sides agree.
    g.computeVertexNormals();
    const nr = g.getAttribute("normal");
    for (let i = 0; i <= steps; i++) {
      const [a, b] = [i * (sides + 1), i * (sides + 1) + sides];
      const v = new THREE.Vector3(nr.getX(a) + nr.getX(b), nr.getY(a) + nr.getY(b), nr.getZ(a) + nr.getZ(b)).normalize();
      nr.setXYZ(a, v.x, v.y, v.z);
      nr.setXYZ(b, v.x, v.y, v.z);
    }
  }
  const parts = [g];
  ends.forEach((kind, e) => {
    if (kind === "open") return;
    const i = e ? steps : 0;
    const t = e ? 1 : 0;
    const at = curve.getPointAt(t);
    const out = frames.tangents[i].clone().multiplyScalar(e ? 1 : -1);
    const r = radius(t);
    const seed = e * 2.3 + r * 40;
    const capPosition: number[] = [];
    const capUv: number[] = [];
    const rings = kind === "broken" ? 18 : 9;
    for (let q = 0; q <= rings; q++) {
      const f = 1 - q / rings;
      for (let j = 0; j <= sides; j++) {
        const a = (j / sides) * Math.PI * 2;
        const n = outward(i, a);
        const k = shape ? shape(t, n) : 1;
        let lift: number;
        if (kind === "broken") {
          // Torn fibres: jagged spikes of every height standing out of the break, the heart pulled out a little.
          const spike = (k: number, m: number, twist: number, phase: number) => Math.max(0, Math.sin(a * k + seed * phase) * Math.sin(f * m + a * twist + seed));
          const jag = 3 * spike(4, 6, 2, 1) ** 2 + 1.5 * spike(9, 11, -3, 1.3) ** 3 + 0.6 * spike(23, 19, 5, 0.7) ** 2;
          lift = r * (jag * Math.min(1, (1 - f) * 5) + 0.15 * (1 - f));
        } else {
          // Rotted from the heart: a soft lip of sapwood round a hollow going in.
          const lip = 0.12 * Math.sin(a * 5 + seed) + 0.06 * Math.sin(a * 11 + seed * 2);
          lift = r * (-1.1 * Math.max(0, 1 - f / 0.62) ** 0.7 + lip * f * (1 - f) * 4);
        }
        capPosition.push(at.x + n.x * r * k * f + out.x * lift, at.y + n.y * r * k * f + out.y * lift, at.z + n.z * r * k * f + out.z * lift);
        capUv.push(f, j / sides);
      }
    }
    const capIndex: number[] = [];
    for (let q = 0; q < rings; q++)
      for (let j = 0; j < sides; j++) {
        const a = q * (sides + 1) + j;
        const b = a + sides + 1;
        // Wound to face out of whichever end it closes.
        if (e) capIndex.push(a, b, a + 1, a + 1, b, b + 1);
        else capIndex.push(a, a + 1, b, a + 1, b + 1, b);
      }
    const cap = new THREE.BufferGeometry();
    cap.setAttribute("position", new THREE.Float32BufferAttribute(capPosition, 3));
    cap.setAttribute("uv", new THREE.Float32BufferAttribute(capUv, 2));
    cap.setAttribute("aMark", new THREE.Float32BufferAttribute(new Float32Array(capUv.length / 2).fill(kind === "broken" ? 1 : 0), 1));
    cap.setAttribute("aEnd", new THREE.Float32BufferAttribute(new Float32Array(capUv.length / 2).fill(1), 1));
    cap.setIndex(capIndex);
    cap.computeVertexNormals();
    parts.push(cap);
  });
  return parts.length > 1 ? mergeGeometries(parts) : g;
}

// Bracket fungi: a woody shelf jutting from the bark, half a flattened dome, marked with how far out each point lies
// from where it grows (aMark) for its growth rings, and as fungus (aEnd 2).
function bracket(at: THREE.Vector3, out: THREE.Vector3, size: number, tilt: number) {
  const g = new THREE.SphereGeometry(1, 28, 14, 0, Math.PI);
  const p = g.getAttribute("position");
  const marks: number[] = [];
  for (let i = 0; i < p.count; i++) {
    const [x, y, z] = [p.getX(i), p.getY(i), p.getZ(i)];
    const d = Math.hypot(x, z);
    marks.push(d);
    // Flat beneath, a low rounded top, its edge a little wavy.
    const wave = 1 + 0.06 * Math.sin(Math.atan2(z, x) * 7 + size * 300);
    p.setXYZ(i, x * wave, y > 0 ? y * 0.32 : y * 0.08, z * 0.78 * wave);
  }
  g.computeVertexNormals();
  g.setAttribute("aMark", new THREE.Float32BufferAttribute(marks, 1));
  g.setAttribute("aEnd", new THREE.Float32BufferAttribute(new Float32Array(p.count).fill(2), 1));
  g.scale(size, size, size);
  g.rotateX(-tilt);
  g.rotateY(Math.atan2(out.x, out.z));
  g.translate(at.x, at.y, at.z);
  return g;
}

// A cheap hash-free wobble for shaping wood: a few sines round and along it.
const lumps = (a: number, x: number) => 0.04 * Math.sin(2 * a + 1.3 + x * 1.7) + 0.03 * Math.sin(3 * a - x * 2.9 + 0.5) + 0.018 * Math.sin(5 * a + x * 6.1 + 2) + 0.01 * Math.sin(9 * a - x * 11);
// Long splits in the main log, where it dried and checked: round it (angle), and from where to where along it.
const SPLITS: [number, number, number][] = [
  [1.2, -1.9, -0.4],
  [2.3, 0.1, 1.6],
  [0.5, 0.7, 2.2],
  [-2.6, -1.2, 0.3]
];

// Bump from a height worked out in the shader rather than read from a texture: the surface tilted by how fast the
// height changes across the screen.
const bumped = (height: any, scale: number) => {
  const dx = positionView.dFdx() as any;
  const dy = positionView.dFdy() as any;
  const r1 = dy.cross(normalView) as any;
  const r2 = normalView.cross(dx) as any;
  const det = dx.dot(r1) as any;
  const grad = det.sign().mul(r1.mul(height.dFdx().mul(scale)).add(r2.mul(height.dFdy().mul(scale)))) as any;
  return det.abs().mul(normalView).sub(grad).normalize();
};

// The fallen log: kinked where it broke, never quite round, swelling at its knots and split along its length; snapped
// off in splinters at one end and rotted hollow at the other; a few branches still on it (one long and bending up,
// the rest snapped short). Its bark has sloughed away in patches to grey, checked grain; moss lies thick over its
// top, lichen crusts its sides, and bracket fungi shelve out of it.
export function Log({ tier }: { tier: QualityTier }) {
  const { mesh, material, geometry } = useMemo(() => {
    const fine = tier === "high" ? 1 : tier === "medium" ? 0.75 : 0.45;
    const span = LOG.to - LOG.from;
    const points: THREE.Vector3[] = [];
    for (let k = 0; k <= 48; k++) {
      const x = LOG.from + (span * k) / 48;
      points.push(new THREE.Vector3(x, logY(x), logZ(x)));
    }
    const xOf = (t: number) => LOG.from + span * t;
    const knotAt = (x: number) => KNOTS.reduce((m, k) => Math.max(m, Math.exp(-(((x - k) / 0.05) ** 2))), 0);
    const shape = (t: number, n: THREE.Vector3) => {
      const x = xOf(t);
      const a = Math.atan2(n.y, n.z);
      let k = 1 + lumps(a, x);
      for (const [at, from, to] of SPLITS) {
        const along = THREE.MathUtils.smoothstep(x, from, from + 0.25) * THREE.MathUtils.smoothstep(x, to, to - 0.25);
        const off = Math.atan2(Math.sin(a - at), Math.cos(a - at));
        k *= 1 - 0.09 * along * Math.exp(-((off / 0.035) ** 2));
      }
      // Settled flat where it bears on the ground.
      if (n.y < -0.4) k *= 1 - 0.2 * (-n.y - 0.4);
      return k;
    };
    const parts = [
      tube(
        points,
        (t) => logRadius(xOf(t)),
        Math.round(128 * fine),
        110 * fine,
        OAK,
        (t) => knotAt(xOf(t)),
        { shape, ends: ["rotten", "broken"] }
      )
    ];
    // Branches from the knots: out and up from the side of the log, tapering to a snapped end.
    const branches: [number, number, number, number][] = [
      [KNOTS[0], 1.9, 0.42, 0.55],
      [KNOTS[1], 0.9, 0.12, 0.7],
      [KNOTS[2], 2.4, 0.2, 0.62],
      [KNOTS[3], 1.2, 0.3, 0.6]
    ];
    for (const [x, turn, length, rise] of branches) {
      const r = logRadius(x) * 0.42;
      const out = new THREE.Vector3(0, Math.sin(turn), Math.cos(turn)).normalize();
      const base = new THREE.Vector3(x, logY(x), logZ(x));
      const dir = out
        .clone()
        .multiplyScalar(1 - rise)
        .add(new THREE.Vector3(0.25, rise, 0))
        .normalize();
      const pts = [0, 0.33, 0.66, 1].map((k) =>
        base
          .clone()
          .addScaledVector(out, logRadius(x) * 0.5)
          .addScaledVector(dir, length * k)
          .add(new THREE.Vector3(0, -0.04 * k * k * length, 0.03 * Math.sin(k * 5)))
      );
      parts.push(
        tube(
          pts,
          (t) => r * (1 - t * 0.6),
          Math.round(28 * fine),
          160 * fine,
          OAK * 0.5,
          () => 0,
          {
            shape: (t, n) => 1 + 0.6 * lumps(Math.atan2(n.y, n.x + n.z), t * 9 + x),
            ends: ["open", "broken"]
          }
        )
      );
    }
    // Bracket fungi, in tiers on the side toward the floor and one or two round the back.
    const shelves: [number, number, number, number][] = [
      [-1.62, 0.25, 0.05, 0.1],
      [-1.55, -0.05, 0.038, 0.18],
      [-1.68, -0.3, 0.03, 0.05],
      [0.98, 0.15, 0.045, 0.12],
      [1.05, -0.15, 0.03, 0.2],
      [1.92, 0.35, 0.034, 0.08],
      [-0.7, Math.PI - 0.2, 0.05, 0.1],
      [0.2, Math.PI + 0.1, 0.036, 0.15]
    ];
    for (const [x, angle, size, tilt] of shelves) {
      const out = new THREE.Vector3(0, Math.sin(angle), Math.cos(angle));
      const at = new THREE.Vector3(x, logY(x), logZ(x)).addScaledVector(out, logRadius(x) * 0.92);
      parts.push(bracket(at, new THREE.Vector3(0, 0, Math.cos(angle)), size, tilt));
    }
    const geometry = mergeGeometries(parts);
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
    const res = tier === "high" ? "2k" : "1k";
    const colour = load(`jolcham_oak_bark_01_diff_${res}`, true);
    const normal = load(`jolcham_oak_bark_01_nor_gl_${res}`, false);
    const height = load(`jolcham_oak_bark_01_disp_${res}`, false);
    const rough = load(`jolcham_oak_bark_01_rough_${res}`, false);
    const mossColour = load("moss_diff_1k", true);
    const mossHeight = load("moss_disp_1k", false);
    // The oak scan is twice as long as it is wide, its furrows running along it.
    const scan = uv().mul(vec2(1, 0.5)) as any;
    const mossScan = scan.mul(1.7) as any;
    const bark = texture(height, scan).r as any;
    const knot = attribute("aMark", "float") as any;
    const end = attribute("aEnd", "float") as any;
    const cut = end.sub(1).abs().oneMinus().clamp(0, 1) as any;
    const fungus = end.sub(1).clamp(0, 1) as any;
    const sides = float(1).sub(end.clamp(0, 1)) as any;
    const p = positionLocal as any;
    // Bark gone in long patches along the grain, its edge torn along the bark's own furrows, showing grey, fibrous
    // wood split by fine checks; a dark lifting lip of bark round each.
    const loss = mx_noise_float(p.mul(vec3(1.1, 6, 6)).add(vec3(0, 3.1, 0)))
      .add(mx_noise_float(p.mul(4)).mul(0.25))
      .add(bark.sub(0.5).mul(0.3)) as any;
    const bare = smoothstep(0.4, 0.43, loss).mul(float(1).sub(knot)).mul(sides) as any;
    const lip = smoothstep(0.34, 0.4, loss).sub(bare).mul(sides) as any;
    const fibre = mx_noise_float(p.mul(vec3(2, 160, 160)))
      .add(mx_noise_float(p.mul(vec3(5, 420, 420))).mul(0.5))
      .mul(0.4)
      .add(0.5)
      .clamp(0, 1) as any;
    const check = smoothstep(0.06, 0.0, mx_noise_float(p.mul(vec3(1.6, 34, 34))).abs()) as any;
    // Moss on whatever faces up, in soft-edged patches, swelling a little proud of the bark, down into its fissures;
    // none on the knots, the bare wood or the ends.
    const up = normalLocal.y as any;
    const patches = mx_noise_float(p.mul(6)).mul(0.35) as any;
    const crevice = float(1).sub(bark).mul(0.25) as any;
    const moss = smoothstep(0.05, 0.55, up.add(patches).add(crevice))
      .mul(float(1).sub(knot.mul(0.8)))
      .mul(float(1).sub(bare.mul(0.7)))
      .mul(sides) as any;
    const mossLift = texture(mossHeight, mossScan).r as any;
    // Lichen: pale crusts in rosettes on the bark of its sides.
    const lichen = smoothstep(0.5, 0.58, mx_noise_float(p.mul(38)).add(mx_noise_float(p.mul(110)).mul(0.3)))
      .mul(smoothstep(-0.1, 0.3, mx_noise_float(p.mul(3.3))))
      .mul(float(1).sub(moss))
      .mul(float(1).sub(bare))
      .mul(sides) as any;
    // The end grain: growth rings out from the heart, wavering, cracked in radial checks, soft and dark with rot at
    // the heart.
    const ring = scan.x as any;
    const turn = scan.y.mul(Math.PI * 2) as any;
    const wobble = mx_noise_float(p.mul(30)).mul(0.04) as any;
    const growth = sin(ring.add(wobble).mul(64)).mul(0.5).add(0.5) as any;
    const radial = smoothstep(0.93, 1, sin(turn.mul(9).add(mx_noise_float(p.mul(12)).mul(2))).abs()).mul(smoothstep(0.95, 0.3, ring)) as any;
    const grainLift = fibre.mul(0.0012).sub(check.mul(0.004)).sub(0.006) as any;
    const sideLift = mix(mix(bark.sub(0.6).mul(0.02), mossLift.mul(0.012), moss), grainLift, bare)
      .add(lip.mul(0.002))
      .add(lichen.mul(0.0008)) as any;
    material.positionNode = p.add(normalLocal.mul(sideLift.mul(sides))) as any;
    const woodHeight = fibre.mul(0.3).sub(check) as any;
    const endHeight = mix(growth.mul(0.25).sub(radial), fibre, knot) as any;
    const fungusHeight = sin(knot.mul(70)).mul(0.5) as any;
    const barkNormal = normalMap(texture(normal, scan), vec2(2, 2)) as any;
    material.normalNode = Fn(() => {
      const plain = mix(barkNormal, bumped(woodHeight, 0.004), bare) as any;
      return (mix(mix(plain, bumped(endHeight, 0.003), cut), bumped(fungusHeight, 0.002), fungus) as any).normalize();
    })() as any;
    // A knot: darker, its grain swirling round in rings.
    const rings = sin(knot.mul(40)).mul(0.5).add(0.5) as any;
    const barkColour = texture(colour, scan)
      .rgb.mul(1.15)
      .mul(mix(float(1), rings.mul(0.35).add(0.45), knot.mul(sides))) as any;
    const greyWood = mix(vec3(0.06, 0.05, 0.04), vec3(0.3, 0.27, 0.22), fibre.mul(fibre)).mul(float(1).sub(check.mul(0.85))) as any;
    const green = mix(vec3(0.75, 0.85, 0.6), vec3(1.1, 1.05, 0.7), mx_noise_float(p.mul(9)).mul(0.5).add(0.5))
      .mul(texture(mossColour, mossScan).rgb)
      .mul(mossLift.mul(0.5).add(0.6)) as any;
    const crust = mix(vec3(0.24, 0.27, 0.22), vec3(0.36, 0.39, 0.31), mx_noise_float(p.mul(140)).mul(0.5).add(0.5)) as any;
    // A rotted end shows its rings round a dark, soft heart; a snapped one torn fibres, paler where freshly broken.
    const crumble = mx_noise_float(p.mul(90)).mul(0.5).add(0.5) as any;
    const rotted = mix(mix(vec3(0.035, 0.024, 0.016), vec3(0.09, 0.06, 0.035), crumble), mix(vec3(0.16, 0.11, 0.07), vec3(0.27, 0.2, 0.13), growth), smoothstep(0.55, 0.8, ring)).mul(
      float(1).sub(radial.mul(0.8))
    ) as any;
    const torn = mix(vec3(0.1, 0.075, 0.05), vec3(0.3, 0.23, 0.15), fibre) as any;
    const endWood = mix(rotted, torn, knot).mul(mix(float(1), float(0.45), smoothstep(0.9, 1, ring))) as any;
    // Growth bands round a bracket, a pale growing edge, cream pores beneath.
    const band = sin(knot.mul(55)).mul(0.5).add(0.5) as any;
    const shelf = mix(mix(vec3(0.16, 0.1, 0.06), vec3(0.38, 0.27, 0.16), band), vec3(0.42, 0.37, 0.28), smoothstep(0.86, 0.97, knot)) as any;
    const fungusColour = mix(shelf, vec3(0.32, 0.29, 0.22), smoothstep(0, -0.5, normalLocal.y)) as any;
    // Damp and dark where it lies in the litter.
    const above = positionWorld.y.sub(groundNode(positionWorld.xz)) as any;
    const dry = smoothstep(0.0, 0.06, above) as any;
    const sideColour = mix(mix(mix(barkColour, greyWood, bare), crust, lichen.mul(0.6)), green, moss).mul(float(1).sub(lip.mul(0.4))) as any;
    const albedo = mix(mix(sideColour, endWood, cut), fungusColour, fungus).mul(dry.mul(0.55).add(0.45)) as any;
    material.colorNode = albedo;
    material.roughnessNode = mix(mix(mix(texture(rough, scan).r, float(0.75), bare), float(1), moss), float(0.6), float(1).sub(dry).mul(0.6)) as any;
    material.emissiveNode = Fn(() => {
      const facing = normalize(normalWorld).y.mul(0.4).add(0.6) as any;
      // Moss rims catch the moon from behind as fine fuzz.
      const V = normalize(cameraPosition.sub(positionWorld)) as any;
      const rim = pow(dot(normalize(normalWorld), V).abs().oneMinus(), 3)
        .mul(moss)
        .mul(light.moonPower)
        .mul(0.05) as any;
      // The night sky's faint light, so the bark reads in the dark rather than going to silhouette.
      const sky = light.moon.mul(light.moonPower).mul(facing).mul(0.9) as any;
      return albedo
        .mul(glowAt(positionWorld).add(giantLight().mul(0.25)).mul(0.6).add(sky))
        .mul(facing)
        .add(light.moon.mul(rim));
    })() as any;
    const mesh = new THREE.Mesh(geometry, material);
    return { mesh, material, geometry };
  }, [tier]);
  useDispose(geometry, material);
  return <primitive object={mesh} />;
}

// The woods all round: tall dark trunks standing back from the floor, their branches reaching out overhead, lit at
// their edges by the moon and on their near sides by the giant mushrooms glowing among them.
export function Trees({ tier }: { tier: QualityTier }) {
  const { mesh, material, geometry, fungi, shelf, shelfMaterial } = useMemo(() => {
    let seed = 41;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const fine = tier === "low" ? 0.5 : 1;
    const parts: THREE.BufferGeometry[] = [];
    // Shelf fungi on the trunks, a few to a tree, low down: where each sits, which way it faces, its size and colour.
    const shelves: { at: THREE.Vector3; turn: number; size: number; hue: number }[] = [];
    let placed = 0;
    for (let tries = 0; placed < (tier === "low" ? 12 : 20) && tries < 200; tries++) {
      const a = random() * Math.PI * 2;
      const d = 3.2 + random() ** 0.8 * 8;
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      // Not in front of the eye, nor on a giant.
      if (z > 1 && Math.abs(x) < 2.5) continue;
      if (GIANTS.some((g) => Math.hypot(g.x - x, g.z - z) < 1.6 + g.cap)) continue;
      placed++;
      const r = 0.14 + random() * 0.32;
      const lean = new THREE.Vector3(random() - 0.5, 0, random() - 0.5).multiplyScalar(0.6);
      const base = new THREE.Vector3(x, groundAt(x, z) - 0.2, z);
      const trunk = [0, 3, 7, 12, 16].map((h) =>
        base
          .clone()
          .add(new THREE.Vector3(0, h, 0))
          .addScaledVector(lean, h * 0.05 + Math.sin(h * 0.4 + a) * 0.1)
      );
      parts.push(tube(trunk, (t) => r * (1 - t * 0.55) * (1 + 0.5 * Math.exp(-t * 30)), Math.round(18 * fine), 2 * fine, 0.9));
      const hue = Math.floor(random() * 8);
      for (let k = 0, n = 2 + Math.floor(random() * 4); k < n; k++) {
        const h = 0.3 + random() * 2.6;
        const turn = random() * Math.PI * 2;
        const girth = r * (1 - (h / 16) * 0.55) * (1 + 0.5 * Math.exp(-(h / 16) * 30));
        const at = base
          .clone()
          .add(new THREE.Vector3(Math.cos(turn) * girth * 0.92, h, Math.sin(turn) * girth * 0.92))
          .addScaledVector(lean, h * 0.05);
        shelves.push({ at, turn, size: 0.14 + random() * 0.18, hue: random() < 0.7 ? hue : Math.floor(random() * 8) });
      }
      // Branches higher up, reaching out and up, tapering to nothing.
      const count = 2 + Math.floor(random() * 3);
      for (let b = 0; b < count; b++) {
        const h = 2.5 + random() * 6;
        const from = base
          .clone()
          .add(new THREE.Vector3(0, h, 0))
          .addScaledVector(lean, h * 0.05);
        const turn = random() * Math.PI * 2;
        const out = new THREE.Vector3(Math.cos(turn), 0.5 + random() * 0.5, Math.sin(turn)).normalize();
        const length = 1.5 + random() * 3;
        const pts = [0, 0.4, 0.75, 1].map((k) =>
          from
            .clone()
            .addScaledVector(out, length * k)
            .add(new THREE.Vector3(0, -0.4 * k * k, 0))
        );
        const br = r * (0.3 + random() * 0.2);
        parts.push(tube(pts, (t) => br * (1 - t * 0.9), Math.round(8 * fine), 3 * fine, 0.9));
      }
    }
    const geometry = mergeGeometries(parts);
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
    const colour = load("bark_brown_02_diff_1k", true);
    const normal = load("bark_brown_02_nor_gl_1k", false);
    material.colorNode = texture(colour, uv()).rgb.mul(0.35) as any;
    material.normalNode = normalMap(texture(normal, uv()), vec2(1.5, 1.5)) as any;
    material.emissiveNode = Fn(() => {
      const albedo = texture(colour, uv()).rgb.mul(0.35) as any;
      const V = normalize(cameraPosition.sub(positionWorld)) as any;
      const rim = pow(dot(normalize(normalWorld), V).abs().oneMinus(), 4)
        .mul(light.moonPower)
        .mul(0.06) as any;
      // Mist between here and there: the further, the more of the night's own colour.
      const far = smoothstep(3, 12, length(positionWorld.xz.sub(cameraPosition.xz))) as any;
      return albedo
        .mul(giantLight().mul(1.2))
        .add(light.moon.mul(rim))
        .add(light.horizon.mul(far.mul(0.6)));
    })() as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.layers.enable(REFLECTED);
    mesh.frustumCulled = false;
    // The shelves: half a flattened dome each, few faces, glowing softly in the colours of the blooms, brightest along
    // their rims and underneath, as the mushrooms' gills are.
    const shelf = new THREE.SphereGeometry(1, 10, 4, 0, Math.PI);
    shelf.scale(1, 0.28, 0.8);
    const hues = new Float32Array(shelves.length);
    shelves.forEach((f, k) => (hues[k] = f.hue));
    shelf.setAttribute("aHue", new THREE.InstancedBufferAttribute(hues, 1));
    const shelfMaterial = new THREE.MeshBasicNodeMaterial({ fog: false });
    shelfMaterial.colorNode = Fn(() => {
      const tint = paletteAt(attribute("aHue", "float")) as any;
      const under = smoothstep(0.2, -0.6, normalize(normalWorld).y) as any;
      const rim = smoothstep(0.55, 0.95, length(positionGeometry.xz)) as any;
      return vec4(tint.mul(float(0.2).add(under.mul(0.9)).add(rim.mul(0.8))), 1);
    })() as any;
    const fungi = new THREE.InstancedMesh(shelf, shelfMaterial, Math.max(1, shelves.length));
    const m = new THREE.Matrix4();
    shelves.forEach((f, k) => {
      m.compose(f.at, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2 - f.turn, 0)), new THREE.Vector3(f.size, f.size, f.size));
      fungi.setMatrixAt(k, m);
    });
    fungi.count = shelves.length;
    fungi.frustumCulled = false;
    return { mesh, material, geometry, fungi, shelf, shelfMaterial };
  }, [tier]);
  useDispose(geometry, material);
  useDispose(shelf, shelfMaterial);
  return (
    <>
      <primitive object={mesh} />
      <primitive object={fungi} />
    </>
  );
}

// The dome of night behind everything.
export function Backdrop() {
  const { mesh, material } = useMemo(() => {
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: true, fog: false });
    // The night over the trees: stars all round, twinkling, the rarer ones brighter, and the Milky Way across them as a
    // faint band; fading out low down among the trunks.
    material.colorNode = Fn(() => {
      const d = normalize(positionWorld) as any;
      // Coarse enough that a star still shows as a soft point through the blur on the far woods.
      const grid = d.mul(210) as any;
      const cell = floor(grid) as any;
      const lucky = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))).mul(43758.5453)) as any;
      const twinkle = sin((clock as any).mul(1.4).add(lucky.mul(90)))
        .mul(0.3)
        .add(0.7) as any;
      const point = smoothstep(0.42, 0.05, (fract(grid).sub(0.5) as any).length()) as any;
      const stars = smoothstep(0.975, 1, lucky).mul(point).mul(twinkle).mul(9) as any;
      const band = mx_noise_float(d.mul(2.4).add(vec3(9, 0, 3))) as any;
      const milky = smoothstep(-0.02, 0.5, band).mul(smoothstep(0.35, 0.0, abs(d.x.mul(0.6).add(d.z.mul(0.8)).sub(d.y.mul(0.25))))) as any;
      const high = smoothstep(-0.03, 0.12, d.y) as any;
      return environment(d).add(
        vec3(0.09, 0.12, 0.24)
          .mul(milky.mul(1.1))
          .add(vec3(0.85, 0.9, 1).mul(stars.mul(milky.mul(1.5).add(0.6))))
          .mul(high)
      );
    })() as any;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(30, 48, 24), material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -2;
    return { mesh, material };
  }, []);
  useDispose(mesh.geometry, material);
  return <primitive object={mesh} />;
}

// Far blooms deep in the woods, out of focus: soft discs with brighter rims, as a lens draws points of light, each
// breathing slowly.
export function Bokeh({ tier }: { tier: QualityTier }) {
  const count = tier === "low" ? 30 : 80;
  const { mesh, material } = useMemo(() => {
    let seed = 91;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const at: number[] = [];
    const tint: number[] = [];
    for (let i = 0; i < count; i++) {
      // Mostly behind the floor, where the eye looks, low among the trunks.
      const a = -Math.PI / 2 + (random() - 0.5) * Math.PI * 1.6;
      const r = 5 + random() * 12;
      at.push(Math.cos(a) * r, -0.2 + random() ** 1.6 * 2.2, Math.sin(a) * r, 0.06 + random() ** 2 * 0.4);
      tint.push(Math.floor(random() * 3), random() * 100, 0.35 + random() * 0.65, 0);
    }
    geometry.setAttribute("aAt", new THREE.InstancedBufferAttribute(new Float32Array(at), 4));
    geometry.setAttribute("aTint", new THREE.InstancedBufferAttribute(new Float32Array(tint), 4));
    geometry.instanceCount = count;
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const placed = attribute("aAt", "vec4") as any;
    const t = attribute("aTint", "vec4") as any;
    const centre = placed.xyz as any;
    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const right = normalize(vec3(toEye.z, 0, toEye.x.negate())) as any;
    const upward = normalize(toEye.cross(right).negate()) as any;
    material.positionNode = centre.add(right.mul(positionGeometry.x.mul(placed.w))).add(upward.mul(positionGeometry.y.mul(placed.w))) as any;
    material.colorNode = Fn(() => {
      const r = positionGeometry.xy.length() as any;
      const disc = smoothstep(1, 0.92, r) as any;
      const rim = smoothstep(0.7, 0.96, r).mul(disc).mul(0.5) as any;
      const breathe = sin((clock as any).mul(0.6).add(t.y))
        .mul(0.3)
        .add(0.7) as any;
      const tint = mix(mix(light.far[0], light.far[1], t.x.greaterThan(0.5).select(1, 0)), light.far[2], t.x.greaterThan(1.5).select(1, 0)) as any;
      return vec4(tint.mul(disc.mul(0.5).add(rim)).mul(t.z).mul(breathe).mul(0.22), 1);
    })() as any;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    return { mesh, material };
  }, [count]);
  useDispose(mesh.geometry, material);
  return <primitive object={mesh} />;
}
