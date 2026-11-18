"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import { orbitPoint, useGrabbable } from "../shared/engine/controls";
import { focusBlur, focusDistance } from "../shared/engine/Post";
import { scenePhase, useQuality } from "../shared/engine/quality";
import { useSetting, useSettingAction } from "../shared/engine/settings";
import { sound, useBed, useEvery, useMusic } from "../shared/engine/sound";
import { followPrompt } from "../shared/ui/Follow";
import { shareResult } from "../shared/ui/Share";
import { useLook } from "../shared/engine/Stage";
import type { DayDefinition } from "../shared/engine/types";
import { Air } from "./air";
import { aim, Backdrop, Bokeh, sky, useSkyEase } from "./backdrop";
import { bead, Dew, dewCap, type Drop } from "./dew";
import { Garden } from "./garden";
import { Silk } from "./silk";
import { alarm, Spider } from "./spider";
import { KINDS, LOOKS, VERSIONS, type Version } from "./versions";
import { Kind, Web } from "./web";

const LOOK = {
  background: "#000000",
  gi: 0.6,
  ao: 0.6,
  aoRadius: 0.2,
  vignette: 0.45,
  grain: 0.02,
  bloomThreshold: 0.8,
  haze: 0
};

// A web spun ahead of need, with the dew strung on it.
type Spun = { key: string; web: Web; drops: Drop[] };

// Threads snapped since the page opened.
const snapped = { count: 0 };

function Scene() {
  useMusic("/codevember/music/analytical-crime-underscore.mp3", 0.32);
  const version = useSetting<Version>("version");
  const windSetting = useSetting<number>("wind");
  const look = LOOKS[version];
  const { tier } = useQuality();
  const camera = useThree((state) => state.camera);
  // Every web is spun, hung and dressed from the start, and only the one shown is moved: changing web is then only a
  // matter of which is shown, with every shader already built behind the loader. A new web is spun only for the one
  // shown, and is ready before it is asked for: the next of each kind is spun, beaded and settled in the background, a
  // couple of milliseconds a frame, so that a press only swaps it in.
  const [seeds, setSeeds] = useState<Record<Version, number>>(() => Object.fromEntries(KINDS.map((v) => [v, 1])) as Record<Version, number>);
  const shown = useRef(version);
  shown.current = version;
  useSettingAction("respin", () => setSeeds((s) => ({ ...s, [shown.current]: s[shown.current] + 1 })));
  const fine = tier === "low" ? 0.7 : tier === "medium" ? 0.85 : 1;
  const cap = dewCap(tier);
  const spun = useRef(new Map<string, Spun>());
  // A web of each kind and seed, strung with its dew and weighed by it; settled later, in one go or a little at a time.
  const spin = (v: Version, seed: number): Spun => {
    const key = `${v} ${seed} ${fine} ${cap}`;
    let made = spun.current.get(key);
    if (!made) {
      const web = new Web(LOOKS[v], seed * 13 + v.length, fine);
      made = { key, web, drops: bead(web, LOOKS[v], cap, seed) };
      spun.current.set(key, made);
    }
    return made;
  };
  const webs = useMemo(() => {
    const all = {} as Record<Version, Spun>;
    // Settled under its dew, once, before it is seen: at once if the background has not finished it yet.
    for (const v of KINDS) {
      all[v] = spin(v, seeds[v]);
      all[v].web.settle();
    }
    // Only the webs shown and the ones being made ready next are kept.
    const keep = new Set(KINDS.flatMap((v) => [all[v].key, `${v} ${seeds[v] + 1} ${fine} ${cap}`]));
    for (const key of spun.current.keys()) if (!keep.has(key)) spun.current.delete(key);
    return all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seeds, fine, cap]);
  useFrame(() => {
    // The next web of each kind, a little more of it each frame, from the first frames behind the loader on (not while
    // the shaders are compiled, which holds frames up anyway).
    if (scenePhase.current === "hold") return;
    for (const v of KINDS) {
      const next = spin(v, seeds[v] + 1);
      if (!next.web.settle(2)) return;
    }
  });
  const web = webs[version].web;
  if (process.env.NODE_ENV !== "production") (globalThis as Record<string, unknown>).__web = web;

  useLook(useMemo(() => ({ ...LOOK, exposure: look.exposure, bloom: look.bloom }), [look]));
  const first = useRef(true);
  useEffect(() => {
    aim(look, first.current);
    first.current = false;
  }, [look]);
  useSkyEase();
  // For testing in development: put the eye somewhere from the console.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (globalThis as Record<string, unknown>).__view = (from: number[], to: number[]) => {
      camera.position.set(from[0], from[1], from[2]);
      orbitPoint.current?.set(to[0], to[1], to[2]);
      camera.lookAt(to[0], to[1], to[2]);
    };
  }, [camera]);
  useAmbience(version);

  // Holding on to a thread: where it was taken, how far it has been drawn, and when it last sang.
  const pull = useRef({
    node: -1,
    start: new THREE.Vector3(),
    drawn: 0,
    sangAt: 0
  });
  // How close to a thread a press must land to take hold of it, as an angle: about seven pixels with a mouse, more under
  // a finger. Anywhere else a drag turns the view.
  const reach = useMemo(() => (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches ? 0.016 : 0.007), []);
  const picked = useRef(-1);
  useGrabbable({
    pick(ray) {
      const hit = web.pick(ray.origin.x, ray.origin.y, ray.origin.z, ray.direction.x, ray.direction.y, ray.direction.z, reach);
      picked.current = hit ? hit.node : -1;
      return hit
        ? {
            distance: hit.distance,
            point: ray.at(hit.distance, new THREE.Vector3())
          }
        : null;
    },
    grab(point) {
      const node = picked.current;
      if (node < 0) return;
      web.grabbed = node;
      web.target.set([point.x, point.y, point.z]);
      pull.current = {
        node,
        start: point.clone(),
        drawn: 0,
        sangAt: performance.now()
      };
      alarm.node = node;
      alarm.at = performance.now();
    },
    drag(point) {
      web.target.set([point.x, point.y, point.z]);
      const p = pull.current;
      p.drawn = point.distanceTo(p.start);
      // The silk tightens audibly as it is drawn, higher the further.
      const now = performance.now();
      if (p.drawn > 0.04 && now - p.sangAt > 150) {
        p.sangAt = now;
        sound.play("pluck", {
          gain: 0.08 + Math.min(0.2, p.drawn * 0.4),
          pitch: 1 + p.drawn * 2.2,
          size: 0.1,
          pan: point.x * 0.4
        });
      }
    },
    release() {
      const p = pull.current;
      const node = web.grabbed;
      web.grabbed = -1;
      if (node < 0) return;
      // Even a tap sets it ringing.
      web.previous[node * 3 + 2] += 0.012;
      sound.play("pluck", {
        gain: 0.35 + Math.min(0.5, p.drawn * 1.5),
        pitch: 0.8 + Math.min(1.2, p.drawn * 1.5) + Math.random() * 0.1,
        size: 0.8,
        pan: web.position[node * 3] * 0.4
      });
      alarm.node = node;
      alarm.at = performance.now();
    }
  });

  const scratch = useMemo(() => new THREE.Vector3(), []);
  const storm = useRef({ next: 4, flash: 0, thunder: -1 });
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    const t = web.time;
    const gust = Math.max(0, Math.sin(t * 0.37) * Math.sin(t * 0.13 + 1)) * look.gusts * 3;
    web.wind = windSetting * look.wind * (1.6 + gust) * 4;
    web.step(delta, tier === "low" ? 6 : 10);
    for (const snap of web.snapped) {
      // A dozen threads snapped is the web well and truly tested: the follow card's moment.
      if (++snapped.count === 12) {
        shareResult.set("I tore a dewy spider web apart, thread by thread, in Tension");
        followPrompt.earn();
      }
      sound.play("snap", {
        gain: snap.kind === Kind.Spiral ? 0.4 : 0.7,
        pitch: snap.kind === Kind.Spiral ? 1.3 : 0.9,
        pan: snap.x * 0.4
      });
    }
    web.snapped.length = 0;

    // Rain: drops striking the web, each knocking a point back.
    if (look.air === "rain") {
      for (let k = 0; k < 30 * delta * 60 * 0.1; k++) {
        const i = Math.floor(Math.random() * web.count);
        if (!web.pinned[i]) web.previous[i * 3 + 2] += 0.004 + Math.random() * 0.006;
      }
      const s = storm.current;
      s.next -= delta;
      if (s.next <= 0) {
        s.next = 7 + Math.random() * 12;
        s.flash = 1;
        s.thunder = 0.6 + Math.random() * 1.5;
      }
      s.flash = Math.max(0, s.flash - delta * 3.5);
      // Two flickers and a fade.
      sky.flash.value = s.flash * (s.flash > 0.7 || (s.flash > 0.35 && s.flash < 0.5) ? 1 : 0.35);
      if (s.thunder > 0) {
        s.thunder -= delta;
        if (s.thunder <= 0) sound.play("thud", { gain: 1, pitch: 0.25, size: 1 });
      }
    } else sky.flash.value = 0;

    // The view turns about the middle of the web, wherever it has swung to: the point it orbits is drawn to the hub.
    const hub = web.hub * 3;
    orbitPoint.current?.lerp(scratch.set(web.position[hub], web.position[hub + 1], web.position[hub + 2]), 1 - Math.exp(-delta * 4));
    // Focus on the web, wherever the eye has moved to.
    focusDistance.value = Math.max(0.4, camera.position.distanceTo(orbitPoint.current ?? new THREE.Vector3()));
    focusBlur.value = 1.4;
  });

  return (
    <>
      <Backdrop />
      <Garden version={version} fine={tier === "low" ? 0.5 : tier === "medium" ? 0.75 : 1} />
      {KINDS.map((v) => (
        <group key={v} visible={v === version}>
          <Bokeh look={LOOKS[v]} tier={tier} />
          <Silk web={webs[v].web} look={LOOKS[v]} active={v === version} />
          <Dew web={webs[v].web} drops={webs[v].drops} look={LOOKS[v]} tier={tier} active={v === version} />
          {LOOKS[v].spider && <Spider web={webs[v].web} look={LOOKS[v]} active={v === version} />}
          <Air look={LOOKS[v]} tier={tier} />
        </group>
      ))}
    </>
  );
}

// Each web sounds of its own weather: birds at dawn, insects in the jungle, crickets and an
// owl by moonlight, rain and thunder in the storm.
function useAmbience(version: Version) {
  useBed("wind", { dawn: 0.1, golden: 0.04, moonlit: 0.05, storm: 0.38 }[version]);
  useBed("crickets", { dawn: 0.02, golden: 0.16, moonlit: 0.15, storm: 0 }[version]);
  useBed("rain", version === "storm" ? 0.42 : 0);
  const pan = () => Math.random() * 1.6 - 0.8;
  useEvery(
    1,
    4,
    () =>
      sound.play("chirp", {
        gain: 0.15 + Math.random() * 0.12,
        pan: pan(),
        pitch: 0.85 + Math.random() * 0.4
      }),
    version === "dawn"
  );
  useEvery(
    4,
    10,
    () =>
      sound.play("chirp", {
        gain: 0.1,
        pan: pan(),
        pitch: 0.6 + Math.random() * 0.3
      }),
    version === "golden"
  );
  useEvery(
    0.6,
    2.5,
    () =>
      sound.play("drip", {
        gain: 0.06 + Math.random() * 0.06,
        pan: pan(),
        pitch: 0.7 + Math.random() * 0.8
      }),
    version === "golden"
  );
  useEvery(
    10,
    24,
    () =>
      sound.play("hoot", {
        gain: 0.35 + Math.random() * 0.2,
        pan: pan(),
        pitch: 0.9 + Math.random() * 0.15
      }),
    version === "moonlit"
  );
}

const tension: DayDefinition = {
  camera: {
    position: [0.18, 0.06, 3.1],
    target: [0, 0, 0],
    fov: 38,
    phone: { position: [0, 0, 4.9], target: [0, 0, 0] }
  },
  hover: true,
  extents: { centre: [0, 0, 0], radius: 7 },
  look: { ...LOOK, exposure: 1.05, bloom: 0.45 },
  passes: { haze: false, depthOfField: { range: 3 } },
  settings: {
    version: { type: "choice", label: "Web", value: "dawn", options: VERSIONS },
    wind: {
      type: "range",
      label: "Wind",
      min: 0,
      max: 2,
      step: 0.01,
      value: 0.6
    },
    respin: { type: "action", label: "Spin a new web" }
  },
  phonePills: ["version", "respin"],
  overview: [
    {
      title: "The web",
      points: [
        "Spun like a garden spider's: frame threads, spokes, a hub mesh, then the sticky spiral, wider below the hub.",
        "Position-based dynamics on the CPU, two substeps a frame, pulls threads back to length; pull too far and one snaps."
      ]
    },
    {
      title: "Silk and dew",
      points: [
        "Threads are camera-facing strips at least a pixel wide, faded as they widen, with a sheen and a rainbow glint.",
        "Instanced dew beads are ball lenses showing the garden upside down; their weight sags the web."
      ]
    },
    {
      title: "The spider",
      points: [
        "Six-segment legs are solved every frame, so the foot comes down steeply to grip and ride a thread.",
        "She walks in an alternating tetrapod, sits head down at the hub and runs along the silk to where you pluck."
      ]
    },
    {
      title: "Tree and weather",
      points: [
        "Twigs grow through the frame's anchors, with CC0 Poly Haven bark and shader-drawn leaves that glow when backlit.",
        "Four weathers glide into each other, lit by a blurred garden dome, with GPU particles, depth of field and bloom."
      ]
    }
  ],
  hint: "Pull a thread and let it go. Pull too far and it snaps.",
  notes: "An orb web strung between twigs, beaded with dew, in four weathers. Pluck it and the spider comes running.",
  Scene
};

export default tension;
