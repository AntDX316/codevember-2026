"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { Fn, abs, attribute, cameraFar, cameraNear, cameraPosition, cross, dot, exp, float, fract, length, max, mix, normalize, perspectiveDepthToViewZ, positionGeometry, positionView, positionWorld, screenUV, sin, smoothstep, step, varying, vec2, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { OVERLAY_LAYER, overlayLink } from "../../shared/engine/Post";
import { mulberry32 } from "../../shared/engine/random";
import { CLAP, DRIZZLE, PING_LIFE, PING_SPEED, PINGS, clapAt, echo } from "./echo";
import { GUTTER } from "./world";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Everything in the air, drawn over the garden in the overlay pass and hidden behind it by the scene's depth: the rain
// itself, the little splashes where it lands, drizzle drifting before the lens, and each clap's shell as it crosses the
// wet air.

const UP = vec3(0, 1, 0);

// Quads, one per item, each corner knowing its seed and which corner it is.
function quads(count: number, seed: number, name: string) {
  const random = mulberry32(seed);
  const seeds = new Float32Array(count * 4 * 4);
  const corners = new Float32Array(count * 4 * 2);
  const index = new Uint32Array(count * 6);
  for (let i = 0; i < count; i++) {
    const s = [random(), random(), random(), random()];
    for (let k = 0; k < 4; k++) {
      seeds.set(s, (i * 4 + k) * 4);
      corners.set([k % 2 === 0 ? -1 : 1, k < 2 ? -1 : 1], (i * 4 + k) * 2);
    }
    index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(`${name}Seed`, new THREE.BufferAttribute(seeds, 4));
  geometry.setAttribute(`${name}Corner`, new THREE.BufferAttribute(corners, 2));
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 4 * 3), 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return geometry;
}

const additive = () => new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });

// Hidden wherever the garden stands in front.
function useHidden(items: { mesh: THREE.Mesh; colour: any }[]) {
  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const scene = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
        for (const { mesh, colour } of items) {
          const material = mesh.material as THREE.MeshBasicNodeMaterial;
          material.colorNode = vec4(colour.rgb.mul(step(scene, positionView.z)), 1) as any;
          material.needsUpdate = true;
        }
      }),
    [items]
  );
}

// How bright the air is at a point: a faint glow from the rain itself, and the claps' fronts, wakes and the held clap.
const airLight = (p: any, px: any) => {
  const c = clapAt(p, UP, px);
  return { drizzle: float(1), clap: c.front.mul(2.2).add(c.wake.mul(0.012)).add(c.charge.mul(0.5)) as any };
};

// Rain: streaks falling in a box that travels with the eye, nearly invisible until a clap's front passes through them,
// which catches every drop in the shell at once. None under the porch roof.
function makeRain(count: number) {
  const geometry = quads(count, 22_31, "rain");
  const BOX = 14;
  const drop = () => {
    const seed = attribute("rainSeed", "vec4") as any;
    const corner = attribute("rainCorner", "vec2") as any;
    const speed = seed.w.mul(2).add(6.5) as any;
    const fall = vec3(0.04, -1, 0.015) as any;
    const travelled = fall.mul(echo.time.mul(speed).div(BOX)) as any;
    const wrapped = fract(seed.xyz.add(travelled).sub(cameraPosition.div(BOX))).sub(0.5).mul(BOX) as any;
    const centre = cameraPosition.add(wrapped) as any;
    const away = length(centre.sub(cameraPosition)) as any;
    return { seed, corner, centre, away, fall: normalize(fall) as any };
  };
  const material = additive();
  material.positionNode = Fn(() => {
    const { seed, corner, centre, away, fall } = drop();
    const side = normalize(cross(fall, centre.sub(cameraPosition))) as any;
    const width = max(away.mul(echo.pixel).mul(0.7), float(0.002)) as any;
    const long = seed.w.mul(0.22).add(0.18) as any;
    // Up the streak against its fall, so that side × up faces the eye and the quad is not culled.
    return centre.sub(fall.mul(corner.y.mul(long))).add(side.mul(corner.x.mul(width)));
  })();
  const look = varying(
    Fn(() => {
      const { seed, corner, centre, away } = drop();
      const width = max(away.mul(echo.pixel).mul(0.7), float(0.002)) as any;
      const { clap } = airLight(centre, away.mul(echo.pixel));
      // Under the porch roof there is no rain; under the ground none either.
      const sheltered = smoothstep(GUTTER.z - 0.1, GUTTER.z + 0.1, centre.z).mul(float(1).sub(smoothstep(2.4, 2.6, centre.y))) as any;
      const fade = smoothstep(0.6, 2.2, away).mul(float(1).sub(sheltered)).mul(smoothstep(-0.05, 0.1, centre.y)) as any;
      const bright = clap.add(0.06).mul(fade).mul(seed.x.mul(0.6).add(0.4)).mul(float(0.003).div(width).min(1)) as any;
      return vec4(corner.x, corner.y, bright, 0);
    })(),
    "vRainLook"
  );
  const colour = Fn(() => {
    const across = exp(look.x.mul(look.x).mul(-2.5));
    const along = float(1).sub(look.y.abs()).max(0);
    return vec4(DRIZZLE.mul(across.mul(along).mul(look.z)), 1);
  })();
  material.colorNode = colour;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.layers.set(OVERLAY_LAYER);
  return { mesh, colour };
}

// Splashes: where a drop lands, a fleck jumps up and falls back in a tenth of a second. A ring of slots the scene writes
// each landing into.
export const SPLASHES = 768;
function makeSplashes() {
  const geometry = quads(SPLASHES, 22_32, "splash");
  const where = new Float32Array(SPLASHES * 4 * 4).fill(-1e4);
  const attribute4 = new THREE.BufferAttribute(where, 4);
  attribute4.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("splashAt", attribute4);
  const fleck = () => {
    const seed = attribute("splashSeed", "vec4") as any;
    const corner = attribute("splashCorner", "vec2") as any;
    const at = attribute("splashAt", "vec4") as any;
    const age = echo.time.sub(at.w) as any;
    const t = age.div(0.16).clamp(0, 1) as any;
    // Out and up, then down.
    const angle = seed.x.mul(Math.PI * 2);
    const out = vec3(sin(angle), 0, sin(angle.add(Math.PI / 2))).mul(t.mul(seed.y.mul(0.05).add(0.02))) as any;
    const height = t.mul(float(1).sub(t)).mul(4).mul(seed.z.mul(0.04).add(0.015)) as any;
    const centre = at.xyz.add(out).add(vec3(0, height, 0)) as any;
    const away = length(centre.sub(cameraPosition)) as any;
    const size = max(away.mul(echo.pixel).mul(1.1), float(0.004)) as any;
    return { seed, corner, centre, away, size, t, age };
  };
  const material = additive();
  material.positionNode = Fn(() => {
    const { corner, centre, size } = fleck();
    return centre.add(echo.right.mul(corner.x.mul(size))).add(echo.up.mul(corner.y.mul(size)));
  })();
  const look = varying(
    Fn(() => {
      const { corner, size, t, age, away, seed } = fleck();
      const alive = age.greaterThan(0).select(1, 0).mul(float(1).sub(t)) as any;
      const bright = alive.mul(float(0.006).div(size).min(1)).mul(1.6).mul(exp(away.mul(-0.08))).mul(seed.w.mul(0.5).add(0.25)) as any;
      return vec4(corner.x, corner.y, bright, 0);
    })(),
    "vSplash"
  );
  const colour = Fn(() => {
    const r = length(vec2(look.x, look.y));
    return vec4(DRIZZLE.mul(float(1).sub(smoothstep(0.3, 1, r)).mul(look.z)), 1);
  })();
  material.colorNode = colour;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.layers.set(OVERLAY_LAYER);
  return { mesh, colour, where, attribute: attribute4 };
}

// Drizzle before the lens, out of focus: soft discs of mixed sizes in a box that travels with the eye, faint until a
// clap's front passes the camera and lights every one.
function makeMotes(count: number) {
  const geometry = quads(count, 22_33, "mote");
  const mote = () => {
    const seed = attribute("moteSeed", "vec4") as any;
    const corner = attribute("moteCorner", "vec2") as any;
    const drift = echo.time.mul(seed.w.mul(0.05).add(0.03));
    const across = fract(seed.x.add(drift.mul(0.15)).add(sin(echo.time.mul(0.4).add(seed.y.mul(20))).mul(0.01)))
      .sub(0.5)
      .mul(2.6);
    const up = fract(seed.y.sub(drift)).sub(0.5).mul(1.7);
    const ahead = seed.z.mul(seed.z).mul(4.5).add(0.6) as any;
    const centre = cameraPosition
      .add(echo.forward.mul(ahead))
      .add(echo.right.mul(across.mul(ahead.mul(0.62))))
      .add(echo.up.mul(up.mul(ahead.mul(0.62)))) as any;
    const size = mix(float(0.005), float(0.03), seed.w.mul(seed.w)).mul(float(1).add(float(1).div(ahead).mul(0.4))) as any;
    return { seed, corner, centre, ahead, size };
  };
  const material = additive();
  material.positionNode = Fn(() => {
    const { corner, centre, size } = mote();
    return centre.add(echo.right.mul(corner.x.mul(size))).add(echo.up.mul(corner.y.mul(size)));
  })();
  const look = varying(
    Fn(() => {
      const { corner, seed, ahead, centre } = mote();
      const glint = clapAt(centre, UP, float(0.01));
      // Caught by a clap's front, and glittering a moment in its wake.
      const clap = glint.front.mul(2.2).add(glint.wake.mul(0.5)).add(glint.charge.mul(0.5)) as any;
      const bright = clap.mul(0.12).add(0.01).mul(seed.x.mul(0.8).add(0.4)).div(ahead.mul(0.5).add(0.6)) as any;
      return vec4(corner.x, corner.y, bright, 0);
    })(),
    "vMote"
  );
  material.colorNode = Fn(() => {
    const r = length(vec2(look.x, look.y));
    const disc = float(1).sub(smoothstep(0.6, 1.0, r)).mul(abs(r).mul(0.2).add(0.8));
    return vec4(mix(DRIZZLE, CLAP, 0.5).mul(disc.mul(look.z)), 1);
  })();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.layers.set(OVERLAY_LAYER);
  return mesh;
}

// A clap's shell in the wet air: a sphere grown to the front, faint across its face and brighter where it is seen
// edge on, so it reads as a ring sweeping out through the rain.
function makeShell(k: number) {
  const geometry = new THREE.IcosahedronGeometry(1, 5);
  const material = additive();
  const ping = echo.pings[k] as any;
  // Built afresh for the position and for the varying: one node shared between the two comes out wrong.
  const grown = () => {
    const age = echo.time.sub(ping.w) as any;
    return { age, radius: age.max(0.001).mul(PING_SPEED) as any };
  };
  material.positionNode = Fn(() => ping.xyz.add(positionGeometry.mul(grown().radius)))();
  // Worked out per pixel from where the pixel lies on the sphere.
  const look = Fn(() => {
    const { age, radius } = grown();
    const p = positionWorld as any;
    const n = normalize(p.sub(ping.xyz)) as any;
    const view = normalize(cameraPosition.sub(p)) as any;
    const edgeOn = float(1).sub(abs(dot(n, view))).clamp(0, 1) as any;
    const power = echo.power[k].mul(float(1).sub(age.div(PING_LIFE * 0.6).clamp(0, 1))).div(radius.mul(0.15).add(1)) as any;
    // Not inside the eye's own head, nor below the ground.
    const near = smoothstep(1.5, 4, length(cameraPosition.sub(p))).mul(smoothstep(-0.05, 0.3, p.y)) as any;
    // Only right at the rim: even a faint fill across the face reads as a milky dome once it is in display space.
    return smoothstep(0.72, 1, edgeOn).pow(2).mul(0.16).mul(power).mul(near).mul(age.greaterThan(0).select(1, 0));
  })();
  const colour = vec4(CLAP.mul(look as any), 1) as any;
  material.colorNode = colour;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.layers.set(OVERLAY_LAYER);
  return { mesh, colour };
}

export type SplashWriter = { write: (slot: number, x: number, y: number, z: number, at: number) => void; flush: () => void };

export function Air({ drops, motes, splashes }: { drops: number; motes: number; splashes: { current: SplashWriter | null } }) {
  const rain = useMemo(() => makeRain(drops), [drops]);
  const specks = useMemo(() => makeMotes(motes), [motes]);
  const splash = useMemo(makeSplashes, []);
  const shells = useMemo(() => Array.from({ length: PINGS }, (_, k) => makeShell(k)), []);
  useDispose(rain.mesh.geometry, rain.mesh.material as THREE.Material, specks.geometry, specks.material as THREE.Material, splash.mesh.geometry, splash.mesh.material as THREE.Material, ...shells.flatMap((s) => [s.mesh.geometry, s.mesh.material as THREE.Material]));
  const hidden = useMemo(() => [rain, splash, ...shells], [rain, splash, shells]);
  useHidden(hidden);

  useEffect(() => {
    let low = SPLASHES;
    let high = -1;
    splashes.current = {
      write: (slot, x, y, z, at) => {
        for (let c = 0; c < 4; c++) splash.where.set([x, y, z, at], (slot * 4 + c) * 4);
        low = Math.min(low, slot);
        high = Math.max(high, slot);
      },
      flush: () => {
        if (high < 0) return;
        splash.attribute.clearUpdateRanges();
        splash.attribute.addUpdateRange(low * 16, (high - low + 1) * 16);
        splash.attribute.needsUpdate = true;
        low = SPLASHES;
        high = -1;
      }
    };
    return () => {
      splashes.current = null;
    };
  }, [splash, splashes]);

  return (
    <>
      <primitive object={rain.mesh} />
      <primitive object={splash.mesh} />
      <primitive object={specks} />
      {shells.map((s, k) => (
        <primitive key={k} object={s.mesh} />
      ))}
    </>
  );
}
