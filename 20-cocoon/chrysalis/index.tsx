"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGrabbable } from "../../shared/engine/controls";
import { dismissPrompt } from "../../shared/engine/prompt";
import { useQuality } from "../../shared/engine/quality";
import { useSetting, useSettingAction, useSettingRef } from "../../shared/engine/settings";
import { sound } from "../../shared/engine/sound";
import { KeyLight, StudioEnvironment } from "../../shared/engine/studio";
import { Backdrop, focus, type Variant } from "../kit";
import { Creature } from "./creature";
import { Motes, Thread, Twig } from "./hanging";
import { DISSOLVE, makeLive, MAX_TAPS, WINGS } from "./live";
import { DROP, hitPod, PIVOT } from "./shape";
import { Shell } from "./shell";
import { SKIN_OPTIONS, SKINS } from "./skins";

// A jewel of a chrysalis hanging from a twig in the dark, its sleeper's heartbeat glowing through jade flesh. Pull it
// to swing it on its thread. Tap it and the skin ripples and gold cracks spread from the tap; enough taps and it splits,
// its pieces folding back or falling, and a creature of light unfolds out of it, then comes apart into sparks. Before
// long the shell gathers itself back together, whole again.

// How the creature's three wings open: where each is hinged, how far it is raised (about the axis out of the wing) and
// swept back once open, and how long after the first it starts.
const WING_OPEN = [
  { hinge: new THREE.Vector3(0.035, 0.12, 0), raise: 0.62, sweep: -0.32, delay: 0 },
  { hinge: new THREE.Vector3(0.03, 0.0, -0.02), raise: -0.42, sweep: -0.12, delay: 0.18 },
  { hinge: new THREE.Vector3(0.02, -0.1, -0.03), raise: -1.18, sweep: 0.2, delay: 0.4 }
];
// Folded inside the shell: hanging down along the body.
const FOLDED_RAISE = -1.5;
const FOLDED_SWEEP = -0.15;
// Seconds from splitting to coming apart, and to the shell gathering itself again.
const LINGER = 8.8;
const REFORM_AFTER = 17;
const REFORM_TIME = 2.6;
// The swing: gravity over the length to the pod's middle, for a slow, heavy sway, and the thread's resistance to twist.
const SWING = 6.5;
const SWING_DAMP = 0.32;
const TWIST_SPRING = 10;
const TWIST_DAMP = 1.4;

type Phase = "whole" | "open" | "reform";

const smooth = (a: number, b: number, x: number) => THREE.MathUtils.smoothstep(x, a, b);

function Scene() {
  const { tier } = useQuality();
  const camera = useThree((state) => state.camera);
  const live = useMemo(() => makeLive(), []);
  const skinName = useSetting<string>("chrysalisSkin");
  const need = useSettingRef<number>("chrysalisTaps");
  const pivot = useRef<THREE.Group>(null);
  const pod = useRef<THREE.Mesh>(null);
  const glow = useRef<THREE.PointLight>(null);
  const spirit = useRef<THREE.PointLight>(null);

  const rim = useMemo(() => {
    const light = new THREE.SpotLight("#a9d0ff", 40, 0, 0.5, 0.9, 2);
    light.position.set(-2.9, 2.6, -3.7);
    light.target.position.set(0, 0.3, 0);
    return light;
  }, []);
  const warm = useMemo(() => {
    const light = new THREE.SpotLight("#ffc890", 14, 0, 0.5, 1, 2);
    light.position.set(3.4, -0.6, -3);
    light.target.position.set(0, 0.2, 0);
    return light;
  }, []);
  useEffect(() => {
    rim.target.updateMatrixWorld();
    warm.target.updateMatrixWorld();
    return () => {
      rim.dispose();
      warm.dispose();
    };
  }, [rim, warm]);

  useEffect(() => {
    const s = SKINS[skinName] ?? SKINS.jade;
    live.skin.value.set(s.skin);
    live.mottle.value.set(s.mottle);
    live.absorb.value.set(...s.absorb);
    live.glow.value.set(s.glow);
    live.strength.value = s.strength;
    live.seam.value.set(s.seam);
    live.gold.value.set(s.gold);
    live.wing.value.set(s.wing);
    const material = pod.current?.material as THREE.MeshPhysicalNodeMaterial | undefined;
    if (material) material.iridescence = s.film;
    glow.current?.color.set(s.glow);
    spirit.current?.color.set(s.wing);
  }, [skinName, live, tier]);

  const sim = useMemo(
    () => ({
      now: 0,
      ax: 0.05,
      az: -0.03,
      vx: 0,
      vz: 0.12,
      tw: 0,
      vt: 0.2,
      held: false,
      grabLocal: new THREE.Vector3(),
      target: new THREE.Vector3(),
      start: new THREE.Vector3(),
      grabAt: 0,
      travelled: 0,
      tapAt: new THREE.Vector3(),
      hitWorld: new THREE.Vector3(),
      phase: "whole" as Phase,
      count: 0,
      splitAt: -1,
      openAt: 0,
      reformAt: 0,
      shardOut: 0,
      dissolveAt: 1e6,
      beatPhase: 0,
      agitation: 0,
      queue: [] as { at: number; play: () => void }[],
      spawn: new THREE.Vector3(),
      forward: new THREE.Vector3()
    }),
    []
  );
  const scratch = useMemo(
    () => ({
      ray: new THREE.Ray(),
      inverse: new THREE.Matrix4(),
      local: new THREE.Vector3(),
      world: new THREE.Vector3(),
      force: new THREE.Vector3(),
      arm: new THREE.Vector3(),
      torque: new THREE.Vector3(),
      axis: new THREE.Vector3(),
      euler: new THREE.Euler(),
      q: new THREE.Quaternion(),
      qa: new THREE.Quaternion(),
      qb: new THREE.Quaternion(),
      x: new THREE.Vector3(1, 0, 0),
      y: new THREE.Vector3(0, 1, 0),
      z: new THREE.Vector3(0, 0, 1),
      centre: new THREE.Vector3()
    }),
    []
  );

  const later = (seconds: number, play: () => void) => sim.queue.push({ at: sim.now + seconds, play });

  const startReform = () => {
    if (sim.phase === "reform") return;
    if (sim.phase === "whole" && sim.count === 0 && sim.splitAt < 0) return;
    sim.splitAt = -1;
    sim.shardOut = sim.phase === "open" ? Math.min(sim.now - sim.openAt, 3.2) : 0;
    sim.phase = "reform";
    sim.reformAt = sim.now;
    // Whatever is left of the creature goes to light now.
    if (sim.dissolveAt > sim.now) {
      sim.dissolveAt = sim.now;
      live.dissolveAt.value = sim.now;
    }
    sound.play("whoosh", { gain: 0.25, pitch: 0.55 });
    sound.play("fold", { gain: 0.3, pitch: 0.8 });
    later(REFORM_TIME * 0.85, () => {
      sound.play("chime", { gain: 0.3, pitch: 0.75 });
      sound.play("click", { gain: 0.25, pitch: 0.7 });
    });
  };
  useSettingAction("chrysalisRegrow", startReform);

  const split = () => {
    sim.phase = "open";
    sim.openAt = sim.now;
    sim.splitAt = -1;
    sim.dissolveAt = sim.now + LINGER;
    live.dissolveAt.value = sim.dissolveAt;
    // The creature rises from where the pod's middle was, a little towards the eye, and floats free of the swing.
    pod.current?.getWorldPosition(sim.spawn);
    sim.forward.subVectors(camera.position, sim.spawn).setY(0);
    if (sim.forward.lengthSq() > 1e-6) sim.forward.normalize().multiplyScalar(0.4);
    sound.play("shatter", { gain: 0.7, size: 0.5 });
    later(0.12, () => sound.play("tinkle", { gain: 0.55 }));
    later(0.45, () => sound.play("tinkle", { gain: 0.35, pitch: 1.3 }));
    later(0.55, () => sound.play("whoosh", { gain: 0.3, pitch: 1.4 }));
    later(1.0, () => sound.play("chime", { gain: 0.55, pitch: 1 }));
    later(1.7, () => sound.play("chime", { gain: 0.35, pitch: 1.5 }));
    later(LINGER, () => sound.play("chime", { gain: 0.3, pitch: 2 }));
    later(LINGER + 0.4, () => sound.play("tinkle", { gain: 0.3, pitch: 1.6 }));
  };

  const tap = () => {
    // A tap knocks it a little away from the eye, and turns it a touch.
    const push = scratch.force.subVectors(sim.hitWorld, camera.position).normalize().multiplyScalar(0.55);
    const arm = scratch.arm.subVectors(sim.hitWorld, PIVOT);
    const torque = scratch.torque.crossVectors(arm, push);
    sim.vx += torque.x;
    sim.vz += torque.z;
    sim.vt += (Math.random() - 0.5) * 0.6;
    if (sim.phase !== "whole" || sim.splitAt >= 0) {
      sound.play("tick", { gain: 0.25, pitch: 0.9 });
      return;
    }
    const slot = Math.min(sim.count, MAX_TAPS - 1);
    (live.taps.array[slot] as THREE.Vector4).set(sim.tapAt.x, sim.tapAt.y, sim.tapAt.z, sim.now);
    sim.count = Math.min(sim.count + 1, MAX_TAPS);
    sim.agitation = Math.min(2.5, sim.agitation + 0.55);
    const goal = Math.max(1, Math.min(MAX_TAPS, Math.round(need.current ?? 5)));
    sound.play("tick", { gain: 0.45, pitch: 1.5 });
    sound.play("crack", { gain: 0.2 + sim.count * 0.05, pitch: 1.35 - sim.count * 0.04 });
    if (sim.count >= goal) {
      sim.splitAt = sim.now + 0.55;
      later(0.15, () => sound.play("crack", { gain: 0.6, pitch: 0.8 }));
      later(0.35, () => sound.play("crack", { gain: 0.5, pitch: 0.65 }));
    }
  };

  useGrabbable({
    pick: (ray) => {
      const mesh = pod.current;
      if (!mesh || sim.phase === "reform") return null;
      scratch.inverse.copy(mesh.matrixWorld).invert();
      const local = scratch.ray.copy(ray).applyMatrix4(scratch.inverse);
      local.direction.normalize();
      if (hitPod(local, scratch.local) === null) return null;
      // Once open, only the petals still hanging can be caught.
      if (sim.phase === "open" && scratch.local.y < 0.1) return null;
      sim.tapAt.copy(scratch.local);
      const point = mesh.localToWorld(scratch.world.copy(scratch.local));
      sim.hitWorld.copy(point);
      return { distance: ray.origin.distanceTo(point), point: point.clone() };
    },
    grab: (point) => {
      if (!pivot.current) return;
      dismissPrompt();
      sim.held = true;
      sim.grabLocal.copy(point);
      pivot.current.worldToLocal(sim.grabLocal);
      sim.target.copy(point);
      sim.start.copy(point);
      sim.grabAt = sim.now;
      sim.travelled = 0;
    },
    drag: (point) => {
      sim.target.copy(point);
      const moved = point.distanceTo(sim.start);
      if (moved > 0.04 && sim.travelled <= 0.04) sound.play("peel", { variant: "silk", gain: 0.18, pitch: 1.3 });
      sim.travelled = Math.max(sim.travelled, moved);
    },
    release: () => {
      sim.held = false;
      if (sim.travelled < 0.035 && sim.now - sim.grabAt < 0.4) {
        tap();
        return;
      }
      const speed = Math.hypot(sim.vx, sim.vz);
      if (speed > 0.4) sound.play("whoosh", { gain: Math.min(0.45, speed * 0.15), pitch: 0.8 });
    }
  });

  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 30);
    sim.now += dt;
    const now = sim.now;
    live.now.value = now;
    for (let i = sim.queue.length - 1; i >= 0; i--) {
      if (sim.queue[i].at <= now) {
        const event = sim.queue[i];
        sim.queue.splice(i, 1);
        event.play();
      }
    }

    // The swing: a heavy pendulum both ways and a twist on the thread, drawn by a spring towards the hand while held.
    const group = pivot.current;
    const mesh = pod.current;
    if (!group || !mesh) return;
    const steps = 2;
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      let tx = 0;
      let tz = 0;
      let ty = 0;
      let hold = 0;
      if (sim.held) {
        group.updateMatrixWorld();
        const at = group.localToWorld(scratch.world.copy(sim.grabLocal));
        const force = scratch.force.subVectors(sim.target, at);
        if (force.length() > 1.2) force.setLength(1.2);
        force.multiplyScalar(26);
        const arm = scratch.arm.subVectors(at, PIVOT);
        const torque = scratch.torque.crossVectors(arm, force);
        const along = scratch.axis.set(0, 1, 0).applyQuaternion(group.quaternion);
        tx = torque.x;
        tz = torque.z;
        ty = torque.dot(along);
        hold = 3.2;
      }
      sim.vx += (-SWING * Math.sin(sim.ax) - (SWING_DAMP + hold) * sim.vx + tx / 1.3) * h;
      sim.vz += (-SWING * Math.sin(sim.az) - (SWING_DAMP + hold) * sim.vz + tz / 1.3) * h;
      sim.vt += (-TWIST_SPRING * sim.tw - TWIST_DAMP * sim.vt + ty * 0.35) * h;
      sim.ax += sim.vx * h;
      sim.az += sim.vz * h;
      sim.tw += sim.vt * h;
      for (const key of ["ax", "az"] as const) {
        const v = key === "ax" ? "vx" : "vz";
        if (Math.abs(sim[key]) > 1.25) {
          sim[key] = Math.sign(sim[key]) * 1.25;
          sim[v] *= -0.2;
        }
      }
      sim.tw = THREE.MathUtils.clamp(sim.tw, -1.4, 1.4);
    }
    group.quaternion.setFromEuler(scratch.euler.set(sim.ax, sim.tw, sim.az, "XZY"));
    group.updateMatrixWorld();
    live.camPod.value.copy(camera.position);
    mesh.worldToLocal(live.camPod.value);

    // The heartbeat: lub-dub, quickening with each tap and settling again.
    sim.agitation *= Math.exp(-dt * 0.22);
    const before = Math.floor(sim.beatPhase);
    sim.beatPhase += dt * (0.72 + sim.agitation * 0.45);
    const f = sim.beatPhase % 1;
    const beat = Math.exp(-Math.pow((f - 0.06) / 0.05, 2)) + 0.6 * Math.exp(-Math.pow((f - 0.27) / 0.065, 2));
    if (Math.floor(sim.beatPhase) !== before && sim.phase === "whole") sound.play("thud", { gain: 0.035 + sim.agitation * 0.025, pitch: 0.55, size: 0.9 });

    if (sim.splitAt >= 0 && now >= sim.splitAt) split();

    let shardT = 0;
    let intact = 1;
    let flare = 0;
    let heal = 1;
    if (sim.splitAt >= 0) flare = Math.pow(1 - (sim.splitAt - now) / 0.55, 2);
    const since = now - sim.openAt;
    if (sim.phase === "open") {
      shardT = Math.min(since, 3.2);
      intact = 1 - smooth(0, 0.35, since);
      flare = Math.exp(-since * 3);
      if (since > REFORM_AFTER) startReform();
    } else if (sim.phase === "reform") {
      const r = (now - sim.reformAt) / REFORM_TIME;
      const e = smooth(0, 1, r);
      shardT = sim.shardOut * (1 - e);
      intact = sim.shardOut > 0 ? smooth(0.6, 0.95, r) : 1;
      flare = Math.sin(Math.PI * Math.min(1, r)) * 0.8;
      heal = 1 - smooth(0.7, 1.05, r);
      if (r >= 1.1) {
        sim.phase = "whole";
        sim.count = 0;
        for (const v of live.taps.array as THREE.Vector4[]) v.set(0, 0, 0, -1000);
        heal = 1;
        flare = 0;
      }
    }
    live.shardT.value = shardT;
    live.intact.value = intact;
    live.flare.value = flare;
    live.heal.value = heal;
    live.cracked.value = sim.count > 0 || flare > 0 || sim.phase !== "whole" ? 1 : 0;
    live.beat.value = beat * (0.35 + 0.65 * intact) * (1 + sim.agitation * 0.25);

    // The creature: unfolding wing by wing after it breaks, breathing, then coming apart from the tips.
    const opened = sim.dissolveAt < 1e5 ? now - (sim.dissolveAt - LINGER) : -1;
    const apart = now - sim.dissolveAt;
    const present = opened > 0 && apart < DISSOLVE + 7.5;
    live.shown.value = present ? smooth(0.25, 0.7, opened) : 0;
    if (present) {
      const wings = live.wingPose.array as THREE.Vector4[];
      const turns = live.wingTurn.array as THREE.Vector4[];
      const settle = 1 - smooth(0, DISSOLVE, apart);
      for (let i = 0; i < WINGS; i++) {
        const w = WING_OPEN[i];
        const e = THREE.MathUtils.clamp((opened - 0.4 - w.delay) / 2.6, 0, 1);
        const p = 1 - Math.pow(1 - e, 3);
        const beatOf = Math.sin(now * 1.35 + i * 0.6) * 0.14 * p * settle;
        const raise = THREE.MathUtils.lerp(FOLDED_RAISE, w.raise, p) + beatOf * 0.5;
        const sweep = THREE.MathUtils.lerp(FOLDED_SWEEP, w.sweep, p) + beatOf;
        scratch.qa.setFromAxisAngle(scratch.y, sweep);
        scratch.qb.setFromAxisAngle(scratch.z, raise);
        scratch.q.copy(scratch.qa).multiply(scratch.qb);
        turns[i].set(scratch.q.x, scratch.q.y, scratch.q.z, scratch.q.w);
        wings[i].set(w.hinge.x, w.hinge.y, w.hinge.z, p);
      }
      live.flap.value = smooth(1.2, 3.2, opened) * settle;
      live.yaw.value = Math.sin(opened * 0.33) * 0.45;
      live.origin.value.copy(sim.spawn).addScaledVector(sim.forward, smooth(0.3, 3.5, opened)).add(scratch.centre.set(0, 0.32 * smooth(0.3, 5, opened), 0));
    }

    // Light: the glow inside throws a little onto the twig and shell; the creature's own light once it is out.
    if (glow.current) glow.current.intensity = (0.12 + beat * 0.35) * intact * live.strength.value + flare * 0.6;
    if (spirit.current) {
      spirit.current.position.copy(live.origin.value);
      spirit.current.intensity = live.shown.value * 1.6 * (1 - smooth(0, DISSOLVE, apart));
    }
    // The lens follows the pod, and the creature while it is out.
    mesh.getWorldPosition(scratch.centre);
    focus.point.lerpVectors(scratch.centre, live.origin.value, present ? smooth(0, 1.5, opened) * (1 - smooth(0, DISSOLVE + 2, apart)) : 0);
    focus.blur = 1;
  });

  return (
    <>
      <Backdrop top="#0c1311" horizon="#090d0c" bottom="#030404" />
      <StudioEnvironment
        intensity={0.9}
        ambient="#030405"
        boxes={[
          { position: [0, 6, 3], scale: [6, 0.2, 4], color: "#fff3e2", intensity: 1.6 },
          { position: [-6, 1.5, -2], scale: [0.2, 5, 1.5], color: "#9ec3ff", intensity: 1.5 },
          { position: [6, 2, -3], scale: [0.2, 4, 1.2], color: "#ffd2a0", intensity: 1.6 },
          { position: [0, 1, -7], scale: [3, 4, 0.2], color: "#3a5a48", intensity: 0.8 },
          { position: [0, -5, 0], scale: [10, 0.2, 10], color: "#0c1210", intensity: 0.5 }
        ]}
      />
      <KeyLight position={[3.2, 4.2, 3.6]} target={[0, 0.4, 0]} color="#ffeedd" intensity={150} angle={0.42} penumbra={0.9} shadowFar={14} />
      <primitive object={rim} />
      <primitive object={rim.target} />
      <primitive object={warm} />
      <primitive object={warm.target} />
      <Twig />
      <group ref={pivot} position={PIVOT.toArray()}>
        <Thread />
        <group position={[0, -DROP, 0]}>
          <Shell ref={pod} live={live} tier={tier} />
          <pointLight ref={glow} color="#c9ff9a" intensity={0.2} distance={0} decay={2} />
        </group>
      </group>
      <pointLight ref={spirit} color="#9fffe0" intensity={0} distance={0} decay={2} />
      <Creature live={live} tier={tier} />
      <Motes live={live} tier={tier} />
    </>
  );
}

const chrysalis: Variant = {
  Scene,
  settings: {
    chrysalisSkin: { type: "choice", label: "Skin", options: SKIN_OPTIONS, value: "jade" },
    chrysalisTaps: { type: "range", label: "Taps to hatch", min: 2, max: MAX_TAPS, step: 1, value: 5 },
    chrysalisRegrow: { type: "action", label: "Regrow" }
  },
  view: { position: [0.9, 0.6, 5.5], target: [0, 0.32, 0], fov: 34 },
  look: { background: "#050706", exposure: 1.1, bloom: 0.5, bloomThreshold: 0.75, ao: 0.45, aoRadius: 0.25, vignette: 0.5, grain: 0.022 },
  hint: "Pull it to swing it on its thread. Tap it to crack it, and keep tapping until it hatches.",
  notes:
    "A jewel-green chrysalis with a crown of gold beads, its sleeper's heartbeat glowing through the flesh. Each tap ripples the skin and grows gold cracks; enough and it splits, and a creature of light unfolds out of it before coming apart into sparks.",
  overview: [
    {
      title: "Chrysalis",
      points: [
        "The glow inside is marched through the pod in the shader: light from round the sleeper and its heart, soaked up by colour through the flesh and blocked by the sleeper's own shape.",
        "The shell is cut into pieces round seeds spread over its surface; cracks are the true edges between them, revealed as each tap's reach spreads, so it breaks exactly where it cracked.",
        "Each piece's fall or fold is worked out in the shader from the time since it broke, so the shell can run backwards and knit itself whole again."
      ]
    }
  ]
};

export default chrysalis;
