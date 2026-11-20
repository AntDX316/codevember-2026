"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSetting, useSettingAction } from "../../shared/engine/settings";
import { sound, useBed } from "../../shared/engine/sound";
import { KeyLight, StudioEnvironment } from "../../shared/engine/studio";
import { Backdrop, focus, usePointerRay, type Variant } from "../kit";
import { Atmosphere } from "./atmosphere";
import { BACKGROUND, Floor, Rings } from "./frame";
import { Loom, RING_TUBE, type Pluck, type ScaleName } from "./sim";
import { COLOURS, KEY_FROM, Strings, type ColourName } from "./strings";

const UP = new THREE.Vector3(0, 1, 0);

function Scene() {
  const { tier } = useQuality();
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const wanted = useSetting<number>("loomStrings") ?? 192;
  const colourName = useSetting<ColourName>("loomColour") ?? "moonlight";
  const scale = useSetting<ScaleName>("loomScale") ?? "pentatonic";
  const count = tier === "low" ? Math.min(wanted, 168) : wanted;

  // A new count of strings is a new loom, but the rings stay where the hand left them.
  const last = useRef<Loom | null>(null);
  const loom = useMemo(() => {
    const next = new Loom(count, "pentatonic");
    if (last.current) next.rings = last.current.rings.map((r) => ({ ...r, held: false }));
    return next;
  }, [count]);
  useEffect(() => {
    last.current = loom;
  }, [loom]);
  useEffect(() => loom.tune(scale), [loom, scale]);

  const look = useMemo(() => ({ colour: new THREE.Color(), neon: { value: 0 }, floor: new THREE.Color() }), []);
  useEffect(() => {
    const c = COLOURS[colourName] ?? COLOURS.moonlight;
    look.colour.set(c.string).convertSRGBToLinear();
    look.floor.set(c.floor).convertSRGBToLinear();
    look.neon.value = colourName === "neon" ? 1 : 0;
  }, [colourName, look]);

  useEffect(() => {
    focus.point.set(0, 0, 0);
    focus.blur = 0.7;
  }, []);

  useSettingAction("loomUntwist", () => {
    loom.reset();
    sound.play("creak", { gain: 0.3, pitch: 0.7 });
  });

  // Taking hold of a ring: whichever ring the ray passes nearest, tested at points all round it.
  const hover = useMemo(() => ({ ring: -1, glow: [0, 0, 0], on: false }), []);
  const hand = useMemo(
    () => ({
      picked: { ring: -1, angle: 0 },
      ring: -1,
      offset: 0,
      last: new THREE.Vector3(),
      point: new THREE.Vector3(),
      delta: new THREE.Vector3(),
      forward: new THREE.Vector3(),
      right: new THREE.Vector3(),
      tangent: new THREE.Vector3()
    }),
    []
  );
  useGrabbable({
    pick: (ray) => {
      let best: { distance: number; point: THREE.Vector3 } | null = null;
      hand.picked.ring = -1;
      for (let ring = 0; ring < 3; ring++) {
        const r = loom.radius(ring);
        const y = loom.height(ring);
        const reach = RING_TUBE[ring] + 0.07;
        for (let k = 0; k < 96; k++) {
          const a = (k / 96) * Math.PI * 2;
          hand.point.set(r * Math.cos(a), y, r * Math.sin(a));
          if (ray.distanceSqToPoint(hand.point) > reach * reach) continue;
          const distance = ray.origin.distanceTo(hand.point);
          if (best && distance >= best.distance) continue;
          best = { distance, point: hand.point.clone() };
          hand.picked.ring = ring;
          hand.picked.angle = a;
        }
      }
      return best;
    },
    grab: (point) => {
      const ring = hand.picked.ring;
      if (ring < 0) return;
      hand.ring = ring;
      // Where on the ring the hand is, in the ring's own frame, so it stays under the hand as the ring turns.
      hand.offset = hand.picked.angle - loom.rings[ring].angle;
      hand.last.copy(point);
      loom.grab(ring);
      dismissPrompt();
      sound.play("click", { gain: 0.25, pitch: 0.7 });
    },
    drag: (point) => {
      const ring = hand.ring;
      if (ring < 0) return;
      const delta = hand.delta.subVectors(point, hand.last);
      hand.last.copy(point);
      // The ring turns so that the point held follows the hand across the screen: the way that point would move, as seen.
      const a = loom.rings[ring].target + hand.offset;
      camera.getWorldDirection(hand.forward);
      hand.right.crossVectors(hand.forward, UP).normalize();
      const t = hand.tangent.set(-Math.sin(a), 0, Math.cos(a));
      t.addScaledVector(hand.forward, -t.dot(hand.forward));
      const seen = t.length();
      // Held at the edge of the ring as seen, where it turns toward the eye, a sideways drag still turns it.
      if (seen < 0.5) {
        const outward = Math.cos(a) * hand.right.x + Math.sin(a) * hand.right.z;
        t.addScaledVector(hand.right, -(outward >= 0 ? 1 : -1) * (0.5 - seen));
      }
      const by = delta.dot(t) / (loom.radius(ring) * Math.max(0.2, t.lengthSq()));
      loom.turn(ring, by, delta.dot(UP));
    },
    release: () => {
      if (hand.ring >= 0) loom.release(hand.ring);
      hand.ring = -1;
    },
    hover: (on) => {
      hover.on = on;
    }
  });

  // Plucking: the pointer passing over a string, held or not.
  const pointer = usePointerRay();
  const sweep = useMemo(
    () => ({
      ndc: new THREE.Vector2(),
      origin: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      known: false,
      now: new THREE.Vector3(),
      then: new THREE.Vector3(),
      screen: new THREE.Vector3(),
      queue: [] as Pluck[],
      lastNote: 0,
      bed: 0
    }),
    []
  );
  const bed = useBed("shimmer", 0);

  useFrame((_, rawDelta) => {
    const dt = Math.min(rawDelta, 1 / 30);
    loom.update(dt);
    hover.ring = hover.on ? hand.picked.ring : -1;

    const held = loom.rings.some((r) => r.held);
    if (!pointer.active || held) {
      sweep.known = false;
      loom.forgetSides();
    } else {
      const moved = sweep.known ? pointer.ndc.distanceTo(sweep.ndc) : 0;
      const speed = moved / Math.max(dt, 1e-3);
      const strength = THREE.MathUtils.clamp(speed / 2.5, 0.2, 1);
      loom.sweep(pointer.ray.origin, pointer.ray.direction, moved > 1e-4, (span, along, depth) => {
        // The way the hand went, at the string's depth: the way it is drawn aside.
        sweep.now.copy(pointer.ray.origin).addScaledVector(pointer.ray.direction, depth);
        sweep.then.copy(sweep.origin).addScaledVector(sweep.dir, depth);
        const m = sweep.then.subVectors(sweep.now, sweep.then);
        loom.pluck(span, along, 0.012 + 0.045 * strength, m.x, m.y + 1e-5, m.z);
        dismissPrompt();
        const pitch = loom.pitch[span];
        if (sweep.queue.length < 6 && !sweep.queue.some((q) => q.pitch === pitch)) {
          const pan = THREE.MathUtils.clamp(sweep.screen.copy(sweep.now).project(camera).x * 0.7, -0.8, 0.8);
          sweep.queue.push({ pitch, gain: 0.22 + 0.4 * strength, pan, size: 0.45 + 0.5 * strength });
        }
      });
      sweep.ndc.copy(pointer.ndc);
      sweep.origin.copy(pointer.ray.origin);
      sweep.dir.copy(pointer.ray.direction);
      sweep.known = true;
    }

    // A quick sweep crosses many strings in a frame: their notes go out one after another, a glissando, not a clang.
    const time = performance.now() / 1000;
    if (sweep.queue.length && time - sweep.lastNote > 0.03) {
      const note = sweep.queue.shift() as Pluck;
      sound.play("pluck", { ...note, gap: 0.028 });
      sweep.lastNote = time;
    }

    // Twisting creaks, higher the tighter it is wound.
    if (loom.creak.turned > 0.3) {
      if (loom.creak.speed > 0.4) sound.play("creak", { gain: THREE.MathUtils.clamp(loom.creak.speed * 0.07, 0.05, 0.32), pitch: 0.7 + loom.twist() * 0.55, gap: 0.09 });
      loom.creak.turned = 0;
    }

    // Everything still ringing hums on together, faintly.
    const level = Math.min(0.32, loom.energy * 0.004);
    if (Math.abs(level - sweep.bed) > 0.01) {
      sweep.bed = level;
      bed.current?.level(level, 0.6);
    }
  });

  const steps = tier === "high" ? 28 : tier === "medium" ? 20 : 12;
  const energy = useMemo(
    () => ({
      get value() {
        return loom.energy;
      }
    }),
    [loom]
  );

  return (
    <>
      <Backdrop top="#0e0f15" horizon="#09090c" bottom="#050506" />
      <StudioEnvironment
        ambient="#050608"
        intensity={0.9}
        boxes={[
          { position: [0, 7, 0], scale: [5, 0.2, 5], color: "#fff1e0", intensity: 2.2 },
          { position: [-6, 1.5, 1.5], scale: [0.2, 6, 1.2], color: "#9fb8ff", intensity: 2.6 },
          { position: [6, 2, -2], scale: [0.2, 6, 1.4], color: "#ffc890", intensity: 2.6 },
          { position: [0, 1.5, -8], scale: [6, 3, 0.2], color: "#ffffff", intensity: 0.35 }
        ]}
      />
      <KeyLight position={[KEY_FROM.x, KEY_FROM.y, KEY_FROM.z]} target={[0, 0, 0]} color="#fff0dc" intensity={240} angle={0.42} penumbra={0.85} />
      <Rings loom={loom} beads={tier !== "low"} hover={hover} />
      <Strings key={`${count}-${steps}`} loom={loom} steps={steps} look={look} />
      <Atmosphere tier={tier} tint={look.colour} energy={energy} />
      <Floor tint={look.floor} energy={energy} mirrorScale={tier === "high" ? 0.5 : tier === "medium" ? 0.35 : 0.25} />
    </>
  );
}

const loomVariant: Variant = {
  Scene,
  settings: {
    loomStrings: { type: "range", label: "Strings", min: 120, max: 300, step: 12, value: 192, phoneMax: 168, short: "Strings" },
    loomColour: {
      type: "choice",
      label: "Colour",
      value: "moonlight",
      options: [
        { value: "moonlight", label: "Moonlight", swatch: ["#b8cdf2", "#0b0d14"] },
        { value: "gold", label: "Gold", swatch: ["#ffc163", "#2a1c08"] },
        { value: "neon", label: "Neon", swatch: ["#ff4d6d", "#ffd23f", "#3ddc97", "#4d8bff", "#b04dff"] }
      ]
    },
    loomScale: {
      type: "choice",
      label: "Scale",
      value: "pentatonic",
      options: [
        { value: "pentatonic", label: "Pentatonic" },
        { value: "wholeTone", label: "Whole tone", short: "Whole" },
        { value: "hirajoshi", label: "Hirajoshi" },
        { value: "lydian", label: "Lydian" }
      ]
    },
    loomUntwist: { type: "action", label: "Untwist" }
  },
  view: { position: [0, 0.55, 6.4], target: [0, -0.12, 0], fov: 36 },
  look: { background: BACKGROUND, exposure: 1.05, bloom: 0.55, bloomThreshold: 0.6, ao: 0, vignette: 0.42, grain: 0.02 },
  hint: "Sweep across the strings to play them like a harp. Grab a brass ring and twist it to reshape the cocoon.",
  notes:
    "A cocoon of light strung like string art: every string runs from a top ring through the waist ring to the bottom ring, and twisting a ring bends the straight lines into a curved surface. Each string vibrates and sounds its own note when plucked.",
  overview: [
    {
      title: "String art",
      points: [
        "Each string is two straight spans, top ring to waist ring and waist ring to bottom ring. Twisting a ring against the waist turns each half from a cone into a rounded hyperboloid, then a pinch, then a point where every string crosses the axis.",
        "The rings have inertia and friction. Wound past half a turn they push back, and Untwist winds them home on a spring."
      ]
    },
    {
      title: "Plucking",
      points: [
        "The pointer is a ray. A string is plucked when the ray passes from one side of it to the other between frames, found by checking which side of each span the ray is on.",
        "Each span vibrates as four standing-wave modes in two directions, started from the triangle a finger makes. Each mode turns and decays as a complex number, so it stays stable at any frame rate. The vibration is slowed right down so you can see the wave.",
        "Notes follow position round the rings, rising to the far side and back down, with the upper half an octave above the lower. A fast sweep plays as a glissando rather than every note at once."
      ]
    },
    {
      title: "Light",
      points: [
        "The strings are camera-facing strips bent on the GPU by their modes, never thinner than a pixel. They brighten while they vibrate and catch a fine highlight wherever they run square to the light.",
        "Polished brass rings and a black lacquer floor that reflects the strings, with a faint pool of their light beneath."
      ]
    }
  ]
};

export default loomVariant;
