"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import {
  abs,
  asin,
  atan,
  attribute,
  cameraFar,
  cameraNear,
  cameraPosition,
  color,
  cos,
  cross,
  dot,
  exp,
  float,
  floor,
  fract,
  Fn,
  instanceIndex,
  int,
  length,
  Loop,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  perspectiveDepthToViewZ,
  positionGeometry,
  positionView,
  positionWorld,
  pow,
  screenUV,
  select,
  sin,
  smoothstep,
  step,
  time,
  transformNormalToView,
  uniform,
  uv,
  varying,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { focusDistance, OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";
import { lehmer } from "../../shared/engine/random";
import type { Dust } from "./dust";
import { clock, ring, ringCount, shapeAt, shudderAt } from "./form";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The light: a warm key high on the left, which the shafts in the air come from (Erosion's).
export const KEY = new THREE.Vector3(-4.3, 3.6, 1.5);

export const look = {
  // The dust in the air: 0 flecks of the form's dust, 1 sparks; and its size.
  dustStyle: uniform(0, "int"),
  dustSize: uniform(1)
};

// ?debug=normals draws the form's normals as colour, to check they face outward.
const SHOW_NORMALS = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "normals";

// A unit sphere with each vertex shared by its triangles, so the shape is worked out once per point.
function sphere(detail: number) {
  const raw = new THREE.IcosahedronGeometry(1, detail);
  raw.deleteAttribute("normal");
  raw.deleteAttribute("uv");
  const shared = mergeVertices(raw, 1e-5);
  raw.dispose();
  return shared;
}

const STONE = new THREE.Color("#100f0e");
const STONE_LIGHT = new THREE.Color("#221f1c");
const DUST = new THREE.Color("#6f6962");
const EMBER = new THREE.Color("#ff5f1a");
const SEAM = new THREE.Color("#ffd29a");

// The form: dark matte stone under a skin of pale dust. It shudders where a front passes; along each front a thin seam
// of light; where dust was shed the stone glows from within for a moment, through fine cracks, then dulls.
export function Form({ detail, dust }: { detail: number; dust: Dust }) {
  const parts = useMemo(() => {
    const geometry = sphere(detail);
    const m = new THREE.MeshStandardNodeMaterial();
    {
      const n = normalize(positionGeometry) as any;
      const shape = shapeAt(n, clock);
      const sh = shudderAt(n, clock);
      m.positionNode = n.mul(shape.r.add(sh.lift)) as any;
    }
    const normal = (() => {
      const n = normalize(attribute("position", "vec3")) as any;
      const shape = shapeAt(n, clock);
      const sh = shudderAt(n, clock);
      const r = shape.r.add(sh.lift) as any;
      return varying(normalize(n.mul(r).sub(shape.grad).sub(sh.grad)), "vShedNormal") as any;
    })();
    const N = normalize(normal) as any;
    const dir = normalize(varying(normalize(attribute("position", "vec3")), "vShedDir")) as any;

    // The skin under this point, read smoothly between texels (wrapping round in longitude).
    const { SW, SH, skin } = dust;
    const lon = atan(dir.z, dir.x) as any;
    const lat = asin(dir.y.clamp(-1, 1)) as any;
    const fx = lon
      .div(Math.PI * 2)
      .add(1)
      .mod(1)
      .mul(SW)
      .sub(0.5) as any;
    const fy = lat
      .div(Math.PI)
      .add(0.5)
      .mul(SH)
      .sub(0.5)
      .clamp(0, SH - 1) as any;
    const x0 = floor(fx) as any;
    const y0 = floor(fy) as any;
    const tx = fx.sub(x0) as any;
    const ty = fy.sub(y0) as any;
    const at = (x: any, y: any) => skin.element(int(x.add(SW).mod(SW)).add(int(y.clamp(0, SH - 1)).mul(SW))) as any;
    const cell = mix(mix(at(x0, y0), at(x0.add(1), y0), tx), mix(at(x0, y0.add(1)), at(x0.add(1), y0.add(1)), tx), ty) as any;

    // Patchy dust: thick in broad drifts, thin in others, with a finer grain to its edge.
    const broad = mx_noise_float(dir.mul(3.1)) as any;
    const fine = mx_noise_float(dir.mul(17)) as any;
    const grain = mx_noise_float(dir.mul(61)) as any;
    const lies = cell.x.mul(broad.mul(0.55).add(0.78)).add(fine.mul(0.2)).add(grain.mul(0.1)) as any;
    const coat = smoothstep(0.45, 0.8, lies) as any;
    const stone = mix(color(STONE), color(STONE_LIGHT), smoothstep(-0.4, 0.6, fine.add(broad.mul(0.6)))) as any;
    const dusty = color(DUST).mul(grain.mul(0.12).add(fine.mul(0.08)).add(0.94)) as any;
    m.colorNode = mix(stone, dusty, coat) as any;
    m.roughnessNode = mix(float(0.66), float(0.96), coat) as any;
    m.metalnessNode = float(0);
    m.normalNode = transformNormalToView(N) as any;

    // The scar: the stone lit from inside, brightest along fine cracks, only where dust has come off.
    const crackNoise = mx_noise_float(dir.mul(5.5).add(vec3(0, 0, 3))).add(mx_noise_float(dir.mul(17)).mul(0.3)) as any;
    const crack = float(1).sub(smoothstep(0.0, 0.045, abs(crackNoise))) as any;
    const heat = cell.y as any;
    const glow = pow(heat.clamp(0, 1), float(2)) as any;
    const scar = color(EMBER)
      .mul(glow.mul(crack.mul(0.9).add(0.22)))
      .mul(float(1).sub(coat.mul(0.8))) as any;

    // The seams: each front a thin line of light, brightest where it closes on itself at a pole.
    const seam = Fn(() => {
      const sum = float(0).toVar() as any;
      Loop(ringCount, ({ i }: any) => {
        const r = ring(i, dir, clock);
        const sf = sin(r.front) as any;
        const closing = exp(sf.mul(sf).div(-0.0144)).mul(2.5).add(1) as any;
        const a2 = r.ahead.mul(r.ahead) as any;
        sum.addAssign(
          exp(a2.div(-0.016 * 0.016))
            .add(exp(a2.div(-0.05 * 0.05)).mul(0.08))
            .mul(r.strength)
            .mul(closing)
        );
      });
      return sum;
    })() as any;
    m.emissiveNode = scar.add(color(SEAM).mul(seam.mul(6))) as any;

    if (SHOW_NORMALS) {
      m.colorNode = vec3(0) as any;
      m.emissiveNode = N.mul(0.5).add(0.5) as any;
    }

    const mesh = new THREE.Mesh(geometry, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return { geometry, material: m, mesh };
  }, [detail, dust]);
  useDispose(parts.geometry, parts.material);
  return <primitive object={parts.mesh} />;
}

// The light in the air (Erosion's). The key pours in from the upper left as a few parallel shafts: a broad one across
// the form and narrower ones either side, each soft at its edges and breathing a little. Everything that floats is lit
// by the same function, so specks glint only where they cross a shaft.
const AXIS = KEY.clone().negate().normalize();
const SIDE = new THREE.Vector3().crossVectors(AXIS, new THREE.Vector3(0, 1, 0)).normalize();
const LIFT = new THREE.Vector3().crossVectors(SIDE, AXIS).normalize();
const BEAMS = [
  { across: 0, up: 0.05, width: 0.38, strength: 1, phase: 0 },
  { across: -1.05, up: 0.55, width: 0.22, strength: 0.75, phase: 1.7 },
  { across: 0.95, up: 0.75, width: 0.17, strength: 0.6, phase: 3.1 },
  { across: 1.8, up: -0.3, width: 0.26, strength: 0.5, phase: 4.6 },
  { across: -2.0, up: -0.6, width: 0.3, strength: 0.45, phase: 2.4 }
].map((beam) => ({ ...beam, from: KEY.clone().addScaledVector(SIDE, beam.across).addScaledVector(LIFT, beam.up) }));

const beamFrom = (k: number) => vec3(BEAMS[k].from.x, BEAMS[k].from.y, BEAMS[k].from.z) as any;
const axisNode = () => vec3(AXIS.x, AXIS.y, AXIS.z) as any;
const breathe = (k: number) => sin(time.mul(0.23).add(BEAMS[k].phase)).mul(0.18).add(0.82) as any;

function shaftAt(k: number, p: any) {
  const from = beamFrom(k);
  const axis = axisNode();
  const s = dot(p.sub(from), axis) as any;
  const waver = sin(s.mul(1.1).add(time.mul(0.09)).add(BEAMS[k].phase)).mul(0.07) as any;
  const off = length(p.sub(from.add(axis.mul(s))))
    .add(waver)
    .max(0) as any;
  const width = s.mul(0.035).add(BEAMS[k].width) as any;
  const across = off.div(width) as any;
  return exp(across.mul(across).negate().mul(1.9))
    .mul(0.78)
    .add(exp(across.mul(across).negate().mul(0.5)).mul(0.22))
    .mul(smoothstep(0.6, 2.6, s))
    .mul(exp(s.mul(-0.07)))
    .mul(BEAMS[k].strength)
    .mul(breathe(k))
    .mul(behind(k, s)) as any;
}

// A shaft whose line runs through the form is mostly stopped by it: it fades out past the form's middle.
const CENTRE_ALONG = KEY.length();
function behind(k: number, s: any) {
  const miss = Math.hypot(BEAMS[k].across, BEAMS[k].up);
  if (miss > 1.15) return float(1);
  const shade = 0.9 * (1 - Math.max(0, (miss - 0.7) / 0.45));
  return float(1).sub(smoothstep(CENTRE_ALONG - 0.4, CENTRE_ALONG + 0.7, s).mul(shade)) as any;
}

export function airLight(p: any) {
  let sum: any = float(0);
  for (let k = 0; k < BEAMS.length; k++) sum = sum.add(shaftAt(k, p));
  return sum;
}

export function eddy(p: any, t: any) {
  const swirl = vec3(
    sin(
      p.y
        .mul(1.7)
        .add(t.mul(0.13))
        .add(sin(p.z.mul(1.1).sub(t.mul(0.07))))
    ),
    sin(
      p.z
        .mul(1.3)
        .add(t.mul(0.11))
        .add(sin(p.x.mul(0.9).add(t.mul(0.05))))
    ).mul(0.6),
    sin(
      p.x
        .mul(1.5)
        .sub(t.mul(0.12))
        .add(sin(p.y.mul(1.2).add(t.mul(0.06))))
    )
  ).mul(0.11) as any;
  return p.add(swirl) as any;
}

// Ash (Erosion's): each mote leaves the form as a glowing speck, cools in a few seconds to a fleck of pale dust that
// drifts on the eddies, glinting as its faces turn whenever it crosses a shaft, and at last settles back onto the form
// and fades into its skin. Drawn over the finished frame, hidden behind the form by the scene's depth, and blurred as a
// lens would by how far it is from the focus.
export function Ash({ dust }: { dust: Dust }) {
  const { mesh, material, geometry } = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.count = dust.pool;
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { mesh, material, geometry };
  }, [dust]);
  useDispose(geometry, material);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
        const motes = dust.motes;
        const seconds = dust.u.seconds as any;
        const row = int(instanceIndex).mul(4) as any;
        const born = motes.element(row) as any;
        const thrown = motes.element(row.add(1)) as any;
        const now = motes.element(row.add(2)) as any;
        const centre = now.xyz as any;
        const seed = thrown.w as any;
        const style = look.dustStyle as any;
        const sparks = style.equal(1) as any;
        // Hot for a moment (sparks stay hot longer), then a fleck of dust for a long while.
        const hot = select(sparks, seed.mul(6).add(8), seed.mul(1.4).add(1.6)) as any;
        const life = seed.mul(12).add(26) as any;
        const age = seconds.sub(born.w) as any;
        const t = age.div(life).clamp(0, 1) as any;
        const alive = step(0, age).mul(step(age, life)) as any;
        const other = fract(seed.mul(91.7).add(0.37)) as any;
        const toEye = normalize(cameraPosition.sub(centre)) as any;
        const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
        const up = cross(toEye, right) as any;
        const away = cameraPosition.sub(centre).length() as any;
        const cooling = age.div(hot).clamp(0, 1) as any;
        // Mostly very fine grains, a rare larger chip; sparks a little smaller still.
        const grain = pow(other, float(7)).mul(0.0055).add(0.0009) as any;
        const styled = grain.mul(select(sparks, float(0.7), float(1))).mul(look.dustSize) as any;
        const sharp = mix(float(0.0075), styled, pow(cooling, float(0.6))) as any;
        const blur = away.sub(focusDistance).abs().div(away).mul(0.04) as any;
        // Settled back on the form: it fades into the skin within a second.
        const landed = now.w as any;
        const gone = select(landed.greaterThan(0), smoothstep(landed, landed.add(0.9), seconds), float(0)) as any;
        const radius = sharp
          .add(blur)
          .mul(alive)
          .mul(float(1).sub(gone.mul(0.6))) as any;
        const spread = sharp.div(sharp.add(blur)).pow(2).max(0.06) as any;
        // It tumbles about two axes, each its own way, so it reads as a little block turning over.
        const rate = other.mul(0.9).add(0.25) as any;
        const ta = age.mul(rate).add(seed.mul(20)) as any;
        const tb = age.mul(rate.mul(0.73)).add(other.mul(31)) as any;
        const narrow = abs(cos(tb)).mul(0.65).add(0.35) as any;
        const qx = positionGeometry.x
          .mul(narrow)
          .mul(cos(ta))
          .sub(positionGeometry.y.mul(sin(ta))) as any;
        const qy = positionGeometry.x
          .mul(narrow)
          .mul(sin(ta))
          .add(positionGeometry.y.mul(cos(ta))) as any;
        material.positionNode = centre.add(right.mul(qx.mul(radius.mul(2)))).add(up.mul(qy.mul(radius.mul(2)))) as any;
        const q = uv().sub(0.5).abs() as any;
        const r = uv().sub(0.5).length() as any;
        const disc = float(1).sub(smoothstep(0.22, 0.5, r)) as any;
        const block = float(1).sub(smoothstep(0.3, 0.46, max(q.x, q.y))) as any;
        const flake = mix(disc, block, smoothstep(0.6, 1, cooling).mul(float(1).sub(smoothstep(0.004, 0.02, blur)))) as any;
        const shape = select(sparks, disc, flake) as any;
        // White hot, then orange, then a dull red ember going out.
        const heat = exp(cooling.mul(-3.2)) as any;
        const hue = mix(mix(color("#6b1a08"), color("#ff5a14"), smoothstep(0.05, 0.4, heat)), color("#fff1c9"), smoothstep(0.55, 1, heat)) as any;
        const flicker = sin(age.mul(seed.mul(9).add(6)))
          .mul(0.25)
          .add(0.85) as any;
        const ember = heat
          .mul(1.3)
          .add(0.2)
          .mul(flicker)
          .mul(float(1).sub(smoothstep(0.7, 1, cooling))) as any;
        // Then dust, which shows by the light it catches: each pair of the block's faces flashes as it turns to mirror
        // the shaft toward the eye, and its faces glow softly as they turn to the light.
        const toLight = vec3(-AXIS.x, -AXIS.y, -AXIS.z) as any;
        const halfway = normalize(toLight.add(toEye)) as any;
        const ca = cos(ta) as any;
        const sa = sin(ta) as any;
        const cb = cos(tb) as any;
        const sb = sin(tb) as any;
        const faces = [vec3(ca.mul(cb), sa.mul(cb), sb), vec3(sa.negate(), ca, 0), vec3(ca.mul(sb).negate(), sa.mul(sb).negate(), cb)] as any[];
        let flash: any = float(0);
        let face: any = float(0);
        for (const f of faces) {
          flash = max(flash, pow(abs(dot(f, halfway)), float(48)));
          face = max(face, abs(dot(f, toLight)));
        }
        const lit = airLight(centre) as any;
        const dusty = smoothstep(0.6, 1, cooling) as any;
        // Flecks: the form's own pale dust, lit by the shafts and a little by the room.
        const crumb = (color(DUST) as any).mul(vec3(1.25, 1.12, 0.95)).mul(
          lit
            .mul(face.mul(1.2).add(0.35).add(flash.mul(2.5)))
            .mul(1.7)
            .add(0.045)
        ) as any;
        const dustColour = crumb.mul(dusty) as any;
        // Sparks: stay hot and bright, cooling slowly through orange, flickering, then glint like flecks.
        const spark = mix(color("#ff7a1c"), color("#ffe4a8"), heat).mul(heat.mul(2.2).add(0.4)).mul(flicker) as any;
        // Fresh off the stone, every mote flashes white-hot for a moment, so the ring that sheds it reads as a ring of light.
        const fresh = exp(age.mul(-5)).mul(3) as any;
        const colour = select(sparks, spark, hue.mul(ember).add(dustColour)).add(color("#fff0d6").mul(fresh)) as any;
        const fade = smoothstep(0, 0.01, t).mul(float(1).sub(smoothstep(0.75, 1, t))) as any;
        const shown = step(sceneZ, positionView.z) as any;
        const common = fade.mul(float(1).sub(gone)).mul(shape).mul(spread).mul(shown).mul(alive) as any;
        material.colorNode = vec4(colour.mul(common), 1) as any;
        material.needsUpdate = true;
      }),
    [material, dust]
  );
  return <primitive object={mesh} />;
}

// The shafts seen in the air, and what floats in them (Erosion's): fine specks, larger motes, and big soft bokeh
// drifting past the lens.
export function Air({ dust }: { dust: number }) {
  const parts = useMemo(() => {
    const random = lehmer(4411);
    const seeds = new Float32Array(dust * 4);
    for (let i = 0; i < dust; i++) seeds.set([random(), random(), random(), random()], i * 4);
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    const dustMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const specks = new THREE.InstancedMesh(quad, dustMaterial, dust);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < dust; i++) specks.setMatrixAt(i, identity);
    specks.frustumCulled = false;
    specks.layers.set(OVERLAY_LAYER);
    const sphere = new THREE.SphereGeometry(40, 32, 16);
    const beamMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.BackSide, blending: THREE.AdditiveBlending });
    const beam = new THREE.Mesh(sphere, beamMaterial);
    beam.frustumCulled = false;
    beam.layers.set(OVERLAY_LAYER);
    return { quad, dustMaterial, specks, sphere, beamMaterial, beam };
  }, [dust]);
  useDispose(parts.quad, parts.dustMaterial, parts.sphere, parts.beamMaterial);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
        {
          const d = normalize(positionWorld.sub(cameraPosition)) as any;
          const axis = axisNode();
          const b = dot(d, axis) as any;
          const den = max(float(1).sub(b.mul(b)), float(1e-4)) as any;
          const stop = sceneZ.div(normalize(positionView).z) as any;
          let glow: any = float(0);
          for (let k = 0; k < BEAMS.length; k++) {
            const w0 = cameraPosition.sub(beamFrom(k)) as any;
            const tRay = b.mul(dot(axis, w0)).sub(dot(d, w0)).div(den) as any;
            const p = cameraPosition.add(d.mul(tRay.clamp(0, stop))) as any;
            glow = glow.add(shaftAt(k, p));
          }
          const middle = cameraPosition.add(d.mul(stop.min(6).mul(0.6))) as any;
          const stir = mx_noise_float(middle.mul(0.9).add(vec3(time.mul(0.04), time.mul(-0.025), 0)))
            .mul(0.35)
            .add(0.85) as any;
          const along = float(1).sub(smoothstep(0.75, 0.98, abs(b))) as any;
          const onSubject = float(1).sub(smoothstep(12, 20, stop)) as any;
          parts.beamMaterial.colorNode = vec4(
            color("#ffdcb4").mul(
              glow
                .mul(along)
                .mul(stir)
                .mul(mix(float(1), float(0.25), onSubject))
                .mul(0.16)
            ),
            1
          ) as any;
          parts.beamMaterial.needsUpdate = true;
        }
        {
          const s = attribute("aSeed", "vec4") as any;
          const t = time as any;
          const size = vec3(7, 5, 7) as any;
          const drift = vec3(t.mul(-0.006), t.mul(0.008), t.mul(0.003)).mul(s.w.add(0.5)) as any;
          const lens = step(s.w, 0.18) as any;
          const mote = step(0.18, s.w).mul(step(s.w, 0.36)) as any;
          const roomPlace = eddy(
            fract(s.xyz.add(drift.div(size)))
              .sub(0.5)
              .mul(size),
            t.add(s.y.mul(40))
          ) as any;
          const nearPlace = cameraPosition.add(
            fract(s.xyz.add(drift.div(2.4)).sub(cameraPosition.div(2.4)))
              .sub(0.5)
              .mul(2.4)
          ) as any;
          const centre = mix(roomPlace, nearPlace, lens) as any;
          const toEye = normalize(cameraPosition.sub(centre)) as any;
          const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
          const up = cross(toEye, right) as any;
          const away = cameraPosition.sub(centre).length() as any;
          const grain = mix(float(1), s.x.mul(2.2).add(1.6), mote) as any;
          const sharp = max(float(0.0016), away.mul(0.0007)).mul(grain).mul(s.y.mul(0.8).add(0.6)) as any;
          const blur = min(away.sub(focusDistance).abs().div(away).mul(0.05), away.mul(0.034)) as any;
          const radius = sharp.add(blur) as any;
          const spread = sharp.div(radius).pow(2).max(0.035) as any;
          const soft = smoothstep(0.004, 0.03, blur) as any;
          parts.dustMaterial.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(up.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
          const twinkle = sin(t.mul(s.y.mul(2).add(0.6)).add(s.z.mul(50)))
            .mul(0.3)
            .add(0.7) as any;
          const r = uv().sub(0.5).length() as any;
          const point = float(1).sub(smoothstep(0.08, 0.5, r)) as any;
          const disc = float(1).sub(smoothstep(0.36, 0.5, r)) as any;
          const dot2 = mix(point, disc, soft).mul(spread) as any;
          const shown = step(sceneZ, positionView.z) as any;
          const light = airLight(centre) as any;
          const lit = mix(light.mul(light).mul(9).add(light.mul(0.6)).add(0.012), light.mul(1.4).add(mix(float(0.04), float(0.3), s.z.mul(s.z))), lens) as any;
          parts.dustMaterial.colorNode = vec4(color("#ffe6cc").mul(lit.mul(twinkle).mul(dot2).mul(shown)), 1) as any;
          parts.dustMaterial.needsUpdate = true;
        }
      }),
    [parts]
  );

  return (
    <>
      <primitive object={parts.beam} />
      <primitive object={parts.specks} />
    </>
  );
}

// The void it floats in: near black, warming to a soft glow behind it on the key's side, darker below.
export function Backdrop() {
  const { material, geometry } = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const d = normalize(positionWorld) as any;
    const glowDir = normalize(vec3(-0.25, 0.2, -1)) as any;
    const halo = pow(max(dot(d, glowDir), float(0)), float(2.2)) as any;
    const below = smoothstep(0.1, -0.7, d.y) as any;
    const toKey = smoothstep(0.55, -0.6, d.x)
      .mul(smoothstep(-0.6, 0.5, d.y))
      .mul(0.7)
      .add(0.3) as any;
    const base = mix(color("#0b0a0a"), color("#271f19"), halo.mul(toKey)) as any;
    m.colorNode = mix(base, color("#050505"), below.mul(0.8)).mul(mix(float(0.55), float(1), toKey)) as any;
    return { material: m, geometry: new THREE.SphereGeometry(45, 48, 24) };
  }, []);
  useDispose(material, geometry);
  return <mesh geometry={geometry} material={material} renderOrder={-1} frustumCulled={false} raycast={() => null} />;
}
