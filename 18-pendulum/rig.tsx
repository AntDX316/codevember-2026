"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { atan, color, cos, float, mix, mx_noise_float, positionLocal, sin, smoothstep, step, uniform, vec2, vec3 } from "three/tsl";
import { useDispose } from "../shared/engine/dispose";
import { BIGGER, CAN, type Parcel, PIVOT, type Pendulum, VESSELS, type VesselName } from "./pendulum";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// What hangs: the beam overhead with an eye bolt, the rope tied in a knot to the bail, and the vessel on it: a paint can
// or a wide plastic bucket with holes round its base. The vessel hangs along the rope's line and turns about it as it
// spins. Each hole's stream is drawn as a tube through its parcels, as thick as the paint each one carries spread over
// the gap to the next, so it thins as it stretches and breaks into beads where it would be too thin to hold together.

// The vessel's mark: a ring with a dot for each hole in its base (one in the middle, or three or five round it), or a bar
// across it for the slot, printed four times round it so one always faces the eye. around: the angle round the vessel;
// y: the height; centre: the mark's height; R: its ring's radius; slot: 1 for the slot.
function holeMark(around: any, y: any, radius: number, centre: number, R: number, holes: any, slot: any) {
  const folded = around.add(Math.PI).mod(Math.PI / 2).sub(Math.PI / 4) as any;
  const p = vec2(folded.mul(radius), y.sub(centre)) as any;
  const aa = R * 0.06;
  const ring = float(1).sub(smoothstep(R * 0.08, R * 0.08 + aa, p.length().sub(R).abs())) as any;
  let dots: any = float(0);
  const spread = holes.greaterThan(1.5).select(float(R * 0.55), float(0)) as any;
  for (let k = 0; k < 5; k++) {
    const angle = float((k * Math.PI * 2) as number).div(holes).add(Math.PI / 2) as any;
    const at = vec2(cos(angle), sin(angle)).mul(spread) as any;
    const dot = float(1).sub(smoothstep(R * 0.2, R * 0.2 + aa, p.sub(at).length())).mul(step(k + 0.5, holes)) as any;
    dots = dots.max(dot);
  }
  const bar = float(1).sub(smoothstep(R * 0.6, R * 0.6 + aa, p.x.abs())).mul(float(1).sub(smoothstep(R * 0.1, R * 0.1 + aa, p.y.abs()))) as any;
  return ring.max(mix(dots, bar, slot)) as any;
}

const SEGMENTS = 1400;
const BEADS = 600;

export function Rig({ pendulum, paintColour, vessel }: { pendulum: Pendulum; paintColour: string; vessel: VesselName }) {
  const tint = useMemo(() => uniform(new THREE.Color(paintColour)), []);
  tint.value.set(paintColour);
  const level = useMemo(() => uniform(1), []);
  // How many holes the vessel has, for the mark printed on it.
  const holeCount = useMemo(() => uniform(1), []);
  const slotMark = useMemo(() => uniform(0), []);
  holeCount.value = VESSELS[vessel].holes;
  slotMark.value = VESSELS[vessel].slot ? 1 : 0;
  const parts = useMemo(() => {
    // The beam, rough-sawn, across the room over the canvas, and the eye bolt under it.
    const wood = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
    const grain = mx_noise_float(positionLocal.mul(vec3(1.5, 30, 30))).mul(0.5).add(0.5) as any;
    wood.colorNode = mix(color("#3a2a1c"), color("#5a4430"), grain) as any;
    const beamGeometry = new THREE.BoxGeometry(7, 0.2, 0.14);
    const beam = new THREE.Mesh(beamGeometry, wood);
    beam.position.set(0, PIVOT.y + 0.12, 0);
    beam.castShadow = true;
    const steel = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, metalness: 1 });
    steel.colorNode = color("#8a8a86") as any;
    const eyeGeometry = new THREE.TorusGeometry(0.018, 0.005, 8, 20);
    const eye = new THREE.Mesh(eyeGeometry, steel);
    eye.position.copy(PIVOT).add(new THREE.Vector3(0, 0.015, 0));

    // The rope: braided cotton, a unit tall, stretched each frame from the eye to the bail.
    const rope = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
    const twist = positionLocal.y.mul(260).add(atan(positionLocal.x, positionLocal.z).mul(2)).sin().mul(0.5).add(0.5) as any;
    rope.colorNode = mix(color("#b9ab92"), color("#e2d8c2"), twist) as any;
    const ropeGeometry = new THREE.CylinderGeometry(0.0045, 0.0045, 1, 10, 1).translate(0, 0.5, 0);
    const ropeMesh = new THREE.Mesh(ropeGeometry, rope);
    ropeMesh.castShadow = true;

    // The can: a steel tin with a rolled rim, a printed label in the paint's colour, paint run down its side, and the
    // paint inside it at its level. Built standing on y = 0, its bail at the top.
    const can = new THREE.Group();
    const tin = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.32, metalness: 0.9 });
    const y = positionLocal.y as any;
    const around = atan(positionLocal.x, positionLocal.z) as any;
    const label = smoothstep(0.035, 0.04, y).mul(smoothstep(0.155, 0.15, y)) as any;
    // Drips: runs from the rim down the outside, each its own length.
    const runs = smoothstep(0.55, 0.85, around.mul(7).sin().mul(around.mul(3.3).add(1).sin())) as any;
    const runLength = mx_noise_float(vec3(around.mul(4), 0, 0)).mul(0.08).add(0.12) as any;
    const from = float(CAN.height).sub(runLength) as any;
    const drip = runs.mul(smoothstep(from, from.add(0.02), y)) as any;
    const printed = mix(color("#c9c6bf"), tint.mul(0.85).add(color("#0d0d0d")), label) as any;
    // The mark, in dark ink on a light paint's label and light ink on a dark one.
    const ink = (tint as any).dot(vec3(0.3, 0.59, 0.11)).greaterThan(0.35).select(color("#141414"), color("#f2efe8")) as any;
    const mark = holeMark(around, y, CAN.radius, 0.095, 0.024, holeCount, slotMark).mul(label) as any;
    tin.colorNode = mix(mix(printed, ink, mark), tint, drip) as any;
    tin.metalnessNode = mix(float(0.9), float(0.05), label.max(drip)) as any;
    tin.roughnessNode = mix(float(0.32), float(0.2), drip) as any;
    tin.clearcoatNode = drip.mul(0.8) as any;
    const bodyGeometry = new THREE.CylinderGeometry(CAN.radius, CAN.radius, CAN.height, 48, 1, true).translate(0, CAN.height / 2, 0);
    const body = new THREE.Mesh(bodyGeometry, tin);
    // The inside: a wall a few millimetres in and a floor, coated in the paint, so the can has a thickness and nothing is
    // seen through it from above as its paint runs low.
    const inside = new THREE.MeshStandardNodeMaterial({ roughness: 0.25, side: THREE.BackSide });
    const streak = mx_noise_float(vec3(atan(positionLocal.x, positionLocal.z).mul(5), positionLocal.y.mul(18), 0)).mul(0.5).add(0.5) as any;
    inside.colorNode = mix(color("#2e2d2b"), tint, streak.mul(0.6).add(0.35)) as any;
    const innerGeometry = new THREE.CylinderGeometry(CAN.radius - 0.0025, CAN.radius - 0.0025, CAN.height - 0.003, 48, 1, true).translate(0, CAN.height / 2 + 0.0015, 0);
    const inner = new THREE.Mesh(innerGeometry, inside);
    const innerFloorGeometry = new THREE.CircleGeometry(CAN.radius - 0.0025, 40).rotateX(-Math.PI / 2).translate(0, 0.003, 0);
    const innerFloor = new THREE.Mesh(innerFloorGeometry, inside);
    body.castShadow = true;
    const baseGeometry = new THREE.CircleGeometry(CAN.radius, 48).rotateX(Math.PI / 2);
    const baseMesh = new THREE.Mesh(baseGeometry, tin);
    const rimGeometry = new THREE.TorusGeometry(CAN.radius, 0.0035, 8, 48).rotateX(Math.PI / 2).translate(0, CAN.height, 0);
    const rim = new THREE.Mesh(rimGeometry, steel);
    const lowerRim = new THREE.Mesh(rimGeometry.clone().translate(0, -CAN.height + 0.003, 0), steel);
    // The paint inside, at its level, glossy.
    const wetPaint = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03 });
    wetPaint.colorNode = tint as any;
    const surfaceGeometry = new THREE.CircleGeometry(CAN.radius - 0.003, 40).rotateX(-Math.PI / 2);
    const surface = new THREE.Mesh(surfaceGeometry, wetPaint);
    // The bail: a wire arc over the top to the rope.
    // Flattened, so its top meets the rope just over the rim.
    const bailGeometry = new THREE.TorusGeometry(CAN.radius, 0.0022, 6, 32, Math.PI).scale(1, CAN.bail / CAN.radius, 1).translate(0, CAN.height, 0);
    const bail = new THREE.Mesh(bailGeometry, steel);
    can.add(body, inner, innerFloor, baseMesh, rim, lowerRim, surface, bail);
    can.traverse((o) => ((o as THREE.Mesh).castShadow = true));

    // The knot where the rope is tied to the bail: a lumpy hitch with two wraps and a short loose tail. Built round the
    // rope's end, up its line.
    const knot = new THREE.Group();
    const lumpGeometry = new THREE.SphereGeometry(0.0105, 14, 10).scale(1.15, 1.5, 1.05).translate(0, 0.008, 0);
    const wrapGeometry = new THREE.TorusGeometry(0.009, 0.0042, 8, 18).rotateX(Math.PI / 2);
    const tailGeometry = new THREE.CylinderGeometry(0.0042, 0.0036, 0.04, 8).translate(0, -0.02, 0);
    const lump = new THREE.Mesh(lumpGeometry, rope);
    const wrapA = new THREE.Mesh(wrapGeometry, rope);
    wrapA.position.y = 0.012;
    wrapA.rotation.z = 0.25;
    const wrapB = new THREE.Mesh(wrapGeometry, rope);
    wrapB.position.y = 0.003;
    wrapB.rotation.z = -0.3;
    const tail = new THREE.Mesh(tailGeometry, rope);
    tail.position.set(0.008, 0.006, 0.004);
    tail.rotation.set(0.25, 0, 0.45);
    knot.add(lump, wrapA, wrapB, tail);
    knot.traverse((o) => ((o as THREE.Mesh).castShadow = true));

    // The bucket: a wide white plastic pail, tapering to its base, with a thick rolled lip, two ribs, paint run down its
    // side, holes round its base, a wire bail with a plastic grip, and the paint inside at its level.
    const pail = VESSELS.three;
    const bucket = new THREE.Group();
    const plastic = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.5, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.4 });
    const pY = positionLocal.y as any;
    const pAround = atan(positionLocal.x, positionLocal.z) as any;
    const pRuns = smoothstep(0.5, 0.85, pAround.mul(6).sin().mul(pAround.mul(2.7).add(1.3).sin())) as any;
    const pLength = mx_noise_float(vec3(pAround.mul(3), 4, 0)).mul(0.1).add(0.12) as any;
    const pFrom = float(pail.height).sub(pLength) as any;
    const pDrip = pRuns.mul(smoothstep(pFrom, pFrom.add(0.025), pY)) as any;
    const scuff = mx_noise_float(positionLocal.mul(40)).mul(0.04) as any;
    const pMark = holeMark(pAround, pY, pail.bottom + 0.01, 0.1, 0.038, holeCount, slotMark) as any;
    plastic.colorNode = mix(mix(color("#e6e3dc").sub(scuff), color("#1b1b1c"), pMark), tint, pDrip) as any;
    plastic.roughnessNode = mix(float(0.5), float(0.18), pDrip) as any;
    plastic.clearcoatNode = mix(float(0.3), float(0.9), pDrip) as any;
    const pailGeometry = new THREE.CylinderGeometry(pail.top, pail.bottom, pail.height, 56, 1, true).translate(0, pail.height / 2, 0);
    const pailBody = new THREE.Mesh(pailGeometry, plastic);
    const pailInnerGeometry = new THREE.CylinderGeometry(pail.top - 0.004, pail.bottom - 0.004, pail.height - 0.004, 56, 1, true).translate(0, pail.height / 2 + 0.002, 0);
    const pailInner = new THREE.Mesh(pailInnerGeometry, inside);
    const pailInnerFloorGeometry = new THREE.CircleGeometry(pail.bottom - 0.004, 48).rotateX(-Math.PI / 2).translate(0, 0.004, 0);
    const pailInnerFloor = new THREE.Mesh(pailInnerFloorGeometry, inside);
    const pailBaseGeometry = new THREE.CircleGeometry(pail.bottom, 56).rotateX(Math.PI / 2);
    const pailBase = new THREE.Mesh(pailBaseGeometry, plastic);
    const lipGeometry = new THREE.TorusGeometry(pail.top + 0.002, 0.0065, 10, 56).rotateX(Math.PI / 2).translate(0, pail.height, 0);
    const lip = new THREE.Mesh(lipGeometry, plastic);
    const ribAt = (h: number) => pail.bottom + ((pail.top - pail.bottom) * h) / pail.height + 0.0015;
    const ribGeometryA = new THREE.TorusGeometry(ribAt(0.17), 0.003, 6, 56).rotateX(Math.PI / 2).translate(0, 0.17, 0);
    const ribGeometryB = new THREE.TorusGeometry(ribAt(0.2), 0.003, 6, 56).rotateX(Math.PI / 2).translate(0, 0.2, 0);
    const ribA = new THREE.Mesh(ribGeometryA, plastic);
    const ribB = new THREE.Mesh(ribGeometryB, plastic);
    // Holes, seen from below: dark discs just under the base where each one is.
    const dark = new THREE.MeshBasicNodeMaterial();
    dark.colorNode = color("#060606") as any;
    const holeGeometry = new THREE.CircleGeometry(0.0055, 14).rotateX(Math.PI / 2);
    const holes = new THREE.Group();
    const pailBailGeometry = new THREE.TorusGeometry(pail.top, 0.0026, 6, 40, Math.PI).scale(1, pail.bail / pail.top, 1).translate(0, pail.height, 0);
    const pailBail = new THREE.Mesh(pailBailGeometry, steel);
    const gripMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.6 });
    gripMaterial.colorNode = color("#1b1b1d") as any;
    const gripGeometry = new THREE.CylinderGeometry(0.011, 0.011, 0.09, 14).rotateZ(Math.PI / 2).translate(0, pail.height + pail.bail - 0.002, 0);
    const grip = new THREE.Mesh(gripGeometry, gripMaterial);
    const pailSurface = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), wetPaint);
    bucket.add(pailBody, pailInner, pailInnerFloor, pailBase, lip, ribA, ribB, holes, pailBail, grip, pailSurface);
    bucket.traverse((o) => ((o as THREE.Mesh).castShadow = true));

    // The stream: a tube a segment between each two parcels, and beads where it breaks up.
    const streamMaterial = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02 });
    streamMaterial.colorNode = tint as any;
    const segmentGeometry = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true).translate(0, 0.5, 0);
    const segments = new THREE.InstancedMesh(segmentGeometry, streamMaterial, SEGMENTS);
    segments.frustumCulled = false;
    segments.castShadow = true;
    // One to start with, so their shaders are built with the rest while loading; the first frame sets the real count.
    segments.count = 1;
    const beadGeometry = new THREE.SphereGeometry(1, 12, 8);
    const beads = new THREE.InstancedMesh(beadGeometry, streamMaterial, BEADS);
    beads.frustumCulled = false;
    beads.castShadow = true;
    beads.count = 1;
    return {
      beam,
      eye,
      ropeMesh,
      can,
      surface,
      knot,
      bucket,
      holes,
      holeGeometry,
      dark,
      pailSurface,
      segments,
      beads,
      geometries: [innerGeometry, innerFloorGeometry, pailInnerGeometry, pailInnerFloorGeometry, beamGeometry, eyeGeometry, ropeGeometry, bodyGeometry, baseGeometry, rimGeometry, lowerRim.geometry, surfaceGeometry, bailGeometry, segmentGeometry, beadGeometry, lumpGeometry, wrapGeometry, tailGeometry, pailGeometry, pailBaseGeometry, lipGeometry, ribGeometryA, ribGeometryB, holeGeometry, pailBailGeometry, gripGeometry, pailSurface.geometry],
      materials: [inside, wood, steel, rope, tin, wetPaint, streamMaterial, plastic, dark, gripMaterial]
    };
  }, [tint, holeCount, slotMark]);
  useDispose(...parts.geometries, ...parts.materials);
  // The bucket's holes for the vessel chosen: as many as it has, round its base where the paint leaves.
  useEffect(() => {
    const { holes, holeGeometry, dark } = parts;
    holes.clear();
    const v = VESSELS[vessel];
    // The bucket is drawn at the three-hole size and scaled up for five, so its holes are placed in those units.
    const unit = vessel === "five" ? BIGGER : 1;
    // The slot: one long, thin cut across the base, pointed at its ends like a pencil's outline.
    if (v.slot) {
      const slot = new THREE.Mesh(holeGeometry, dark);
      slot.position.set(0, -0.0015, 0);
      slot.scale.set((v.slot / 2 + 0.006) / 0.0055, 1, 0.45);
      holes.add(slot);
      return;
    }
    for (let k = 0; k < v.holes; k++) {
      const a = (k / v.holes) * Math.PI * 2;
      const hole = new THREE.Mesh(holeGeometry, dark);
      hole.position.set((Math.cos(a) * v.ring) / unit, -0.0015, (Math.sin(a) * v.ring) / unit);
      holes.add(hole);
    }
  }, [parts, vessel]);

  const scratch = useMemo(() => ({ up: new THREE.Vector3(), q: new THREE.Quaternion(), m: new THREE.Matrix4(), a: new THREE.Vector3(), b: new THREE.Vector3(), order: [] as Parcel[], s: new THREE.Vector3(), x: new THREE.Vector3(), z: new THREE.Vector3(), basis: new THREE.Matrix4() }), []);
  useFrame(() => {
    const { up, q, m, a, b, order, s, x, z, basis } = scratch;
    // The rope from the eye to the bail; the can hanging along the rope's line below it.
    up.subVectors(PIVOT, pendulum.end);
    const length = up.length();
    up.normalize();
    q.setFromUnitVectors(Y, up.clone().negate());
    parts.ropeMesh.quaternion.setFromUnitVectors(Y, up);
    parts.ropeMesh.position.copy(pendulum.end);
    parts.ropeMesh.scale.set(1, length, 1);
    // The knot at the rope's end, up its line.
    parts.knot.position.copy(pendulum.end);
    parts.knot.quaternion.setFromUnitVectors(Y, up);
    // The vessel: its bail at the rope's end, hanging down the rope's line, turned about it as it spins.
    const v = pendulum.vessel;
    const isCan = vessel === "can";
    parts.can.visible = isCan;
    parts.bucket.visible = !isCan;
    const hung = isCan ? parts.can : parts.bucket;
    pendulum.frame(x, a, z);
    hung.quaternion.setFromRotationMatrix(basis.makeBasis(x, a, z));
    hung.position.copy(pendulum.end).addScaledVector(up, -(v.height + v.bail));
    const unit = vessel === "five" ? BIGGER : 1;
    parts.bucket.scale.setScalar(unit);
    const depth = 0.006 + pendulum.level * v.height * 0.85;
    parts.surface.position.y = depth;
    const across = v.bottom + ((v.top - v.bottom) * depth) / v.height - 0.004;
    parts.pailSurface.position.y = depth / unit;
    parts.pailSurface.scale.set(across / unit, 1, across / unit);
    parts.pailSurface.visible = pendulum.level > 0.01;
    level.value = pendulum.level;

    // The streams, one a hole, each oldest parcel (lowest) to newest (at its hole).
    order.length = 0;
    for (const p of pendulum.parcels) if (p.alive) order.push(p);
    order.sort((x, y) => x.stream - y.stream || x.born - y.born);
    let segs = 0;
    let beadCount = 0;
    for (let k = 0; k < order.length; k++) {
      const from = order[k];
      const last = k + 1 >= order.length || order[k + 1].stream !== from.stream;
      const to = last ? pendulum.holeAt(from.stream, b) : order[k + 1].p;
      // Parcels let go far apart in time are separate pours, not one stream.
      if (!last && order[k + 1].born - from.born > 0.02) continue;
      if (last && (pendulum.held || pendulum.finished || pendulum.time - from.born > 0.02)) continue;
      a.subVectors(to, from.p);
      const gap = a.length();
      if (gap < 1e-5) continue;
      // A sheet from the slot: a flat ribbon as wide as the slot, as thick as its paint spread over that width and the
      // gap, never breaking into beads.
      const half = from.axis.length();
      if (half > 0) {
        if (segs >= SEGMENTS) continue;
        s.copy(a).divideScalar(gap);
        x.copy(from.axis).addScaledVector(s, -from.axis.dot(s));
        const wide = x.length();
        if (wide < 1e-4) continue;
        x.multiplyScalar(half / wide);
        z.crossVectors(x, s).normalize().multiplyScalar(THREE.MathUtils.clamp(from.volume / (gap * half * 2), 0.0005, 0.003));
        basis.makeBasis(x, a.copy(s).multiplyScalar(gap * 1.08), z).setPosition(from.p);
        parts.segments.setMatrixAt(segs++, basis);
        continue;
      }
      // As thick as its paint spread over the gap: a stretched stream is thin.
      const radius = Math.sqrt(from.volume / (Math.PI * gap));
      if (radius < 0.0009) {
        // Too thin to hold together: it breaks into a bead holding the same paint.
        if (beadCount < BEADS) {
          const r = Math.cbrt((3 * from.volume) / (4 * Math.PI));
          m.makeScale(r, r * 1.15, r).setPosition(from.p);
          parts.beads.setMatrixAt(beadCount++, m);
        }
        continue;
      }
      if (segs >= SEGMENTS) continue;
      const r = Math.min(radius, 0.0045);
      s.copy(a).divideScalar(gap);
      q.setFromUnitVectors(Y, s);
      m.compose(from.p, q, a.set(r, gap * 1.08, r));
      parts.segments.setMatrixAt(segs++, m);
    }
    parts.segments.count = segs;
    parts.beads.count = beadCount;
    parts.segments.instanceMatrix.needsUpdate = true;
    parts.beads.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      <primitive object={parts.beam} />
      <primitive object={parts.eye} />
      <primitive object={parts.ropeMesh} />
      <primitive object={parts.can} />
      <primitive object={parts.bucket} />
      <primitive object={parts.knot} />
      <primitive object={parts.segments} />
      <primitive object={parts.beads} />
    </>
  );
}

const Y = new THREE.Vector3(0, 1, 0);
