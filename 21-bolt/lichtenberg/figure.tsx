"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  color,
  cross,
  dot,
  exp,
  float,
  int,
  length,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  pow,
  screenSize,
  select,
  sin,
  smoothstep,
  sqrt,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER } from "../../shared/engine/Post";
import { SEGMENT_FLOATS } from "./grow";
import { CENTRE, FLOOR, HALF, IOR, KEY_DIR, u } from "./block";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

export const MAX_TREES = 32;

// Every figure's segments live in one buffer, drawn as thin strips that face the screen. Per figure: when it was
// struck, how long it takes to grow, how much of it the charge reached (0 to 1), and how slow time ran for it.
export type Figures = {
  geometry: THREE.InstancedBufferGeometry;
  buffer: THREE.InstancedInterleavedBuffer;
  array: Float32Array;
  capacity: number;
  trees: any;
  used: number;
};

export function makeFigures(capacity: number): Figures {
  const geometry = new THREE.InstancedBufferGeometry();
  // A strip: x is which end, y which side.
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, -1, 0, 1, 0, 1, 1, -1, 0, 1, 1, 0], 3));
  geometry.setIndex([0, 2, 1, 1, 2, 3]);
  const array = new Float32Array(capacity * SEGMENT_FLOATS);
  // Nothing is born yet: birth past any charge.
  for (let s = 0; s < capacity; s++) array[s * SEGMENT_FLOATS + 8] = 9;
  const buffer = new THREE.InstancedInterleavedBuffer(array, SEGMENT_FLOATS);
  buffer.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("aFrom", new THREE.InterleavedBufferAttribute(buffer, 4, 0));
  geometry.setAttribute("aTo", new THREE.InterleavedBufferAttribute(buffer, 4, 4));
  geometry.setAttribute("aInfo", new THREE.InterleavedBufferAttribute(buffer, 4, 8));
  // One hidden strip always drawn, so the pipeline is built behind the loader.
  geometry.instanceCount = 1;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  const trees = uniformArray(
    Array.from({ length: MAX_TREES }, () => new THREE.Vector4(-100, 1, 0, 1)),
    "vec4"
  );
  return { geometry, buffer, array, capacity, trees, used: 1 };
}

// How far along a figure is, for one segment: whether it shows, how hot its leader is, the flash as it completes, and
// how far it has cooled (1 hot, 0 frozen).
function lifeOf(figures: Figures) {
  const info = attribute("aInfo", "vec4") as any;
  const tree = figures.trees.element(int(info.w)) as any;
  const growth = u.clock.sub(tree.x).div(tree.y) as any;
  const front = growth.clamp(0, 1).mul(tree.z) as any;
  const shown = info.x.lessThanEqual(front) as any;
  const after = u.clock.sub(tree.x).sub(tree.y).div(tree.w) as any;
  const leader = exp(front.sub(info.x).max(0).div(-0.03)).mul(exp(after.max(0).div(-0.08))) as any;
  const flash = exp(after.max(0).div(-0.16)).mul(select(after.greaterThan(0), float(1), float(0))) as any;
  const cool = exp(after.max(0).div(-1.1)) as any;
  return { info, shown, leader, flash, cool };
}

// Where a point inside the block appears to an eye outside, seen through one face (and maybe after one reflection
// off a side face, which inside acrylic is always total). Exact Snell's law at the face: the place on it where the
// bent ray to the point leaves, found by a few Newton steps, then the point set along the eye's line through it at
// the distance light really travels.
function apparent(P: any, faceN: any, faceK: any, mirN: any, mirK: any, E: any) {
  const Pm = P.sub(mirN.mul(dot(P, mirN).sub(mirK).mul(2))) as any;
  const hE = dot(E, faceN).sub(faceK).max(1e-3) as any;
  const dP = faceK.sub(dot(Pm, faceN)).max(1e-4) as any;
  const footE = E.sub(faceN.mul(hE)) as any;
  const footP = Pm.add(faceN.mul(dP)) as any;
  const across = footP.sub(footE) as any;
  const D = length(across).max(1e-6) as any;
  const dir = across.div(D) as any;
  let x: any = float(IOR)
    .mul(hE)
    .mul(D)
    .div(dP.add(hE.mul(IOR)));
  for (let i = 0; i < 4; i++) {
    const a = D.sub(x) as any;
    const ra = sqrt(a.mul(a).add(dP.mul(dP))) as any;
    const rb = sqrt(x.mul(x).add(hE.mul(hE))) as any;
    const f = a.mul(IOR).div(ra).sub(x.div(rb)) as any;
    const slope = dP
      .mul(dP)
      .mul(IOR)
      .div(ra.mul(ra).mul(ra))
      .add(hE.mul(hE).div(rb.mul(rb).mul(rb)))
      .negate() as any;
    x = clamp(x.sub(f.div(slope)), float(0), D);
  }
  const Q = footE.add(dir.mul(x)) as any;
  const app = Q.add(normalize(Q.sub(E)).mul(length(Pm.sub(Q)))) as any;
  const cosIn = hE.div(length(E.sub(Q))) as any;
  return { app, cosIn };
}

const F0 = Math.pow((IOR - 1) / (IOR + 1), 2);

// The figure as seen through the block: one material for every face and reflection, each drawn as its own copy of
// the strips with the face and mirror as per-object uniforms.
function figureMaterial(figures: Figures) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
  const faceN = uniform(new THREE.Vector3(0, 0, 1)).onObjectUpdate(({ object }: any) => object.userData.faceN) as any;
  const faceK = uniform(0.6).onObjectUpdate(({ object }: any) => object.userData.faceK) as any;
  const mirN = uniform(new THREE.Vector3()).onObjectUpdate(({ object }: any) => object.userData.mirN) as any;
  const mirK = uniform(0).onObjectUpdate(({ object }: any) => object.userData.mirK) as any;
  const mirrored = uniform(0).onObjectUpdate(({ object }: any) => object.userData.mirrored) as any;
  // 1 for the copies seen in the floor's reflection: placed as seen from the mirrored eye, then turned over.
  const inFloor = uniform(0).onObjectUpdate(({ object }: any) => object.userData.inFloor) as any;
  const E = mix(u.eye, u.eyeMirror, inFloor) as any;

  const from = attribute("aFrom", "vec4") as any;
  const to = attribute("aTo", "vec4") as any;
  const { info, shown, leader, flash, cool } = lifeOf(figures);
  const A = apparent(from.xyz, faceN, faceK, mirN, mirK, E);
  const B = apparent(to.xyz, faceN, faceK, mirN, mirK, E);
  const viewProjection = cameraProjectionMatrix.mul(cameraViewMatrix) as any;
  const flip = vec4(1, float(1).sub(inFloor.mul(2)), 1, 1) as any;
  const worldA = u.toWorld.mul(vec4(A.app, 1)).mul(flip) as any;
  const worldB = u.toWorld.mul(vec4(B.app, 1)).mul(flip) as any;
  const clipA = viewProjection.mul(worldA) as any;
  const clipB = viewProjection.mul(worldB) as any;
  const halfScreen = screenSize.mul(0.5) as any;
  const sA = clipA.xy.div(clipA.w).mul(halfScreen) as any;
  const sB = clipB.xy.div(clipB.w).mul(halfScreen) as any;
  const run = sB.sub(sA) as any;
  const along = run.div(length(run).max(1e-4)) as any;
  const perp = vec2(along.y.negate(), along.x) as any;
  const end = positionGeometry.x as any;
  const side = positionGeometry.y as any;
  const focal = (cameraProjectionMatrix as any).element(1).element(1).mul(halfScreen.y) as any;
  const clipEnd = mix(clipA, clipB, end) as any;
  const widthPx = mix(from.w, to.w, end).mul(focal).div(clipEnd.w) as any;
  const drawn = widthPx.max(u.minWidth) as any;
  const thin = widthPx.div(drawn).max(0.5) as any;
  const screenAt = mix(sA, sB, end)
    .add(perp.mul(side.mul(drawn).mul(0.5)))
    .add(along.mul(end.mul(2).sub(1).mul(drawn).mul(0.5))) as any;
  const placed = vec4(screenAt.div(halfScreen).mul(clipEnd.w), clipEnd.z, clipEnd.w) as any;
  m.vertexNode = select(shown, placed, vec4(0, 0, 2, 1)) as any;

  // Where on the screen this copy holds: only where the eye's line enters the block through its face.
  const seenAt = varying(mix(A.app, B.app, end)) as any;
  // The floor gives back a quarter, less the further below it the image lies.
  const below = mix(worldA.y, worldB.y, end).negate().max(0) as any;
  const floorGain = mix(float(1), exp(below.mul(-1.4)).mul(0.26), inFloor) as any;
  const transmit = varying(
    float(1)
      .sub(float(F0).add(float(1 - F0).mul(pow(float(1).sub(mix(A.cosIn, B.cosIn, end)), 5))))
      .mul(mix(float(1), float(0.92), mirrored))
      .mul(floorGain)
  ) as any;

  // The finished figure is fine fractures: each catches the key at its own angle, so it glints as the block turns.
  const segment = normalize(to.xyz.sub(from.xyz)) as any;
  const scatter = normalize(vec3(sin(info.y.mul(91.7)), sin(info.y.mul(47.3).add(1.3)), sin(info.y.mul(13.9).add(2.1)))) as any;
  const facet = normalize(cross(segment, scatter)) as any;
  const half = normalize(u.keyLocal.add(normalize(E.sub(from.xyz)))) as any;
  const glint = pow(abs(dot(facet, half)), float(28)).mul(3.2) as any;
  const thickness = info.z as any;
  const shine = varying(vec4(leader, flash, cool, glint)) as any;
  const body = varying(vec2(thin, thickness)) as any;

  const look = normalize(seenAt.sub(E)) as any;
  const t = faceK.sub(dot(E, faceN)).div(min(dot(look, faceN), float(-1e-4))) as any;
  const Q = E.add(look.mul(t)) as any;
  const H = vec3(HALF.x, HALF.y, HALF.z) as any;
  const outside = abs(Q).sub(H) as any;
  const inside = float(1).sub(smoothstep(0.0, 0.004, max(outside.x, max(outside.y, outside.z)))) as any;
  const across = varying(side) as any;
  const strip = exp(across.mul(across).mul(-2.6)) as any;

  // Brightness follows the channel: the trunks and main limbs bright, the fine feathering a haze around them.
  const strength = pow(body.y, float(1.5)).mul(2.8).add(0.5) as any;
  const frozen = u.frozenColour.mul(strength.add(shine.w.mul(body.y.add(0.3)))).add((u.hotColour as any).mul(u.under.mul(strength).mul(0.8))) as any;
  const hot = mix(u.hotColour.mul(3.2), color("#eef6ff").mul(6), body.y.mul(0.6)) as any;
  const glow = mix(frozen, hot, shine.z).add(color("#f4f9ff").mul(shine.x.mul(14).add(shine.y.mul(9)))) as any;
  m.colorNode = vec4(glow.mul(strip).mul(body.x).mul(transmit).mul(inside), 1) as any;
  return m;
}

// The figures' shadows (and the light they bend) on the floor, drawn from above into a map the floor reads. The key's
// light bends down through the top face, passes each fracture, bends back out of the bottom and lands on the floor.
export const SHADOW_SPAN = 4;
function shadowMaterial(figures: Figures) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
  const from = attribute("aFrom", "vec4") as any;
  const to = attribute("aTo", "vec4") as any;
  const { shown } = lifeOf(figures);
  const keyIn = uniform(new THREE.Vector3()).onRenderUpdate(() => keyInside) as any;
  const keyWorld = vec3(KEY_DIR.x, KEY_DIR.y, KEY_DIR.z) as any;
  const land = (P: any) => {
    const toBottom = P.y.add(HALF.y).div(keyIn.y.negate().max(0.05)) as any;
    const bottom = u.toWorld.mul(vec4(P.add(keyIn.mul(toBottom)), 1)).xyz as any;
    const reach = bottom.y.sub(FLOOR).div(keyWorld.y.negate()) as any;
    return bottom.add(keyWorld.mul(reach)) as any;
  };
  const a = land(from.xyz);
  const b = land(to.xyz);
  const end = positionGeometry.x as any;
  const side = positionGeometry.y as any;
  const run = b.xz.sub(a.xz) as any;
  const along = run.div(length(run).max(1e-5)) as any;
  const perp = vec2(along.y.negate(), along.x) as any;
  const texel = SHADOW_SPAN / 512;
  const width = mix(from.w, to.w, end).max(texel * 1.4) as any;
  const thin = mix(from.w, to.w, end).div(width) as any;
  const at = mix(a.xz, b.xz, end)
    .add(perp.mul(side.mul(width).mul(0.5)))
    .add(along.mul(end.mul(2).sub(1).mul(width).mul(0.5))) as any;
  const placed = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(at.x, FLOOR, at.y, 1)) as any;
  m.vertexNode = select(shown, placed, vec4(0, 0, 2, 1)) as any;
  const across = varying(side) as any;
  const dim = varying(thin) as any;
  m.colorNode = vec4((exp(across.mul(across).mul(-2)) as any).mul(dim).mul(0.9), 0, 0, 1) as any;
  return m;
}

// The key's direction inside the block, bent at the top face; set from the scene.
const keyInside = new THREE.Vector3();
{
  const n = new THREE.Vector3(0, 1, 0);
  const cosI = -KEY_DIR.dot(n);
  const eta = 1 / IOR;
  const k = 1 - eta * eta * (1 - cosI * cosI);
  keyInside
    .copy(KEY_DIR)
    .multiplyScalar(eta)
    .addScaledVector(n, eta * cosI - Math.sqrt(k))
    .normalize();
}

// Every copy of the figure that can be seen: through each face, straight or after one reflection off each of the
// four faces beside it, and (with `reflect`) straight through each face again as the floor's reflection sees it. Only
// the faces toward the eye are drawn each frame.
export function FigureView({ figures, mirrors, reflect, target }: { figures: Figures; mirrors: boolean; reflect: boolean; target: THREE.RenderTarget }) {
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const parts = useMemo(() => {
    const material = figureMaterial(figures);
    const copies: THREE.Mesh[] = [];
    const H = [HALF.x, HALF.y, HALF.z];
    for (let f = 0; f < 6; f++) {
      const axis = f >> 1;
      const s = f & 1 ? -1 : 1;
      const faceN = new THREE.Vector3().setComponent(axis, s);
      const images: { mirN: THREE.Vector3; mirK: number; inFloor: number }[] = [{ mirN: new THREE.Vector3(), mirK: 0, inFloor: 0 }];
      if (mirrors)
        for (let b = 0; b < 3; b++) {
          if (b === axis) continue;
          for (const t of [1, -1]) images.push({ mirN: new THREE.Vector3().setComponent(b, t), mirK: H[b], inFloor: 0 });
        }
      if (reflect) images.push({ mirN: new THREE.Vector3(), mirK: 0, inFloor: 1 });
      for (const image of images) {
        const mesh = new THREE.Mesh(figures.geometry, material);
        mesh.frustumCulled = false;
        mesh.layers.set(OVERLAY_LAYER);
        mesh.userData = { face: f, faceN, faceK: H[axis], mirN: image.mirN, mirK: image.mirK, mirrored: image.mirK ? 1 : 0, inFloor: image.inFloor };
        copies.push(mesh);
      }
    }
    const shadow = new THREE.Mesh(figures.geometry, shadowMaterial(figures));
    shadow.frustumCulled = false;
    const shadowScene = new THREE.Scene();
    shadowScene.add(shadow);
    const camera = new THREE.OrthographicCamera(-SHADOW_SPAN / 2, SHADOW_SPAN / 2, SHADOW_SPAN / 2, -SHADOW_SPAN / 2, 0.1, 40);
    camera.position.set(CENTRE.x, 20, CENTRE.z);
    camera.up.set(0, 0, -1);
    camera.lookAt(CENTRE.x, 0, CENTRE.z);
    camera.updateMatrixWorld();
    return { material, copies, shadow, shadowScene, camera };
  }, [figures, mirrors, reflect]);
  useDispose(parts.material, parts.shadow.material as THREE.Material);

  const clear = useMemo(() => new THREE.Color() as THREE.Color & { a: number }, []);
  useFrame(() => {
    const H = [HALF.x, HALF.y, HALF.z];
    for (const mesh of parts.copies) {
      const eye = (mesh.userData.inFloor ? u.eyeMirror.value : u.eye.value) as THREE.Vector3;
      const f = mesh.userData.face as number;
      const axis = f >> 1;
      const s = f & 1 ? -1 : 1;
      mesh.visible = eye.getComponent(axis) * s > H[axis] + 1e-3;
    }
    // The floor's map, drawn fresh each frame (the block turns), into a target the floor samples.
    const before = gl.getRenderTarget();
    gl.getClearColor(clear);
    const alpha = gl.getClearAlpha();
    gl.setRenderTarget(target);
    gl.setClearColor(0x000000, 0);
    gl.clear();
    gl.render(parts.shadowScene, parts.camera);
    gl.setRenderTarget(before);
    gl.setClearColor(clear, alpha);
  });

  return (
    <>
      {parts.copies.map((mesh, i) => (
        <primitive key={i} object={mesh} />
      ))}
    </>
  );
}
