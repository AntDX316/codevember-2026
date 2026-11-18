"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { attribute, cameraFar, cameraNear, cameraPosition, color, cross, exp, float, fract, Fn, max, min, mix, mx_noise_float, normalize, perspectiveDepthToViewZ, positionGeometry, positionView, positionWorld, screenUV, sin, smoothstep, step, time, uniform, uv, vec3, vec4 } from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { focusDistance, OVERLAY_LAYER, overlayLink } from "../shared/engine/Post";
import { lehmer } from "../shared/engine/random";
import { ROOM } from "./studio";
import { SUN, WINDOWS } from "./studios";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The light through the gallery's windows, as seen in the air: a beam from each window, the window's shape swept along
// the way the sun shines in, and dust drifting through the room that glints where it crosses one.
//
// Each beam is a slanted box. For every pixel of it the shader finds how far the eye's line runs through the box, cut
// short where the scene's depth says something stands in the way, and lights it by that length: so a beam is brightest
// seen along its length, soft at its sides (where the line through it shrinks to nothing), fades as it leaves the
// window, ends on the floor and on whatever it falls on, and shows the window bars as soft gaps. Both are drawn in the
// overlay pass, added over the finished frame, and hidden by the scene's depth rather than tested against it.

const SUN_COLOUR = new THREE.Color("#fff0d8");
const LONG = 9;

// The beams: for each window the corner it starts from and the map from the room into its box, where the window spans
// 0 to 1 across (u) and up (v) and the beam runs 0 to 1 along its length (w).
function beams() {
  const down = new THREE.Vector3(...SUN).negate().normalize();
  return WINDOWS.openings.map(([centre, width]) => {
    const corner = new THREE.Vector3(-ROOM.width / 2, WINDOWS.sill, centre - width / 2);
    const across = new THREE.Vector3(0, 0, width);
    const up = new THREE.Vector3(0, WINDOWS.head - WINDOWS.sill, 0);
    const along = down.clone().multiplyScalar(LONG);
    const toBox = new THREE.Matrix4().makeBasis(across, up, along).setPosition(corner);
    return { corner, toBox, fromBox: toBox.clone().invert() };
  });
}

// Where a point is in a beam's box: u, v and w.
const inBox = (fromBox: any, p: any) => fromBox.mul(vec4(p, 1)).xyz as any;

export function WindowLight({ dust }: { dust: number }) {
  const parts = useMemo(() => {
    const list = beams();
    const fromBoxes = list.map((b) => uniform(b.fromBox));
    // One box mesh a beam, the unit cube carried into the room.
    const geometries: THREE.BufferGeometry[] = [];
    const beamMaterials = list.map(() => new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.BackSide, blending: THREE.AdditiveBlending }));
    const meshes = list.map((b, n) => {
      const g = new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5).applyMatrix4(b.toBox);
      geometries.push(g);
      const mesh = new THREE.Mesh(g, beamMaterials[n]);
      mesh.layers.set(OVERLAY_LAYER);
      mesh.frustumCulled = false;
      return mesh;
    });

    // The dust: specks in a box over the room's left half, where the light comes in, each wandering slowly and sinking.
    const random = lehmer(9187);
    const seeds = new Float32Array(dust * 4);
    for (let i = 0; i < dust; i++) seeds.set([random(), random(), random(), random()], i * 4);
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    geometries.push(quad);
    const dustMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const specks = new THREE.InstancedMesh(quad, dustMaterial, dust);
    const identity = new THREE.Matrix4();
    for (let i = 0; i < dust; i++) specks.setMatrixAt(i, identity);
    specks.frustumCulled = false;
    specks.layers.set(OVERLAY_LAYER);
    return { list, fromBoxes, meshes, beamMaterials, dustMaterial, specks, geometries };
  }, [dust]);
  useDispose(...parts.geometries, ...parts.beamMaterials, parts.dustMaterial);

  // The shaders need the scene's depth, which the overlay pass hands over once it is built.
  useEffect(
    () =>
      overlayLink.listen((depth) => {
        const sceneZ = perspectiveDepthToViewZ(depth.sample(screenUV).r, cameraNear, cameraFar) as any;
        const t = time as any;

        parts.beamMaterials.forEach((material, n) => {
          const fromBox = parts.fromBoxes[n] as any;
          material.colorNode = Fn(() => {
            const dir = normalize(positionWorld.sub(cameraPosition)) as any;
            const o = inBox(fromBox, cameraPosition) as any;
            const d = fromBox.mul(vec4(dir, 0)).xyz as any;
            const safe = d.sign().mul(d.abs().max(1e-5)) as any;
            const t0 = o.negate().div(safe) as any;
            const t1 = float(1).sub(o).div(safe) as any;
            const near = min(t0, t1) as any;
            const far = max(t0, t1) as any;
            // Along the eye's line: into the box, out of it, or where the scene stops it, whichever comes first.
            const into = max(max(near.x, near.y), max(near.z, 0)) as any;
            const stop = sceneZ.div(normalize(positionView).z) as any;
            const out = min(min(far.x, far.y), min(far.z, stop)) as any;
            const length = max(out.sub(into), 0) as any;
            const mid = o.add(d.mul(into.add(out).mul(0.5))) as any;
            // Soft at the window's edges, dimmer as it leaves the window, gaps where the glazing bars are.
            const edges = smoothstep(0, 0.08, mid.x).mul(float(1).sub(smoothstep(0.92, 1, mid.x))).mul(smoothstep(0, 0.05, mid.y)).mul(float(1).sub(smoothstep(0.95, 1, mid.y))) as any;
            const leaving = exp(mid.z.mul(-2.2)).mul(smoothstep(0, 0.04, mid.z)) as any;
            const barU = fract(mid.x.mul(WINDOWS.cols)) as any;
            const barV = fract(mid.y.mul(WINDOWS.rows)) as any;
            const bars = smoothstep(0.0, 0.035, min(barU, float(1).sub(barU))).mul(smoothstep(0.0, 0.045, min(barV, float(1).sub(barV)))) as any;
            // Motes in the air make it stir a little.
            const atWorld = cameraPosition.add(dir.mul(into.add(out).mul(0.5))) as any;
            const stir = mx_noise_float(atWorld.mul(1.6).add(vec3(t.mul(0.05), t.mul(-0.03), 0))).mul(0.25).add(0.9) as any;
            const glow = length.mul(edges).mul(leaving).mul(bars.mul(0.7).add(0.3)).mul(stir).mul(0.2) as any;
            return vec4(color(SUN_COLOUR).mul(glow), 1);
          })() as any;
          material.needsUpdate = true;
        });

        // Dust: each speck wanders on its own slow path and sinks, wrapped in the box; drawn as a soft dot facing the
        // eye, faint in shade and glinting in a beam. Most are fine motes, a few larger flecks. Drawn over the finished
        // frame, past its lens blur, so each is blurred here as a lens would: by how far it lies from the focus it
        // grows into a soft disc with a faint rim (bokeh), its light spread over its size, so motes near the lens float
        // past as big soft blooms and those at the focus stay sharp points.
        const s = attribute("aSeed", "vec4") as any;
        const lo = vec3(-ROOM.width / 2 + 0.1, 0.05, -ROOM.depth / 2 + 0.2) as any;
        const size = vec3(6.9, 3.1, ROOM.depth - 0.4) as any;
        const drift = vec3(sin(t.mul(0.07).add(s.w.mul(40))).mul(0.12), t.mul(-0.006).mul(s.w.add(0.5)), sin(t.mul(0.05).add(s.x.mul(31))).mul(0.12)) as any;
        // About one in seven keeps to a small box round the eye instead, so there is always air close to the lens,
        // drifting past as big soft blooms, wherever the view turns.
        const close = step(s.w, 0.15) as any;
        const roomPlace = lo.add(fract(s.xyz.add(drift.div(size))).mul(size)) as any;
        const nearPlace = cameraPosition.add(fract(s.xyz.add(drift.div(2.4)).sub(cameraPosition.div(2.4))).sub(0.5).mul(2.4)) as any;
        const centre = mix(roomPlace, nearPlace, close) as any;
        const toEye = normalize(cameraPosition.sub(centre)) as any;
        const right = normalize(cross(vec3(0, 1, 0), toEye)) as any;
        const up = cross(toEye, right) as any;
        const away = cameraPosition.sub(centre).length() as any;
        const fleck = step(s.w, 0.3).mul(1.6).add(1) as any;
        const sharp = max(float(0.0026), away.mul(0.0012)).mul(fleck) as any;
        const blur = away.sub(focusDistance).abs().div(away).mul(0.05) as any;
        const radius = sharp.add(blur) as any;
        // Its light spread over the larger disc, but never so thin that a near one vanishes.
        const spread = sharp.div(radius).pow(2).max(0.05) as any;
        const soft = smoothstep(0.004, 0.03, blur) as any;
        parts.dustMaterial.positionNode = centre.add(right.mul(positionGeometry.x.mul(radius.mul(2)))).add(up.mul(positionGeometry.y.mul(radius.mul(2)))) as any;
        let lit: any = float(0);
        for (const fromBox of parts.fromBoxes) {
          const p = inBox(fromBox as any, centre) as any;
          const inside = smoothstep(0, 0.05, p.x).mul(float(1).sub(smoothstep(0.95, 1, p.x))).mul(smoothstep(0, 0.04, p.y)).mul(float(1).sub(smoothstep(0.96, 1, p.y))).mul(step(0, p.z)).mul(exp(p.z.mul(-1.6))) as any;
          lit = lit.add(inside);
        }
        const twinkle = sin(t.mul(s.y.mul(2).add(0.6)).add(s.z.mul(50))).mul(0.3).add(0.7) as any;
        const r = uv().sub(0.5).length() as any;
        const point = float(1).sub(smoothstep(0.15, 0.5, r)) as any;
        const disc = float(1).sub(smoothstep(0.4, 0.5, r)).mul(0.75).add(smoothstep(0.3, 0.46, r).mul(float(1).sub(smoothstep(0.46, 0.5, r))).mul(0.4)) as any;
        const dot = mix(point, disc, soft).mul(spread) as any;
        const shown = step(sceneZ, positionView.z) as any;
        // In shade a mote still catches the bright room's light a little, enough to show over anything dark.
        const brightness = mix(float(0.22), float(2.6), lit.min(1)).mul(twinkle).mul(dot).mul(shown) as any;
        parts.dustMaterial.colorNode = vec4(color(SUN_COLOUR).mul(brightness), 1) as any;
        parts.dustMaterial.needsUpdate = true;
      }),
    [parts]
  );

  return (
    <>
      {parts.meshes.map((mesh, n) => (
        <primitive key={n} object={mesh} />
      ))}
      <primitive object={parts.specks} />
    </>
  );
}
