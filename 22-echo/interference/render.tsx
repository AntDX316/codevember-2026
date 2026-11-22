"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
  cameraFar,
  cameraNear,
  cameraPosition,
  cross,
  dot,
  exp,
  float,
  Fn,
  fract,
  instancedArray,
  instanceIndex,
  length,
  max,
  min,
  mix,
  normalize,
  normalWorld,
  perspectiveDepthToViewZ,
  positionGeometry,
  positionView,
  positionWorld,
  pow,
  screenUV,
  sin,
  smoothstep,
  step,
  uniform,
  uv,
  varying,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";
import { lehmer } from "../../shared/engine/random";
import { beacons, clock, emission, MIST, mistEdge, PERIOD, PING, soundField, SPEED } from "./waves";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The palette: deep black, the ice blue of sound in the mist, white where crests pile up, and the warm gold of the form
// answering.
const ICE = vec3(0.32, 0.66, 1);
const HOT = vec3(1, 0.93, 0.82);
const DEEP = vec3(0.05, 0.16, 0.42);
const GOLD = vec3(1, 0.62, 0.26);

// The lens: a pixel's size at a distance of one, and where it is focused, set each frame by the scene.
export const lens = { pixel: uniform(0.001), focus: uniform(6), eye: uniform(new THREE.Vector3()), turn: uniform(0) };

// Called with the scene's depth once the overlay pass exists, so what is drawn there hides behind the form.
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

// The hidden form. Matte black, lit only by sound: thin gold contour lines where the crests cross its surface,
// brightest where the waves of several beacons pile up, and a soft glow that lingers a moment after each wave passes,
// strongest toward the rim. Turned slowly by its group.
export function Form({ geometry, group }: { geometry: THREE.BufferGeometry; group: THREE.Group }) {
  const material = useMemo(() => {
    const m = new THREE.MeshBasicNodeMaterial();
    const p = positionWorld as any;
    const n = normalize(normalWorld) as any;
    const view = normalize(cameraPosition.sub(p)) as any;
    const { s, g, l } = soundField(p, true, 0.02);
    // Each crest a thin line; where crests of several beacons meet it flares, where a crest meets a trough it fades.
    const lines = l.mul(s.max(0).mul(2.2).add(0.45)).mul(2.4) as any;
    const rim = pow(float(1).sub(abs(dot(n, view))), 2.5) as any;
    const glowing = g.mul(rim.mul(0.5).add(0.03)) as any;
    const hot = smoothstep(1.5, 6, lines) as any;
    const light = mix(GOLD, HOT, hot).mul(lines.mul(rim.mul(0.6).add(0.5))).add(GOLD.mul(glowing).mul(0.025)) as any;
    m.colorNode = vec4(light.add(DEEP.mul(0.012).mul(rim)), 1) as any;
    return m;
  }, []);
  useDispose(material);
  return (
    <primitive object={group}>
      <mesh geometry={geometry} material={material} />
    </primitive>
  );
}

// The mist: a soft ball of fine specks, each lit by the sound at its place. A compute pass works out every speck's
// place (a slow drift) and its light once a frame; the sprites only read it.
export function Mist({ count }: { count: number }) {
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const parts = useMemo(() => {
    const random = lehmer(2207);
    const seeds = new Float32Array(count * 4);
    for (let k = 0; k < count; k++) {
      // Even through the ball, thinning softly toward its rim.
      let x = 0;
      let y = 0;
      let z = 0;
      for (;;) {
        x = random() * 2 - 1;
        y = random() * 2 - 1;
        z = random() * 2 - 1;
        const r2 = x * x + y * y + z * z;
        if (r2 <= 1 && random() < 1 - r2 * 0.55) break;
      }
      seeds.set([x * MIST, y * MIST * 0.82, z * MIST, random()], k * 4);
    }
    const seed = instancedArray(seeds, "vec4") as any;
    const place = instancedArray(count, "vec4") as any;
    const shade = instancedArray(count, "vec4") as any;
    const pass = Fn(() => {
      const sd = seed.element(instanceIndex) as any;
      const t = clock as any;
      const o = sd.xyz as any;
      const swirl = vec3(sin(o.y.mul(0.9).add(t.mul(0.07)).add(sd.w.mul(6))), sin(o.z.mul(0.7).sub(t.mul(0.05))).mul(0.6), sin(o.x.mul(0.8).add(t.mul(0.06)))).mul(0.08) as any;
      const at = o.add(swirl) as any;
      const { s, g, l } = soundField(at, true, 0.035);
      const edge = mistEdge(at) as any;
      const wave = l.mul(s.max(0).mul(s.max(0)).mul(2.5).add(0.4)).mul(edge) as any;
      place.element(instanceIndex).assign(vec4(at, wave));
      shade.element(instanceIndex).assign(vec4(g.mul(edge), sd.w, 0, 0));
    })().compute(count);
    const quad = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(quad, material);
    mesh.count = count;
    mesh.frustumCulled = false;
    mesh.layers.set(OVERLAY_LAYER);
    return { place, shade, pass, quad, material, mesh };
  }, [count]);
  useDispose(parts.quad, parts.material);

  useFrame(() => {
    if (parts.mesh.visible) gl.compute(parts.pass);
  });

  useOverlay((sceneZ) => {
    // Where and how big: from the compute pass's place, built apart from the colour's copy.
    const sprite = () => {
      const pl = parts.place.element(instanceIndex) as any;
      const sh = parts.shade.element(instanceIndex) as any;
      const centre = pl.xyz as any;
      const away = length(cameraPosition.sub(centre)) as any;
      // A speck about a pixel and a half across, swelling a little in a crest; nearer and further than the focus, a
      // soft disc never wider than about a degree.
      const sharp = lens.pixel.mul(away).mul(sh.y.mul(0.7).add(0.8)) as any;
      const blur = min(abs(away.sub(lens.focus)).div(away).mul(0.012), away.mul(0.012)) as any;
      return { centre, sharp, radius: sharp.add(blur) };
    };
    const a = sprite();
    const toEye = normalize(cameraPosition.sub(a.centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
    const upward = cross(toEye, right) as any;
    parts.material.positionNode = a.centre.add(right.mul(positionGeometry.x.mul(a.radius.mul(2)))).add(upward.mul(positionGeometry.y.mul(a.radius.mul(2)))) as any;

    const b = sprite();
    const pl = parts.place.element(instanceIndex) as any;
    const sh = parts.shade.element(instanceIndex) as any;
    const wave = pl.w as any;
    const hot = smoothstep(0.8, 4, wave) as any;
    const tint = mix(ICE, HOT, hot) as any;
    // A faint floor of deep blue so the mist is there in the dark, and the trail the sound leaves as it passes.
    const base = DEEP.mul(sh.y.mul(0.5).add(0.5).mul(0.02)) as any;
    const light = tint.mul(wave).add(DEEP.mul(sh.x.mul(0.06))).add(base) as any;
    const spread = pow(b.sharp.div(b.radius), 2) as any;
    const colour = varying(light.mul(spread)) as any;
    const r = uv().sub(0.5).length().mul(2) as any;
    const shape = exp(r.mul(r).mul(-4.5)).sub(exp(float(-4.5))).max(0) as any;
    const shown = step(sceneZ, positionView.z) as any;
    parts.material.colorNode = vec4(colour.mul(shape).mul(shown), 1) as any;
    parts.material.needsUpdate = true;
  });
  return <primitive object={parts.mesh} />;
}

// Each beacon: a hot white point where it sits, flaring as it sounds, with a soft blue halo.
export function Beacons() {
  const parts = useMemo(
    () =>
      beacons.map((b) => {
        const quad = new THREE.PlaneGeometry(1, 1);
        const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
        const mesh = new THREE.Mesh(quad, material);
        mesh.frustumCulled = false;
        mesh.layers.set(OVERLAY_LAYER);
        return { b, quad, material, mesh };
      }),
    []
  );
  useDispose(...parts.flatMap((p) => [p.quad, p.material]));

  useOverlay((sceneZ) => {
    for (const { b, material } of parts) {
      const at = b.at as any;
      const times = b.times as any;
      const centre = at.xyz as any;
      const toEye = normalize(cameraPosition.sub(centre)) as any;
      const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
      const upward = cross(toEye, right) as any;
      const away = length(cameraPosition.sub(centre)) as any;
      const size = away.mul(0.06) as any;
      material.positionNode = centre.add(right.mul(positionGeometry.x.mul(size))).add(upward.mul(positionGeometry.y.mul(size))) as any;
      // Sounding now: held, or in a ping.
      const since = clock.sub(times.x) as any;
      const held = step(times.x, clock).mul(step(clock, times.y)) as any;
      const w = clock.sub(times.y).add(PING) as any;
      const ping = step(PERIOD, w).mul(float(1).sub(smoothstep(0, PING, fract(w.div(PERIOD)).mul(PERIOD)))) as any;
      const sounding = max(held, ping).mul(step(clock, times.z)) as any;
      const fresh = exp(since.mul(-3)) as any;
      const r = uv().sub(0.5).length().mul(2) as any;
      const core = exp(r.mul(r).mul(-900)) as any;
      const halo = exp(r.mul(r).mul(-28)).sub(exp(float(-28))).max(0) as any;
      const alive = float(0.35).add(float(0.65).mul(step(clock, times.z))) as any;
      const light = HOT.mul(core.mul(4)).add(ICE.mul(halo.mul(sounding.mul(0.5).add(0.12).add(fresh)))).mul(at.w).mul(alive) as any;
      material.colorNode = vec4(light.mul(step(sceneZ, positionView.z)), 1) as any;
      material.needsUpdate = true;
    }
  });
  return (
    <>
      {parts.map((p, k) => (
        <primitive key={k} object={p.mesh} />
      ))}
    </>
  );
}

// Dust and bokeh: fine specks round the form, a few large soft discs drifting past the lens, all faintly catching the
// sound as it passes, so the near air flickers with each wave.
export function Motes({ count }: { count: number }) {
  const parts = useMemo(() => {
    const random = lehmer(5113);
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
    const place = () => {
      const s = attribute("aSeed", "vec4") as any;
      const t = clock as any;
      const lensNear = step(s.w, 0.12) as any;
      const drift = vec3(t.mul(0.006), t.mul(0.004), t.mul(-0.003)).mul(s.w.add(0.5)) as any;
      const box = 9 as number;
      const far = fract(s.xyz.add(drift.div(box)))
        .sub(0.5)
        .mul(box) as any;
      const near = cameraPosition.add(
        fract(s.xyz.add(drift.div(2.4)).sub(cameraPosition.div(2.4)))
          .sub(0.5)
          .mul(2.4)
      ) as any;
      return { s, centre: mix(far, near, lensNear) as any, lensNear };
    };
    const a = place();
    const toEye = normalize(cameraPosition.sub(a.centre)) as any;
    const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
    const upward = cross(toEye, right) as any;
    const away = length(cameraPosition.sub(a.centre)) as any;
    const sharp = max(float(0.0018), away.mul(0.0011)).mul(a.s.y.mul(1.2).add(0.5)) as any;
    const blur = min(abs(away.sub(lens.focus)).div(away).mul(0.045), away.mul(0.034)) as any;
    const radius = sharp.add(blur) as any;
    parts.material.positionNode = a.centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(upward.mul(positionGeometry.y.mul(radius.mul(2)))) as any;

    const b = place();
    const awayB = length(cameraPosition.sub(b.centre)) as any;
    const sharpB = max(float(0.0018), awayB.mul(0.0011)).mul(b.s.y.mul(1.2).add(0.5)) as any;
    const blurB = min(abs(awayB.sub(lens.focus)).div(awayB).mul(0.045), awayB.mul(0.034)) as any;
    const spread = pow(sharpB.div(sharpB.add(blurB)), 2).max(0.04) as any;
    const { s, g } = soundField(b.centre, false);
    const heard = s.mul(s).mul(0.6).add(g.mul(0.05)) as any;
    const twinkle = sin(clock.mul(b.s.y.mul(1.7).add(0.4)).add(b.s.z.mul(40)))
      .mul(0.3)
      .add(0.7) as any;
    const amount = mix(float(1), float(0.12), b.lensNear) as any;
    const light = mix(vec3(0.62, 0.74, 0.95), vec3(0.95, 0.86, 0.74), b.s.x).mul(heard.mul(1.6).add(0.05)).mul(twinkle).mul(amount).mul(spread) as any;
    const colour = varying(light) as any;
    const r = uv().sub(0.5).length() as any;
    const soft = smoothstep(0.004, 0.03, blurB) as any;
    const shape = mix(float(1).sub(smoothstep(0.08, 0.5, r)), float(1).sub(smoothstep(0.38, 0.5, r)), varying(soft)) as any;
    parts.material.colorNode = vec4(colour.mul(shape).mul(step(sceneZ, positionView.z)), 1) as any;
    parts.material.needsUpdate = true;
  });
  return <primitive object={parts.mesh} />;
}

// The wavefronts themselves: every crest of every beacon's sound as a thin luminous bubble, brightest at its limb where
// the eye looks along it. Each crest is lit by the whole field where it is, so where another beacon's crest crosses it
// a bright band runs round it, and where a trough crosses it a dark one. Echoes are the same, centred on the point of
// the form that sent them back, warmer and fainter, and only over the side that surface faces.
const CRESTS = 10;
export function Shells({ fine }: { fine: boolean }) {
  const parts = useMemo(() => {
    const sphere = new THREE.SphereGeometry(1, fine ? 96 : 48, fine ? 48 : 24);
    const list = beacons.flatMap((b) =>
      [false, true].map((echo) => {
        const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
        const mesh = new THREE.Mesh(sphere, material);
        mesh.count = CRESTS;
        mesh.frustumCulled = false;
        mesh.layers.set(OVERLAY_LAYER);
        return { b, echo, material, mesh };
      })
    );
    return { sphere, list };
  }, [fine]);
  useDispose(parts.sphere, ...parts.list.map((p) => p.material));

  useOverlay((sceneZ) => {
    for (const { b, echo, material } of parts.list) {
      const at = b.at as any;
      const times = b.times as any;
      const omega = times.w as any;
      const period = float(Math.PI * 2).div(omega) as any;
      const delay = echo ? (b.echo.w as any) : float(0);
      const centre = echo ? (b.echo.xyz as any) : (at.xyz as any);
      // Crest j: the j-th most recent emitted, its emission time a whole number of periods.
      const crest = () => {
        const heard = clock.sub(delay) as any;
        const te = heard.div(period).floor().sub(float(instanceIndex)).mul(period) as any;
        const radius = heard.sub(te).mul(SPEED) as any;
        const fall = at.w.div(radius.add(delay.mul(SPEED)).mul(0.3).add(1)) as any;
        const strength = emission(te, times).strength.mul(fall).mul(echo ? (b.face.w as any) : float(1)) as any;
        return { radius, strength };
      };
      const c = crest();
      // Gone once it has left the mist: a crest is not drawn at all when faint or wholly outside it.
      const shown = step(0.004, c.strength).mul(step(c.radius, length(centre).add(MIST * 0.9))) as any;
      material.positionNode = centre.add(positionGeometry.mul(c.radius.mul(shown))) as any;

      // How this crest stands against the whole field here: 1 alone, more where crests meet, nothing where a trough
      // does. The bands are broad, so it is worked out at the vertices.
      const meet = (() => {
        const d = crest();
        const at3 = centre.add(positionGeometry.mul(d.radius)) as any;
        const { s } = soundField(at3, echo);
        return varying(s.max(0).div(d.strength.add(0.02)).min(3).mul(d.strength)) as any;
      })();
      const strength = varying(crest().strength) as any;
      const p = positionWorld as any;
      const n = normalize(p.sub(centre)) as any;
      const view = normalize(cameraPosition.sub(p)) as any;
      const rim = pow(float(1).sub(abs(dot(n, view))), 4.5) as any;
      const m = meet.div(strength.add(1e-4)) as any;
      const facing = echo ? (smoothstep(-0.1, 0.5, dot(n, b.face.xyz as any)) as any) : float(1);
      const edge = float(1).sub(smoothstep(MIST * 0.35, MIST * 0.85, length(p))) as any;
      const glowing = strength.mul(rim.mul(0.85).add(0.006)).mul(m.mul(m.sqrt())).mul(facing).mul(edge).mul(echo ? 0.6 : 1) as any;
      const tint = echo ? mix(GOLD, HOT, smoothstep(1.5, 3, m)) : (mix(ICE, HOT, smoothstep(1.3, 3, m)) as any);
      material.colorNode = vec4(tint.mul(glowing).mul(step(sceneZ, positionView.z)), 1) as any;
      material.needsUpdate = true;
    }
  });
  return (
    <>
      {parts.list.map((p, k) => (
        <primitive key={k} object={p.mesh} />
      ))}
    </>
  );
}
