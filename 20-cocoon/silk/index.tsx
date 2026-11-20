"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSetting, useSettingAction, useSettingRef } from "../../shared/engine/settings";
import { sound } from "../../shared/engine/sound";
import { Backdrop, focus, type Variant } from "../kit";
import { Bead, Motes, Pupa } from "./pupa";
import { MAX_TAIL, SHAPE, STEP, Spool, type Pattern } from "./spool";
import { strandGeometry, strandMaterial, strandUniforms } from "./strands";

const COLOURS: Record<string, string> = { gold: "#e6d2a6", white: "#f4efe4", rose: "#e9a993", moon: "#c6d2ea" };
// Silk the cocoon can hold before new turns start taking the places of the innermost, and how many motes drift by.
const CAPACITY = { low: 30000, medium: 56000, high: 90000 };
const MOTES = { low: 400, medium: 700, high: 1000 };
// As fast as a flick can spin it, in radians a second.
const TOP_SPIN = 30;
// The slow turn it keeps when left alone.
const IDLE_SPIN = 0.3;

function Scene() {
  const { tier } = useQuality();
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const size = useThree((state) => state.size);
  const pattern = useSettingRef<string>("silkPattern");
  const glow = useSettingRef<number>("silkGlow");
  const colour = useSetting<string>("silkColour");

  // The cocoon opens already a good way wound, as if it had been turning a while before anyone came.
  const spool = useMemo(() => {
    const spool = new Spool(CAPACITY[tier]);
    spool.prewind(Math.round(CAPACITY[tier] * 0.42));
    return spool;
  }, [tier]);

  const u = useMemo(() => strandUniforms(), []);
  const material = useMemo(() => strandMaterial(u), [u]);
  useDispose(material);

  // The wound silk reads its lengths straight from the spool's arrays; the loose end gets its own, rewritten every frame.
  const wound = useMemo(() => {
    const made = strandGeometry(0);
    const from = new THREE.InstancedBufferAttribute(spool.from, 4);
    const to = new THREE.InstancedBufferAttribute(spool.to, 4);
    const birth = new THREE.InstancedBufferAttribute(spool.birth, 1);
    made.geometry.setAttribute("aFrom", from);
    made.geometry.setAttribute("aTo", to);
    made.geometry.setAttribute("aBirth", birth);
    made.geometry.instanceCount = spool.used;
    spool.dirtyFrom = Infinity;
    spool.dirtyTo = -1;
    return { geometry: made.geometry, attributes: [from, to, birth] };
  }, [spool]);
  const tail = useMemo(() => strandGeometry(MAX_TAIL), []);
  useDispose(wound.geometry, tail.geometry);
  const tailPoints = useMemo(() => new Float32Array(MAX_TAIL * 3), []);

  useEffect(() => {
    u.silk.value.set(COLOURS[colour] ?? COLOURS.gold);
  }, [colour, u]);

  useEffect(() => {
    focus.point.set(0, 0, 0);
    focus.blur = 1;
  }, []);

  const group = useRef<THREE.Group>(null);
  const hold = useRef({ mode: "none" as "none" | "spin" | "tail", turned: 0, radius: 1, tx: 0, tz: 0, last: new THREE.Vector3(), index: -1 });
  const scratch = useMemo(() => ({ v: new THREE.Vector3(), w: new THREE.Vector3(), inverse: new THREE.Matrix4() }), []);

  useSettingAction("silkFresh", () => {
    spool.clear();
    wound.geometry.instanceCount = 0;
    spool.omega = Math.max(Math.abs(spool.omega), 5) * (Math.sign(spool.omega) || 1);
    hold.current.mode = "none";
    sound.play("whoosh", { gain: 0.35, pitch: 0.8 });
    sound.play("rustle", { gain: 0.4, pitch: 1.2 });
  });

  useGrabbable({
    pick: (ray) => {
      // The loose end first, with a reach that grows with distance so it is as easy to catch near as far.
      const t = spool.tail;
      let best = Infinity;
      let index = -1;
      for (let i = 2; i < spool.tailCount; i++) {
        scratch.v.set(t[i * 3], t[i * 3 + 1], t[i * 3 + 2]);
        const along = scratch.w.copy(scratch.v).sub(ray.origin).dot(ray.direction);
        if (along <= 0) continue;
        const off = ray.distanceSqToPoint(scratch.v);
        const reach = 0.012 * along + 0.02;
        if (off < reach * reach && along < best) {
          best = along;
          index = i;
        }
      }
      // Then the cocoon itself, as an egg as big as it has grown.
      const s = spool.shell() + 0.02;
      const w = SHAPE.width * s;
      const h = ((SHAPE.top + SHAPE.bottom) / 2) * s;
      const o = ray.origin;
      const d = ray.direction;
      const ox = o.x / w;
      const oy = o.y / h;
      const oz = o.z / w;
      const dx = d.x / w;
      const dy = d.y / h;
      const dz = d.z / w;
      const a = dx * dx + dy * dy + dz * dz;
      const b = 2 * (ox * dx + oy * dy + oz * dz);
      const c = ox * ox + oy * oy + oz * oz - 1;
      const disc = b * b - 4 * a * c;
      const hit = disc >= 0 ? (-b - Math.sqrt(disc)) / (2 * a) : Infinity;
      // A loose end lying on the cocoon is still the loose end.
      if (index >= 0 && best < hit + 0.3) {
        hold.current.index = index;
        return { distance: best, point: ray.at(best, new THREE.Vector3()) };
      }
      hold.current.index = -1;
      if (hit > 0 && hit < Infinity) return { distance: hit, point: ray.at(hit, new THREE.Vector3()) };
      return null;
    },
    grab: (point) => {
      dismissPrompt();
      const h = hold.current;
      if (h.index >= 0 && h.index < spool.tailCount) {
        h.mode = "tail";
        spool.held = h.index;
        spool.hand.x = point.x;
        spool.hand.y = point.y;
        spool.hand.z = point.z;
        sound.play("pluck", { gain: 0.18, pitch: 1.6 });
        return;
      }
      h.mode = "spin";
      h.turned = 0;
      h.last.copy(point);
      // The way the surface moves where it was taken, as the spindle turns forward.
      h.radius = Math.max(0.3, Math.hypot(point.x, point.z));
      h.tx = point.z / h.radius;
      h.tz = -point.x / h.radius;
      sound.play("brush", { gain: 0.25, pitch: 0.9 });
    },
    drag: (point) => {
      const h = hold.current;
      if (h.mode === "tail") {
        spool.hand.x = point.x;
        spool.hand.y = point.y;
        spool.hand.z = point.z;
        return;
      }
      if (h.mode !== "spin") return;
      h.turned += ((point.x - h.last.x) * h.tx + (point.z - h.last.z) * h.tz) / h.radius;
      h.last.copy(point);
    },
    hover: (hovering) => {
      u.tailHover.value = hovering && hold.current.index >= 0 ? 1 : 0;
    },
    release: () => {
      const h = hold.current;
      if (h.mode === "tail") {
        spool.held = -1;
        sound.play("peel", { variant: "silk", gain: 0.15, pitch: 1.3 });
      }
      h.mode = "none";
    }
  });

  useFrame((_, raw) => {
    const dt = Math.min(raw, 1 / 20);
    if (dt <= 0) return;
    spool.clock += dt;
    spool.setPattern(pattern.current as Pattern);
    const h = hold.current;
    const ease = (rate: number) => 1 - Math.exp(-dt * rate);

    // The spindle is a flywheel: a hand on it sets its pace, a pull on the thread turns it, and let go it runs down
    // slowly to the idle turn it keeps.
    if (h.mode === "spin") {
      spool.omega += (h.turned / dt - spool.omega) * ease(22);
      h.turned = 0;
    } else if (h.mode === "tail") {
      spool.omega += (spool.pullTurn / dt - spool.omega) * ease(9);
    } else {
      spool.omega -= spool.omega * 0.28 * dt;
      if (Math.abs(spool.omega) < IDLE_SPIN) spool.omega += ((Math.sign(spool.omega) || 1) * IDLE_SPIN - spool.omega) * ease(0.8);
    }
    spool.pullTurn = 0;
    spool.omega = Math.max(-TOP_SPIN, Math.min(TOP_SPIN, spool.omega));
    spool.turn(spool.omega * dt, h.mode !== "tail");

    // The loose end in steps of no more than a hundred and twentieth of a second.
    const steps = Math.ceil(dt * 120);
    for (let i = 0; i < steps; i++) spool.step(dt / steps, spool.clock);

    const g = group.current;
    if (g) {
      g.rotation.y = spool.theta;
      g.updateMatrixWorld();
      scratch.inverse.copy(g.matrixWorld).invert();
      u.eye.value.copy(camera.position).applyMatrix4(scratch.inverse);
      camera.getWorldDirection(u.facing.value);
      u.facing.value.transformDirection(scratch.inverse);
    }
    u.pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.max(1, size.height);
    u.width.value = tier === "low" ? 0.006 : 0.0038;
    u.focusDistance.value = camera.position.length();
    u.now.value = spool.clock;
    u.outer.value = spool.shell();
    u.glow.value = glow.current;
    u.beat.value = 1 + 0.07 * Math.sin(spool.clock * 1.4) + 0.04 * Math.sin(spool.clock * 0.53);

    // Only the lengths laid or taken since last frame go to the GPU.
    if (spool.dirtyTo >= 0) {
      const lo = spool.dirtyFrom;
      const hi = spool.dirtyTo;
      for (const attribute of wound.attributes) {
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(lo * attribute.itemSize, (hi - lo + 1) * attribute.itemSize);
        attribute.needsUpdate = true;
      }
      spool.dirtyFrom = Infinity;
      spool.dirtyTo = -1;
    }
    wound.geometry.instanceCount = spool.used;

    // The loose end, in the spindle's frame like the rest, finer toward its tip.
    spool.tailInSpindle(tailPoints);
    const n = spool.tailCount;
    const from = tail.from.array as Float32Array;
    const to = tail.to.array as Float32Array;
    const birth = tail.birth.array as Float32Array;
    for (let i = 0; i < n - 1; i++) {
      const k = i * 4;
      const p = i * 3;
      from[k] = tailPoints[p];
      from[k + 1] = tailPoints[p + 1];
      from[k + 2] = tailPoints[p + 2];
      from[k + 3] = 900 + i * STEP;
      to[k] = tailPoints[p + 3];
      to[k + 1] = tailPoints[p + 4];
      to[k + 2] = tailPoints[p + 5];
      to[k + 3] = 0.6 + 1.0 * Math.min(1, (n - 2 - i) / 12);
      birth[i] = -1e4;
    }
    tail.geometry.instanceCount = Math.max(0, n - 1);
    for (const attribute of [tail.from, tail.to, tail.birth]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, Math.max(1, n - 1) * attribute.itemSize);
      attribute.needsUpdate = true;
    }

    // A soft brushing as silk goes on, quicker and brighter the faster it spins; a silky tearing as it comes off.
    const spin = Math.abs(spool.omega);
    if (spool.laid > 0 && spin > 0.8) {
      sound.play("brush", { gain: Math.min(0.28, 0.03 + spin * 0.01), pitch: 0.6 + Math.min(0.9, spin * 0.035), gap: Math.max(0.06, 0.4 - spin * 0.012), pan: 0.25 });
    }
    if (spool.peeled > 0) {
      sound.play("peel", { variant: "silk", gain: Math.min(0.55, 0.12 + spool.peeled * 0.05), pitch: 0.85 + Math.random() * 0.3, gap: 0.07 });
    }
    spool.laid = 0;
    spool.peeled = 0;
  });

  return (
    <>
      <Backdrop top="#141011" horizon="#0b090a" bottom="#040304" />
      <group ref={group}>
        <Pupa u={u} />
        <mesh geometry={wound.geometry} material={material} frustumCulled={false} raycast={() => null} />
        <mesh geometry={tail.geometry} material={material} frustumCulled={false} raycast={() => null} />
      </group>
      <Bead u={u} spool={spool} />
      <Motes count={MOTES[tier]} u={u} />
    </>
  );
}

const silk: Variant = {
  Scene,
  settings: {
    silkPattern: {
      type: "choice",
      label: "Pattern",
      value: "eight",
      options: [
        { value: "eight", label: "Figure eight" },
        { value: "helix", label: "Helix" },
        { value: "chaotic", label: "Wild" }
      ]
    },
    silkColour: {
      type: "choice",
      label: "Silk",
      value: "gold",
      options: [
        { value: "gold", label: "Raw silk", swatch: [COLOURS.gold] },
        { value: "white", label: "White", swatch: [COLOURS.white] },
        { value: "rose", label: "Rose", swatch: [COLOURS.rose] },
        { value: "moon", label: "Moonlight", swatch: [COLOURS.moon] }
      ]
    },
    silkGlow: { type: "range", label: "Glow", min: 0, max: 2, step: 0.01, value: 1, reset: 1 },
    silkFresh: { type: "action", label: "Start fresh" }
  },
  view: { position: [0, 0.35, 5.6], target: [0, 0, 0], fov: 34 },
  look: { background: "#08070a", exposure: 0.95, bloom: 0.18, bloomThreshold: 1.1, ao: 0.6, aoRadius: 0.15, vignette: 0.5, grain: 0.02 },
  hint: "Drag the cocoon sideways to spin it and lay on silk. Grab the loose end and pull to unwind it.",
  notes:
    "A glowing pupa on an invisible spindle, wound in one unbroken thread. Spin it and a guide lays silk across it in crossing passes; pull the loose end and the thread peels back off, turning the spindle as it goes.",
  overview: [
    {
      title: "Winding",
      points: [
        "The cocoon is a single thread of up to ninety thousand points, kept in the spindle's frame so laid silk turns for free.",
        "A guide sways in a figure of eight, a helix or a wandering path while the spindle turns, so each pass crosses the last.",
        "The spindle is a flywheel: a drag sets its pace, and the thread goes on faster the faster it runs."
      ]
    },
    {
      title: "Silk",
      points: [
        "Every length is a strip turned to the eye and shaded as a fibre, so its sheen is a line of light that slides as it turns.",
        "The pupa's glow is filtered out through each turn laid over it, and fresh silk glows as it leaves the guide.",
        "The loose end is a chain of particles adrift in the air; pulled taut, it takes points back off the cocoon."
      ]
    }
  ]
};

export default silk;
