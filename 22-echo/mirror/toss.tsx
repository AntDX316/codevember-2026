"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { useDispose } from "../../shared/engine/dispose";
import { cardGeometry, cardMaterial, FANS, fanGeometry } from "./card";

// The tool that pops it: a graphics card. With the pointer over the bubble a card is held up close at the bottom left
// of the view, drifting loosely after the pointer, fans spinning, and a dotted arc runs from it to the point under the pointer, showing where it will go;
// a tap lobs it along that arc, tumbling, and the bubble bursts when it lands. A finger has no hover, so on a phone the
// card simply leaves the hand when the bubble is tapped.

// How long the throw takes, how high it arcs, and the card's size in the hand and on landing.
const FLIGHT = 0.9;
const ARC = 0.4;
const HELD = 0.32;
const LANDED = 0.8;
// The hand: where on the screen (from -1 to 1 each way) the card is held, how far in front of the eye, how much of the
// way toward the pointer it leans, and how quickly it catches up.
const HAND = { x: -0.58, y: -0.52, away: 0.75, follow: 0.28, ease: 5 };
// The dots along the arc, their size on screen (as a share of their distance), and how fast they run along it.
const DOTS = 28;
const DOT = 0.0042;
const RUN = 0.9;

export const toss = {
  // Where the pointer's ray meets the bubble while it hovers there; null when it is off it. And the pointer on the
  // screen, from -1 to 1 each way.
  aim: null as THREE.Vector3 | null,
  pointer: new THREE.Vector2(),
  // A throw in the air: from, to, when it left, and what to do when it lands.
  flight: null as null | { from: THREE.Vector3; to: THREE.Vector3; start: number; spin: THREE.Vector3; land: () => void },
  // Throw from the hand at a point; `land` runs when it gets there.
  throwAt: null as null | ((to: THREE.Vector3, land: () => void) => void)
};

const tmp = { lean: new THREE.Vector2(), p: new THREE.Vector3(), from: new THREE.Vector3(), q: new THREE.Quaternion(), e: new THREE.Euler(), m: new THREE.Matrix4(), s: new THREE.Vector3(), zero: new THREE.Matrix4().makeScale(0, 0, 0) };

// The arc's point at u (0 in the hand, 1 on the film): eased a touch at the start, as a lob leaves the hand slow, and
// lifted over the middle.
function along(from: THREE.Vector3, to: THREE.Vector3, u: number, out: THREE.Vector3) {
  out.lerpVectors(from, to, u * u * (1.6 - 0.6 * u));
  out.y += Math.sin(Math.PI * u) * ARC;
  return out;
}

export function Toss() {
  const camera = useThree((state) => state.camera);
  const parts = useMemo(() => {
    const geometry = cardGeometry();
    const fanGeo = fanGeometry();
    const material = cardMaterial();
    const card = new THREE.Mesh(geometry, material);
    const fans = FANS.map((x) => {
      const fan = new THREE.Mesh(fanGeo, material);
      fan.position.x = x;
      card.add(fan);
      return fan;
    });
    card.visible = false;
    card.frustumCulled = false;
    card.raycast = () => {};
    for (const fan of fans) fan.raycast = () => {};
    // The dots: one draw, a little brighter than white so the bloom gives them a soft glow.
    const dotGeo = new THREE.IcosahedronGeometry(1, 1);
    const dotMat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1.5, 1.42, 1.3) });
    const dots = new THREE.InstancedMesh(dotGeo, dotMat, DOTS);
    dots.frustumCulled = false;
    dots.raycast = () => {};
    dots.visible = false;
    dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return { geometry, fanGeo, material, card, fans, dotGeo, dotMat, dots, now: 0, held: 0, fan: 0, lean: new THREE.Vector2(HAND.x, HAND.y) };
  }, []);
  useDispose(parts.geometry, parts.fanGeo, parts.material, parts.dotGeo, parts.dotMat);

  // The hand, in the world: its point on the screen, a little way in front of the eye, whatever the aspect.
  const hand = (out: THREE.Vector3) => {
    out.set(parts.lean.x, parts.lean.y, 0.5).unproject(camera).sub(camera.position).normalize();
    return out.multiplyScalar(HAND.away).add(camera.position);
  };

  useFrame((_, raw) => {
    const p = parts;
    const dt = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1 / 20) : 1 / 60;
    p.now += dt;
    p.fan += dt * 30;
    p.fans.forEach((fan, k) => (fan.rotation.z = p.fan + k * 1.3));
    const flight = toss.flight;
    if (flight) {
      const u = Math.min(1, (p.now - flight.start) / FLIGHT);
      along(flight.from, flight.to, u, p.card.position);
      tmp.q.setFromEuler(tmp.e.set(flight.spin.x * u, flight.spin.y * u, flight.spin.z * u));
      p.card.quaternion.copy(camera.quaternion).multiply(tmp.q);
      p.card.scale.setScalar(HELD + (LANDED - HELD) * u);
      p.card.visible = true;
      p.dots.visible = false;
      p.held = 0;
      if (u >= 1) {
        toss.flight = null;
        p.card.visible = false;
        flight.land();
      }
      return;
    }
    // Held: rises into view when the pointer comes onto the bubble and drops away when it leaves, bobbing a little.
    p.held += ((toss.aim ? 1 : 0) - p.held) * (1 - Math.exp(-dt * 12));
    const shown = p.held > 0.02;
    p.card.visible = shown;
    p.dots.visible = shown && !!toss.aim;
    if (!shown) return;
    // Leaning a little after the pointer, and catching up slowly, so it follows loosely.
    tmp.lean.set(HAND.x + (toss.pointer.x - HAND.x) * HAND.follow, HAND.y + (toss.pointer.y - HAND.y) * HAND.follow);
    if (toss.aim) p.lean.lerp(tmp.lean, 1 - Math.exp(-dt * HAND.ease));
    hand(p.card.position);
    p.card.position.y += Math.sin(p.now * 2.4) * 0.005 - (1 - p.held) * 0.12;
    tmp.q.setFromEuler(tmp.e.set(-0.3, 0.55, -0.2 + Math.sin(p.now * 1.7) * 0.05 + (p.lean.x - HAND.x) * 0.4));
    p.card.quaternion.copy(camera.quaternion).multiply(tmp.q);
    p.card.scale.setScalar(HELD);

    // The arc: dots running from the hand to the aim, each sized by its distance so all look alike on screen, thinning
    // in at the hand end and grown a little at the far end.
    if (!toss.aim) return;
    hand(tmp.from);
    const shift = (p.now * RUN) % 1;
    for (let k = 0; k < DOTS; k++) {
      const u = (k + shift) / DOTS;
      if (u < 0.08) {
        p.dots.setMatrixAt(k, tmp.zero);
        continue;
      }
      along(tmp.from, toss.aim, u, tmp.p);
      const size = DOT * tmp.p.distanceTo(camera.position) * Math.min(1, (u - 0.08) * 8) * (0.8 + u * 0.5) * p.held;
      p.dots.setMatrixAt(k, tmp.m.compose(tmp.p, tmp.q.identity(), tmp.s.setScalar(size)));
    }
    p.dots.instanceMatrix.needsUpdate = true;
  });

  useEffect(() => {
    toss.throwAt = (to, land) => {
      const r = () => Math.random() * 2 - 1;
      toss.flight = { from: hand(new THREE.Vector3()), to: to.clone(), start: parts.now, spin: new THREE.Vector3(r() * 2 + 3, r() * 3, r() * 2), land };
    };
    return () => {
      toss.throwAt = null;
      toss.flight = null;
      toss.aim = null;
    };
  });

  return (
    <>
      <primitive object={parts.card} />
      <primitive object={parts.dots} />
    </>
  );
}
