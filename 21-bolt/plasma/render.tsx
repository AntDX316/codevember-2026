"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  atan,
  attribute,
  cameraFar,
  cameraNear,
  cameraPosition,
  clamp,
  cos,
  cross,
  dot,
  exp,
  float,
  floor,
  fract,
  length,
  luminance,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  perspectiveDepthToViewZ,
  equirectUV,
  positionGeometry,
  positionView,
  positionWorld,
  pow,
  reflect,
  screenUV,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  time,
  uniform,
  uniformArray,
  varying,
  uv,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";
import { lehmer } from "../../shared/engine/random";
import { CONTACTS, CORE, GLASS, INNER, type Plasma } from "./filaments";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The gases a globe can be filled with, each glowing its own colours: the trunk of a filament, its tips and the spots
// where they meet the glass, and the white-hot core.
export const GASES = {
  classic: { label: "Classic", inner: "#7488ff", outer: "#ff38b4", core: "#eceeff", swatch: ["#7488ff", "#ff38b4"] },
  neon: { label: "Neon", inner: "#ff6a3a", outer: "#ff2a1a", core: "#ffe0c0", swatch: ["#ff6a2a", "#ff2a1a"] },
  argon: { label: "Argon", inner: "#9466ff", outer: "#d26cff", core: "#f2e6ff", swatch: ["#8a5cff", "#c87cff"] },
  xenon: { label: "Xenon", inner: "#4f86ff", outer: "#58d6ff", core: "#e4f6ff", swatch: ["#3d7bff", "#63d0ff"] }
} as const;
export type Gas = keyof typeof GASES;

// Everything the shaders read that the scene changes: the gas's colours, eased from one to the next; how hard the
// discharge is running; how hard it is being touched; how thick the gas glows; and where the globe's middle falls on
// screen.
export const glow = {
  inner: uniform(new THREE.Color(GASES.classic.inner)),
  outer: uniform(new THREE.Color(GASES.classic.outer)),
  core: uniform(new THREE.Color(GASES.classic.core)),
  power: uniform(1),
  surge: uniform(0),
  gas: uniform(0.5),
  centre: uniform(new THREE.Vector2(0.5, 0.5)),
  // Stopped down as the eye comes in close, as a camera's exposure would, so a close look is not washed out by bloom.
  exposure: uniform(1)
};

// The rooms the globe can stand in, each a real HDRI from Poly Haven: how bright it shows behind the globe and in the
// glass, how far it is cooled toward moonlight so the globe stays the warm thing in it, and how it is turned so its
// lights fall well on the glass.
export const ROOMS = {
  bar: { label: "Bar", file: "warm_bar", behind: 0.22, mirror: 0.8, cool: 0.15, yaw: 4.3, peak: 0.6 },
  loft: { label: "Loft", file: "christmas_photo_studio_01", behind: 0.4, mirror: 1.6, cool: 0.6, yaw: 2.1, peak: 0.45 },
  studio: { label: "Studio", file: "studio_small_03", behind: 0.22, mirror: 0.9, cool: 0.35, yaw: 0.6, peak: 0.6 },
  station: { label: "Station", file: "dresden_station_night", behind: 0.26, mirror: 0.22, cool: 0.45, yaw: 2.5, peak: 4 }
} as const;
export type Room = keyof typeof ROOMS;

// The chosen room as uniforms, so changing room only swaps the picture and these numbers, never a shader. fade dims it
// out and back in round the swap.
export const room = {
  behind: uniform(ROOMS.bar.behind),
  mirror: uniform(ROOMS.bar.mirror),
  cool: uniform(ROOMS.bar.cool),
  yaw: uniform(ROOMS.bar.yaw),
  // How hard the brightest lights in the glass are rolled off: more for a room whose lights would draw hard lines.
  peak: uniform(ROOMS.bar.peak),
  fade: uniform(1)
};
const COOL = vec3(0.62, 0.74, 1.0);
// The room's two pictures: the full one for what the glass reflects, and a small blurred one for what lies behind.
export type RoomMaps = { sharp: THREE.Texture; soft: THREE.Texture };
export function roomAt(env: RoomMaps, d: any, blur: number) {
  const c = cos(room.yaw) as any;
  const s = sin(room.yaw) as any;
  const turned = vec3(d.x.mul(c).sub(d.z.mul(s)), d.y, d.x.mul(s).add(d.z.mul(c))) as any;
  const hdr = (blur < 0.3 ? texture(env.sharp, equirectUV(turned)) : texture(env.soft, equirectUV(turned))).rgb as any;
  return mix(hdr, COOL.mul(luminance(hdr)), room.cool).mul(room.fade) as any;
}

// The room as seen behind the globe: dim, and its lights rolled off so they glow softly rather than flare.
function behind(c: any) {
  const dim = c.mul(room.behind) as any;
  return dim.div(luminance(dim).mul(2.2).add(1)) as any;
}

// Called with the scene's depth once the overlay pass exists, so things drawn there hide behind what the scene draws.
function useOverlay(build: (sceneZ: any) => void) {
  useEffect(
    () =>
      overlayLink.listen((depth) => {
        build(perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar));
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- built once; the builder closes over memoised objects.
    []
  );
}

// A filament's light across its width: u runs -1 to 1 over the strip. A near-white core clipping under bloom, inside a
// soft sheath: lavender-blue along the trunk, magenta-pink over its outer third and at the tips.
function filamentLight(u: any, info: any, gain: any) {
  const bright = info.y as any;
  const along = info.z as any;
  const heat = info.w as any;
  const core = exp(u.mul(u).mul(-1 / (2 * 0.16 * 0.16))) as any;
  const sheath = exp(u.mul(u).mul(-1 / (2 * 0.45 * 0.45))) as any;
  const tint = mix(glow.inner, glow.outer, smoothstep(0.55, 0.97, along)) as any;
  const hot = mix(mix(glow.core, tint, smoothstep(0.6, 1, along).mul(0.55)), vec3(1, 0.97, 1), heat.mul(0.6)) as any;
  return hot
    .mul(core.mul(mix(float(3.4), float(6), heat)))
    .add(tint.mul(sheath.mul(0.6)))
    .mul(bright)
    .mul(gain) as any;
}

// 1 where the electrode is not in the way: the ball is solid, so whatever lies behind it, seen from the eye, is hidden.
function beforeCore() {
  const d = positionWorld.sub(cameraPosition) as any;
  const far = length(d) as any;
  const dir = d.div(far) as any;
  const along = dot(cameraPosition.negate(), dir) as any;
  const miss = dot(cameraPosition, cameraPosition).sub(along.mul(along)) as any;
  const into = sqrt(max(float(CORE * CORE).sub(miss), float(0))) as any;
  const hit = along.sub(into) as any;
  // Hidden only where the ray truly meets the ball (into > 0) before reaching this point.
  return float(1).sub(step(float(1e-5), into).mul(step(hit, far.sub(0.002)))) as any;
}

// The filaments, as the processor lays them out each frame, drawn twice from one buffer: the lines themselves, and a
// wide, faint halo round each, which is the glow of the gas it heats.
export function Filaments({ plasma }: { plasma: Plasma }) {
  const parts = useMemo(() => {
    const make = (scale: number) => {
      const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
      material.positionNode = positionGeometry.add(attribute("aSide", "vec3").mul(scale)) as any;
      const mesh = new THREE.Mesh(plasma.geometry, material);
      mesh.frustumCulled = false;
      mesh.layers.set(OVERLAY_LAYER);
      return { material, mesh };
    };
    return { line: make(1), halo: make(3.2) };
  }, [plasma]);
  useDispose(parts.line.material, parts.halo.material);

  useOverlay((sceneZ) => {
    const info = attribute("aInfo", "vec4") as any;
    const u = info.x as any;
    const shown = step(sceneZ, positionView.z).mul(beforeCore()) as any;
    // Close in, the crowd of roots round the electrode would bloom over the ball: held down near it, more the closer the eye.
    const nearCore = float(1).sub(float(1).sub(glow.exposure).mul(1.4).mul(float(1).sub(smoothstep(0.1, 0.32, length(positionWorld))))).max(0.25) as any;
    parts.line.material.colorNode = vec4(filamentLight(u, info, shown.mul(glow.exposure).mul(nearCore)), 1) as any;
    parts.line.material.needsUpdate = true;
    const tint = mix(glow.inner, glow.outer, smoothstep(0.5, 0.97, info.z)) as any;
    const halo = exp(u.mul(u).mul(-4))
      .sub(exp(float(-4)))
      .max(0) as any;
    parts.halo.material.colorNode = vec4(tint.mul(halo.mul(info.y.min(2)).mul(attribute("aHalo", "float")).mul(0.05).mul(shown).mul(glow.exposure.mul(glow.exposure))), 1) as any;
    parts.halo.material.needsUpdate = true;
  });
  return (
    <>
      <primitive object={parts.halo.mesh} />
      <primitive object={parts.line.mesh} />
    </>
  );
}

// Each branch's splash where it meets the glass: a soft round glow lying flat on the inner surface, white-pink at its
// heart, foreshortened as the glass turns away, and spread soft and dim on the far wall, out of focus.
export function Splashes({ plasma }: { plasma: Plasma }) {
  const parts = useMemo(() => {
    const quad = new THREE.PlaneGeometry(1, 1);
    const count = plasma.splashes.length / 4;
    const at = new THREE.InstancedBufferAttribute(plasma.splashes, 4).setUsage(THREE.DynamicDrawUsage);
    quad.setAttribute("aSplash", at);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const mesh = new THREE.InstancedMesh(quad, material, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { quad, at, material, mesh };
  }, [plasma]);
  useDispose(parts.quad, parts.material);
  useFrame(() => {
    parts.at.needsUpdate = true;
  });
  useOverlay((sceneZ) => {
    const splash = attribute("aSplash", "vec4") as any;
    const n = normalize(splash.xyz) as any;
    const across = normalize(cross(n, vec3(0.31, 0.95, 0.05))) as any;
    const up = cross(n, across) as any;
    // Far from the eye, on the far wall, it spreads and dims as the lens softens it.
    const far = smoothstep(0.1, -0.6, dot(n, normalize(cameraPosition))) as any;
    const size = float(0.035).mul(far.mul(1.6).add(1)) as any;
    parts.material.positionNode = n.mul(INNER * 0.998).add(across.mul(positionGeometry.x.mul(size.mul(2)))).add(up.mul(positionGeometry.y.mul(size.mul(2)))) as any;
    const r = uv().sub(0.5).length().mul(2) as any;
    const core = exp(r.mul(r).mul(-60)) as any;
    const halo = exp(r.mul(r).mul(-7)).sub(exp(float(-7))).max(0) as any;
    const light = vec3(1, 0.9, 0.97)
      .mul(core.mul(1.4).mul(float(1).sub(far)))
      .add(glow.outer.mul(halo.mul(0.7)))
      .mul(splash.w)
      .div(far.mul(1.6).add(1).pow(2)) as any;
    parts.material.colorNode = vec4(light.mul(step(sceneZ, positionView.z)), 1) as any;
    parts.material.needsUpdate = true;
  });
  return <primitive object={parts.mesh} />;
}

// Soft round dots where strands leave the ball heading at the eye: the end of a glowing tube, seen down its length.
export function Dots({ plasma }: { plasma: Plasma }) {
  const parts = useMemo(() => {
    const quad = new THREE.PlaneGeometry(1, 1);
    const at = new THREE.InstancedBufferAttribute(plasma.dots, 4).setUsage(THREE.DynamicDrawUsage);
    quad.setAttribute("aDot", at);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.InstancedMesh(quad, material, plasma.dots.length / 4);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < plasma.dots.length / 4; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { quad, at, material, mesh };
  }, [plasma]);
  useDispose(parts.quad, parts.material);
  useFrame(() => {
    parts.at.needsUpdate = true;
  });
  useOverlay((sceneZ) => {
    const dot = attribute("aDot", "vec4") as any;
    const centre = dot.xyz as any;
    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
    const up = cross(toEye, right) as any;
    const size = float(0.014) as any;
    parts.material.positionNode = centre.add(toEye.mul(0.004)).add(right.mul(positionGeometry.x.mul(size.mul(2)))).add(up.mul(positionGeometry.y.mul(size.mul(2)))) as any;
    const r = uv().sub(0.5).length().mul(2) as any;
    const core = exp(r.mul(r).mul(-14)) as any;
    const soft = exp(r.mul(r).mul(-4)).sub(exp(float(-4))).max(0) as any;
    const light = mix(glow.core, vec3(1), 0.4).mul(core.mul(2.2)).add(glow.inner.mul(soft.mul(0.6))).mul(dot.w) as any;
    parts.material.colorNode = vec4(light.mul(glow.exposure).mul(step(sceneZ, positionView.z)), 1) as any;
    parts.material.needsUpdate = true;
  });
  return <primitive object={parts.mesh} />;
}

// The filaments and electrode drawn again, small, into a target of their own each frame, for the glass to show bent
// through its thick rim.
export function useGhost(plasma: Plasma, fraction: number) {
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera);
  const ghost = useMemo(() => {
    const target = new THREE.RenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
    const scene = new THREE.Scene();
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    material.positionNode = positionGeometry.add(attribute("aSide", "vec3").mul(1.6)) as any;
    const info = attribute("aInfo", "vec4") as any;
    material.colorNode = vec4(filamentLight(info.x.mul(1.6), info, float(1)), 1) as any;
    const mesh = new THREE.Mesh(plasma.geometry, material);
    mesh.frustumCulled = false;
    const ball = new THREE.SphereGeometry(CORE * 1.4, 24, 16);
    const ballMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    ballMaterial.colorNode = vec4(glow.outer.mul(0.8).mul(glow.power), 1) as any;
    scene.add(mesh, new THREE.Mesh(ball, ballMaterial));
    return { target, scene, material, ball, ballMaterial, size: new THREE.Vector2(), clear: new THREE.Color() };
  }, [plasma]);
  useDispose(ghost.target, ghost.material, ghost.ball, ghost.ballMaterial);

  useFrame(() => {
    gl.getDrawingBufferSize(ghost.size);
    const w = Math.max(4, Math.round(ghost.size.x * fraction));
    const h = Math.max(4, Math.round(ghost.size.y * fraction));
    if (ghost.target.width !== w || ghost.target.height !== h) ghost.target.setSize(w, h);
    const before = gl.getRenderTarget();
    gl.getClearColor(ghost.clear);
    const alpha = gl.getClearAlpha();
    gl.setRenderTarget(ghost.target);
    gl.setClearColor(0x000000, 0);
    gl.clear();
    gl.render(ghost.scene, camera);
    gl.setRenderTarget(before);
    gl.setClearColor(ghost.clear, alpha);
  });
  return ghost.target;
}

// The room all round: the same picture the glass reflects, turned and graded the same, so a lamp behind the globe shows
// in the glass where it should. Seen far out of focus, darker than the globe, and lit faintly violet by it, pulsing.
export function Backdrop({ env }: { env: RoomMaps }) {
  const parts = useMemo(() => {
    const geometry = new THREE.SphereGeometry(40, 64, 32);
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
    const d = normalize(positionWorld.sub(cameraPosition)) as any;
    const painted = mix(glow.inner, glow.outer, 0.4).mul(glow.power.add(glow.surge.mul(0.6))).mul(0.012) as any;
    material.colorNode = behind(roomAt(env, d, 0.55)).add(painted) as any;
    return { geometry, material };
  }, [env]);
  useDispose(parts.geometry, parts.material);
  return <mesh geometry={parts.geometry} material={parts.material} renderOrder={-2} frustumCulled={false} raycast={() => null} />;
}

// What the glass takes away from the room behind it: at the rim, where it reflects most, little of the room gets
// through. Drawn in the scene, as a dark veil by (1 - F)², before the glass's own light is added over it.
export function Shell() {
  const parts = useMemo(() => {
    const geometry = new THREE.SphereGeometry(GLASS, 128, 96);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const n = normalize(positionWorld) as any;
    const d = normalize(positionWorld.sub(cameraPosition)) as any;
    const f = float(0.04).add(float(0.96).mul(pow(float(1).sub(abs(dot(n, d))), 5))) as any;
    const through = float(1).sub(f).pow(4) as any;
    material.colorNode = vec4(0, 0, 0, float(1).sub(through).mul(0.9)) as any;
    return { geometry, material };
  }, []);
  useDispose(parts.geometry, parts.material);
  return <mesh geometry={parts.geometry} material={parts.material} renderOrder={1} raycast={() => null} />;
}

// Where three fingerprints have been left on the glass, and which way each lies.
const PRINTS = [
  { at: new THREE.Vector3(0.42, 0.3, 0.86), turn: 0.6 },
  { at: new THREE.Vector3(-0.5, -0.12, 0.86), turn: -0.9 },
  { at: new THREE.Vector3(-0.3, 0.2, -0.93), turn: 2.1 }
].map((p) => ({ ...p, at: p.at.normalize() }));

// The glass, drawn as light added over the scene: the room reflected in it (both surfaces, its lights sweeping across as
// the view turns, the hand-blown surface wavering them a little), the splash where each filament touches it, the flare
// and spreading pink glow under a hand, a double line round its edge where you look through the thick shell side-on,
// the filaments seen bent through that rim, fingerprints, a few tiny bubbles, and the violet gas inside, thickest round
// the electrode. Front and back are two meshes: the back shows the far wall's spots, soft as they are out of focus.
export function Glass({ plasma, ghost, env }: { plasma: Plasma; ghost: THREE.RenderTarget; env: RoomMaps }) {
  const parts = useMemo(() => {
    const geometry = new THREE.SphereGeometry(GLASS, 160, 120);
    const make = (side: THREE.Side) => {
      const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side, blending: THREE.AdditiveBlending });
      const mesh = new THREE.Mesh(geometry, m);
      mesh.layers.set(OVERLAY_LAYER);
      mesh.frustumCulled = false;
      return { m, mesh };
    };
    return { geometry, front: make(THREE.FrontSide), back: make(THREE.BackSide), tips: uniformArray(plasma.tips, "vec4"), hands: uniformArray(plasma.hands, "vec4") };
  }, [plasma]);
  useDispose(parts.geometry, parts.front.m, parts.back.m);

  useOverlay((sceneZ) => {
    const shown = step(sceneZ, positionView.z) as any;
    for (const facing of ["front", "back"] as const) {
      const front = facing === "front";
      const n = normalize(positionWorld) as any;
      const d = normalize(positionWorld.sub(cameraPosition)) as any;
      const cosine = abs(dot(n, d)) as any;
      // A thin shell reflects twice, front face and back: about 2F / (1 + F) of Schlick's F.
      const f = float(0.04).add(float(0.96).mul(pow(float(1).sub(cosine), 5))) as any;
      const shell = f.mul(2).div(f.add(1)) as any;

      // Where each filament touches: a small hot splash and a wider bloom; on the far wall, softened as the lens is
      // focused on the near side, into round pink bokeh.
      // The soft parts are worked out at the vertices, which are fine enough for them; only the small hot splashes on
      // the near side are worked out for every pixel.
      const nv = normalize(positionWorld) as any;
      // The splashes sit on the inner surface, a few millimetres in: where the eye's line meets it, seen through the
      // glass and foreshortened at the rim. Past the inner surface's edge, the outer surface is the nearest there is.
      const toMiddle = cameraPosition.negate() as any;
      const reach = dot(toMiddle, d) as any;
      const passes = sqrt(max(dot(toMiddle, toMiddle).sub(reach.mul(reach)), float(0))) as any;
      const into = sqrt(max(float(INNER * INNER).sub(passes.mul(passes)), float(0))) as any;
      const onInner = normalize(cameraPosition.add(d.mul(front ? reach.sub(into) : reach.add(into)))) as any;
      const ni = mix(n, onInner, step(passes, float(INNER))) as any;
      let tight: any = float(0);
      let centre: any = float(0);
      let soft: any = float(0);
      let wideSum: any = float(0);
      for (let i = 0; i < plasma.limit; i++) {
        const tip = parts.tips.element(i) as any;
        const offV = float(1).sub(dot(nv, tip.xyz)) as any;
        soft = soft.add((front ? exp(offV.mul(-160)).mul(0.12) : exp(offV.mul(-420)).mul(0.45).add(exp(offV.mul(-90)).mul(0.12))).mul(tip.w));
        if (front) {
          wideSum = wideSum.add(exp(offV.mul(-40)).mul(tip.w));
          const off = float(1).sub(dot(ni, tip.xyz)) as any;
          tight = tight.add(exp(off.mul(-2200)).mul(1.1).mul(tip.w));
          centre = centre.add(exp(off.mul(-12000)).mul(1.4).mul(tip.w));
        }
      }
      const atVertex = varying(vec4(soft, wideSum, front ? mx_noise_float(nv.mul(vec3(3, 9, 3))) : float(0), 0)) as any;
      const spots = (front ? tight.add(atVertex.x) : atVertex.x) as any;
      const wideLight = atVertex.y as any;
      let light: any = mix(glow.outer, glow.core, 0.2).mul(spots).add(vec3(1, 0.9, 0.97).mul(centre));
      // Under each hand: a white-hot flare at the point, a wide pink glow spreading over the inner surface round it that
      // fades slowly after letting go, and a pink wash over the whole globe while it is held.
      let warm: any = float(0);
      for (let k = 0; k < CONTACTS; k++) {
        const hand = parts.hands.element(k) as any;
        const off = float(1).sub(dot(n, hand.xyz)) as any;
        // A crisp white-hot point, a saturated pink ring round it, and a soft wide halo lighting the glass.
        light = light.add(
          vec3(1, 0.95, 1)
            .mul(exp(off.mul(-9000)).mul(6))
            .add(mix(glow.outer, vec3(1, 0.85, 0.95), 0.3).mul(exp(off.mul(-1200)).mul(1.6)))
            .add(glow.outer.mul(exp(off.mul(-150)).mul(0.45)))
            .mul(hand.w)
        );
        warm = warm.add(exp(off.mul(-60)).mul(hand.w));
      }
      const wash = glow.surge.mul(float(0.006).add(pow(float(1).sub(cosine), 2).mul(0.025))) as any;
      light = light.add(glow.outer.mul(warm.mul(front ? 0.14 : 0.08).add(wash)));

      // The room in the glass: crisp, its lights drawing bright arcs; the hand-blown surface wavers them a little.
      const waver = vec3(sin(n.y.mul(31).add(n.x.mul(7))), sin(n.z.mul(27).add(n.y.mul(9))), sin(n.x.mul(29).add(n.z.mul(11)))).mul(0.006) as any;
      const bent = normalize(n.add(waver)) as any;
      const facingN = front ? bent : bent.negate();
      const r = reflect(d, facingN) as any;
      const roomSeen = roomAt(env, r, 0.03) as any;
      // Its lights rolled off a little, so they read as crisp bright shapes rather than flares.
      const mirrored = roomSeen.mul(shell).mul(room.mirror).mul(front ? 1 : 0.4) as any;
      light = light.add(mirrored.div(luminance(mirrored).mul(room.peak).add(1)));

      if (front) {
        // How near the eye's line passes the middle: at the rim it runs through the shell side-on.
        const toCentre = cameraPosition.negate() as any;
        const along = dot(toCentre, d) as any;
        const miss = sqrt(max(dot(toCentre, toCentre).sub(along.mul(along)), float(0))) as any;
        const plasmaTint = mix(glow.inner, glow.outer, 0.6) as any;
        // Both surfaces' edges, lit from inside where filaments meet the glass nearby.
        const outerEdge = pow(float(1).sub(cosine), 12).mul(0.4) as any;
        const innerEdge = exp(
          miss
            .sub(INNER)
            .div(0.005)
            .pow(2)
            .negate()
        ).mul(0.2) as any;
        const nearby = wideLight.mul(0.25).add(warm.mul(0.6)).add(0.15) as any;
        light = light.add(plasmaTint.mul(outerEdge.add(innerEdge).mul(nearby).mul(glow.power)));
        // Through that band of thick glass the filaments are seen again, bent: the ring just inside the inner surface
        // is drawn out across the rim, mirrored.
        const band = smoothstep(INNER - 0.01, INNER + 0.004, miss).mul(float(1).sub(smoothstep(0.985, 1.0, miss))) as any;
        const source = float(INNER).sub(miss.sub(INNER).mul(3.2)) as any;
        const fromCentre = screenUV.sub(glow.centre) as any;
        const seenAt = glow.centre.add(fromCentre.mul(source.div(max(miss, float(0.5))))) as any;
        const seen = texture(ghost.texture, seenAt).rgb.add(texture(ghost.texture, seenAt.add(fromCentre.mul(-0.01))).rgb).mul(0.5) as any;
        light = light.add(seen.mul(band.mul(0.4)));

        // Fingerprints: whorls of fine ridges, seen only where something bright lights them.
        let prints: any = float(0);
        for (const p of PRINTS) {
          const across = new THREE.Vector3().crossVectors(p.at, new THREE.Vector3(0, 1, 0)).normalize().applyAxisAngle(p.at, p.turn);
          const up = new THREE.Vector3().crossVectors(across, p.at);
          const x = dot(n, vec3(across.x, across.y, across.z)) as any;
          const y = dot(n, vec3(up.x, up.y, up.z)).mul(0.78) as any;
          const rr = length(vec2(x, y)) as any;
          const ridges = sin(rr.mul(1100).add(atan(y, x).mul(1.5)).add(sin(x.mul(90)).mul(1.2)))
            .mul(0.5)
            .add(0.5) as any;
          const pad = exp(rr.div(0.075).pow(4).negate()).mul(step(float(0.3), dot(n, vec3(p.at.x, p.at.y, p.at.z)))) as any;
          prints = prints.add(ridges.mul(pad).mul(0.8).add(pad.mul(0.2)));
        }
        const smear = atVertex.z
          .mul(0.5)
          .add(0.5) as any;
        const catchLight = luminance(roomSeen).mul(1.2).add(wideLight.mul(0.05)).add(warm.mul(0.5)).add(0.03) as any;
        light = light.add(mix(vec3(0.8, 0.82, 0.9), plasmaTint, 0.5).mul(prints.mul(0.1).add(smear.mul(0.015)).mul(catchLight)));

        // Tiny bubbles in the glass: a few cells in many hold one, a bright pin with a dark ring catching the light.
        const cells = n.mul(70) as any;
        const cell = floor(cells) as any;
        const h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))).mul(43758.5453)) as any;
        const middle = cell.add(0.5).add(vec3(fract(h.mul(13.1)), fract(h.mul(7.7)), fract(h.mul(3.3))).sub(0.5).mul(0.6)) as any;
        const dist = length(cells.sub(middle)) as any;
        const size = h.mul(0.12).add(0.05) as any;
        const bubble = step(0.992, h).mul(float(1).sub(smoothstep(size.mul(0.4), size, dist))) as any;
        light = light.add(vec3(0.9, 0.9, 1).mul(bubble.mul(luminance(roomSeen).mul(2).add(wideLight.mul(0.08)).add(0.05))));

        // The gas: light from a column of it as deep as the ray's path through the globe, thickest round the electrode.
        const chord = sqrt(max(float(1).sub(miss.mul(miss)), float(0))) as any;
        const haze = exp(miss.mul(miss).mul(-1 / (2 * 0.13 * 0.13)))
          .mul(0.04)
          .add(exp(miss.mul(miss).mul(-1 / (2 * 0.42 * 0.42))).mul(0.035))
          .add(chord.mul(0.018)) as any;
        const gasColour = mix(glow.inner, glow.core, exp(miss.mul(-14)).mul(0.5)) as any;
        // Touched, the energy goes to the hand and the gas round it turns pink.
        light = light.add(mix(gasColour, glow.outer, glow.surge.mul(0.35)).mul(haze.mul(glow.gas).mul(glow.power.mul(0.8).add(glow.surge.mul(0.2)))));
      }
      const m = front ? parts.front.m : parts.back.m;
      m.colorNode = vec4(light.mul(shown), 1) as any;
      m.needsUpdate = true;
    }
  });

  return (
    <>
      <primitive object={parts.back.mesh} />
      <primitive object={parts.front.mesh} />
    </>
  );
}

// The electrode: a glassy ball glowing from within, its mottled, veined, speckled surface turning slowly, brighter at
// the limb as glass is, with the room's lights caught on it. Each filament sits on it as a bright foot in a pool of glow;
// those rooted round the back light its edge.
export function Electrode({ plasma, env }: { plasma: Plasma; env: RoomMaps }) {
  const { mesh, material, geometry, roots } = useMemo(() => {
    const geometry = new THREE.SphereGeometry(CORE, 96, 64);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.layers.set(OVERLAY_LAYER);
    mesh.frustumCulled = false;
    return { mesh, material, geometry, roots: uniformArray(plasma.roots, "vec4") };
  }, [plasma]);
  useDispose(material, geometry);
  useOverlay((sceneZ) => {
    const n = normalize(positionWorld) as any;
    const toEye = normalize(cameraPosition.sub(positionWorld)) as any;
    const facing = max(dot(n, toEye), float(0)) as any;
    const limb = float(1).sub(facing) as any;
    const t = time as any;
    // The surface turns slowly, so its pattern moves with it.
    const spin = t.mul(0.12) as any;
    const turned = vec3(n.x.mul(cos(spin)).sub(n.z.mul(sin(spin))), n.y, n.x.mul(sin(spin)).add(n.z.mul(cos(spin)))) as any;
    const veins = abs(mx_noise_float(turned.mul(5))) as any;
    const mottle = mx_noise_float(turned.mul(11).add(vec3(0, t.mul(0.08), 0)))
      .mul(0.5)
      .add(0.5) as any;
    const cells = turned.mul(30) as any;
    const id = floor(cells) as any;
    const h = fract(sin(dot(id, vec3(12.9898, 78.233, 37.719))).mul(43758.5453)) as any;
    const speck = float(1)
      .sub(smoothstep(0.1, 0.28, length(fract(cells).sub(0.5))))
      .mul(step(0.6, h))
      .mul(sin(t.mul(h.mul(20).add(6)).add(h.mul(40)))
        .mul(0.5)
        .add(0.5)) as any;
    // The feet: a white-hot point where each filament leaves the face, a flared bright patch round it, a wider pool; and
    // for those round the back, a glow wrapping over the edge.
    const wrapped = normalize(n.sub(toEye.mul(0.9))) as any;
    let foot: any = float(0);
    let patch: any = float(0);
    let pools: any = float(0);
    let wrap: any = float(0);
    for (let i = 0; i < plasma.limit; i++) {
      const root = roots.element(i) as any;
      const off = float(1).sub(dot(n, root.xyz)) as any;
      foot = foot.add(exp(off.mul(-1400)).mul(root.w));
      patch = patch.add(exp(off.mul(-220)).mul(root.w));
      pools = pools.add(exp(off.mul(-30)).mul(root.w));
      wrap = wrap.add(exp(float(1).sub(dot(wrapped, root.xyz)).mul(-12)).mul(root.w));
    }
    const warmTone = mix(glow.outer, vec3(1, 0.3, 0.1), 0.55) as any;
    const veined = float(1).sub(smoothstep(0.02, 0.12, veins)) as any;
    // Lit from within: brightest through the middle, where the eye sees deepest into it, with the texture on top.
    const inside = mix(warmTone.mul(0.1), warmTone.mul(0.65), mottle.mul(0.55).add(veined.mul(0.45))).mul(facing.mul(0.75).add(0.25)) as any;
    // Glass at the limb: brighter, and paler.
    const rim = mix(warmTone, glow.core, 0.5).mul(pow(limb, 3).mul(1.1)) as any;
    // The room's lights on it.
    const f = float(0.04).add(float(0.96).mul(pow(limb, 5))) as any;
    // A lumpy, organic surface: the room's lights caught on it break up across the bumps.
    const lumpy = normalize(n.add(vec3(mx_noise_float(turned.mul(7)), mx_noise_float(turned.mul(7).add(13)), mx_noise_float(turned.mul(7).add(29))).mul(0.18))) as any;
    const caught = roomAt(env, reflect(toEye.negate(), lumpy), 0.02).mul(room.mirror).mul(f.add(0.06)).mul(2.2) as any;
    const caughtSoft = caught.div(luminance(caught).mul(0.4).add(1)) as any;
    // Fine bright wisps over its surface, drifting: the thin lines where a slow noise crosses zero.
    const wisp = float(1).sub(smoothstep(0, 0.035, abs(mx_noise_float(turned.mul(9).add(vec3(0, t.mul(0.25), 0)))))) as any;
    const body = inside
      .add(mix(warmTone, vec3(1, 0.85, 0.9), 0.5).mul(wisp.mul(0.55)))
      .add(vec3(1, 0.5, 0.3).mul(speck.mul(1.3)))
      .add(mix(warmTone, glow.core, 0.3).mul(pools.mul(0.18)))
      .add(mix(glow.inner, glow.core, 0.6).mul(patch.mul(1.4)))
      .add(vec3(1, 0.96, 1).mul(foot.mul(3)))
      .add(mix(glow.inner, glow.core, 0.5).mul(wrap.mul(pow(limb, 2)).mul(0.5)))
      .add(rim)
      .add(caughtSoft) as any;
    material.colorNode = vec4((clamp(body, 0, 4) as any).mul(glow.power.mul(0.8).add(glow.surge.mul(0.3)).add(0.2)).mul(glow.exposure).mul(step(sceneZ, positionView.z)), 1) as any;
    material.needsUpdate = true;
  });
  return <primitive object={mesh} />;
}

// The air of the room: for each pixel, the globe's light scattered toward the eye along its whole line by a faint haze
// round it (the closed form of 1/r² along a line).
export function Aura() {
  const parts = useMemo(() => {
    const geometry = new THREE.SphereGeometry(30, 48, 24);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.BackSide, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.layers.set(OVERLAY_LAYER);
    mesh.frustumCulled = false;
    return { geometry, material, mesh };
  }, []);
  useDispose(parts.geometry, parts.material);
  useOverlay((sceneZ) => {
    const d = normalize(positionWorld.sub(cameraPosition)) as any;
    const toCentre = cameraPosition.negate() as any;
    const along = dot(toCentre, d) as any;
    const miss = sqrt(max(dot(toCentre, toCentre).sub(along.mul(along)), float(1e-4))) as any;
    // As far as the line reaches: the room's far side.
    const stop = min(sceneZ.div(normalize(positionView).z), float(16)) as any;
    const scattered = atan(stop.sub(along), miss).add(atan(along, miss)).div(miss) as any;
    const outside = smoothstep(0.95, 1.25, miss) as any;
    const tint = mix(glow.inner, glow.outer, 0.45) as any;
    const globe = tint.mul(scattered.mul(outside).mul(exp(miss.mul(-0.9))).mul(0.02).mul(glow.power.add(glow.surge.mul(0.6)))) as any;
    parts.material.colorNode = vec4(globe, 1) as any;
    parts.material.needsUpdate = true;
  });
  return <primitive object={parts.mesh} />;
}

// Dust in the room: fine pale specks round the globe, lit by it close to the glass, and soft discs of bokeh drifting
// past the lens. Nearly half drift in a smaller cloud close round the globe, where its light catches them. Drawn over
// the frame.
export function Motes({ count }: { count: number }) {
  const parts = useMemo(() => {
    const random = lehmer(9071);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) seeds.set([random(), random(), random(), random()], i * 4);
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.InstancedMesh(quad, material, count);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, identity);
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { quad, material, mesh };
  }, [count]);
  useDispose(parts.quad, parts.material);

  useOverlay((sceneZ) => {
    const s = attribute("aSeed", "vec4") as any;
    const t = time as any;
    const lens = step(s.w, 0.16) as any;
    const close = step(s.w, 0.6).sub(lens) as any;
    const size = mix(vec3(7, 4, 7), vec3(3.8, 2.8, 3.8), close) as any;
    const drift = vec3(t.mul(-0.004), t.mul(0.007), t.mul(0.002)).mul(s.w.add(0.5)) as any;
    const place = fract(s.xyz.add(drift.div(size)))
      .sub(0.5)
      .mul(size)
      .add(vec3(0, 0.2, 0)) as any;
    const swirl = vec3(sin(place.y.mul(1.7).add(t.mul(0.13))), sin(place.z.mul(1.3).add(t.mul(0.11))).mul(0.6), sin(place.x.mul(1.5).sub(t.mul(0.12)))).mul(0.1) as any;
    const near = cameraPosition.add(
      fract(s.xyz.add(drift.div(2.2)).sub(cameraPosition.div(2.2)))
        .sub(0.5)
        .mul(2.2)
    ) as any;
    const centre = mix(place.add(swirl), near, lens) as any;
    const toEye = normalize(cameraPosition.sub(centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
    const up = cross(toEye, right) as any;
    const away = length(cameraPosition.sub(centre)) as any;
    const focus = length(cameraPosition) as any;
    const sharp = max(float(0.0016), away.mul(0.0007)).mul(s.y.mul(0.9).add(0.55)) as any;
    // Out of focus, a speck spreads into a disc, never wider than about two degrees.
    const blur = min(abs(away.sub(focus)).div(away).mul(0.04), away.mul(0.034)) as any;
    const radius = sharp.add(blur) as any;
    const spread = sharp.div(radius).pow(2).max(0.03) as any;
    const soft = smoothstep(0.004, 0.03, blur) as any;
    parts.material.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(up.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
    const r = uv().sub(0.5).length() as any;
    const point = float(1).sub(smoothstep(0.08, 0.5, r)) as any;
    const disc = float(1).sub(smoothstep(0.36, 0.5, r)) as any;
    const shape = mix(point, disc, soft).mul(spread) as any;
    // Lit by the globe, falling off with distance from it; none inside the glass.
    const fromGlobe = length(centre) as any;
    const lit = float(1.2).div(fromGlobe.mul(fromGlobe).add(0.15)).mul(glow.power.add(glow.surge.mul(0.8))) as any;
    const outside = smoothstep(GLASS + 0.02, GLASS + 0.12, fromGlobe) as any;
    const twinkle = sin(t.mul(s.y.mul(2).add(0.6)).add(s.z.mul(50)))
      .mul(0.3)
      .add(0.7) as any;
    // Pale dust, warm to cool white, only faintly tinged by the gas: never pink.
    const tint = mix(mix(vec3(1, 0.9, 0.78), vec3(0.82, 0.9, 1), s.x), glow.inner, 0.12) as any;
    const light = tint.mul(lit) as any;
    // Motes right at the lens are few and faint: big soft discs of them read as blobs over the globe.
    const amount = mix(float(1.5), float(0.06), lens) as any;
    const shown = step(sceneZ, positionView.z) as any;
    parts.material.colorNode = vec4(light.mul(outside.mul(twinkle).mul(shape).mul(amount).mul(shown)), 1) as any;
    parts.material.needsUpdate = true;
  });
  return <primitive object={parts.mesh} />;
}
