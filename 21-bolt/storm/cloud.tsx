"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  floor,
  fract,
  length,
  max,
  min,
  mix,
  normalize,
  positionWorld,
  pow,
  reflect,
  screenCoordinate,
  screenUV,
  select,
  sin,
  smoothstep,
  texture,
  texture3D,
  uniform,
  uv,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { useQuality } from "../../shared/engine/quality";
import { BASE, BOX, storm } from "./state";
import type { StormVolume } from "./volume";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The cloud, the rain under it, the mist on the water and the sea's reflection of all three, raymarched at half
// resolution into a buffer of its own. Each step reads the baked cloud (density and its lighting) in one tap, wears its
// edges with finer noise that drifts upward, and lights it by the moon behind it (several scattering orders, so the
// rim silvers and the inside still glows) and by every flash: in-cloud flashes as light spreading through the cloud,
// the channel to the sea as a glowing line that lights the base from below. A ray that reaches the sea bounces off a
// gently rippled mirror and is marched again. A dome round the eye draws the stars and the moon at full resolution
// behind it all, and lays the buffer over them.

// In-cloud light: white-lavender near the channel, deepening to violet as it spreads through the cloud.
const FLASH = new THREE.Color("#f0e8ff");
const FLASH_FAR = new THREE.Color("#9c86ff");
const BOLT = new THREE.Color("#e6e4ff");
const MOONLIGHT = new THREE.Color("#9fb4dc").multiplyScalar(0.22);
const AMBIENT = new THREE.Color("#04060c");
const ZENITH = new THREE.Color("#010205");
const HORIZON = new THREE.Color("#0a0e1a");
// Units of extinction per unit of cloud density per world unit: firm billows, under half a unit deep.
const SIGMA = 2.4;

export function StormCloud({ volume }: { volume: StormVolume }) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const { tier } = useQuality();
  const steps = tier === "low" ? 44 : tier === "medium" ? 72 : 96;
  const bounceSteps = tier === "low" ? 24 : tier === "medium" ? 40 : 52;
  const dome = useRef<THREE.Mesh>(null);

  const pass = useMemo(() => {
    const make = () => new THREE.RenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false });
    // This frame's march, and two histories that take turns being read and written.
    const target = make();
    const history = [make(), make()];
    const view = {
      inverseView: uniform(new THREE.Matrix4()),
      inverseProjection: uniform(new THREE.Matrix4()),
      previous: uniform(new THREE.Matrix4()),
      eye: uniform(new THREE.Vector3()),
      frame: uniform(0),
      blend: uniform(1),
      texel: uniform(new THREE.Vector2(0.5, 0.5))
    };
    return { target, history, view, size: new THREE.Vector2(), count: 0 };
  }, []);

  const material = useMemo(() => {
    const { view } = pass;
    const boxMin = vec3(BOX.min.x, BOX.min.y, BOX.min.z);
    const boxMax = vec3(BOX.max.x, BOX.max.y, BOX.max.z);
    const boxInv = vec3(1 / (BOX.max.x - BOX.min.x), 1 / (BOX.max.y - BOX.min.y), 1 / (BOX.max.z - BOX.min.z));
    const flashColour = vec3(FLASH.r, FLASH.g, FLASH.b);
    const flashFar = vec3(FLASH_FAR.r, FLASH_FAR.g, FLASH_FAR.b);
    const boltColour = vec3(BOLT.r, BOLT.g, BOLT.b);
    const moonColour = vec3(MOONLIGHT.r, MOONLIGHT.g, MOONLIGHT.b);
    const ambientColour = vec3(AMBIENT.r, AMBIENT.g, AMBIENT.b);

    // Where a ray enters and leaves the box: [enter, leave], with leave < enter for a miss.
    const span = (o: any, d: any) => {
      const safe = vec3(select(abs(d.x).lessThan(1e-5), float(1e-5), d.x), select(abs(d.y).lessThan(1e-5), float(1e-5), d.y), select(abs(d.z).lessThan(1e-5), float(1e-5), d.z));
      const a = boxMin.sub(o).div(safe) as any;
      const b = boxMax.sub(o).div(safe) as any;
      const lo = min(a, b) as any;
      const hi = max(a, b) as any;
      return { enter: max(max(max(lo.x, lo.y), lo.z), 0) as any, leave: min(min(hi.x, hi.y), hi.z) as any };
    };

    // Henyey–Greenstein, scaled so that light scattered evenly reads 1.
    const hg = (g: number, c: any) => float(1 - g * g).div(pow(float(1 + g * g).sub(c.mul(2 * g)), 1.5));

    // Light arriving at a point from every flash and the channel, for a point whose light from below gets `under` of
    // the way through the cloud.
    const flashes = (p: any, under: any) => {
      let near: any = float(0);
      let far: any = float(0);
      for (const ic of storm.ic) {
        const d = length(p.sub(ic.xyz)) as any;
        near = near.add(ic.w.mul(exp(d.mul(-0.6))));
        far = far.add(ic.w.mul(exp(d.mul(-0.32))));
      }
      const glow = flashColour.mul(near.mul(2.4)).add(flashFar.mul(far.mul(0.14)));
      // Distance to the channel, from where it leaves the cloud to its tip.
      const ab = storm.tip.xyz.sub(storm.top.xyz) as any;
      const h = clamp(dot(p.sub(storm.top.xyz), ab).div(dot(ab, ab).max(1e-4)), 0, 1);
      const ds = length(p.sub(storm.top.xyz).sub(ab.mul(h))) as any;
      const line = float(1)
        .div(ds.mul(ds).mul(2.2).add(1))
        .mul(1.3)
        .add(exp(ds.mul(-0.32)).mul(0.22)) as any;
      const strike = boltColour.mul(line.mul(storm.top.w.add(storm.tip.w)).mul(pow(under, 0.5)));
      return glow.add(strike);
    };

    // March one ray from enter to leave, adding what it sees into light and dimming through.
    const march = (o: any, d: any, enter: any, leave: any, count: number, jitter: any, light: any, through: any) => {
      const length_ = leave.sub(enter).max(0);
      const dt = length_.div(count).max(0.09).toVar();
      const t = enter.add(dt.mul(jitter)).toVar();
      const cosine = dot(d, storm.moon);
      const phaseA = hg(0.65, cosine).toVar();
      const phaseB = hg(0.3, cosine).toVar();
      const phaseC = hg(-0.05, cosine).toVar();
      Loop(count, () => {
        If(t.greaterThan(leave).or(through.lessThan(0.008)), () => {
          Break();
        });
        const p = o.add(d.mul(t)).toVar();
        const cell = texture3D(volume.cloud, p.sub(boxMin).mul(boxInv), 0).toVar();
        const dense = cell.r.toVar();
        // The edges, worn by finer cells that rise slowly, as if the cloud were still boiling up.
        If(dense.greaterThan(0.01), () => {
          const q = p.mul(0.23).add(vec3(0.0, storm.time.mul(-0.016), storm.time.mul(0.005)));
          const fine = texture3D(volume.noise, q, 0).g;
          const worn = dense.sub(float(1).sub(fine).mul(float(1).sub(dense).mul(0.75).add(0.25)).mul(0.62));
          dense.assign(smoothstep(0.0, 0.42, worn));
        });
        // Rain: a curtain under the base, streaked by stretched noise falling through it, slanting downwind.
        const rain = float(0).toVar();
        If(p.y.lessThan(BASE + 0.8), () => {
          const fallen = float(BASE).sub(p.y).max(0);
          const slant = p.x.sub(storm.rain.x).sub(fallen.mul(0.12));
          const across = length(vec2(slant, p.z.sub(storm.rain.y))) as any;
          // The curtain spreads as it falls, its edge ragged.
          const ragged = texture3D(volume.noise, vec3(slant.mul(0.2), p.y.mul(0.05), p.z.mul(0.2)), 0).a;
          const reach = storm.rain.z.mul(fallen.mul(0.09).add(1)).mul(ragged.mul(0.6).add(0.7));
          const curtain = float(1).sub(smoothstep(reach.mul(0.2), reach, across));
          const streak = texture3D(volume.noise, vec3(slant.mul(0.42), p.y.mul(0.035).add(storm.time.mul(0.32)), p.z.mul(0.42)), 0).b;
          const top = float(1).sub(smoothstep(BASE - 1.4, BASE + 0.2, p.y));
          rain.assign(curtain.mul(streak.mul(streak).mul(1.5).add(0.25)).mul(top).mul(storm.rain.w).mul(0.11));
        });
        // Mist lying on the water, thinning out far from the cloud.
        const mist = exp(p.y.mul(-2.4))
          .mul(float(1).sub(smoothstep(8, 15, length(p.xz))))
          .mul(0.06);
        const sigma = dense.mul(SIGMA).add(rain).add(mist).toVar();
        If(sigma.greaterThan(0.0005), () => {
          const moonT = cell.g;
          const open = cell.a;
          // Several scattering orders: each deeper, softer and less forward than the last, so light still gets into
          // the cloud's body and the rim facing the moon blazes.
          const moon = moonColour.mul(
            phaseA
              .mul(moonT)
              .add(phaseB.mul(pow(moonT, 0.3)).mul(0.07))
              .add(phaseC.mul(pow(moonT, 0.1)).mul(0.025))
          );
          const height = clamp(p.y.sub(BASE).div(12), 0, 1);
          // Less of the moon low down, or the thin skirt under the base glows as a bright line.
          const moonLow = moon.mul(height.mul(0.7).add(0.3));
          const ambient = ambientColour.mul(open.mul(0.75).add(0.25)).mul(height.mul(0.6).add(0.5));
          const lit = moonLow.add(ambient).add(flashes(p, cell.b));
          const fade = exp(sigma.mul(dt).negate());
          light.addAssign(lit.mul(through).mul(float(1).sub(fade)));
          through.mulAssign(fade);
        });
        t.addAssign(dt);
      });
    };

    // No blending, so the alpha (what of the sky still shows through) is written as it is: an opaque material would set it to 1.
    const m = new THREE.MeshBasicNodeMaterial({ depthWrite: false, depthTest: false, blending: THREE.NoBlending });
    m.colorNode = Fn(() => {
      // This pixel's ray. The buffer's rows run top down, so its v is flipped against clip space.
      const ndc = vec2(uv().x, float(1).sub(uv().y)).mul(2).sub(1) as any;
      const far = view.inverseProjection.mul(vec4(ndc.x, ndc.y, 1, 1)) as any;
      const d = normalize(view.inverseView.mul(vec4(far.xyz.div(far.w), 0)).xyz).toVar() as any;
      const o = view.eye;
      // Interleaved gradient noise, moved on by the golden ratio each frame, for where each pixel starts stepping: the
      // history below averages the speckle away.
      const jitter = fract(
        fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715)))
          .mul(52.9829189)
          .add(view.frame.mul(0.618034))
      );
      const light = vec3(0).toVar();
      const through = float(1).toVar();
      const box = span(o, d);
      // Where the ray meets the sea, if it does.
      const sea = select(d.y.lessThan(-1e-4), o.y.negate().div(d.y), float(1e6)).toVar();
      march(o, d, box.enter, min(box.leave, sea), steps, jitter, light, through);
      const alpha = through.toVar();
      If(sea.lessThan(1e5), () => {
        const s = o.add(d.mul(sea)).toVar();
        // A sea as still as glass, faintly swelling, roughened where the rain falls on it.
        const fromRain = length(s.xz.sub(storm.rain.xy)) as any;
        const roughness = float(1)
          .sub(smoothstep(storm.rain.z.mul(0.4), storm.rain.z.mul(1.3), fromRain))
          .mul(storm.rain.w.min(1.5))
          .mul(0.16)
          .add(0.018);
        const ripple = texture3D(volume.noise, vec3(s.x.mul(0.31), s.z.mul(0.31), storm.time.mul(0.05)), 0).ba.sub(0.5) as any;
        const fine = texture3D(volume.noise, vec3(s.x.mul(1.7), s.z.mul(1.7), storm.time.mul(0.6)), 0).ba.sub(0.5) as any;
        const n = normalize(
          vec3(ripple.x.mul(0.4).add(fine.x.mul(roughness.mul(4))), 1, ripple.y.mul(0.4).add(fine.y.mul(roughness.mul(4)))).mul(vec3(roughness.mul(1.5), 1, roughness.mul(1.5)))
        ) as any;
        const r = reflect(d, n).toVar() as any;
        r.y.assign(r.y.abs().max(0.002));
        const facing = clamp(dot(d.negate(), n), 0, 1);
        const fresnel = float(0.02)
          .add(pow(float(1).sub(facing), 5).mul(0.98))
          .mul(1.5)
          .add(0.05)
          .min(0.72);
        const back = vec3(0).toVar();
        const kept = float(1).toVar();
        const bounce = span(s, r);
        march(s, r, bounce.enter, bounce.leave, bounceSteps, jitter, back, kept);
        // The strike's own light on the water round where it lands.
        const toTip = length(s.xz.sub(storm.tip.xz)) as any;
        const pool = boltColour.mul(storm.top.w.add(storm.tip.w.mul(0.5)).mul(float(0.6).div(toTip.mul(toTip).mul(1.2).add(1))));
        light.addAssign(through.mul(back.mul(fresnel).add(pool.mul(float(1).sub(fresnel)))));
        // The sky in the water shows only where the reflected cloud leaves it.
        alpha.assign(through.mul(mix(float(1), kept, fresnel.min(1))));
      });
      return vec4(light, alpha);
    })();
    const quad = new THREE.QuadMesh(m);

    // The history: last frame's result, found where this pixel's ray was then (taken at the cloud's distance), held
    // within the range of this frame's neighbours, so a flash shows at once and only the speckle is averaged.
    const resolve = new THREE.MeshBasicNodeMaterial({ depthWrite: false, depthTest: false, blending: THREE.NoBlending });
    const raw = texture(pass.target.texture);
    const past = texture(pass.history[0].texture);
    resolve.colorNode = Fn(() => {
      const at = uv();
      const now = raw.sample(at).toVar();
      const low = now.toVar();
      const high = now.toVar();
      for (const [x, y] of [
        [-1, -1],
        [0, -1],
        [1, -1],
        [-1, 0],
        [1, 0],
        [-1, 1],
        [0, 1],
        [1, 1]
      ]) {
        const n = raw.sample(at.add(vec2(x, y).mul(view.texel)));
        low.assign(min(low, n));
        high.assign(max(high, n));
      }
      const ndc = vec2(at.x, float(1).sub(at.y)).mul(2).sub(1) as any;
      const far = view.inverseProjection.mul(vec4(ndc.x, ndc.y, 1, 1)) as any;
      const d = normalize(view.inverseView.mul(vec4(far.xyz.div(far.w), 0)).xyz) as any;
      const reach = length(vec3(1, 9, 0).sub(view.eye));
      const clip = view.previous.mul(vec4(view.eye.add(d.mul(reach)), 1)) as any;
      const ahead = clip.xy.div(clip.w).mul(0.5).add(0.5) as any;
      const back = vec2(ahead.x, float(1).sub(ahead.y)) as any;
      const inside = back.x.greaterThan(0).and(back.x.lessThan(1)).and(back.y.greaterThan(0)).and(back.y.lessThan(1)).and(clip.w.greaterThan(0));
      const held = clamp(past.sample(back), low, high);
      return mix(held, now, select(inside, view.blend, float(1)));
    })();
    const resolveQuad = new THREE.QuadMesh(resolve);

    // The dome: stars and the moon at full resolution, mirrored in the sea, with the buffer laid over them.
    const domeMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const cloudTexture = texture(pass.history[1].texture, screenUV);
    const hash = (v: any) => fract(sin(dot(v, vec3(127.1, 311.7, 74.7))).mul(43758.5453));
    const skyAt = (dir: any) => {
      const up = dir.y.max(0) as any;
      const base = mix(vec3(HORIZON.r, HORIZON.g, HORIZON.b), vec3(ZENITH.r, ZENITH.g, ZENITH.b), pow(up, 0.45)) as any;
      // Stars: one at most to a cell of a grid laid over directions, few and faint.
      const g = dir.mul(150) as any;
      const cell = floor(g);
      const seed = hash(cell);
      const spot = cell.add(0.5).add(
        vec3(hash(cell.add(17.0)), hash(cell.add(31.0)), hash(cell.add(57.0)))
          .sub(0.5)
          .mul(0.6)
      );
      const star = float(1)
        .sub(smoothstep(0.0, 0.3, length(g.sub(spot))))
        .mul(smoothstep(0.986, 1.0, seed))
        .mul(hash(cell.add(5.0)).mul(1.4).add(0.2));
      const stars = vec3(0.75, 0.82, 1.0).mul(star.mul(smoothstep(0.02, 0.2, up)));
      // The moon, small and sharp, with a faint ring of glow.
      const c = dot(dir, storm.moon) as any;
      const disc = smoothstep(0.99993, 0.99996, c).mul(2.6);
      const halo = pow(c.max(0), 900)
        .mul(0.35)
        .add(pow(c.max(0), 60).mul(0.035));
      const moon = vec3(0.86, 0.9, 1.0).mul(disc.add(halo));
      // Air lit faintly by the flashes, brightest round the cloud.
      const toCloud = normalize(vec3(1, 10, 0).sub(cameraPosition));
      const near = pow(dot(dir, toCloud).max(0), 6);
      const air = flashColour.mul(storm.flash.mul(near.mul(0.006).add(0.0003)));
      // A faint pale band along the horizon, so the edge of the sea shows against the sky.
      const band = vec3(0.016, 0.02, 0.032).mul(exp(up.mul(-45)));
      return base.add(band).add(stars).add(moon).add(air);
    };
    domeMaterial.colorNode = Fn(() => {
      const dir = normalize(positionWorld.sub(cameraPosition)).toVar() as any;
      const sky = vec3(0).toVar();
      If(dir.y.greaterThanEqual(0), () => {
        sky.assign(skyAt(dir));
      }).Else(() => {
        // The sky mirrored in the still water, weaker where the water looks down into itself.
        const mirrored = vec3(dir.x, dir.y.negate(), dir.z);
        const facing = dir.y.negate();
        const fresnel = float(0.02)
          .add(pow(float(1).sub(facing), 5).mul(0.98))
          .mul(1.5)
          .add(0.05)
          .min(0.72);
        sky.assign(skyAt(mirrored).mul(fresnel));
      });
      const over = cloudTexture as any;
      return vec4(over.rgb.add(sky.mul(over.a)), 1);
    })();
    return { m, quad, resolve, resolveQuad, past, domeMaterial, cloudTexture };
  }, [pass, volume, steps, bounceSteps]);

  useDispose(material.m, material.resolve, material.domeMaterial, pass.target, ...pass.history);

  // After the hover has placed the eye (0.5), before the frame is drawn (1).
  useFrame(() => {
    dome.current?.position.copy(camera.position);
    gl.getDrawingBufferSize(pass.size);
    const w = Math.max(2, Math.floor(pass.size.x / 2));
    const h = Math.max(2, Math.floor(pass.size.y / 2));
    const resized = pass.target.width !== w || pass.target.height !== h;
    if (resized) [pass.target, ...pass.history].forEach((t) => t.setSize(w, h));
    camera.updateMatrixWorld();
    const { view } = pass;
    view.inverseView.value.copy(camera.matrixWorld);
    view.inverseProjection.value.copy(camera.projectionMatrixInverse);
    view.eye.value.copy(camera.position);
    view.texel.value.set(1 / w, 1 / h);
    view.frame.value = pass.count % 64;
    view.blend.value = resized || pass.count === 0 ? 1 : 0.2;
    const read = pass.history[pass.count % 2];
    const write = pass.history[(pass.count + 1) % 2];
    material.past.value = read.texture;
    material.cloudTexture.value = write.texture;
    const before = gl.getRenderTarget();
    gl.setRenderTarget(pass.target);
    material.quad.render(gl);
    gl.setRenderTarget(write);
    material.resolveQuad.render(gl);
    gl.setRenderTarget(before);
    view.previous.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    pass.count++;
  }, 0.75);

  return (
    <mesh ref={dome} material={material.domeMaterial} renderOrder={-10} frustumCulled={false} raycast={() => null}>
      <sphereGeometry args={[100, 64, 32]} />
    </mesh>
  );
}
