"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { focusBlur, focusDistance } from "../../shared/engine/Post";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSetting } from "../../shared/engine/settings";
import { KeyLight, StudioEnvironment } from "../../shared/engine/studio";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { createDust } from "./dust";
import { clock, FALL, hitForm, PASS, PASSES, RINGS, ringAt, ringCount, ringPower } from "./form";
import { Air, Ash, Backdrop, Form, KEY, look } from "./render";
import { hum, strike } from "./sound";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// A press held this long becomes a hum, which sends out a weaker ring this often while it lasts.
const HOLD = 0.32;
const STREAM = 0.3;
// The stone's notes, a pentatonic run: each strike steps a little from the last.
const SCALE = [293.66, 329.63, 392, 440, 523.25, 587.33];

const DUST_STYLES = [
  { value: "flecks", label: "Flecks" },
  { value: "sparks", label: "Sparks" }
];

const scratch = { ray: new THREE.Ray(), ndc: new THREE.Vector2(), caster: new THREE.Raycaster(), move: new THREE.Vector3() };

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const dustStyle = useSetting<string>("dustStyle");

  const dust = useMemo(() => {
    const low = startTier === "low";
    return createDust(low ? 192 : 256, low ? 96 : 128, low ? 12000 : startTier === "medium" ? 26000 : 40000, low ? 0.14 : 0.24);
  }, [startTier]);

  const state = useRef({
    seconds: 0,
    held: false,
    heldAt: 0,
    humming: false,
    nextStream: 0,
    stop: null as (() => void) | null,
    from: new THREE.Vector3(0, 0, 1),
    rings: [] as { from: THREE.Vector3; at: number; strength: number }[],
    note: 2,
    strikes: 0,
    earned: false,
    salt: 0,
    pointer: { x: 0, y: 0, has: false },
    over: false,
    touching: false,
    hand: new THREE.Vector3(),
    handLast: new THREE.Vector3(),
    handHas: false
  });

  // Both passes run once behind the loader, so neither compiles on the first tap.
  useEffect(() => {
    gl.compute([dust.passes.field, dust.passes.drift] as any);
  }, [gl, dust]);

  useEffect(() => {
    const s = state.current;
    return () => s.stop?.();
  }, []);

  // The pointer, followed over the canvas so it can stir the dust in the air as a hand does smoke.
  useEffect(() => {
    const el = gl.domElement;
    const move = (e: PointerEvent) => {
      const s = state.current;
      const rect = el.getBoundingClientRect();
      s.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      s.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      s.pointer.has = true;
      s.over = e.pointerType === "mouse";
    };
    const leave = () => {
      state.current.over = false;
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") state.current.touching = true;
      move(e);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") state.current.touching = false;
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      el.removeEventListener("pointerleave", leave);
    };
  }, [gl]);

  // A ring leaves from direction `from` now, at the given strength; past the most there is room for, the oldest goes.
  const ring = (from: THREE.Vector3, strength: number) => {
    const s = state.current;
    s.rings.push({ from: from.clone(), at: s.seconds, strength });
    if (s.rings.length > RINGS) s.rings.shift();
  };

  useGrabbable({
    pick: (ray) => hitForm(ray, state.current.seconds),
    grab: (point) => {
      const s = state.current;
      s.held = true;
      s.heldAt = s.seconds;
      s.humming = false;
      s.from.copy(point).normalize();
      dismissPrompt();
      ring(s.from, 1);
      s.note = THREE.MathUtils.clamp(s.note + Math.round((Math.random() - 0.5) * 4), 0, SCALE.length - 1);
      strike(SCALE[s.note], 0.55, PASSES - 1, PASS, FALL);
      s.strikes++;
    },
    // Held and dragged, the hum follows the finger over the form.
    drag: (point) => {
      const s = state.current;
      scratch.ray.origin.copy(camera.position);
      scratch.ray.direction.subVectors(point, camera.position).normalize();
      const hit = hitForm(scratch.ray, s.seconds);
      if (hit) s.from.copy(hit.point).normalize();
    },
    release: () => {
      const s = state.current;
      s.held = false;
      if (s.humming) {
        s.stop?.();
        s.stop = null;
        s.humming = false;
      }
    }
  });

  useFrame((_, raw) => {
    const delta = Math.min(raw, 1 / 20);
    const s = state.current;
    const u = dust.u;
    s.seconds += delta;
    clock.value = s.seconds;
    u.seconds.value = s.seconds;
    u.delta.value = delta;
    s.salt = (s.salt + 7919) % 1000003;
    u.salt.value = s.salt;
    look.dustStyle.value = Math.max(
      0,
      DUST_STYLES.findIndex((d) => d.value === dustStyle)
    );

    // Held, it hums, and sheds a weaker ring from under the finger every little while.
    if (s.held && !s.humming && s.seconds - s.heldAt > HOLD) {
      s.humming = true;
      s.nextStream = s.seconds;
      s.stop = hum(SCALE[s.note] / 2);
    }
    if (s.humming && s.seconds >= s.nextStream) {
      s.nextStream = s.seconds + STREAM;
      ring(s.from, 0.42);
    }

    // The hand in the air: where the pointer's line passes the form's depth, and how fast that point moves.
    const handing = s.pointer.has && (s.over || s.touching);
    if (handing) {
      scratch.ndc.set(s.pointer.x, s.pointer.y);
      scratch.caster.setFromCamera(scratch.ndc, camera);
      const ray = scratch.caster.ray;
      s.hand.copy(ray.origin).addScaledVector(ray.direction, camera.position.length());
      if (s.handHas) {
        scratch.move.subVectors(s.hand, s.handLast).divideScalar(Math.max(delta, 1e-3));
        if (scratch.move.length() > 3) scratch.move.setLength(3);
        u.handMove.value.lerp(scratch.move, 1 - Math.exp(-delta * 18));
      }
      s.handLast.copy(s.hand);
      s.handHas = true;
      u.handFrom.value.copy(ray.origin);
      u.handAlong.value.copy(ray.direction);
    } else {
      s.handHas = false;
      u.handMove.value.multiplyScalar(Math.exp(-delta * 10));
    }
    u.hand.value = handing ? 1 : 0;

    // The live rings, packed into the first slots.
    s.rings = s.rings.filter((r) => s.seconds - r.at < PASSES * PASS + 0.1);
    const at = ringAt.array as THREE.Vector4[];
    const power = ringPower.array as THREE.Vector4[];
    s.rings.forEach((r, k) => {
      at[k].set(r.from.x, r.from.y, r.from.z, r.at);
      power[k].set(r.strength, 0, 0, 0);
    });
    ringCount.value = s.rings.length;

    gl.compute([dust.passes.field, dust.passes.drift] as any);

    focusDistance.value = Math.max(0.6, camera.position.length() - 0.8);
    focusBlur.value = 0.55;

    if (!s.earned && s.strikes >= 4) {
      s.earned = true;
      followPrompt.earn("shed");
      shareResult.set("Struck a stone in the dark and watched rings of sparks peel off it, echoing round");
    }
  });

  const low = startTier === "low";
  return (
    <>
      <Backdrop />
      <StudioEnvironment
        ambient="#070606"
        intensity={0.45}
        boxes={[
          { position: [-6, 6, 4], scale: [4, 4, 0.2], color: "#ffe6cc", intensity: 2.6 },
          { position: [7, 2, -5], scale: [0.2, 5, 3], color: "#d4dcf0", intensity: 1.4 },
          { position: [0, 8, 0], scale: [5, 0.2, 5], color: "#fff4e8", intensity: 0.5 },
          { position: [2, -6, 3], scale: [5, 0.2, 5], color: "#3a2c22", intensity: 0.4 },
          { position: [3, 1, 8], scale: [4, 3, 0.2], color: "#fff6ec", intensity: 0.7 }
        ]}
      />
      <KeyLight position={[KEY.x, KEY.y, KEY.z]} target={[0, 0, 0]} color="#ffe2c4" intensity={180} angle={0.36} penumbra={0.75} shadowFar={14} />
      <RimLight />
      <Form detail={low ? 72 : startTier === "medium" ? 110 : 150} dust={dust} />
      <Ash dust={dust} />
      <Air dust={low ? 1000 : 2600} />
    </>
  );
}

// A cool light from behind on the right, outlining the far edge against the dark.
function RimLight() {
  const light = useMemo(() => {
    const l = new THREE.DirectionalLight("#dfe6f4", 2.4);
    l.position.set(4, 2.5, -5);
    return l;
  }, []);
  useDispose(light);
  return <primitive object={light} />;
}

const PHONE = typeof window !== "undefined" && window.matchMedia("(max-width: 900px), (hover: none)").matches;

const day: DayDefinition = {
  camera: {
    position: [1.3, 0.55, 5.5],
    target: [0, 0, 0],
    fov: 34,
    limits: { turn: { left: 80, right: 80, up: 55, down: 55 }, move: 0.6 },
    phone: { position: [1.45, 0.65, 7.3], target: [0, 0, 0], fov: 42 }
  },
  hover: true,
  extents: { centre: [0, 0, 0], radius: 12, color: "#ffd7b0" },
  look: { background: "#000000", exposure: 1.1, bloom: 0.32, bloomThreshold: 1.1, gi: 0, ao: 1, aoRadius: 0.18, vignette: 0.6, grain: 0.014, haze: 0 },
  passes: { bounce: false, haze: false, overlay: true },
  settings: {
    dustStyle: { type: "choice", label: "Dust", value: "flecks", options: DUST_STYLES }
  },
  phonePills: ["dustStyle"],
  prompt: { title: "Tap the stone", detail: "Hold to make it hum", ...(PHONE ? { low: true } : { high: true }) },
  hint: "Tap the stone: a ring runs round it, shaking off its dust, meets itself on the far side and echoes back. Hold to make it hum.",
  notes: "A dust-coated stone struck in the dark: each ring runs round it, sheds a layer of sparks, and echoes back weaker until the dust settles again.",
  overview: [
    { title: "Rings", points: ["Each strike is a front at a growing angle from the struck point; it closes at the far pole and runs back, each pass 0.58 of the last", "The surface ripples as it passes, normals from the exact gradient of the shape plus the ripple"] },
    { title: "Dust", points: ["A 256×128 skin map on the GPU: every texel sheds where a front passes and lets that dust go as motes", "Erosion's motes: ember sparks cooling to tumbling flecks on the eddies, drifting back to settle on the stone"] }
  ],
  Scene
};

export default day;
