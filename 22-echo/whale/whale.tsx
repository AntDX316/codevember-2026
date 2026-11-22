"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Fn, abs, attribute, cameraPosition, clamp, cos, exp, float, length, max, mix, modelWorldMatrix, normalize, positionWorld, pow, sin, uniform, varying, vec3, vec4 } from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { lines, revealAt, waterColour } from "./pulses";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// A humpback, thirteen metres long, built as smooth lofted surfaces: the body as one tube of changing cross-section
// (the flat rostrum, the fuller belly with its throat grooves, the small hooked dorsal fin on its hump and the
// flattened tail stock), and the long knobbly flippers and the flukes as tubes of a thin aerofoil section. It faces +x.

export const LENGTH = 13;
const HALF = LENGTH / 2;

type Ring = { c: THREE.Vector3; t: THREE.Vector3; n: THREE.Vector3; b: THREE.Vector3; a: number; h: number };

// A closed tube through rings, each an ellipse a along n and h along b. With n × b = t, (k, k + 1, next ring's k)
// winds anticlockwise seen from outside, so every face looks out. `shape` can push a point in or out.
function loft(rings: Ring[], segments: number, scan: (i: number, k: number) => [number, number], shape?: (i: number, angle: number) => [number, number]) {
  const positions: number[] = [];
  const scans: number[] = [];
  const index: number[] = [];
  const p = new THREE.Vector3();
  rings.forEach((r, i) => {
    for (let k = 0; k < segments; k++) {
      const angle = (k / segments) * Math.PI * 2;
      const [sa, sh] = shape ? shape(i, angle) : [1, 1];
      p.copy(r.c)
        .addScaledVector(r.n, Math.cos(angle) * r.a * sa)
        .addScaledVector(r.b, Math.sin(angle) * r.h * sh);
      positions.push(p.x, p.y, p.z);
      scans.push(...scan(i, k));
    }
  });
  for (let i = 0; i < rings.length - 1; i++)
    for (let k = 0; k < segments; k++) {
      const a = i * segments + k;
      const b = i * segments + ((k + 1) % segments);
      const c = a + segments;
      const d = b + segments;
      index.push(a, b, c, b, d, c);
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aScan", new THREE.Float32BufferAttribute(scans, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

// Linear between the samples of a table, eased.
function table(rows: [number, number][], u: number) {
  if (u <= rows[0][0]) return rows[0][1];
  for (let i = 1; i < rows.length; i++) {
    if (u <= rows[i][0]) {
      const t = (u - rows[i - 1][0]) / (rows[i][0] - rows[i - 1][0]);
      const s = t * t * (3 - 2 * t);
      return rows[i - 1][1] + (rows[i][1] - rows[i - 1][1]) * s;
    }
  }
  return rows[rows.length - 1][1];
}

// Half its width and height along the body, from the tip of the rostrum (0) to the notch of the flukes (1), and how
// far the middle of the section sits above the body's line.
const WIDTH: [number, number][] = [[0, 0.42], [0.08, 0.74], [0.18, 1.12], [0.3, 1.45], [0.42, 1.42], [0.55, 1.18], [0.66, 0.86], [0.76, 0.52], [0.86, 0.3], [0.94, 0.2], [1, 0.14]];
const HEIGHT: [number, number][] = [[0, 0.24], [0.08, 0.55], [0.18, 0.98], [0.3, 1.38], [0.42, 1.4], [0.55, 1.22], [0.66, 0.98], [0.76, 0.76], [0.86, 0.56], [0.94, 0.36], [1, 0.2]];
const LIFT: [number, number][] = [[0, -0.18], [0.1, -0.1], [0.3, 0], [0.6, 0.08], [0.8, 0.12], [1, 0.05]];

function buildBody(rings: number, segments: number) {
  const list: Ring[] = [];
  const us: number[] = [];
  for (let i = 0; i <= rings; i++) {
    // Closer together at the ends, where the shape turns fastest.
    const v = i / rings;
    const u = (0.5 - 0.5 * Math.cos(v * Math.PI)) * 0.85 + v * 0.15;
    us.push(u);
    // A rounded snout: the section shrinks to a point along a quarter ellipse over the first few per cent.
    const nose = Math.sqrt(Math.max(0, 1 - Math.pow(1 - Math.min(u / 0.07, 1), 2)));
    const tail = Math.sqrt(Math.max(0, 1 - Math.pow(1 - Math.min((1 - u) / 0.025, 1), 2)));
    const cap = Math.max(1e-3, nose * tail);
    list.push({
      c: new THREE.Vector3(HALF - u * LENGTH, table(LIFT, u), 0),
      t: new THREE.Vector3(-1, 0, 0),
      n: new THREE.Vector3(0, 0, 1),
      b: new THREE.Vector3(0, 1, 0),
      a: table(WIDTH, u) * cap,
      h: table(HEIGHT, u) * cap
    });
  }
  return loft(
    list,
    segments,
    (i, k) => [us[i] * LENGTH, k / segments],
    (i, angle) => {
      const u = us[i];
      const s = Math.sin(angle);
      const c = Math.cos(angle);
      let width = 1;
      let height = 1;
      if (s > 0) {
        // The rostrum is flat on top; behind the blowhole the back rounds out.
        height *= 1 - 0.32 * (1 - smoothstep(0.05, 0.3, u)) * s;
        // The hump, and on it the small hooked dorsal fin, rising steeply in front and sloping off behind.
        const fin = smoothstep(0.6, 0.655, u) * (1 - smoothstep(0.665, 0.73, u));
        const ridge = Math.exp(-Math.pow(c / 0.07, 2));
        height *= 1 + (0.06 * Math.exp(-Math.pow((u - 0.62) / 0.06, 2)) + 0.42 * fin * ridge) * s;
        // Along the back past the fin, the knuckles of the tail stock.
        height *= 1 + 0.03 * Math.max(0, Math.sin((u - 0.7) * 90)) * smoothstep(0.7, 0.74, u) * (1 - smoothstep(0.88, 0.92, u)) * ridge;
        // The tail stock is flattened side to side into a keel.
        width *= 1 - 0.35 * smoothstep(0.72, 0.9, u) * s * s;
      } else {
        // The belly is fuller under the head and chest, with throat grooves running back to the navel.
        height *= 1 + 0.12 * Math.exp(-Math.pow((u - 0.25) / 0.14, 2)) * -s;
        const grooves = smoothstep(0.04, 0.1, u) * (1 - smoothstep(0.4, 0.48, u)) * smoothstep(0.15, 0.6, -s);
        const groove = 1 - 0.022 * grooves * Math.pow(Math.abs(Math.sin(angle * 34)), 0.5);
        width *= groove;
        height *= groove;
        // A keel under the tail stock too.
        width *= 1 - 0.3 * smoothstep(0.75, 0.9, u) * s * s;
      }
      return [width, height];
    }
  );
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// A fin along a curved line from root to tip: chord (a) and thickness (h) by how far along it is (0 to 1), the chord
// lying along `chord` square to the line, and the leading edge toward it.
function buildFin(spine: (s: number) => THREE.Vector3, chord: THREE.Vector3, a: (s: number) => number, h: (s: number) => number, lead: (s: number) => number, rings: number, segments: number, offset: number) {
  const list: Ring[] = [];
  for (let i = 0; i <= rings; i++) {
    const s = i / rings;
    const c = spine(s);
    const t = spine(Math.min(1, s + 0.01))
      .sub(spine(Math.max(0, s - 0.01)))
      .normalize();
    const n = chord.clone().addScaledVector(t, -chord.dot(t)).normalize();
    const b = new THREE.Vector3().crossVectors(t, n);
    const tip = Math.sqrt(Math.max(0, 1 - Math.pow(1 - Math.min((1.004 - s) / 0.05, 1), 2)));
    list.push({ c, t, n, b, a: Math.max(1e-3, a(s) * tip), h: Math.max(1e-3, h(s) * tip) });
  }
  return loft(
    list,
    segments,
    (i, k) => [offset + (i / rings) * 3, k / segments],
    // An aerofoil: blunt and knobbly at the leading edge, drawn out thin to the trailing edge.
    (i, angle) => {
      const c = Math.cos(angle);
      const lift = c > 0 ? 1 + lead(i / rings) : 1;
      return [lift, c > 0 ? 1 : 1 - 0.55 * c * c];
    }
  );
}

function buildWhale(detail: number) {
  const body = buildBody(Math.round(160 * detail), Math.round(96 * detail));
  const parts = [body];
  for (const side of [1, -1]) {
    // The flippers: a third of the body long, from low on the chest, swept back and down, the tubercles along their
    // leading edge.
    const root = new THREE.Vector3(HALF - 0.3 * LENGTH, -0.55, side * 0.95);
    const spine = (s: number) => {
      const d = s * 4.3;
      return root.clone().add(new THREE.Vector3(-d * 0.55 - d * d * 0.05, -d * 0.42 + d * d * 0.03, side * d * 0.72));
    };
    parts.push(
      buildFin(
        spine,
        new THREE.Vector3(1, 0.15, 0),
        (s) => 0.5 * (1 - s) ** 0.55 + 0.1 - 0.12 * Math.exp(-Math.pow((s - 0.04) / 0.06, 2)),
        (s) => 0.12 * (1 - s) + 0.03,
        (s) => (s > 0.1 ? 0.16 * Math.pow(Math.max(0, Math.sin(s * Math.PI * 11)), 2) * (1 - s * 0.6) : 0),
        Math.round(70 * detail),
        Math.round(24 * detail),
        20
      )
    );
    // The flukes: broad and swept, a fifth of the body each, thin at the trailing edge.
    const tailRoot = new THREE.Vector3(-HALF + 0.35, 0.05, 0);
    const flukeSpine = (s: number) => {
      const d = s * 2.35;
      return tailRoot.clone().add(new THREE.Vector3(-d * 0.38 - d * d * 0.06, d * 0.04, side * d));
    };
    parts.push(
      buildFin(
        flukeSpine,
        new THREE.Vector3(1, 0, 0),
        (s) => 0.62 * (1 - s * s) ** 0.7 + 0.1,
        (s) => 0.13 * (1 - s) + 0.02,
        () => 0,
        Math.round(50 * detail),
        Math.round(24 * detail),
        40
      )
    );
  }
  const merged = mergeGeometries(parts.map((g) => {
    const plain = new THREE.BufferGeometry();
    plain.setAttribute("position", g.getAttribute("position"));
    plain.setAttribute("normal", g.getAttribute("normal"));
    plain.setAttribute("aScan", g.getAttribute("aScan"));
    plain.setIndex(g.getIndex());
    return plain;
  }))!;
  merged.computeBoundingSphere();
  return merged;
}

// Where the whale is and how it swims, set each frame.
export const swim = {
  phase: uniform(0),
  // How hard the flukes are beating, 0 to 1.
  beat: uniform(0.6),
  // For checking the mesh: 1 draws its normals as colour.
  normals: uniform(0)
};

function whaleMaterial() {
  const material = new THREE.MeshBasicNodeMaterial();
  const built = attribute("position", "vec3") as any;
  const n0 = attribute("normal", "vec3") as any;
  // The body bends in a wave running back to the flukes, growing as the square toward them: rising and falling, as
  // whales swim. The normal is turned by the slope of the bend.
  const u = clamp(float(HALF).sub(built.x).div(LENGTH), 0, 1.4) as any;
  const k = (2 * Math.PI) / 1.15;
  const amp = u.mul(u).mul(swim.beat).mul(0.85) as any;
  const wave = swim.phase.sub(u.mul(k)) as any;
  const dy = amp.mul(sin(wave)) as any;
  const slope = u.mul(2).mul(swim.beat).mul(0.85).mul(sin(wave)).sub(amp.mul(k).mul(cos(wave))).div(-LENGTH) as any;
  material.positionNode = built.add(vec3(0, dy, 0)) as any;
  const turned = vec3(n0.x.sub(slope.mul(n0.y)), n0.y, n0.z) as any;
  const N = varying(normalize(modelWorldMatrix.mul(vec4(turned, 0)).xyz)) as any;
  const scan = varying(attribute("aScan", "vec2")) as any;
  material.colorNode = Fn(() => {
    const P = positionWorld as any;
    const toEye = cameraPosition.sub(P) as any;
    const dist = length(toEye) as any;
    const V = toEye.div(dist) as any;
    const n = normalize(N) as any;
    const rim = pow(float(1).sub(abs(n.dot(V))), 2.5) as any;
    // Slices across the body, and a few lines along it.
    const pattern = () => max(lines(scan.x, 0.42, 1.3), lines(scan.y, 1 / 18, 1).mul(0.35));
    const glow = revealAt(P, pattern, 0.5, 1.6).mul(rim.mul(1.6).add(0.45)) as any;
    // A dark back, only a breath of the light from above on it; and from below, against the water, a silhouette.
    const above = max(n.y, 0).mul(0.004).add(rim.mul(0.002)) as any;
    const keep = exp(dist.div(-70)) as any;
    const water = waterColour(V.negate()) as any;
    const rgb = mix(water, vec3(0.3, 0.6, 0.8).mul(above), keep).add(glow.mul(exp(dist.div(-200)))) as any;
    return vec4(mix(rgb, n.mul(0.5).add(0.5), swim.normals as any) as any, 1);
  })() as any;
  return material;
}

// The whale and its path: a long slow loop out in the dark ahead, rising and sinking a little, banking into the turns.
export const whaleState = {
  position: new THREE.Vector3(),
  heading: 0,
  // The front of the head, where its calls come from.
  head: new THREE.Vector3(),
  speed: 1.7,
  angle: 0.6,
  // The flukes beat harder for a while after it calls.
  effort: 0,
  // For checking the mesh by hand in development: held here, turned to this heading.
  pin: null as null | { at: THREE.Vector3; heading: number }
};

const PATH = { x: -4, y: -3, z: -50, rx: 18, rz: 13 };

export function placeWhale(angle: number, out: THREE.Vector3) {
  return out.set(PATH.x + Math.cos(angle) * PATH.rx, PATH.y + Math.sin(angle * 2 + 0.6) * 1.8, PATH.z + Math.sin(angle) * PATH.rz);
}

export function Whale({ detail }: { detail: number }) {
  const { mesh, geometry, material } = useMemo(() => {
    const geometry = buildWhale(detail);
    const material = whaleMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.order = "YZX";
    mesh.frustumCulled = false;
    mesh.name = "whale";
    return { mesh, geometry, material };
  }, [detail]);
  useDispose(geometry, material);

  const scratch = useMemo(() => ({ next: new THREE.Vector3(), prev: new THREE.Vector3(), head: new THREE.Vector3(HALF - 0.8, 0.2, 0) }), []);
  useFrame((_, raw) => {
    const delta = Math.min(raw, 1 / 20);
    const w = whaleState;
    w.effort = Math.max(0, w.effort - delta * 0.12);
    const speed = w.speed * (1 + w.effort * 0.5);
    // Round the ellipse at a steady speed along it.
    const radius = Math.hypot(PATH.rx * Math.sin(w.angle), PATH.rz * Math.cos(w.angle));
    w.angle -= (speed * delta) / Math.max(radius, 1);
    placeWhale(w.angle, w.position);
    placeWhale(w.angle - 0.02, scratch.next);
    placeWhale(w.angle + 0.02, scratch.prev);
    const dir = scratch.next.clone().sub(w.position);
    const heading = Math.atan2(-dir.z, dir.x);
    const pitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z));
    // Banking into the turn, by how fast the heading is changing.
    const back = w.position.clone().sub(scratch.prev);
    const turn = THREE.MathUtils.euclideanModulo(heading - Math.atan2(-back.z, back.x) + Math.PI, Math.PI * 2) - Math.PI;
    mesh.position.copy(w.position);
    mesh.rotation.set(-turn * 6, heading, pitch);
    if (w.pin) {
      mesh.position.copy(w.pin.at);
      mesh.rotation.set(0, w.pin.heading, 0);
    }
    w.heading = heading;
    mesh.updateMatrixWorld();
    w.head.copy(scratch.head).applyMatrix4(mesh.matrixWorld);
    swim.beat.value = 0.55 + w.effort * 0.45;
    swim.phase.value += delta * Math.PI * 2 * (0.2 + w.effort * 0.12);
  });

  return <primitive object={mesh} />;
}
