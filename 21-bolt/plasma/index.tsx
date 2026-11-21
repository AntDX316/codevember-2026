"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { use, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import { orbitControls, useGrabbable } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { dismissPrompt } from "../../shared/engine/prompt";
import { narrowScreen, useQuality } from "../../shared/engine/quality";
import { useSetting, useSettingsStore } from "../../shared/engine/settings";
import { useMusic } from "../../shared/engine/sound";
import type { DayDefinition } from "../../shared/engine/types";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { CONTACTS, createPlasma, GLASS, HAND_PULL } from "./filaments";
import { Aura, Backdrop, Dots, Splashes, Electrode, Filaments, GASES, Glass, glow, Motes, room, ROOMS, Shell, useGhost, type Gas, type Room } from "./render";
import { loadRoom, SOFT_HEIGHT, SOFT_WIDTH, type Decoded } from "./hdr";
import { buildVoice, createVoice, loadBuzz } from "./sound";
import type { Hands } from "./hands";
import { createRig, HandsInScene, placeHands, type Rig, type RigHand } from "./hand3d";
import { TIPS } from "./hand-shape";

const lens = { pixel: 0.001, focus: 4, defocus: 0 };

// The hands as the voice hears them, refilled each frame rather than made anew. A resting mouse is a lighter touch to
// the lightning (HOVER), but heard as loud as a press: full once it has drawn in as far as a hover goes.
const HOVER = 0.55;
const heard = Array.from({ length: CONTACTS }, () => ({ strength: 0, held: 0 }));
function handState(contacts: { strength: number; want: number; held: number }[]) {
  contacts.forEach((c, k) => {
    heard[k].strength = Math.min(1, c.strength / HOVER);
    heard[k].held = c.held;
  });
  return heard;
}

const scratch = {
  ndc: new THREE.Vector2(),
  caster: new THREE.Raycaster(),
  hit: new THREE.Vector3(),
  colour: new THREE.Color(),
  last: new THREE.Vector3()
};

// Where a ray meets the glass, as a direction from the middle; or, for a hand dragged off the edge, the nearest point of
// the rim. Null for a ray that misses, unless `rim` is asked for.
function onGlass(ray: THREE.Ray, out: THREE.Vector3, rim: boolean) {
  const b = ray.origin.dot(ray.direction);
  const c = ray.origin.lengthSq() - GLASS * GLASS;
  const h = b * b - c;
  if (h >= 0) {
    const t = -b - Math.sqrt(h);
    if (t > 0) return out.copy(ray.origin).addScaledVector(ray.direction, t).normalize();
  }
  if (!rim) return null;
  return out.copy(ray.origin).addScaledVector(ray.direction, Math.max(0, -b)).normalize();
}

// A finger or the mouse on the glass: where on screen, which hand it drives, and whether it is pressed or only resting.
type Touch = { slot: number; x: number; y: number; pressed: boolean; mouse: boolean };

// Real fingertips from the camera (IRL Hands) are touches too, with ids above any pointer's.
const HAND_ID = 1 << 20;
// OrbitControls' own steps, which its pointer handling uses: turning, and moving in and out (scaled, then damped and
// held to its limits by its update, as a mouse drag would be).
type OrbitSteps = { target: THREE.Vector3; rotateSpeed: number; _rotateLeft(angle: number): void; _rotateUp(angle: number): void; _dollyIn(scale: number): void };
// How strongly a pinch turns the view, against a mouse drag of the same distance on screen.
const PINCH_TURN = 1;
const pinchAim = new THREE.Vector3();
// IRL Hands' pinch steers the view. One hand pinching and moving turns it about the core, as a drag with the mouse
// does; two hands pinching zoom it by how far apart they spread or close (and turn it by their midpoint). While any
// hand pinches, the point turned about eases back to the core (in about a third of a second), the eye carried with it.
function steerByPinch(rig: Rig, camera: THREE.Camera, width: number, height: number, dt: number) {
  const orbit = orbitControls.current as unknown as OrbitSteps | null;
  let first: RigHand | null = null;
  let second: RigHand | null = null;
  for (const r of rig.hands) {
    if (!r.live || !r.pinching) continue;
    if (!first) first = r;
    else second = r;
  }
  if (orbit && first) {
    pinchAim.copy(orbit.target);
    orbit.target.multiplyScalar(Math.exp(-dt / 0.1));
    camera.position.add(pinchAim.subVectors(orbit.target, pinchAim));
    // Turned by the pinch's motion on screen, in pixels, as the mouse turns it: a full turn for a drag the screen's height.
    const turn = (dx: number, dy: number, gain: number) => {
      orbit._rotateLeft(((2 * Math.PI * dx * width) / 2 / height) * orbit.rotateSpeed * PINCH_TURN * gain);
      orbit._rotateUp(((2 * Math.PI * -dy * height) / 2 / height) * orbit.rotateSpeed * PINCH_TURN * gain);
    };
    if (!second && !Number.isNaN(first.lastX)) turn(first.pinchX - first.lastX, first.pinchY - first.lastY, 1);
    if (second && !Number.isNaN(first.lastX) && !Number.isNaN(second.lastX)) {
      const now = Math.hypot((first.pinchX - second.pinchX) * width, (first.pinchY - second.pinchY) * height);
      const before = Math.hypot((first.lastX - second.lastX) * width, (first.lastY - second.lastY) * height);
      if (now > 4 && before > 4) orbit._dollyIn(before / now);
      turn((first.pinchX + second.pinchX - first.lastX - second.lastX) / 2, (first.pinchY + second.pinchY - first.lastY - second.lastY) / 2, 0.5);
    }
  }
  for (const r of rig.hands) {
    if (!r.live || !r.pinching) continue;
    r.lastX = r.pinchX;
    r.lastY = r.pinchY;
  }
}

// How far the view can be panned from the globe's middle before it is drawn back (the glass's radius is 1).
const PAN = 0.8;

// A fingertip that strays off the globe lets go after this long, so its edge never flickers.
const HAND_OFF = 0.12;

function Scene() {
  const { tier } = useQuality();
  const startTier = useRef(tier).current;
  // Drawn as finely as the tier the visit starts on allows; a later step down keeps it.
  const plasma = useMemo(() => createPlasma(startTier), [startTier]);
  useDispose(plasma.geometry);
  const gl = useThree((state) => state.gl) as unknown as THREE.WebGPURenderer;
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const scene = useThree((state) => state.scene);
  const size = useThree((state) => state.size);
  const gas = useSetting<Gas>("gas");
  const storm = useSetting<number>("storm");

  const ghost = useGhost(plasma, startTier === "low" ? 0.35 : 0.5);
  // The room: only the one chosen is fetched. The first is fetched and decoded behind the loader, so it is there on the
  // first frame. Changing room fetches the next off the main thread and, once it is in, swaps its picture into the same
  // textures (every room is the same size and kind), so nothing is rebuilt, dimming the room out and back in round the
  // swap. Whatever is chosen last wins; a room that fails (after the loader's own retries) leaves the current one up,
  // and is tried again when chosen again.
  const store = useSettingsStore();
  const roomChoice = useSetting<Room>("room");
  const roomUrl = (r: Room) => `/assets/21-bolt/${(ROOMS[r] ?? ROOMS.bar).file}.room`;
  const firstRoom = useRef(store.get("room") as Room).current;
  // The loader keeps one promise per room, so this is the same promise on every render, as `use` needs.
  const first = use(loadRoom(roomUrl(firstRoom)));
  // The full picture for the glass to reflect, and a small blurred copy for the room seen out of focus behind.
  const env = useMemo(() => {
    const sharp = new THREE.DataTexture(first.data.slice(), first.width, first.height, THREE.RGBAFormat, THREE.HalfFloatType);
    sharp.mapping = THREE.EquirectangularReflectionMapping;
    sharp.minFilter = THREE.LinearFilter;
    sharp.magFilter = THREE.LinearFilter;
    sharp.wrapS = THREE.RepeatWrapping;
    sharp.needsUpdate = true;
    const soft = new THREE.DataTexture(first.soft.slice(), SOFT_WIDTH, SOFT_HEIGHT, THREE.RGBAFormat, THREE.HalfFloatType);
    soft.mapping = THREE.EquirectangularReflectionMapping;
    soft.minFilter = THREE.LinearFilter;
    soft.magFilter = THREE.LinearFilter;
    soft.wrapS = THREE.RepeatWrapping;
    soft.needsUpdate = true;
    return { sharp, soft };
  }, [first]);
  useDispose(env.sharp, env.soft);
  const swap = useRef({ showing: firstRoom, wanted: firstRoom, next: null as Decoded | null, nextRoom: firstRoom, loading: "" as Room | "", failed: "" as Room | "" });
  // Once the visit is under way, the other rooms are fetched quietly one after another, so changing room is instant.
  // Not on a phone, where data costs: there a room is fetched when it is chosen.
  useEffect(() => {
    if (startTier === "low") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const rest = (Object.keys(ROOMS) as Room[]).filter((r) => r !== firstRoom);
      rest.reduce((chain, r) => chain.then(() => (cancelled ? undefined : loadRoom(roomUrl(r)).then(() => undefined, () => undefined))), Promise.resolve() as Promise<void>);
    }, 5000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, after the first room.
  }, []);
  // All the way round, as there is no back to hide; only kept from going over the top or under, and from the glass.
  useEffect(() => {
    const orbit = orbitControls.current;
    if (!orbit) return;
    const was = { min: orbit.minPolarAngle, max: orbit.maxPolarAngle, near: orbit.minDistance, far: orbit.maxDistance };
    orbit.minPolarAngle = 0.45;
    orbit.maxPolarAngle = 2.35;
    orbit.minDistance = 1.5;
    orbit.maxDistance = 9;
    return () => {
      orbit.minPolarAngle = was.min;
      orbit.maxPolarAngle = was.max;
      orbit.minDistance = was.near;
      orbit.maxDistance = was.far;
    };
  }, []);

  const state = useRef({
    touches: new Map<number, Touch>(),
    // Fingers down off the glass, turning or pinching the view.
    offGlass: new Set<number>(),
    pressedFor: 0,
    hovered: 0,
    earned: false,
    struck: [] as boolean[],
    moving: 0,
    // Set by the pointer handlers: a camera fingertip at a place on screen, and letting one go.
    finger: null as null | ((id: number, x: number, y: number, now: number) => void),
    lift: null as null | ((id: number) => void),
    fingerOff: new Map<number, number>(),
    seenFingers: new Set<number>(),
    panKey: false,
    was: Array.from({ length: CONTACTS }, () => new THREE.Vector3())
  });
  const voice = useMemo(() => createVoice(), []);
  // The music sits under the globe's own sound, and dips a little further while a hand is on the glass so the buzz cuts
  // through. Paid for and licensed to this site only: where the file is missing (the open-source repo), there is none.
  const [touching, setTouching] = useState(false);
  useMusic("/codevember/music/trap-hip-hop-instrumental.mp3", touching ? 0.11 : 0.2);
  useEffect(() => () => voice.stop(), [voice]);

  // IRL Hands: the camera and the tracker are loaded only when it is turned on, and released when it is turned off. If
  // the camera is refused or missing, it turns itself back off and says why.
  // Desktop only: on a phone or any touch screen (the engine's own tests for its phone layout and touch) the toggle is
  // never shown, so no camera or tracker code is ever loaded there. Published again after a Reset.
  const desk = useSetting<boolean>("desk");
  useEffect(() => {
    const publish = () => store.set("desk", !window.matchMedia("(pointer: coarse)").matches && !narrowScreen());
    publish();
    return store.onAction("reset", publish);
  }, [store]);
  const handsOn = useSetting<boolean>("hands");
  // Turning IRL Hands on closes the controls panel, so the globe and the camera preview are clear to reach into.
  const handsWere = useRef(handsOn);
  useEffect(() => {
    if (handsOn && !handsWere.current && desk) {
      const head = document.querySelector<HTMLButtonElement>(".cv-panel-head");
      if (head?.getAttribute("aria-expanded") === "true") head.click();
    }
    handsWere.current = handsOn;
  }, [handsOn, desk]);
  const hands = useRef<Hands | null>(null);
  // The hands as drawn in the scene, and where their fingertips are on screen.
  const rig = useMemo(() => createRig(), []);
  useEffect(() => {
    if (!handsOn || !desk) return;
    const s = state.current;
    let live = true;
    let made: Hands | null = null;
    const abort = new AbortController();
    const off = () => live && store.set("hands", false);
    import("./hands").then(
      (m) =>
        m.startHands({ signal: abort.signal, onFail: off }).then(
          (h) => {
            if (!live) return h.stop();
            made = h;
            hands.current = h;
          },
          // The setup card has already said why.
          off
        ),
      off
    );
    return () => {
      live = false;
      abort.abort();
      made?.stop();
      hands.current = null;
      for (const id of [...s.touches.keys()]) if (id >= HAND_ID) s.lift?.(id);
    };
  }, [handsOn, desk, store]);

  if (process.env.NODE_ENV !== "production") Object.assign(globalThis, { __plasma: plasma, __plasmaState: state, __camera: camera, __plasmaSwap: swap, __plasmaBuildVoice: buildVoice, __plasmaLoadBuzz: loadBuzz, __plasmaScene: scene, __plasmaHands: () => hands.current, __plasmaRig: rig });

  // Every finger on the glass, and the mouse whether pressed or only resting on it.
  useEffect(() => {
    const el = gl.domElement;
    const s = state.current;
    const toNdc = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      return [((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1];
    };
    const hits = (x: number, y: number) => {
      scratch.ndc.set(x, y);
      scratch.caster.setFromCamera(scratch.ndc, camera);
      return onGlass(scratch.caster.ray, scratch.hit, false) !== null;
    };
    const free = () => {
      const used = new Set([...s.touches.values()].map((t) => t.slot));
      let best = -1;
      for (let k = 0; k < CONTACTS; k++) {
        if (used.has(k)) continue;
        if (best < 0 || plasma.contacts[k].strength < plasma.contacts[best].strength) best = k;
      }
      return best;
    };
    const letGo = (id: number) => {
      const t = s.touches.get(id);
      if (!t) return;
      plasma.contacts[t.slot].want = 0;
      plasma.contacts[t.slot].live = false;
      s.touches.delete(id);
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // Shift, Ctrl or Cmd with a drag pans the view, even over the glass.
      if (e.shiftKey || e.ctrlKey || e.metaKey) return;
      const [x, y] = toNdc(e);
      // A finger that lands off the glass is turning or pinching the view: while it is down, no other finger strikes a
      // bolt, so a pinch that strays onto the glass still zooms.
      if (!hits(x, y)) {
        if (e.pointerType !== "mouse") s.offGlass.add(e.pointerId);
        return;
      }
      if (s.offGlass.size > 0) return;
      let t = s.touches.get(e.pointerId);
      if (!t) {
        const slot = free();
        if (slot < 0) return;
        t = { slot, x, y, pressed: true, mouse: e.pointerType === "mouse" };
        s.touches.set(e.pointerId, t);
        plasma.contacts[slot].at.copy(scratch.hit);
        plasma.contacts[slot].pull = 1;
      }
      t.pressed = true;
      t.x = x;
      t.y = y;
      const c = plasma.contacts[t.slot];
      if (c.strength < 0.7) voice.strike();
      c.want = 1;
      c.live = true;
      dismissPrompt();
    };
    const move = (e: PointerEvent) => {
      const [x, y] = toNdc(e);
      const t = s.touches.get(e.pointerId);
      if (t) {
        // A resting mouse lets go when a button goes down to pan or turn the view.
        if (!t.pressed && e.buttons !== 0) {
          letGo(e.pointerId);
          return;
        }
        t.x = x;
        t.y = y;
        // A resting mouse that slides off the glass lets go; a pressed one drags along the rim.
        if (!t.pressed && !hits(x, y)) letGo(e.pointerId);
        return;
      }
      if (e.pointerType !== "mouse" || e.buttons !== 0 || !hits(x, y)) return;
      const slot = free();
      if (slot < 0) return;
      s.touches.set(e.pointerId, { slot, x, y, pressed: false, mouse: true });
      const c = plasma.contacts[slot];
      c.pull = 1;
      c.at.copy(scratch.hit);
      c.want = HOVER;
      c.live = true;
      // Resting on the glass is already touching it: the prompt has been answered.
      dismissPrompt();
    };
    const up = (e: PointerEvent) => {
      s.offGlass.delete(e.pointerId);
      const t = s.touches.get(e.pointerId);
      if (!t) return;
      const [x, y] = toNdc(e);
      if (t.mouse && e.type === "pointerup" && hits(x, y)) {
        t.pressed = false;
        plasma.contacts[t.slot].want = HOVER;
        return;
      }
      letGo(e.pointerId);
    };
    const leave = (e: PointerEvent) => {
      const t = s.touches.get(e.pointerId);
      if (t && !t.pressed) letGo(e.pointerId);
    };
    // A camera fingertip: over the globe it is a press there, the same as a finger on the screen; off it a moment, it lets go.
    s.finger = (id, x, y, now) => {
      const on = hits(x, y);
      let t = s.touches.get(id);
      if (!t) {
        if (!on || s.offGlass.size > 0) return;
        const slot = free();
        if (slot < 0) return;
        t = { slot, x, y, pressed: true, mouse: false };
        s.touches.set(id, t);
        const c = plasma.contacts[slot];
        c.pull = HAND_PULL;
        c.at.copy(scratch.hit);
        if (c.strength < 0.7) voice.strike();
        c.want = 1;
        c.live = true;
        dismissPrompt();
      }
      t.x = x;
      t.y = y;
      if (on) s.fingerOff.delete(id);
      else {
        const since = s.fingerOff.get(id) ?? now;
        s.fingerOff.set(id, since);
        if (now - since > HAND_OFF) {
          letGo(id);
          s.fingerOff.delete(id);
        }
      }
    };
    s.lift = (id) => {
      letGo(id);
      s.fingerOff.delete(id);
    };

    // Held keys that turn a drag on the glass into a pan.
    const keys = (e: KeyboardEvent) => (s.panKey = e.shiftKey || e.ctrlKey || e.metaKey);
    const blur = () => (s.panKey = false);
    window.addEventListener("keydown", keys);
    window.addEventListener("keyup", keys);
    window.addEventListener("blur", blur);

    // No long-press menu or callout on the glass (iOS and Android).
    const noMenu = (e: Event) => e.preventDefault();
    const callout = el.style.getPropertyValue("-webkit-touch-callout");
    el.style.setProperty("-webkit-touch-callout", "none");
    el.addEventListener("contextmenu", noMenu);
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("keydown", keys);
      window.removeEventListener("keyup", keys);
      window.removeEventListener("blur", blur);
      el.removeEventListener("contextmenu", noMenu);
      el.style.setProperty("-webkit-touch-callout", callout);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      el.removeEventListener("pointerleave", leave);
    };
  }, [gl, camera, plasma, voice]);

  // A press on the glass is a touch, not a turn of the view; anywhere else turns it.
  useGrabbable({
    pick: (ray) => {
      if (state.current.offGlass.size > 0 || state.current.panKey) return null;
      const at = onGlass(ray, new THREE.Vector3(), false);
      if (!at) return null;
      return { distance: ray.origin.distanceTo(at), point: at };
    },
    grab: () => {},
    drag: () => {},
    release: () => {}
  });

  useFrame((_, raw) => {
    const dt = Math.min(raw, 1 / 20);
    const s = state.current;

    // On a computer the view can be panned (right-drag, or Shift, Ctrl or Cmd with a drag), and then turns about the point
    // panned to; past PAN from the globe's middle it is drawn back, eye and all, so the globe is never lost. On a phone,
    // where the globe fills the width, the view always turns about the globe's middle: the hover's drift of the point
    // looked at is drawn back to it, or it would wander off the side.
    const aim = orbitControls.current?.target;
    if (aim && !desk) aim.multiplyScalar(Math.exp(-dt * 4));
    else if (aim) {
      const far = aim.length();
      if (far > PAN) {
        scratch.last.copy(aim);
        aim.setLength(PAN + (far - PAN) * Math.exp(-dt * 8));
        camera.position.add(scratch.last.subVectors(aim, scratch.last));
      }
    }

    // Camera hands onto the screen and into the scene (the picture as a mirror, cropped to fill the screen, each hand
    // drawn at a natural size round its palm), then each fingertip that counts is a touch where it is drawn.
    const h = hands.current;
    placeHands(rig, h, camera, size.width / Math.max(1, size.height), dt);
    steerByPinch(rig, camera, size.width, size.height, dt);
    if (h && s.finger && s.lift) {
      const now = performance.now() / 1000;
      const seen = s.seenFingers;
      seen.clear();
      for (const tip of h.tips) {
        const r = rig.hands.find((x) => x.live && x.slot === Math.floor(tip.id / 5));
        if (!r) continue;
        const k = TIPS[tip.id % 5];
        const id = HAND_ID + tip.id;
        seen.add(id);
        s.finger(id, r.ndc[k * 2], r.ndc[k * 2 + 1], now);
      }
      h.onGlass.clear();
      for (const id of s.touches.keys()) {
        if (id < HAND_ID) continue;
        if (!seen.has(id)) s.lift(id);
        else h.onGlass.add(id - HAND_ID);
      }
    }

    // Each hand's place on the glass, found again every frame as the eye drifts.
    let pressing = 0;
    let moving = 0;
    for (const t of s.touches.values()) {
      scratch.ndc.set(t.x, t.y);
      scratch.caster.setFromCamera(scratch.ndc, camera);
      const c = plasma.contacts[t.slot];
      const at = onGlass(scratch.caster.ray, scratch.hit, t.pressed);
      if (at) {
        moving = Math.max(moving, at.angleTo(c.at) / Math.max(dt, 1e-3));
        c.at.copy(at);
      }
      if (t.pressed) pressing++;
    }
    s.moving += (Math.min(moving / 3, 1) - s.moving) * (1 - Math.exp(-dt * 10));

    // The room: fade out, swap the picture once the new one is in, fade back in.
    const sw = swap.current;
    if (sw.wanted !== roomChoice) {
      sw.failed = "";
      voice.whoosh();
    }
    sw.wanted = roomChoice;
    // A room fetched but no longer wanted is let go.
    if (sw.next && sw.nextRoom !== sw.wanted) sw.next = null;
    if (sw.wanted !== sw.showing && sw.loading !== sw.wanted && sw.failed !== sw.wanted && !sw.next) {
      const asked = sw.wanted;
      sw.loading = asked;
      loadRoom(roomUrl(asked)).then(
        (decoded) => {
          const now = swap.current;
          if (now.loading === asked) now.loading = "";
          // Only if it is still the one wanted: the latest choice always wins.
          if (now.wanted !== asked) return;
          now.next = decoded;
          now.nextRoom = asked;
        },
        () => {
          const now = swap.current;
          if (now.loading === asked) now.loading = "";
          if (now.wanted === asked) now.failed = asked;
        }
      );
    }
    // Out while a new room is on its way; back in once it is swapped, or if it could not be had.
    const out = sw.wanted !== sw.showing && sw.failed !== sw.wanted;
    room.fade.value = THREE.MathUtils.clamp(room.fade.value + (out ? -dt : dt) * 4, 0, 1);
    if (out && room.fade.value === 0 && sw.next) {
      env.sharp.image = { data: sw.next.data.slice(), width: sw.next.width, height: sw.next.height };
      env.sharp.needsUpdate = true;
      (env.soft.image as { data: Uint16Array }).data.set(sw.next.soft);
      env.soft.needsUpdate = true;
      sw.next = null;
      sw.showing = sw.nextRoom;
    }
    const r = ROOMS[sw.showing] ?? ROOMS.bar;
    room.behind.value = r.behind;
    room.mirror.value = r.mirror;
    room.cool.value = r.cool;
    room.yaw.value = r.yaw;
    room.peak.value = r.peak;

    // Gas colours ease from one to the next.
    const g = GASES[gas] ?? GASES.classic;
    const ease = 1 - Math.exp(-dt * 4);
    glow.inner.value.lerp(scratch.colour.set(g.inner), ease);
    glow.outer.value.lerp(scratch.colour.set(g.outer), ease);
    glow.core.value.lerp(scratch.colour.set(g.core), ease);

    // The lens: a pixel's width at a distance of one, the focus on the front of the globe, filaments behind it softer.
    const pixel = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, size.height);
    lens.pixel = pixel;
    lens.focus = camera.position.length() - 0.25;
    lens.defocus = startTier === "low" ? 0 : 0.03;
    glow.gas.value = 0.55 + storm * 0.9;
    glow.exposure.value = 0.45 + 0.55 * THREE.MathUtils.smoothstep(camera.position.length(), 1.7, 3.8);
    plasma.step(dt, storm, camera.position, lens);
    const totals = plasma.totals;
    glow.power.value += (0.75 + 0.25 * Math.min(1.4, totals.glow) + totals.surging * 0.2 - glow.power.value) * (1 - Math.exp(-dt * 8));
    glow.surge.value += (totals.surge * Math.min(1, 0.5 + totals.held * 0.25) - glow.surge.value) * (1 - Math.exp(-dt * 6));
    // Where the globe's middle falls on screen, for the glass to bend its rim about.
    scratch.hit.set(0, 0, 0).project(camera);
    glow.centre.value.set(scratch.hit.x * 0.5 + 0.5, 0.5 - scratch.hit.y * 0.5);

    voice.update(dt, {
      // A resting mouse is a light touch, heard more quietly than a press.
      hands: handState(plasma.contacts),
      moving: s.moving,
      storm,
      flicker: totals.flicker,
      struck: totals.struck,
      surging: totals.surging,
      forked: totals.forked
    });

    // The moment worth sharing: the lightning held at a fingertip a few seconds, or several fingers at once.
    if (pressing > 0) s.pressedFor += dt;
    if ((pressing > 0) !== touching) setTouching(pressing > 0);
    if (!s.earned && (s.pressedFor > 4 || pressing > 1)) {
      s.earned = true;
      followPrompt.earn("bolt");
      shareResult.set("Just held the lightning of a plasma globe at my fingertip");
    }
  });

  return (
    <>
      <Backdrop env={env} />
      <Shell />
      <Aura />
      <Glass plasma={plasma} ghost={ghost} env={env} />
      <Electrode plasma={plasma} env={env} />
      <HandsInScene rig={rig} plasma={plasma} />
      <Filaments plasma={plasma} />
      <Dots plasma={plasma} />
      <Splashes plasma={plasma} />
      <Motes count={startTier === "low" ? 1600 : 4000} />
    </>
  );
}

const day: DayDefinition = {
  camera: {
    position: [0, 0.22, 4.15],
    target: [0, -0.04, 0],
    fov: 34,
    phone: { position: [0, 0.3, 6.6], target: [0, 0, 0], fov: 42 }
  },
  hover: true,
  extents: { centre: [0, 0, 0], radius: 11, color: "#c8a8ff" },
  // Black behind: the glass, the filaments and the dust are added over the whole frame in the overlay pass.
  look: { background: "#000000", exposure: 1.05, bloom: 0.5, bloomThreshold: 1, gi: 0, ao: 0, vignette: 0.6, grain: 0.016, haze: 0 },
  passes: { bounce: false, haze: false, overlay: true, occlusion: false },
  settings: {
    gas: {
      type: "choice",
      label: "Gas",
      value: "classic",
      options: (Object.keys(GASES) as Gas[]).map((k) => ({ value: k, label: GASES[k].label, swatch: [...GASES[k].swatch] }))
    },
    storm: { type: "range", label: "Storm", min: 0, max: 1, step: 0.01, value: 0.2, reset: 0.2 },
    room: {
      type: "choice",
      label: "Room",
      value: "bar",
      options: (Object.keys(ROOMS) as Room[]).map((k) => ({ value: k, label: ROOMS[k].label }))
    },
    desk: { type: "toggle", label: "Desktop", value: false, hidden: true },
    hands: { type: "toggle", label: "IRL Hands", value: false, when: { setting: "desk", is: true } }
  },
  phoneDock: ["room", "storm"],
  prompt: { title: "Touch the glass", detail: "Drag off the globe to spin round it", low: true },
  hint: "Touch the glass and the lightning swings to your fingertip; drag to lead it, or use several fingers on a phone. Drag anywhere off the globe to spin all the way round it; on a computer, right-drag (or Shift-drag) pans. Turn on IRL Hands to touch it with your real fingers through the camera: the tracking runs on this device and nothing is uploaded.",
  notes: "A plasma globe floating in a dark room it lights itself: filaments writhe from the electrode to the glass and gather to your fingertip.",
  Scene
};

export default day;
