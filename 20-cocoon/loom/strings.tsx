"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { Fn, abs, attribute, cameraPosition, clamp, cos, cross, dot, float, fract, length, max, mix, normalize, positionGeometry, positionWorld, pow, sin, uniform, varying, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { MODES, type Loom } from "./sim";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Where the two lights the strings glint in come from: the key over the right shoulder, and a cool rim from behind.
export const KEY_FROM = new THREE.Vector3(2.6, 6, 3.2);
const RIM_FROM = new THREE.Vector3(-3, 2.2, -4);

export const COLOURS = {
  moonlight: { string: "#b8cdf2", floor: "#6f86b8" },
  gold: { string: "#ffc163", floor: "#b8853a" },
  neon: { string: "#d6c4ff", floor: "#8a6fd0" }
} as const;
export type ColourName = keyof typeof COLOURS;

export type StringLook = { colour: THREE.Color; neon: { value: number } };

// Every span is one strip of many short steps turned to face the eye, bent each frame on the GPU by its modes: so a
// plucked string shows its standing wave, the belly swinging and the ends held. The strip is never drawn thinner than
// about a pixel, and is dimmed by however much it had to be widened, so far strings stay fine. Light is added over what
// is behind, but the strip still writes depth so that the lens blur knows how far away it is.
export function Strings({ loom, steps, look }: { loom: Loom; steps: number; look: StringLook }) {
  const size = useThree((state) => state.size);
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;

  const { material, pixel, tint, neon } = useMemo(() => {
    const pixel = uniform(0.001);
    const width = uniform(0.0034);
    const tint = uniform(new THREE.Color());
    const neon = uniform(0);
    const key = vec3(KEY_FROM.clone().normalize());
    const rim = vec3(RIM_FROM.clone().normalize());

    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: true, blending: THREE.AdditiveBlending });
    // Built afresh for each use: a node handed to varying() is read back from the varying wherever else it appears.
    const bend = () => {
      const from = attribute("aFrom", "vec4") as any;
      const to = attribute("aTo", "vec4") as any;
      const ma = attribute("aModeA", "vec4") as any;
      const mb = attribute("aModeB", "vec4") as any;
      const mc = attribute("aModeC", "vec4") as any;
      const modes = [vec3(ma.x, ma.y, ma.z), vec3(ma.w, mb.x, mb.y), vec3(mb.z, mb.w, mc.x), vec3(mc.y, mc.z, mc.w)] as any[];
      const s = positionGeometry.x as any;
      const e = to.xyz.sub(from.xyz) as any;
      let centre = from.xyz.add(e.mul(s)) as any;
      let tangent = e as any;
      modes.slice(0, MODES).forEach((m, i) => {
        const k = Math.PI * (i + 1);
        centre = centre.add(m.mul(sin(s.mul(k))));
        tangent = tangent.add(m.mul(cos(s.mul(k)).mul(k)));
      });
      const glow = from.w as any;
      const wanted = width.mul(glow.mul(0.45).add(1)) as any;
      const drawn = max(wanted, length(cameraPosition.sub(centre)).mul(pixel).mul(1.25)) as any;
      // Across the string and square to the line from the eye: the strip faces whichever camera draws it, the mirror's too.
      const side = normalize(cross(tangent, cameraPosition.sub(centre)).add(vec3(1e-7, 0, 0))) as any;
      return { centre, tangent, side, drawn, wanted, glow, hue: to.w as any };
    };
    const placed = bend();
    material.positionNode = placed.centre.add(placed.side.mul(positionGeometry.y.mul(placed.drawn).mul(0.5))) as any;
    const passed = bend();
    const tangent = varying(passed.tangent) as any;
    const coverage = varying(passed.wanted.div(passed.drawn)) as any;
    const glow = varying(passed.glow) as any;
    const hue = varying(passed.hue) as any;
    const across = varying(positionGeometry.y.mul(1)) as any;

    material.colorNode = Fn(() => {
      const T = normalize(tangent) as any;
      const V = normalize(cameraPosition.sub(positionWorld)) as any;
      // A thin round wire shows a highlight wherever it runs square to the half-way between eye and light: a fine
      // glint that slides along the strings as they turn.
      const glint = (L: any, sharp: number) => {
        const th = dot(T, normalize(L.add(V))) as any;
        return pow(max(th.mul(th).oneMinus(), 0), sharp) as any;
      };
      const shine = glint(key, 90).mul(1.1).add(glint(rim, 40).mul(0.5)) as any;
      // Spectrum: each string's hue follows its note, low red through to violet.
      const spectrum = clamp(abs(fract(vec3(hue.mul(0.82)).add(vec3(0, 2 / 3, 1 / 3))).mul(6).sub(3)).sub(1), 0, 1) as any;
      const base = mix(tint, spectrum.mul(spectrum).mul(0.9).add(0.04), neon) as any;
      const lit = base.mul(glow.mul(1.6).add(0.3)).add(mix(vec3(1, 1, 1), base, 0.35).mul(shine).mul(glow.mul(0.8).add(0.55))) as any;
      // Round in section: brightest down the middle of the strip.
      const round = across.abs().oneMinus().max(0).sqrt() as any;
      return vec4(lit.mul(coverage).mul(round).mul(float(1.15)), 1);
    })() as any;

    // The colour and neon are copied into these each frame, so changing them builds no shader.
    return { material, pixel, tint, neon };
  }, []);
  useDispose(material);

  const { mesh, from, to, modeA, modeB, modeC } = useMemo(() => {
    const geometry = new THREE.InstancedBufferGeometry();
    const position: number[] = [];
    const index: number[] = [];
    for (let k = 0; k <= steps; k++) {
      position.push(k / steps, -1, 0, k / steps, 1, 0);
      if (k < steps) index.push(k * 2, k * 2 + 1, k * 2 + 3, k * 2, k * 2 + 3, k * 2 + 2);
    }
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    geometry.setIndex(index);
    const n = loom.spans;
    const make = (name: string) => {
      const attribute = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
      geometry.setAttribute(name, attribute);
      return attribute;
    };
    const from = make("aFrom");
    const to = make("aTo");
    const modeA = make("aModeA");
    const modeB = make("aModeB");
    const modeC = make("aModeC");
    geometry.instanceCount = n;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    return { mesh, from, to, modeA, modeB, modeC };
  }, [loom, steps, material]);
  useDispose(mesh.geometry);

  useFrame(() => {
    tint.value.copy(look.colour);
    neon.value = look.neon.value;
    pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.max(1, size.height);
    const f = from.array as Float32Array;
    const t = to.array as Float32Array;
    // The twelve numbers of the four modes' world swings, run on through the three attributes.
    const packs = [modeA.array as Float32Array, modeB.array as Float32Array, modeC.array as Float32Array];
    const { ends, axes, modes, glow, hue } = loom;
    for (let s = 0; s < loom.spans; s++) {
      const o = s * 6;
      const k = s * 4;
      f[k] = ends[o];
      f[k + 1] = ends[o + 1];
      f[k + 2] = ends[o + 2];
      f[k + 3] = glow[s];
      t[k] = ends[o + 3];
      t[k + 1] = ends[o + 4];
      t[k + 2] = ends[o + 5];
      t[k + 3] = hue[s];
      for (let n = 0; n < MODES; n++) {
        const m = (s * MODES + n) * 4;
        const u = modes[m];
        const w = modes[m + 2];
        for (let c = 0; c < 3; c++) {
          const slot = n * 3 + c;
          packs[slot >> 2][k + (slot & 3)] = u * axes[o + c] + w * axes[o + 3 + c];
        }
      }
    }
    from.needsUpdate = true;
    to.needsUpdate = true;
    modeA.needsUpdate = true;
    modeB.needsUpdate = true;
    modeC.needsUpdate = true;
  });

  return <primitive object={mesh} />;
}
