/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  cameraPosition,
  dot,
  exp,
  float,
  length,
  max,
  mix,
  modelViewMatrix,
  modelWorldMatrix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  saturate,
  sin,
  smoothstep,
  sqrt,
  step,
  uniform,
  varying,
  vec3,
  vec4
} from "three/tsl";
import { SHAPE } from "./spool";

// The light the silk is shaded by. There are no lamps in the scene: every strand works out its own light from these,
// a warm key from the left side, a cool rim behind on the right, and the pupa glowing inside.
export const KEY = new THREE.Vector3(-0.9, 0.4, 0.2).normalize();
export const RIM = new THREE.Vector3(0.65, 0.3, -0.75).normalize();

export type StrandUniforms = ReturnType<typeof strandUniforms>;

export function strandUniforms() {
  return {
    // The eye and the way it looks, both in the spindle's frame; and the size of a pixel one unit from the eye.
    eye: uniform(new THREE.Vector3()),
    facing: uniform(new THREE.Vector3(0, 0, -1)),
    pixel: uniform(0.001),
    width: uniform(0.0055),
    now: uniform(0),
    silk: uniform(new THREE.Color("#e3b867")),
    glow: uniform(1),
    // The cocoon's outer skin, as a share of the full egg, which the depth of each strand is measured against.
    outer: uniform(SHAPE.inner),
    // How bright the pupa is just now, breathing.
    beat: uniform(1),
    // 1 while the pointer is over the loose end.
    tailHover: uniform(0),
    // How far the lens is focused, for the dust's out-of-focus discs.
    focusDistance: uniform(5.6)
  };
}

// Basic materials take their normal from the geometry, which for a strip turned to the eye means nothing. This one
// hands the screen-space passes the cocoon's own surface normal, so its creases shade as a surface's would.
class StrandMaterial extends THREE.MeshBasicNodeMaterial {
  strandNormal: any = null;
  setupNormal() {
    return (this.strandNormal ?? super.setupNormal()) as any;
  }
}

// Each length of silk is a flat strip between two points, turned to face the eye and never drawn under a pixel wide.
// It is shaded as a fibre rather than a surface: light catches it in a line across the strand wherever it lies square
// to the halfway between eye and light, which is what gives silk its sheen and makes the highlights slide as it turns.
export function strandMaterial(u: StrandUniforms) {
  const material = new StrandMaterial({ side: THREE.DoubleSide });
  const A = SHAPE.width;

  // Built afresh for each use: a node handed to varying() is read back from the varying wherever else it appears.
  const strip = () => {
    const from = attribute("aFrom", "vec4") as any;
    const to = attribute("aTo", "vec4") as any;
    const a = from.xyz as any;
    const b = to.xyz as any;
    const d = b.sub(a) as any;
    const span = length(d) as any;
    const along = normalize(d.add(vec3(1e-7, 0, 0))) as any;
    const centre = a.add(d.mul(positionGeometry.x)) as any;
    const born = attribute("aBirth", "float") as any;
    // New silk draws out over a moment rather than appearing whole.
    const wanted = u.width.mul(to.w).mul(smoothstep(0, 0.25, u.now.sub(born)).mul(0.7).add(0.3)) as any;
    const drawn = max(wanted, length(u.eye.sub(centre)).mul(u.pixel)).mul(step(0.001, to.w)) as any;
    const f = u.facing as any;
    const side = normalize(
      vec3(along.y.mul(f.z).sub(along.z.mul(f.y)), along.z.mul(f.x).sub(along.x.mul(f.z)), along.x.mul(f.y).sub(along.y.mul(f.x))).add(vec3(0, 1e-6, 0))
    ) as any;
    // How far out on the egg this point is: 1 on its full outer skin.
    const tall = mix(float(SHAPE.bottom), float(SHAPE.top), step(0, centre.y)) as any;
    const depth = length(centre.div(vec3(A, tall, A))) as any;
    const normal = normalize(centre.div(vec3(A * A, 1, A * A).mul(vec3(1, tall.mul(tall), 1)))) as any;
    return { from, along, centre, span, born, wanted, drawn, side, depth, normal };
  };

  const placed = strip();
  material.positionNode = placed.centre.add(placed.side.mul(positionGeometry.y.mul(placed.drawn).mul(0.5))) as any;

  const passed = strip();
  const tangent = varying(modelWorldMatrix.mul(vec4(passed.along, 0)).xyz) as any;
  const normalWorld = varying(modelWorldMatrix.mul(vec4(passed.normal, 0)).xyz) as any;
  const coverage = varying(passed.wanted.div(max(passed.drawn, 1e-6))) as any;
  const arc = varying(passed.from.w.add(passed.span.mul(positionGeometry.x))) as any;
  const born = varying(passed.born) as any;
  const depth = varying(passed.depth) as any;
  const across = varying(positionGeometry.y.mul(1)) as any;

  const forNormal = strip();
  material.strandNormal = normalize(varying(modelViewMatrix.mul(vec4(forNormal.normal, 0)).xyz));

  material.colorNode = Fn(() => {
    const T = normalize(tangent) as any;
    const N = normalize(normalWorld) as any;
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const silk = u.silk as any;
    // Kajiya and Kay's fibre light: a strand lit by how square it lies to the light, and shining by how square it
    // lies to the halfway vector.
    const across2 = (L: any) => sqrt(max(float(1).sub(dot(T, L).mul(dot(T, L))), 0)) as any;
    const sheen = (L: any, sharpness: number) => pow(across2(normalize(L.add(V))), sharpness) as any;

    // How deep under the outer skin, from 0 there to 1 at the first turn; and anything well clear of the skin, the
    // loose end in the air, is lit as if nothing stood between it and the lights.
    const span = 1 - SHAPE.inner;
    const under = saturate(u.outer.sub(depth).div(span)) as any;
    const clear = smoothstep(u.outer.add(0.04), u.outer.add(0.3), depth) as any;
    // Each turn laid over a strand shades it, so the outer threads stand out against darker ones beneath.
    const buried = exp(under.mul(-4.5)) as any;
    const key = vec3(KEY.x, KEY.y, KEY.z) as any;
    const rim = vec3(RIM.x, RIM.y, RIM.z) as any;
    // Light from one side only: the far side of the egg falls away into shadow, with hardly any wrap.
    const facingKey = mix(pow(saturate(dot(N, key).mul(1.1).add(0.02)), 2.0), float(1), clear).mul(buried) as any;
    const facingRim = mix(saturate(dot(N, rim).add(0.15)), float(1), clear).mul(buried) as any;

    // Every thread a little brighter or dimmer than its neighbours, changing slowly along it, so they read apart.
    const which = sin(arc.mul(0.71).floor().mul(12.9898)).mul(43758.5).fract() as any;
    const own = which.mul(0.45).add(0.55) as any;

    const keyLight = vec3(1.0, 0.88, 0.72).mul(1.3) as any;
    const rimLight = vec3(0.55, 0.62, 0.82).mul(0.3) as any;
    const lit = keyLight
      .mul(silk.mul(across2(key).mul(0.75).add(0.1)).add(mix(vec3(1, 1, 1), silk, 0.4).mul(sheen(key, 90)).mul(0.35)).add(silk.mul(sheen(key, 18)).mul(0.12)))
      .mul(facingKey)
      .add(rimLight.mul(sheen(rim, 60).add(silk.mul(pow(saturate(dot(V.negate(), rim)), 3)).mul(0.4))).mul(facingRim))
      .mul(own) as any;

    // The pupa's light reaches only the first few turns; further out it is the dark gaps between threads it shows in.
    const out = normalize(positionWorld) as any;
    const pupa = vec3(1.0, 0.52, 0.18).mul(u.glow).mul(u.beat) as any;
    const throughSilk = exp(depth.sub(SHAPE.inner).div(span).max(0).mul(-7)).mul(float(1).sub(clear)) as any;
    const fromPupa = pupa.mul(throughSilk).mul(mix(silk, vec3(1, 1, 1), 0.3)).mul(across2(out.negate()).mul(0.5).add(0.3)).mul(0.45) as any;

    // Glints that run along the threads as it turns: a bead of light now and then where a strand already shines.
    const seed = sin(arc.mul(0.173)).mul(43.7) as any;
    const travel = pow(sin(arc.mul(2.1).sub(u.now.mul(2.6)).add(seed)).mul(0.5).add(0.5), 40) as any;
    const glint = keyLight.mul(travel).mul(sheen(key, 40)).mul(facingKey).mul(1.4) as any;

    // Fresh silk is warm as it comes off the guide, then cools.
    const fresh = mix(silk, pupa, 0.4).mul(exp(u.now.sub(born).mul(-2))).mul(0.7) as any;

    // The loose end shimmers, a slow pulse running out along it toward the tip, brighter under the pointer.
    const isTail = step(899, arc) as any;
    const pulse = pow(sin(arc.mul(2.4).sub(u.now.mul(2.2))).mul(0.5).add(0.5), 6) as any;
    const beckon = mix(silk, vec3(1, 0.85, 0.6), 0.5).mul(pulse.mul(0.55).add(0.1)).mul(u.tailHover.mul(1.2).add(1)).mul(isTail) as any;

    const ambient = silk.mul(0.006) as any;
    // Round in section: bright down the middle of the strip, dark at its edges, so crossing threads separate.
    const round = sqrt(saturate(float(1).sub(across.mul(across)))).mul(0.65).add(0.35) as any;
    const total = lit.add(fromPupa).add(glint).add(fresh).add(ambient).add(beckon).mul(round).mul(mix(float(0.5), float(1), saturate(coverage))) as any;
    return vec4(total, 1);
  })() as any;

  return material;
}

// The strip every length is drawn with, and the per-length data, each of `count` lengths.
export function strandGeometry(count: number) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const from = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
  const to = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
  const birth = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
  geometry.setAttribute("aFrom", from);
  geometry.setAttribute("aTo", to);
  geometry.setAttribute("aBirth", birth);
  geometry.instanceCount = 0;
  return { geometry, from, to, birth };
}
