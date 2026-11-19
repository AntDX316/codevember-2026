"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraFar,
  cameraNear,
  cameraPosition,
  color,
  cross,
  dot,
  exp,
  float,
  fract,
  instanceIndex,
  int,
  ivec3,
  length,
  max,
  min,
  mix,
  normalGeometry,
  normalize,
  perspectiveDepthToViewZ,
  positionGeometry,
  positionView,
  positionWorld,
  pow,
  screenUV,
  select,
  sin,
  cos,
  mx_noise_float,
  smoothstep,
  step,
  time,
  transformNormalToView,
  uint,
  uniform,
  uv,
  varying,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { focusDistance, OVERLAY_LAYER, overlayLink } from "../shared/engine/Post";
import { lehmer } from "../shared/engine/random";
import { HEAT, SPAN, type Morph } from "./grid";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The light: a warm key high on the left, which the shaft in the air comes from.
export const KEY = new THREE.Vector3(-4.3, 3.6, 1.5);

// The finish, as uniforms: the clay body, and what growing adds (the same clay, a touch fresher).
export type Finish = {
  label: string;
  swatch: string[];
  body: string;
  bodyRough: number;
  bodyMetal: number;
  ghost: string;
  ghostRough: number;
  ghostMetal: number;
  // The void behind: its base, the glow behind the sculpture, and below.
  base: string;
  halo: string;
  below: string;
};
export const FINISHES: Record<string, Finish> = {
  clay: {
    label: "Clay",
    swatch: ["#d8c9b4", "#a9b6c6"],
    body: "#ddd0bd",
    bodyRough: 0.82,
    bodyMetal: 0,
    // Grown clay: the same, a touch fresher.
    ghost: "#e8ddcc",
    ghostRough: 0.76,
    ghostMetal: 0,
    base: "#0d0c0c",
    halo: "#2a241f",
    below: "#060606"
  }
};

export const look = {
  body: uniform(new THREE.Color(FINISHES.clay.body)),
  bodyRough: uniform(FINISHES.clay.bodyRough),
  bodyMetal: uniform(FINISHES.clay.bodyMetal),
  ghost: uniform(new THREE.Color(FINISHES.clay.ghost)),
  ghostRough: uniform(FINISHES.clay.ghostRough),
  ghostMetal: uniform(FINISHES.clay.ghostMetal),
  base: uniform(new THREE.Color(FINISHES.clay.base)),
  halo: uniform(new THREE.Color(FINISHES.clay.halo)),
  below: uniform(new THREE.Color(FINISHES.clay.below)),
  // How strongly the brush's reach shows where the pointer rests.
  grow: uniform(1),
  // When the dust then in the air was told to melt away (a change of form, a restore), in seconds.
  dissolveAt: uniform(-1),
  // The dust: 0 flecks in the sculpture's colour, 1 sparks; and its size.
  dustStyle: uniform(0, "int"),
  dustSize: uniform(1),
  showBrush: uniform(0),
  reach: uniform(14),
  dilate: uniform(0)
};

const EMBER = new THREE.Color("#ff8a2a");
const FROST = new THREE.Color("#ffe3bf");

// Which bit of a cell's neighbour mask stands for the neighbour at offset o (each part -1, 0 or 1).
const bitOf = (o: any) => int(o.x.add(1).add(o.y.add(1).mul(3)).add(o.z.add(1).mul(9)));
const has = (mask: any, o: any) =>
  mask
    .shiftRight(uint(bitOf(o)))
    .bitAnd(uint(1))
    .toFloat();

// The two directions across a face, given its normal.
const across = (n: any) => {
  const a = abs(n) as any;
  const u = select(a.x.greaterThan(0.5), vec3(0, 1, 0), vec3(1, 0, 0)) as any;
  const v = vec3(1).sub(a).sub(u) as any;
  return { u, v };
};

// The surface of the sculpture: one little cube for every cell on it, drawn from the list the compute pass made, so only
// cells on the surface cost anything. Faces against a full neighbour fold away; corners darken by the neighbours round
// them, as voxel art is shaded; edges that meet open air are bevelled, so each block catches the light on its rim.
export function Voxels({ morph }: { morph: Morph }) {
  const { mesh, material, geometry } = useMemo(() => {
    const { list, hit } = morph;
    const G = morph.u.g as any;
    // One quad, turned in the shader to whichever face of its cell an entry stands for.
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.setIndirect(morph.args);
    const m = new THREE.MeshStandardNodeMaterial();

    // A cell's place and neighbours, built from scratch for each use (a node shared between the position and a varying
    // breaks the shader).
    const cell = () => {
      const info = list.element(instanceIndex) as any;
      const id = int(info.x) as any;
      const c = ivec3(id.mod(G), id.div(G).mod(G), id.div(G.mul(G))) as any;
      const centre = vec3(c).add(0.5).div(float(G)).sub(0.5).mul(SPAN) as any;
      return { info, c, centre, mask: info.y.bitAnd(uint(0x7ffffff)) };
    };
    // The face's outward direction, and the quad's corner as a point of the cell's cube (±0.5 each way).
    const faceNormal = () => {
      const f = int(list.element(instanceIndex).y.shiftRight(uint(27))) as any;
      const axis = f.div(2) as any;
      const sign = float(f.mod(2)).mul(2).sub(1) as any;
      return vec3(select(axis.equal(0), sign, float(0)), select(axis.equal(1), sign, float(0)), select(axis.equal(2), sign, float(0))) as any;
    };
    const corner = () => {
      const n = faceNormal();
      const { u } = across(n);
      const v = cross(n, u) as any;
      return n.mul(0.5).add(u.mul(positionGeometry.x)).add(v.mul(positionGeometry.y)) as any;
    };

    {
      const { centre, mask } = cell();
      // look.grow shrinks every cube to its middle and back, to hide a change of resolution.
      m.positionNode = centre.add(corner().mul(morph.u.cellSize).mul(look.grow)) as any;
    }

    // Corner shading: the two neighbours beside this corner on the open side of the face, and the one across from it.
    const shading = (() => {
      const { c, mask } = cell();
      const n = ivec3(faceNormal()) as any;
      const s = ivec3(corner().sign()) as any;
      const { u, v } = across(faceNormal());
      const su = ivec3(vec3(s).mul(u)) as any;
      const sv = ivec3(vec3(s).mul(v)) as any;
      const a = has(mask, n.add(su)) as any;
      const b = has(mask, n.add(sv)) as any;
      const k = has(mask, n.add(su).add(sv)) as any;
      const filled = select(a.mul(b).greaterThan(0.5), float(3), a.add(b).add(k)) as any;
      const ao = float(1).sub(filled.mul(0.21)) as any;
      // How freshly the brush wore or grew here, from the coarse heat grid.
      const hc = ivec3(
        vec3(c)
          .add(0.5)
          .div(float(G))
          .mul(HEAT)
          .floor()
          .clamp(0, HEAT - 1)
      ) as any;
      const warmth = morph.heat.element(
        hc.z
          .mul(HEAT * HEAT)
          .add(hc.y.mul(HEAT))
          .add(hc.x)
      ) as any;
      return varying(vec4(ao, warmth.x, warmth.y, 0), "vCell") as any;
    })();
    const brushV = (() => {
      const { c } = cell();
      const h = hit.element(0) as any;
      const d = length(vec3(c).add(0.5).sub(h.xyz)) as any;
      const edge = float(1)
        .sub(smoothstep(0.4, 1.4, abs(d.sub(look.reach))))
        .mul(0.7) as any;
      const inside = float(1)
        .sub(smoothstep(look.reach.mul(0.6), look.reach, d))
        .mul(0.14) as any;
      return varying(select(h.w.greaterThanEqual(0), max(edge, inside), float(0)).mul(look.showBrush), "vBrush") as any;
    })();
    // A smooth normal at each corner, from the eight cells that meet there: it points from the full ones toward the empty
    // ones. Cubes that share a corner work out the same normal, so light runs smoothly over a stepped curve and the steps
    // read as the grid, not as stripes.
    const smooth = (() => {
      const { mask } = cell();
      const s = ivec3(corner().sign()) as any;
      let sum: any = vec3(0);
      for (const [x, y, z] of [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
        [0, 0, 1],
        [1, 0, 1],
        [0, 1, 1],
        [1, 1, 1]
      ]) {
        const o = ivec3(s.x.mul(x), s.y.mul(y), s.z.mul(z)) as any;
        const empty = x + y + z === 0 ? float(0) : float(1).sub(has(mask, o));
        sum = sum.add(vec3(o).sub(vec3(s).mul(0.5)).mul(empty));
      }
      const n = faceNormal();
      const len = length(sum) as any;
      const safe = (select as any)(len.greaterThan(0.01), sum.div(max(len, float(0.01))), n) as any;
      return varying(normalize((mix as any)(n, safe, 0.78)), "vSmooth") as any;
    })();
    // Which edges of the face meet open air (along +u, -u, +v, -v), for the bevel.
    const edges = (() => {
      const { mask } = cell();
      const { u, v } = across(faceNormal());
      const iu = ivec3(u) as any;
      const iv = ivec3(v) as any;
      return varying(vec4(float(1).sub(has(mask, iu)), float(1).sub(has(mask, iu.negate())), float(1).sub(has(mask, iv)), float(1).sub(has(mask, iv.negate()))), "vEdges") as any;
    })();

    // The bevel: within a sliver of an open edge the normal leans out over it.
    const n = varying(faceNormal(), "vFace") as any;
    const { u, v } = across(n);
    const p = varying(corner(), "vCorner") as any;
    const du = dot(p, u) as any;
    const dv = dot(p, v) as any;
    const lean = (x: any) => smoothstep(0.36, 0.5, x) as any;
    const tiltU = lean(du).mul(edges.x).sub(lean(du.negate()).mul(edges.y)) as any;
    const tiltV = lean(dv).mul(edges.z).sub(lean(dv.negate()).mul(edges.w)) as any;
    const bent = normalize(
      normalize(smooth)
        .add(u.mul(tiltU.mul(0.45)))
        .add(v.mul(tiltV.mul(0.45)))
    ) as any;
    m.normalNode = transformNormalToView(bent) as any;

    const ghost = shading.w as any;
    const rim = max(abs(tiltU), abs(tiltV)) as any;
    m.colorNode = mix(look.body, look.ghost, ghost).mul(shading.x).mul(rim.mul(0.12).add(1)) as any;
    m.roughnessNode = mix(look.bodyRough, look.ghostRough, ghost).sub(rim.mul(0.12)) as any;
    m.metalnessNode = mix(look.bodyMetal, look.ghostMetal, ghost) as any;
    // The erosion front smoulders as it is opened and cools within a second or so; grown cells come in frosted.
    const front = pow(shading.y, float(2)) as any;
    const ember = color(EMBER).mul(front.mul(1.2)).mul(shading.x.mul(0.6).add(0.4)) as any;
    const frost = color(FROST).mul(pow(shading.z, float(1.4)).mul(0.7)) as any;
    const brushTint = mix(color("#ffd7b0"), color("#bfe3ff"), look.dilate).mul(brushV.mul(0.55)) as any;
    m.emissiveNode = ember.add(frost).add(brushTint) as any;

    const mesh = new THREE.Mesh(geometry, m);
    mesh.count = morph.capacity;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return { mesh, material: m, geometry };
  }, [morph]);
  useDispose(geometry, material);
  return <primitive object={mesh} />;
}

// The light in the air. The key pours in from the upper left as a few parallel shafts, as if through gaps high in an
// unseen wall: a broad one across the sculpture and narrower ones either side, each soft at its edges and breathing a
// little. Everything that floats (dust, bokeh, the sculpture's own lost cells) is lit by the same function, so specks
// glint only where they cross a shaft and fall away to near nothing in the dark between.
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

// How strongly one shaft lights a point: by its distance from the shaft's line, and how far down the shaft it lies.
function shaftAt(k: number, p: any) {
  const from = beamFrom(k);
  const axis = axisNode();
  const s = dot(p.sub(from), axis) as any;
  // Its edge wavers a little along its length and in time, so no edge runs ruler-straight.
  const waver = sin(s.mul(1.1).add(time.mul(0.09)).add(BEAMS[k].phase)).mul(0.07) as any;
  const off = length(p.sub(from.add(axis.mul(s))))
    .add(waver)
    .max(0) as any;
  const width = s.mul(0.035).add(BEAMS[k].width) as any;
  // A soft core inside a much wider halo: feathered, with nowhere a line could be drawn.
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

// A shaft whose line runs through the sculpture is mostly stopped by it: it fades out past the sculpture's middle.
const CENTRE_ALONG = KEY.length();
function behind(k: number, s: any) {
  const miss = Math.hypot(BEAMS[k].across, BEAMS[k].up);
  if (miss > 1.15) return float(1);
  const shade = 0.9 * (1 - Math.max(0, (miss - 0.7) / 0.45));
  return float(1).sub(smoothstep(CENTRE_ALONG - 0.4, CENTRE_ALONG + 0.7, s).mul(shade)) as any;
}

// How lit a point in the air is, by every shaft together.
export function airLight(p: any) {
  let sum: any = float(0);
  for (let k = 0; k < BEAMS.length; k++) sum = sum.add(shaftAt(k, p));
  return sum;
}

// The air's slow stirring: a lazy drift up and toward the light, with eddies that turn things over as they pass.
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

// Ash: each lost cell that lets go a mote leaves as a glowing speck the size of the cell, thrown out from the brush. It
// cools in a few seconds to a fleck of pale dust that drifts up and toward the light on the air's eddies for a good while
// longer, glinting as its faces turn whenever it crosses a shaft. Drawn over the finished frame, hidden behind the
// sculpture by the scene's depth, and blurred as a lens would by how far it is from the focus.
export function Ash({ morph }: { morph: Morph }) {
  const { mesh, material, geometry } = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.count = morph.pool;
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { mesh, material, geometry };
  }, [morph]);
  useDispose(geometry, material);

  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
        const motes = morph.motes;
        const row = int(instanceIndex).mul(4) as any;
        const born = motes.element(row) as any;
        const thrown = motes.element(row.add(1)) as any;
        const centre = motes.element(row.add(2)).xyz as any;
        const seed = thrown.w as any;
        const style = look.dustStyle as any;
        const sparks = style.equal(1) as any;
        // Hot for a couple of seconds (sparks stay hot), then a fleck of dust for a long while.
        const hot = select(sparks, seed.mul(6).add(8), seed.mul(1.4).add(1.6)) as any;
        const life = seed.mul(14).add(14) as any;
        const age = morph.u.seconds.sub(born.w) as any;
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
        const sharp = mix(morph.u.cellSize.mul(0.7), styled, pow(cooling, float(0.6))) as any;
        const blur = away.sub(focusDistance).abs().div(away).mul(0.04) as any;
        // Dust from a form that has since been changed or restored melts away within half a second, shrinking as it goes.
        const gone = select(born.w.lessThan(look.dissolveAt), smoothstep(look.dissolveAt, look.dissolveAt.add(0.5), morph.u.seconds), float(0)) as any;
        const radius = sharp
          .add(blur)
          .mul(alive)
          .mul(float(1).sub(gone.mul(0.7))) as any;
        const spread = sharp.div(sharp.add(blur)).pow(2).max(0.06) as any;
        // It tumbles about two axes, slowly, each its own way: the quad turns in the view and narrows as a face turns
        // edge-on, so it reads as a little block turning over.
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
        // Then dust, which shows by the light it catches: each of the block's three pairs of faces flashes as it turns
        // to mirror the shaft's light toward the eye, and its faces glow softly as they turn to the light.
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
        // Classic: the sculpture's own colour, as if it were crumbs of it, lit by the shafts and a little by the room.
        const crumb = (look.body as any).mul(vec3(1, 0.88, 0.72)).mul(
          lit
            .mul(face.mul(1.2).add(0.35).add(flash.mul(2.5)))
            .mul(1.7)
            .add(0.045)
        ) as any;
        const dustColour = crumb.mul(dusty) as any;
        // Sparks: stay hot and bright, cooling slowly through orange, flickering.
        const spark = mix(color("#ff7a1c"), color("#ffe4a8"), heat).mul(heat.mul(2.2).add(0.4)).mul(flicker) as any;
        const colour = select(sparks, spark, hue.mul(ember).add(dustColour)) as any;
        // In softly, and out over the last third, never popping.
        const fade = smoothstep(0, 0.01, t).mul(float(1).sub(smoothstep(0.62, 1, t))) as any;
        const shown = step(sceneZ, positionView.z) as any;
        const common = fade.mul(float(1).sub(gone)).mul(shape).mul(spread).mul(shown).mul(alive) as any;
        material.colorNode = vec4(colour.mul(common), 1) as any;
        material.needsUpdate = true;
      }),
    [material, morph]
  );
  return <primitive object={mesh} />;
}

// The shafts seen in the air, and what floats in them: fine specks round the sculpture, sharp where the lens is focused
// and catching the light only inside a shaft; larger motes; and big, soft, even discs of bokeh drifting past the lens.
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

        // The shafts: for each pixel and each shaft, the closest the eye's line comes to the shaft's line, short of
        // whatever the scene puts in the way, lit by that shaft there. A slow noise there stirs them, as dust does.
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
          // Seen along its length a shaft is brightest; keep it soft so its sides never band.
          const along = float(1).sub(smoothstep(0.75, 0.98, abs(b))) as any;
          // Over the sculpture the air in front of it is only a few centimetres deep: keep its light from washing the clay.
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

        // Floaters. Three kinds by seed: about two thirds fine specks in a box round the sculpture; a fifth larger motes
        // in the same box; and the rest in a small box that travels with the eye, so soft bokeh always drifts past the
        // lens. All wander on a slow path, wrapped in their box, and turn in the air's eddies.
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
          // Out of focus a speck spreads into a disc, never wider than about two degrees.
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
          // An even disc with only a soft edge: a rim would turn bokeh into soap bubbles.
          const disc = float(1).sub(smoothstep(0.36, 0.5, r)) as any;
          const dot2 = mix(point, disc, soft).mul(spread) as any;
          const shown = step(sceneZ, positionView.z) as any;
          const light = airLight(centre) as any;
          // Specks glint only in a shaft; bokeh near the lens carries a little of the light scattered all round, so the
          // dark between the shafts is never empty.
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
    // Brighter toward the key, falling away into shadow on the far side.
    const toKey = smoothstep(0.55, -0.6, d.x)
      .mul(smoothstep(-0.6, 0.5, d.y))
      .mul(0.7)
      .add(0.3) as any;
    const base = mix(look.base, look.halo, halo.mul(toKey)) as any;
    m.colorNode = mix(base, look.below, below.mul(0.8)).mul(mix(float(0.55), float(1), toKey)) as any;
    return { material: m, geometry: new THREE.SphereGeometry(45, 48, 24) };
  }, []);
  useDispose(material, geometry);
  return <mesh geometry={geometry} material={material} renderOrder={-1} frustumCulled={false} raycast={() => null} />;
}
