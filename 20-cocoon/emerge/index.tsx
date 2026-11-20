"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { orbitControls, orbitPoint, useGrabbable } from "../../shared/engine/controls";
import { useDispose } from "../../shared/engine/dispose";
import { dismissPrompt } from "../../shared/engine/prompt";
import { holdQuality, initialTier, scenePhase, useQuality } from "../../shared/engine/quality";
import { useSetting, useSettingAction, useSettingsStore } from "../../shared/engine/settings";
import { sound, useBed, useEvery, useMusic } from "../../shared/engine/sound";
import { useLook } from "../../shared/engine/Stage";
import { followPrompt } from "../../shared/ui/Follow";
import { shareResult } from "../../shared/ui/Share";
import { Air } from "../../14-tension/air";
import { aim, sky, useSkyEase } from "../../14-tension/backdrop";
import { LOOKS, VERSIONS, type Version } from "../../14-tension/versions";
import { focus, usePointerRay, type Variant } from "../kit";
import { anchor, card, Overlay } from "./card";
import { chainName, clashes, prepareWall, wall, type Clash } from "./clash";
import { shakeDew } from "./drops";
import { dustSince, makeDust } from "./dust";
import { live } from "./live";
import { endFor, makeWay, TRY, wayOut } from "./exit";
import { Grip, HIPS, REACH } from "./grip";
import { BUILD, wingDetail, wingPace, wingUpload } from "./look";
import { Motes } from "./motes";
import { SkyDome } from "./sky";
import { caseMap, pupaAxis, pupaPoint, rimPoints, shell, SHELL_OPTIONS, shellProbe, shellSurface, STALK, usePupa, WALL } from "./pupa";
import { Butterfly, type Hold } from "./rig";
import { Tree } from "./set";
import { LIFE, SPECIES, SPECIES_NAMES, SPECIES_OPTIONS, type SpeciesName } from "./species";
import { Swarm, visitGate } from "./swarm";
import { branchPath, branchSurface, HANG, Twig } from "./twig";

// Recorded sounds (ElevenLabs): a flutter of wings as it takes to the air, and tiny feet scurrying as it walks.
const FLUTTER = "/assets/20-cocoon/flutter.mp3";
const SCURRY = "/assets/20-cocoon/scurry.mp3";

// A butterfly coming out of its chrysalis under a branch in Tension's garden, in the same light and weathers. Tap the
// chrysalis: it clears to show the wings folded inside, splits along its lines of weakness, and the butterfly climbs out
// to hang from the empty shell, fill its wings, dry them and try them. Reach for it and it flies up onto the branch,
// where it fans its wings and walks up and down. Reach for it again and it flies away for good; the shell lets go and
// falls, and the next butterfly's chrysalis grows in its place.

// The beats of the emergence, in seconds from the tap: compressed, in order, after the real thing (research/eclosion.md).
export const KEY = {
  clear: [0.3, 5.5],
  pleats: [4.2, 7],
  crack: 7.2,
  // The break-open is slow: the sides part in two pulls, the lid lifts in three, with a catch between each.
  sides: [7.25, 8.6],
  lid: [7.7, 10.2],
  legs: [9.8, 11.6],
  head: [10.8, 13.2],
  antennae: [20.8, 23.0],
  thorax: [13.0, 15.2],
  abdomen: [15.0, 16.8],
  flip: [15.4, 19.0],
  empty: [15.4, 20.3],
  expand: [18.8, 29.3],
  proboscis: [17.3, 29.3],
  dry: [28.3, 33.3],
  test: [33.3, 41.3],
  // From here it will answer a hand: after its first trial of its wings.
  ready: 36.2
} as const;

// The ventral side of the chrysalis, and the butterfly's back once it hangs, face this way: toward the eye's left, so the
// lid opens toward it and the open wings show their upper sides.
const FACING = new THREE.Vector3(-0.75, 0, 0.66).normalize();
const TURN = Math.atan2(FACING.x, FACING.z);
// Flight is shown slowed, as a high-speed camera would: this much of real time at the branch.
const SLOW = 0.5;
// The wings held up together over the back, in flight where there is no room to beat them.
const WINGS_UP = 1.45;
// Where it lands, along the branch from the point over the chrysalis, in forewing lengths; and how far it strolls.
const LAND_AT = -0.32;
const STROLL = [-1.4, 1.1];
// How far the lid swings open and the sides spring apart, in radians: each species as little as lets it out clean
// (found with the clash test).
const LID = 2.3;
const SIDES: Record<SpeciesName, number> = { morpho: 0.9, paperkite: 0.9, monarch: 0.9, glasswing: 0.75 };
// The way out, in seconds from the tap: the tail drawn out of the shell, the body curling forward as it comes, the
// swing up to hang, and the wing pads let out from the size of their cases.
const OUT = { drawn: [14.6, 19.0], hang: [18.2, 20.8], unpack: [21.6, 23.4], refold: [20.6, 21.6], close: [15.8, 17.4], flip: [15.2, 20.6] } as const;
// The flip, planned as a climb (by `__emerge.plan()`, which tries a grid of poses against the drawn shell and keeps the
// cheapest way through those where nothing is through a wall and at least three legs, here always four, could hold).
// Each row: the thorax's height above the shell's tip and its distance in front of the shell's middle line (forewing
// lengths), how far it has turned over (radians: 0 head down, pi head up), and the curl of its abdomen.
const FLIP: Record<SpeciesName, [number, number, number, number][]> = {
  morpho: [[0.079, 0.111, 0.501, 0.14], [0.079, 0.172, 0.627, 0.14], [0.079, 0.172, 0.753, 0.14], [0.079, 0.172, 0.879, 0.14], [0.079, 0.172, 1.005, 0.14], [0.079, 0.172, 1.131, 0.55], [0.079, 0.172, 1.257, 0.55], [0.079, 0.172, 1.383, 0.55], [0.079, 0.172, 1.509, 0.95], [0.079, 0.233, 1.635, 0.95], [0.079, 0.233, 1.761, 0.95], [0.017, 0.233, 1.887, 0.95], [0.017, 0.233, 2.013, 1.35], [-0.045, 0.233, 2.14, 1.75], [-0.045, 0.233, 2.266, 1.75], [-0.045, 0.233, 2.392, 1.75], [-0.045, 0.233, 2.518, 1.75], [-0.045, 0.233, 2.644, 1.75], [-0.045, 0.233, 2.77, 1.35], [-0.045, 0.172, 2.896, 0.95], [-0.045, 0.172, 3.022, 0.55]],
  paperkite: [[-0.025, 0.17, 0.872, 0.55], [-0.025, 0.17, 0.98, 0.55], [0.031, 0.17, 1.087, 0.55], [0.031, 0.231, 1.194, 0.55], [0.031, 0.231, 1.302, 0.55], [0.031, 0.231, 1.409, 0.55], [0.031, 0.231, 1.517, 0.95], [0.031, 0.231, 1.624, 0.95], [0.031, 0.292, 1.732, 0.95], [0.031, 0.292, 1.839, 0.95], [0.031, 0.292, 1.947, 0.95], [0.031, 0.292, 2.054, 0.95], [0.031, 0.292, 2.162, 0.95], [0.031, 0.292, 2.269, 0.95], [0.031, 0.292, 2.377, 1.35], [0.031, 0.292, 2.484, 1.35], [-0.025, 0.292, 2.592, 0.95], [-0.082, 0.231, 2.699, 0.55], [-0.138, 0.17, 2.807, 0.55], [-0.138, 0.109, 2.914, 0.55], [-0.138, 0.109, 3.022, 0.14]],
  monarch: [[0.026, 0.181, 0.567, 0.14], [0.026, 0.181, 0.69, 0.14], [0.026, 0.181, 0.812, 0.14], [0.026, 0.181, 0.935, 0.55], [0.026, 0.181, 1.058, 0.55], [0.026, 0.181, 1.181, 0.55], [0.026, 0.181, 1.303, 0.95], [0.026, 0.181, 1.426, 0.95], [0.026, 0.241, 1.549, 0.95], [0.026, 0.241, 1.672, 0.95], [0.026, 0.241, 1.794, 0.95], [0.09, 0.241, 1.917, 0.95], [0.09, 0.241, 2.04, 0.95], [0.09, 0.301, 2.162, 0.95], [0.09, 0.301, 2.285, 0.95], [0.09, 0.301, 2.408, 0.95], [0.09, 0.301, 2.531, 0.95], [0.09, 0.301, 2.653, 0.95], [0.026, 0.241, 2.776, 0.95], [0.026, 0.241, 2.899, 0.55], [0.026, 0.241, 3.022, 0.14]],
  glasswing: [[0.28, 0.382, 1.935, 1.35], [0.28, 0.382, 1.99, 1.35], [0.28, 0.382, 2.044, 1.35], [0.28, 0.382, 2.098, 1.35], [0.28, 0.382, 2.153, 1.35], [0.28, 0.382, 2.207, 1.35], [0.28, 0.382, 2.261, 1.35], [0.28, 0.382, 2.316, 1.35], [0.28, 0.382, 2.37, 1.35], [0.28, 0.382, 2.424, 1.35], [0.28, 0.382, 2.478, 1.35], [0.28, 0.382, 2.533, 1.35], [0.28, 0.382, 2.587, 1.35], [0.28, 0.382, 2.641, 1.35], [0.28, 0.382, 2.696, 1.35], [0.28, 0.382, 2.75, 1.35], [0.35, 0.382, 2.804, 1.35], [0.35, 0.382, 2.859, 1.35], [0.35, 0.382, 2.913, 1.35], [0.35, 0.382, 2.967, 1.35], [0.35, 0.382, 3.022, 1.35]]
};
// Which species take the planned flip, their clock waiting on their feet; the others still go the older way (carried
// to the hang, which their feet do not always reach). The Paper Kite's plan holds only three legs at its start, and
// walked, it stalls.
const PLANNED: Record<SpeciesName, boolean> = { morpho: true, monarch: true, glasswing: true, paperkite: true };
// Hanging: its lean back from upright; how far down the slit's lips it hangs from (0 at the tear line, 1 at the tip);
// and how far out from them it stands, as a share of its legs' reach.
const LEAN = 0.12;
const PARK = true;
const BUMP = 0.2;
// The draw-out in pulls: the flip's way taken in this many heaves, each over the first `duty` of its share of the time
// with a breath after, `depth` of the way from a steady glide (0) to whole stops between pulls (1). (false: the flip
// at an even pace, as it was planned. Proven on: no more shell hits than the even pace, feet as before.)
const PULLED = true;
// (Found by trying a grid of them against the clash test: deeper stops, or more or fewer pulls, put feet through walls.)
const PULLS = { count: 5, duty: 0.88, depth: 0.35 };
// How many feet must hold before the body moves on, through the flip.
const FEET = 3;
// Whether the emergence waits on its feet (see poseEmerging). Off until the way out itself keeps within their reach:
// with it on and the present way, no hold serves through the flip and the whole emergence crawls.
const GATE = true;
// The hang at arm's length (as the newly out butterfly really hangs: legs nearly straight, its thorax well below the
// shell's rim, wings and abdomen free beneath): its own planned flips, walked by a species once its plan is proven.
const ARM: Record<SpeciesName, boolean> = { morpho: false, paperkite: false, monarch: false, glasswing: false };
const FLIP_ARM: Record<SpeciesName, [number, number, number, number][]> = {
  morpho: [[0.079, 0.111, 0.501, 0.14], [0.079, 0.172, 0.627, 0.14], [0.079, 0.172, 0.753, 0.14], [0.079, 0.172, 0.879, 0.14], [0.079, 0.172, 1.005, 0.14], [0.079, 0.172, 1.131, 0.55], [0.079, 0.172, 1.257, 0.55], [0.079, 0.172, 1.383, 0.55], [0.079, 0.172, 1.509, 0.95], [0.079, 0.233, 1.635, 0.95], [0.079, 0.233, 1.761, 0.95], [0.017, 0.233, 1.887, 0.95], [0.017, 0.233, 2.013, 1.35], [-0.045, 0.233, 2.14, 1.75], [-0.108, 0.233, 2.266, 1.75], [-0.108, 0.233, 2.392, 1.75], [-0.108, 0.233, 2.518, 1.35], [-0.17, 0.172, 2.644, 0.95], [-0.17, 0.172, 2.77, 0.55], [-0.17, 0.172, 2.896, 0.14], [-0.17, 0.172, 3.022, 0.14]],
  paperkite: [[-0.138, 0.17, 0.872, 0.55], [-0.138, 0.17, 0.98, 0.95], [-0.138, 0.17, 1.087, 0.95], [-0.138, 0.17, 1.194, 1.35], [-0.195, 0.17, 1.302, 1.35], [-0.195, 0.17, 1.409, 1.35], [-0.195, 0.17, 1.517, 1.75], [-0.195, 0.17, 1.624, 1.75], [-0.195, 0.17, 1.732, 1.75], [-0.195, 0.17, 1.839, 1.75], [-0.251, 0.17, 1.947, 1.75], [-0.251, 0.17, 2.054, 1.35], [-0.251, 0.109, 2.162, 1.35], [-0.251, 0.109, 2.269, 1.35], [-0.251, 0.109, 2.377, 1.35], [-0.251, 0.109, 2.484, 1.35], [-0.251, 0.109, 2.592, 1.35], [-0.195, 0.109, 2.699, 1.35], [-0.195, 0.109, 2.807, 0.95], [-0.195, 0.109, 2.914, 0.55], [-0.195, 0.109, 3.022, 0.14]],
  monarch: [[0.026, 0.181, 0.567, 0.14], [0.026, 0.181, 0.69, 0.14], [0.026, 0.181, 0.812, 0.14], [0.026, 0.181, 0.935, 0.55], [0.026, 0.181, 1.058, 0.55], [-0.038, 0.181, 1.181, 0.95], [-0.102, 0.181, 1.303, 1.35], [-0.165, 0.181, 1.426, 1.35], [-0.165, 0.181, 1.549, 1.35], [-0.165, 0.181, 1.672, 1.75], [-0.165, 0.181, 1.794, 1.75], [-0.165, 0.181, 1.917, 1.75], [-0.229, 0.181, 2.04, 1.75], [-0.229, 0.181, 2.162, 1.75], [-0.229, 0.181, 2.285, 1.75], [-0.229, 0.121, 2.408, 1.75], [-0.229, 0.061, 2.531, 1.75], [-0.229, 0.061, 2.653, 1.35], [-0.229, 0.061, 2.776, 0.95], [-0.229, 0.061, 2.899, 0.55], [-0.229, 0.061, 3.022, 0.14]],
  glasswing: [[0.28, 0.382, 1.935, 1.35], [0.28, 0.382, 1.99, 1.35], [0.28, 0.382, 2.044, 1.35], [0.28, 0.382, 2.098, 1.35], [0.28, 0.382, 2.153, 1.35], [0.28, 0.382, 2.207, 1.35], [0.28, 0.382, 2.261, 1.35], [0.28, 0.382, 2.316, 1.35], [0.28, 0.382, 2.37, 1.35], [0.28, 0.382, 2.424, 1.35], [0.28, 0.382, 2.478, 1.35], [0.28, 0.382, 2.533, 1.35], [0.28, 0.382, 2.587, 1.35], [0.28, 0.382, 2.641, 1.35], [0.28, 0.382, 2.696, 1.35], [0.28, 0.382, 2.75, 1.35], [0.28, 0.438, 2.804, 1.35], [0.28, 0.438, 2.859, 1.35], [0.28, 0.438, 2.913, 1.75], [0.28, 0.438, 2.967, 1.75], [0.28, 0.438, 3.022, 1.75]]
};
// What each plan was made against (fingerprint(), below): a plan whose shell, body or holds have since changed is not
// walked, and that species comes out the old way until it is planned again.
const FLIP_FOR: Record<SpeciesName, number> = { morpho: 104.015, paperkite: 101.441, monarch: 106.246, glasswing: 100.652 };
// The emergence goes forward in steps of this length whatever the frame rate, so that it is the same every time: the
// same feet on the same holds, proven once (clash()) for everyone.
const TICK = 1 / 60;
// The most the feet may hold the clock back in one emergence, all told (seconds): past it, it goes on regardless.
const WAIT = 5;
// From when the rig may part the wing pads to keep them off the legs: once they are out from between the flaps.
const YIELD = 0;
// How far the head, eyes and palps are held off the shell once it hangs, past what they measure (forewing lengths):
// their hair reaches further than their cores.
const HEAD = 0.03;
// How far the sides stay open once the butterfly's thorax and wings are out, as a share of their widest.
const REST = 1;
const HANG_AT = 1.0;
const HANG_OUT = 0.5;
const HANG_DOWN = 0.5;
// The wing pads inside: folded back along the flanks.
// How far off the shell a foot's hold is set, in forewing lengths: the thickness of its toe.
const TOE = 0.007;
const FOLDED = 2.0;
const HUNG = 1.25;
// And the legs inside: this far folded as for flight, the rest drawn up under the chest.
const PACKED = 0.7;
// The order they come in, round and round: the Blue Morpho first and the Paper Kite's gold last.
const ROTATION: SpeciesName[] = ["morpho", "monarch", "glasswing", "paperkite"];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const span = (k: readonly [number, number] | readonly number[], t: number) => clamp01((t - k[0]) / (k[1] - k[0]));
const ease = (x: number) => x * x * (3 - 2 * x);
const easeOut = (x: number) => 1 - (1 - x) ** 3;
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const smooth = (a: number, b: number, x: number) => ease(clamp01((x - a) / (b - a)));
// Toward a value with no overshoot and no sudden start: a critically damped spring, stepped exactly, so it moves the
// same at any frame rate. Returns the new value; the speed is kept in `state.v`.
function spring(x: number, state: { v: number }, to: number, omega: number, dt: number) {
  const d = x - to;
  const temp = (state.v + omega * d) * dt;
  const e = Math.exp(-omega * dt);
  state.v = (state.v - omega * temp) * e;
  return to + (d + temp) * e;
}
function springVector(x: THREE.Vector3, v: THREE.Vector3, to: THREE.Vector3, omega: number, dt: number) {
  const e = Math.exp(-omega * dt);
  for (const axis of ["x", "y", "z"] as const) {
    const d = x[axis] - to[axis];
    const temp = (v[axis] + omega * d) * dt;
    v[axis] = (v[axis] - omega * temp) * e;
    x[axis] = to[axis] + (d + temp) * e;
  }
}
// How long the wings take to pass from one way of being held to another (hanging to flying, standing to flying).
const HAND = 0.32;

// The chrysalis: whole and waiting; opened (its timeline running, then empty); let go and falling; shrinking away
// unopened; waiting for the old butterfly to be gone; a new one growing.
type Pod = "idle" | "open" | "falling" | "fading" | "waiting" | "growing";
// The butterfly: none; on the shell (inside it, coming out, hanging); flying up to the branch; on the branch; leaving.
type Stage = "none" | "shell" | "hop" | "perched" | "leaving";

const LOOK = { background: "#000000", ao: 0.6, aoRadius: 0.2, vignette: 0.45, grain: 0.02, bloomThreshold: 0.8, haze: 0 };

// The branch for the rig: its smooth top line to be carried along, and, asked for an angle round it, the true bark as
// drawn (relief and moss), so that each foot is set on the surface itself.
const surface = (s: number, out: Hold, phi?: number) => {
  if (phi === undefined) branchPath(s, out);
  else branchSurface(s, phi, out);
};

function Scene() {
  const weather = useSetting<Version>("emergeWeather");
  const speciesName = useSetting<SpeciesName>("emergeSpecies");
  const store = useSettingsStore();
  const look = LOOKS[weather];
  const { tier } = useQuality();
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const scene = useThree((state) => state.scene);
  const size = useThree((state) => state.size);
  const renderer = useThree((state) => state.gl);
  const fine = tier === "low" ? 0.6 : tier === "medium" ? 0.8 : 1;
  const pointer = usePointerRay();

  useLook(useMemo(() => ({ ...LOOK, exposure: look.exposure, bloom: look.bloom }), [look]));
  const first = useRef(true);
  // A gentle track under the garden; the flutter and scurry are recorded loud enough to sit over it.
  useMusic("/codevember/music/hummingbird.mp3", 0.3);
  useEffect(() => {
    sound.preload(FLUTTER);
    sound.preload(SCURRY);
  }, []);
  useEffect(() => {
    aim(look, first.current);
    first.current = false;
  }, [look]);
  useSkyEase();
  useAmbience(weather);

  // A macro scene: let the eye come close.
  useEffect(() => {
    const orbit = orbitControls.current;
    if (!orbit) return;
    const before = orbit.minDistance;
    orbit.minDistance = 0.3;
    return () => {
      orbit.minDistance = before;
    };
  }, []);

  const pupa = usePupa(fine);
  const butterfly = useMemo(() => {
    // (Wings at half the size on the low tier and on phones: a quarter of the memory.)
    wingDetail.top = tier === "low" ? 2048 : 4096;
    return new Butterfly();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- made once, at the tier it starts on.
  }, []);
  useDispose(...butterfly.disposables);

  // Dust starts along the seams of the default chrysalis.
  const seams = useMemo(() => {
    const sp = SPECIES.morpho;
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < 40; i++) {
      const t = 0.45 + Math.random() * 0.55;
      out.push(pupaPoint(sp, t, (Math.random() < 0.5 ? -1 : 1) * (0.36 + Math.random() * 0.06)));
      out.push(pupaPoint(sp, 0.45, (Math.random() - 0.5) * Math.PI * 2));
    }
    return out;
  }, []);

  // The hanging: from the pad, a pendulum; inside it the chrysalis' own space.
  const rig = useMemo(() => {
    const hang = new THREE.Group();
    hang.position.copy(HANG);
    const pod = new THREE.Group();
    pod.position.y = -STALK;
    pod.rotation.y = TURN;
    hang.add(pod);
    const dust = makeDust(seams);
    return { hang, pod, dust };
  }, [seams]);
  // Put together after the memo, since React may run a memo twice and keep either: an object has only one parent.
  useEffect(() => {
    for (const name of SPECIES_NAMES) rig.pod.add(pupa.groups[name]);
    rig.pod.add(rig.dust.mesh);
    rig.pod.add(butterfly.object);
    // In flight and on the branch the butterfly is the scene's own child, not React's: taken out with the rest.
    return () => {
      butterfly.object.removeFromParent();
      // A change of quality builds the chrysalises again: the old ones must not stay hanging with the new.
      for (const name of SPECIES_NAMES) pupa.groups[name].removeFromParent();
      rig.dust.mesh.removeFromParent();
      card.hide();
    };
  }, [rig, pupa, butterfly]);
  useDispose(rig.dust.mesh.geometry, rig.dust.material);

  // Everything that changes from moment to moment.
  const sim = useMemo(
    () => ({
      pod: "idle" as Pod,
      stage: "none" as Stage,
      species: "morpho" as SpeciesName,
      t: 0,
      owed: 0,
      primed: "",
      prime: 0,
      // Whose shell wall, opened full, is sampled ready for the clash test (clash.ts: prepareWall).
      walled: "",
      // How far down the case its tail has come (the shell's t), the furthest yet in this emergence; -1 before.
      front: -1,
      frozen: false,
      waited: 0,
      clock: 0,
      // Sway of the hanging chrysalis, and its twitches.
      sx: 0,
      sz: 0,
      vx: 0,
      vz: 0,
      twitchAt: 4,
      // A new chrysalis: how far grown, and the time in whatever the pod is doing.
      grow: 1,
      podT: 0,
      // Hanging: its own clock, the next wing test and leg step.
      perch: 0,
      nextOpen: 8,
      openAt: -10,
      nextStep: 2,
      stepLeg: -1,
      stepAt: -10,
      // On the branch: what it is doing, until when, and which way it walks.
      stroll: { mode: "settle" as "settle" | "fan" | "walk" | "pause", t: 0, until: 1, dir: 1 as 1 | -1, speed: 0, since: 0, wasMoving: false, lastStep: 0, lastScurry: -10, loopAt: 28 },
      // Flight.
      fly: {
        t: 0,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        start: new THREE.Quaternion(),
        goal: new THREE.Vector3(),
        goalTurn: new THREE.Quaternion(),
        way: Array.from({ length: 6 }, () => new THREE.Vector3()),
        // How many of the way's points this flight uses, and how far along it each of 64 steps of the curve lies.
        ways: 4,
        arc: new Float32Array(65),
        // The bob of its strokes about the way: how far and how fast.
        bob: 0,
        bobV: 0,
        // How long its wings are held up over its back as it lets go, before the first stroke.
        held: 0,
        // How far it has come clear of what it took off from (0 to 1): it turns into its flying attitude only so far.
        clear: 0,
        dest: new THREE.Vector3(),
        yaw: 0,
        yaw0: 0,
        yaw1: 0,
        yawRate: 0,
        climb: 0.7,
        bank: 0,
        phase: 0,
        lastPhase: 0,
        flapping: true,
        bout: 0,
        glide: 0,
        beats: 0,
        landS: 0,
        push: new THREE.Vector3(),
        seed: 0,
        // The flight to the branch: which way it heads midway, which way it faces when it lands.
        yawMid: 2.9,
        facing: 1 as 1 | -1
      },
      // Whether a hand may set it off, for how long that has been so, and how long the pointer has been on it.
      armed: 0,
      armedAt: 0,
      dwell: 0,
      hinted: 0,
      // The eye: how far it started from what it looks at, and whether it has been told the butterfly landed.
      home: 0,
      earned: false,
      carded: "",
      fetched: "",
      // A new chrysalis asked for while it was on its way up to the branch: it goes as soon as it lands.
      sendOff: false,
      // How many feet hold the shell.
      planted: 0,
      // How fast the emergence's clock runs: slowed while the body waits on its feet.
      rate: 1,
      stuck: 0,
      // How long a chrysalis has hung ready, and how long since the visitor last moved the view themselves.
      ready: 0,
      own: 0,
      // For looking closely in development: the timeline stopped and the lens left alone.
      hold: false,
      // How far the eye has been carried from where the visitor left it, and drawn back.
      shift: new THREE.Vector3(),
      shiftV: new THREE.Vector3(),
      drawn: 0,
      drawnV: { v: 0 },
      focusV: new THREE.Vector3(),
      // The pose of the wings and legs at the moment one thing hands over to another, and how long ago.
      hand: { t: 9, flap: 0, fold: 0, sweep: 0, hindSweep: 0, pitch: 0, hindLag: 0, bend: 0, twist: 0, camber: 0, tuck: 0, tucked: 1 }
    }),
    []
  );

  // The species: only its chrysalis shows; its colours and wing frames are uniforms.
  const applySpecies = (name: SpeciesName) => {
    sim.species = name;
    const sp = SPECIES[name];
    live.jade.value.set(sp.jade);
    live.deep.value.set(sp.deep);
    live.spot.value.set(sp.spot);
    live.cleared.value.set(sp.cleared);
    live.gold.value = sp.gold;
    live.column.value = sp.column;
    live.length.value = sp.pupa;
    live.plump.value = sp.plump;
    live.fore.value.set(...sp.fore);
    live.hind.value.set(...sp.hind);
    live.structure.value = sp.structure;
    live.peak.value = sp.peak || 465;
    live.through.value = sp.through;
    live.body.value.set(sp.body);
    live.fur.value.set(sp.fur);
    live.dots.value = sp.gold > 0.5 ? 1 : 0;
    const apex = sp.column === 0 ? [0.69, 0.72] : sp.column === 1 ? [0.8, 0.59] : sp.column === 2 ? [0.85, 0.52] : [0.79, 0.61];
    const map = caseMap(apex as [number, number]);
    live.caseX.value.copy(map.x);
    live.caseY.value.copy(map.y);
    butterfly.setSpecies(sp);
  };
  // Choosing a butterfly jumps the rotation to it: at once if its chrysalis has not been touched, otherwise the one
  // that is out is let go and the chosen one's chrysalis grows.
  const applied = useRef(false);
  useEffect(() => {
    if (!applied.current) {
      applied.current = true;
      applySpecies(speciesName);
      // (The second one's wings are sent for behind the loader; after that, each next one's as the one before leaves.)
      butterfly.preload(SPECIES[ROTATION[(ROTATION.indexOf(speciesName) + 1) % ROTATION.length]]);
      sim.fetched = speciesName;
    } else if (speciesName !== sim.species) {
      // (Its wings are sent for at once, long before it is seen.)
      butterfly.preload(SPECIES[speciesName]);
      sim.fetched = sim.species;
      if (sim.stage === "none" && (sim.pod === "idle" || sim.pod === "growing")) applySpecies(speciesName);
      else restart();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the choice itself.
  }, [speciesName]);

  const scratch = useMemo(
    () => ({
      inv: new THREE.Matrix4(),
      ray: new THREE.Ray(),
      v: new THREE.Vector3(),
      w: new THREE.Vector3(),
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      c: new THREE.Vector3(),
      h: new THREE.Vector3(),
      head: new THREE.Vector3(),
      right: new THREE.Vector3(),
      back: new THREE.Vector3(),
      sphere: new THREE.Sphere(),
      q: new THREE.Quaternion(),
      q2: new THREE.Quaternion(),
      m: new THREE.Matrix4(),
      hold: { point: new THREE.Vector3(), normal: new THREE.Vector3(), tangent: new THREE.Vector3(), radius: 0 } as Hold,
      up: new THREE.Vector3(0, 1, 0),
      aim: new THREE.Vector3(),
      subject: new THREE.Vector3()
    }),
    []
  );

  const start = () => {
    if (sim.pod !== "idle" || sim.stage !== "none") return;
    dismissPrompt();
    // (The frame rate is not judged over the moments known to be heavy: the start, the split, a take-off.)
    holdQuality(9000);
    sim.pod = "open";
    sim.stage = "shell";
    sim.t = 0;
    sim.rate = 1;
    sim.perch = 0;
    sim.nextOpen = 8;
    sim.openAt = -10;
    pose.gait.reset();
    // The touch itself: a soft pluck and a bright ring over it; then the shell begins to creak.
    sound.play("plop", { gain: 0.4, pitch: 1.35 });
    sound.play("tinkle", { gain: 0.16, pitch: 1.1 });
    sound.play("tick", { gain: 0.22, pitch: 0.8 });
  };

  // Where the body stands on the branch at s, should the rig not say.
  const perchPose = (s: number, facing: 1 | -1, position: THREE.Vector3, turn: THREE.Quaternion) => {
    const sp = SPECIES[sim.species];
    const h = scratch.hold;
    branchPath(s, h);
    position.copy(h.point).addScaledVector(h.normal, 0.105 * sp.wing);
    scratch.head.copy(h.tangent).multiplyScalar(facing);
    scratch.right.crossVectors(scratch.head, h.normal).normalize();
    turn.setFromRotationMatrix(scratch.m.makeBasis(scratch.right, scratch.head, h.normal));
    butterfly.perchFrame(surface, s, facing, position, turn);
  };

  // The wings and legs as they are held now, kept so that what takes over next can ease away from it.
  const handOver = () => {
    const h = sim.hand;
    const b = butterfly;
    h.t = 0;
    h.flap = b.flap;
    h.fold = b.fold;
    h.sweep = b.sweep;
    h.hindSweep = b.hindSweep;
    h.pitch = b.pitch;
    h.hindLag = b.hindLag;
    h.bend = live.bend.value;
    h.twist = live.twist.value;
    h.camber = live.camber.value;
    h.tuck = live.tuck.value;
    h.tucked = b.tucked;
  };
  // Called after the new pose is written: for a moment it is mixed with the one before.
  const easeIn = (dt: number) => {
    const h = sim.hand;
    if (h.t >= HAND) return;
    h.t += dt;
    const k = ease(clamp01(h.t / HAND));
    const b = butterfly;
    // (The rig eases its own wing and abdomen poses in; the fold of the wings is the scene's.)
    b.fold = h.fold + (b.fold - h.fold) * k;
  };

  // Off the shell and up to the branch.
  const hop = () => {
    if (sim.stage !== "shell" || sim.t < KEY.ready) return;
    holdQuality(3000);
    const f = sim.fly;
    const sp = SPECIES[sim.species];
    const FL = sp.wing;
    scene.attach(butterfly.object);
    f.t = 0;
    f.pos.copy(butterfly.object.position);
    f.start.copy(butterfly.object.quaternion);
    // From rest: it lets go and is drawn back from the shell a little before its wings bite.
    f.vel.set(0, 0, 0);
    handOver();
    f.landS = LAND_AT * FL;
    perchPose(f.landS, 1, f.goal, f.goalTurn);
    branchPath(f.landS, scratch.hold);
    // Wings up over its back, it leaps off the shell out toward the eye and down, into open air far enough for a full
    // first stroke; beats out and up in front of the branch until it is above it, comes back in over it, and down onto
    // its top, its strokes shortening as it comes down (flyUp).
    const away = scratch.c.copy(FACING).add(scratch.v.set(0, 0, 1.4)).normalize();
    f.dest.copy(f.pos);
    f.way[0]
      .copy(f.pos)
      .addScaledVector(away, 0.9 * FL)
      .add(scratch.v.set(0, -0.35 * FL, 0));
    f.way[1]
      .copy(f.pos)
      .addScaledVector(away, 1.35 * FL)
      .add(scratch.v.set(0, 0.05 * FL, 0));
    f.way[2].copy(f.goal).add(scratch.v.set(-0.1 * FL, 0.5 * FL, 1.2 * FL));
    f.way[3].copy(f.goal).add(scratch.v.set(0, 0.6 * FL, 0.3 * FL));
    f.way[4].copy(f.goal).addScaledVector(scratch.hold.normal, 0.03 * FL);
    f.ways = 5;
    f.held = 0.22;
    f.clear = 0;
    layWay(f);
    f.bob = 0;
    f.bobV = 0;
    f.yaw0 = Math.atan2(-FACING.x, -FACING.z);
    f.yaw1 = Math.atan2(scratch.hold.tangent.x, scratch.hold.tangent.z);
    f.yawMid = 2.9;
    f.facing = 1;
    f.yaw = f.yaw0;
    f.phase = 0;
    f.lastPhase = 0;
    f.beats = 0;
    f.glide = 0;
    f.bank = 0;
    sim.stage = "hop";
    // The shell it let go of trembles and settles.
    pupa.nudge(1);
    sim.armed = 0;
    card.hint(null);
    sound.play("brush", { gain: 0.4, pitch: 1.25, pan: -0.2 });
    sound.sample(FLUTTER, 1.5);
  };

  // Off the branch and away.
  const leave = (fromShell = false) => {
    if (sim.stage !== (fromShell ? "shell" : "perched")) return;
    // (Through its going, the shell's fall and the next one growing.)
    holdQuality(9000);
    const f = sim.fly;
    const b = butterfly;
    // The next one's wings are sent for now, while there is most going on to hide the moment they arrive.
    const chosen = store.get("emergeSpecies") as SpeciesName;
    b.preload(SPECIES[chosen !== sim.species ? chosen : ROTATION[(ROTATION.indexOf(sim.species) + 1) % ROTATION.length]]);
    if (!fromShell) b.release();
    scene.attach(b.object);
    f.t = 0;
    f.pos.copy(b.object.position);
    f.start.copy(b.object.quaternion);
    // Wings up, it leaps clear (way 0 to way 1) far enough for a full first stroke: off the shell out toward the eye
    // and down, off the bark up and out.
    const FL = SPECIES[sim.species].wing;
    f.way[0].copy(f.pos);
    if (fromShell) {
      f.push.copy(FACING).add(scratch.v.set(0, 0, 1.4)).normalize().add(scratch.v.set(0, -0.45, 0)).normalize();
      f.way[1].copy(f.pos).addScaledVector(f.push, 1.0 * FL);
      f.yaw = Math.atan2(f.push.x, f.push.z);
    } else {
      branchPath(b.s, scratch.hold);
      shakeDew(0.5, b.object.position);
      f.way[1]
        .copy(f.pos)
        .addScaledVector(scratch.hold.normal, 0.7 * FL)
        .add(scratch.v.set(0, 0, 0.35 * FL));
      f.push.copy(f.way[1]).sub(f.pos).normalize();
      f.yaw = Math.atan2(scratch.hold.tangent.x * b.facing, scratch.hold.tangent.z * b.facing);
    }
    f.held = 0.2;
    // Up and out past the eye's shoulder, on the side away from the controls.
    scratch.right.setFromMatrixColumn(camera.matrixWorld, 0);
    f.dest
      .copy(camera.position)
      .addScaledVector(scratch.right, -2.7)
      .add(scratch.v.set(0, 1.0, 0));
    f.phase = 0;
    f.lastPhase = 0;
    f.beats = 0;
    f.flapping = true;
    f.bout = 0;
    f.glide = 0;
    f.bank = 0;
    f.yawRate = 0;
    f.climb = 0.7;
    f.clear = 0;
    // From rest, pushed off by its legs over the first moment rather than all at once.
    f.vel.set(0, 0, 0);
    f.seed = Math.random() * 10;
    handOver();
    sim.stage = "leaving";
    sim.armed = 0;
    card.hint(null);
    sound.play("whoosh", { gain: 0.28, pitch: 1.5 });
    sound.play("brush", { gain: 0.45, pitch: 1.2 });
    sound.sample(FLUTTER, 1.7);
  };

  // Left alone on the branch a while, it lifts off, flies a small loop out over the eye's side of the branch and comes
  // down on it again a little way along: the same flight as the one up from the shell, from a standing start.
  const loop = () => {
    if (sim.stage !== "perched") return;
    const f = sim.fly;
    const b = butterfly;
    const FL = SPECIES[sim.species].wing;
    const from = b.s;
    const to = THREE.MathUtils.clamp(from + (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.5) * FL, STROLL[0] * FL, STROLL[1] * FL);
    const heading = b.facing;
    b.release();
    scene.attach(b.object);
    f.t = 0;
    f.pos.copy(b.object.position);
    f.start.copy(b.object.quaternion);
    f.vel.set(0, 0, 0);
    handOver();
    f.landS = Math.abs(to - from) < 0.3 * FL ? THREE.MathUtils.clamp(from - Math.sign(to - from || 1) * 0.7 * FL, STROLL[0] * FL, STROLL[1] * FL) : to;
    f.facing = Math.random() < 0.5 ? 1 : -1;
    perchPose(f.landS, f.facing, f.goal, f.goalTurn);
    branchPath(from, scratch.hold);
    // Wings up, a leap up and out off the bark far enough for a full first stroke; out and over in front of the branch,
    // back in over where it lands and down onto it.
    f.dest.copy(f.pos);
    f.way[0]
      .copy(f.pos)
      .addScaledVector(scratch.hold.normal, 0.7 * FL)
      .add(scratch.v.set(0, 0, 0.35 * FL));
    f.yaw0 = Math.atan2(scratch.hold.tangent.x * heading, scratch.hold.tangent.z * heading);
    branchPath(f.landS, scratch.hold);
    f.way[1]
      .copy(f.pos)
      .lerp(f.goal, 0.5)
      .add(scratch.v.set(0, 0.75 * FL, 1.1 * FL));
    f.way[2].copy(f.goal).add(scratch.v.set(0, 0.6 * FL, 0.3 * FL));
    f.way[3].copy(f.goal).addScaledVector(scratch.hold.normal, 0.03 * FL);
    f.ways = 4;
    f.held = 0.2;
    f.clear = 0;
    layWay(f);
    f.bob = 0;
    f.bobV = 0;
    // Heading: out along the way it goes, then round to face along the branch; each the short way round from the last.
    const near = (a: number, to: number) => a - Math.PI * 2 * Math.round((a - to) / (Math.PI * 2));
    f.yawMid = near(Math.atan2(f.way[1].x - f.way[0].x, f.way[1].z - f.way[0].z - 0.6 * FL), f.yaw0);
    f.yaw1 = near(Math.atan2(scratch.hold.tangent.x * f.facing, scratch.hold.tangent.z * f.facing), f.yawMid);
    f.yaw = f.yaw0;
    f.phase = 0;
    f.lastPhase = 0;
    f.beats = 0;
    f.glide = 0;
    f.bank = 0;
    sim.stage = "hop";
    sim.armed = 0;
    sound.play("brush", { gain: 0.35, pitch: 1.2, pan: THREE.MathUtils.clamp(f.pos.x * 0.25, -0.6, 0.6) });
    sound.sample(FLUTTER, 1.2);
  };

  // What a hand on the butterfly does, by where it is.
  const act = () => {
    if (sim.stage === "shell") hop();
    else if (sim.stage === "perched") leave();
  };

  // The shell lets go of the branch.
  const drop = () => {
    if (sim.pod !== "open") return;
    sim.pod = "falling";
    sim.podT = 0;
    pupa.dropShell();
    sound.play("snap", { gain: 0.16, pitch: 1.7 });
    sound.play("tick", { gain: 0.2, pitch: 1.3 });
  };

  // A new chrysalis, whatever is going on: the butterfly, if it is out, is let go; the shell falls or, unopened, is
  // drawn back into the pad; and the next one grows.
  const restart = () => {
    if (sim.pod === "falling" || sim.pod === "fading" || sim.pod === "waiting" || sim.pod === "growing") return;
    holdQuality(6000);
    card.hide();
    sim.carded = "";
    if (sim.stage === "perched") leave();
    else if (sim.stage === "shell" && sim.t >= KEY.ready) leave(true);
    else if (sim.stage === "hop") sim.sendOff = true;
    if (sim.pod === "open" && sim.stage !== "shell") drop();
    else {
      sim.pod = "fading";
      sim.podT = 0;
      sound.play("rustle", { gain: 0.2, pitch: 0.7 });
    }
  };
  useSettingAction("emergeRegrow", restart);

  // Taps: on the chrysalis to begin, on the butterfly to send it on.
  const target = useRef<"pupa" | "butterfly" | null>(null);
  const canAct = () => (sim.stage === "shell" && sim.t >= KEY.ready) || (sim.stage === "perched" && sim.stroll.since > 1.2);
  useGrabbable({
    pick(ray) {
      target.current = null;
      const species = SPECIES[sim.species];
      if (canAct() && butterfly.object.parent) {
        butterfly.object.updateMatrixWorld();
        scratch.sphere.center.set(0, -0.05, 0.3).applyMatrix4(butterfly.object.matrixWorld);
        scratch.sphere.radius = species.wing * 0.6;
        const hit = ray.intersectSphere(scratch.sphere, scratch.v);
        if (hit) {
          target.current = "butterfly";
          return { distance: ray.origin.distanceTo(hit), point: hit.clone() };
        }
      }
      if (sim.pod === "idle" && sim.stage === "none") {
        // The chrysalis as an ellipsoid in its own space.
        rig.pod.updateMatrixWorld();
        scratch.inv.copy(rig.pod.matrixWorld).invert();
        const local = scratch.ray.copy(ray).applyMatrix4(scratch.inv);
        const L = species.pupa;
        const r = species.plump * L * 1.35;
        local.origin.y = (local.origin.y + L * 0.55) * (r / (L * 0.55));
        local.direction.y *= r / (L * 0.55);
        local.direction.normalize();
        scratch.sphere.center.set(0, 0, 0);
        scratch.sphere.radius = r;
        if (local.intersectSphere(scratch.sphere, scratch.w)) {
          const point = rig.pod.localToWorld(new THREE.Vector3(0, -L * 0.55, 0));
          target.current = "pupa";
          return { distance: ray.origin.distanceTo(point), point };
        }
      }
      return null;
    },
    grab() {},
    drag() {},
    release() {
      if (target.current === "pupa") {
        sim.vx += 0.25;
        start();
      } else if (target.current === "butterfly") act();
      target.current = null;
    }
  });

  // For screenshots in development: jump the timeline, set things off.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (globalThis as Record<string, unknown>).__emerge = {
      sim,
      camera,
      rig,
      orbitPoint,
      KEY,
      seek(t: number) {
        if (sim.stage !== "shell") {
          sim.pod = "open";
          sim.stage = "shell";
          sim.grow = 1;
          pupa.resetDrop();
          pupa.grow(1);
          live.fade.value = 0;
          rig.hang.visible = true;
        }
        sim.t = t;
        sim.frozen = false;
        dismissPrompt();
      },
      // In development: the emergence worked through from its beginning to a time, step by step as it is played, and
      // held frozen there (for pictures of the very run a visitor sees, whatever the page was doing before).
      at(to: number) {
        (window as unknown as { __emerge: { seek(t: number): void } }).__emerge.seek(0);
        const b = butterfly;
        const { x, z } = rig.hang.rotation;
        rig.hang.rotation.set(0, 0, 0);
        sim.rate = 1;
        let t = 0;
        for (let turns = 0; t < to && turns < 20000; t += TICK * sim.rate, turns++) {
          openShell(t);
          poseEmerging(t, TICK);
          rig.hang.updateMatrixWorld(true);
          b.object.updateMatrixWorld(true);
          b.update(camera.position, TICK);
          followTail(t);
        }
        rig.hang.rotation.set(x, 0, z);
        sim.t = t;
        sim.hold = sim.frozen = true;
        return [sim.species, +t.toFixed(3)];
      },
      start,
      hop,
      leave,
      loop,
      act,
      takeOff: act,
      regrow: restart,
      diary,
      plans,
      fingerprint,
      clash,
      // In development: every flight of one butterfly (up from the shell, `loops` little loops off the branch, away),
      // flown a step at a time from a seed, and at each step its body and wings (legs aside: feet are meant to touch)
      // tested against the shell, the branch and the trunk. Must find nothing.
      flights(name: SpeciesName = sim.species, seed = 1, loops = 2, fromShell = false) {
        const random = Math.random;
        let a = seed >>> 0 || 1;
        Math.random = () => {
          a = (a + 0x6d2b79f5) | 0;
          let x = Math.imul(a ^ (a >>> 15), 1 | a);
          x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
          return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
        };
        try {
          if (sim.species !== name) applySpecies(name);
          (window as unknown as { __emerge: { at(t: number): void } }).__emerge.at(KEY.ready + 0.2);
          const sp = SPECIES[sim.species];
          const FL = sp.wing;
          const b = butterfly;
          const toPod = new THREE.Matrix4();
          const toBody = new THREE.Matrix4();
          const found: Clash[] = [];
          const h = { point: new THREE.Vector3(), normal: new THREE.Vector3(), tangent: new THREE.Vector3(), radius: 0 };
          const c = new THREE.Vector3();
          const d = new THREE.Vector3();
          const p = new THREE.Vector3();
          const q = new THREE.Vector3();
          const at = new THREE.Vector3();
          const side = new THREE.Vector3();
          // How far a point stands off the bark (negative inside it), the bark as drawn.
          const offBark = (pt: THREE.Vector3) => {
            let s = pt.x;
            for (let i = 0; i < 4; i++) {
              branchPath(s, h);
              c.copy(h.point).addScaledVector(h.normal, -h.radius);
              s += d.copy(pt).sub(c).dot(h.tangent);
            }
            branchPath(s, h);
            c.copy(h.point).addScaledVector(h.normal, -h.radius);
            d.copy(pt).sub(c);
            d.addScaledVector(h.tangent, -d.dot(h.tangent));
            side.crossVectors(h.tangent, h.normal);
            const phi = Math.atan2(d.dot(side), d.dot(h.normal));
            return d.length() - branchSurface(s, phi, h).radius;
          };
          const fly = (kind: string, until: () => boolean, most: number) => {
            const r = { kind, steps: 0, shell: 0, branch: 0, trunk: 0, legs: 0, barkGap: 9, what: {} as Record<string, number>, line: "", path: [] as number[][], worst: [] as string[], cross: 0, midGap: 9 };
            const note = (what: string) => (r.what[what] = (r.what[what] ?? 0) + 1);
            for (; r.steps < most && !until(); r.steps++) {
              if (sim.stage === "hop") flyUp(TICK);
              else if (sim.stage === "leaving") flyAway(TICK);
              else if (sim.stage === "perched") stroll(TICK);
              else break;
              b.object.updateMatrixWorld(true);
              b.update(camera.position, TICK);
              const probe = b.probe();
              // The left wings against the right: each is the other's mirror, so they cross where either is past the
              // body's middle plane (wings 0 and 2 on its right, 1 and 3 on its left).
              toBody.copy(b.object.matrixWorld).invert();
              let mid = 9;
              const per = [9, 9, 9, 9];
              for (let i = 0; i < probe.count; i++) {
                const chain = probe.chain[i];
                if (chain < 20) continue;
                const w = Math.floor(((chain - 20) % 20) >= 10 ? -1 : (chain - 20) / 20);
                if (w < 0) continue;
                const x = at.fromArray(probe.points, i * 3).applyMatrix4(toBody).x;
                // (Hindwing samples wrapped round the abdomen have the body between them, not the other wing.)
                if (w > 1 && Math.hypot(at.x, at.z) < 0.07) continue;
                mid = Math.min(mid, w % 2 === 0 ? x : -x);
                per[w] = Math.min(per[w], w % 2 === 0 ? x : -x);
              }
              r.midGap = Math.min(r.midGap, mid);
              if (mid < 0) r.cross++;
              let shellHit = false;
              let barkHit = false;
              let trunkHit = false;
              let least = 9;
              let leastAt = "";
              if (sim.pod === "open") {
                rig.hang.updateMatrixWorld(true);
                toPod.copy(rig.pod.matrixWorld).invert();
                found.length = 0;
                clashes(sp, pupa.pivots[sim.species], probe, toPod, 1, found);
                for (const f of found) {
                  if (f.chain >= 3 && f.chain <= 8) r.legs++;
                  else {
                    shellHit = true;
                    note(`shell ${chainName(f.chain)}`);
                  }
                }
              }
              for (let i = 0; i < probe.count; i++) {
                const chain = probe.chain[i];
                if (chain < 0 || (chain >= 3 && chain <= 8)) continue;
                const joined = i + 1 < probe.count && probe.chain[i + 1] === chain;
                p.fromArray(probe.points, i * 3);
                if (joined) q.fromArray(probe.points, (i + 1) * 3);
                for (let k = 0; k <= (joined ? 2 : 0); k++) {
                  at.lerpVectors(p, joined ? q : p, k / 2);
                  const gap = offBark(at) - probe.radius[i];
                  r.barkGap = Math.min(r.barkGap, gap / FL);
                  if (gap < least) {
                    least = gap;
                    leastAt = chainName(chain);
                  }
                  if (gap < 0 && !barkHit) {
                    barkHit = true;
                    note(`branch ${chainName(chain)}`);
                  }
                  if (Math.hypot(at.x + 5.25, at.z + 3.7) < 0.9 && !trunkHit) {
                    trunkHit = true;
                    note(`trunk ${chainName(chain)}`);
                  }
                }
              }
              if (shellHit) r.shell++;
              if (barkHit) r.branch++;
              if (barkHit) r.worst.push(`${r.steps}:${leastAt}:${(least / FL).toFixed(3)}`);
              if (r.steps % 10 === 0) r.path.push(b.object.position.toArray().map((v) => +v.toFixed(3)));
              r.line += shellHit && barkHit ? "X" : shellHit ? "s" : barkHit ? "b" : trunkHit ? "t" : mid < 0 ? "c" : ".";
              if (mid < 0) r.worst.push(`${r.steps}: mid ${mid.toFixed(3)} fold ${b.fold.toFixed(2)} flap ${b.flap.toFixed(2)} pitch ${b.pitch.toFixed(2)} per ${per.map((v) => v.toFixed(3))} lag ${b.hindLag.toFixed(2)} bend ${live.bend.value.toFixed(2)} tw ${live.twist.value.toFixed(2)} cam ${live.camber.value.toFixed(2)}`);
              if (trunkHit) r.trunk++;
            }
            r.barkGap = +r.barkGap.toFixed(3);
            r.midGap = +r.midGap.toFixed(4);
            return r;
          };
          // On the branch a while between flights, as it would be (measured too: the stance itself).
          const rest = (time: number) => fly("perch", () => sim.stage !== "perched", Math.round(time / TICK));
          const out: ReturnType<typeof fly>[] = [];
          if (fromShell) {
            leave(true);
            out.push(fly("leave off the shell", () => sim.stage !== "leaving" || sim.fly.t > 4, 900));
            return { species: sim.species, seed, flights: out };
          }
          hop();
          out.push(fly("hop", () => sim.stage !== "hop", 600));
          for (let n = 0; n < loops; n++) {
            out.push(rest(2.5));
            sim.stroll.mode = "pause";
            loop();
            out.push(fly("loop", () => sim.stage !== "hop", 600));
          }
          out.push(rest(6));
          leave();
          out.push(fly("leave", () => sim.stage !== "leaving" || sim.fly.t > 4, 900));
          return { species: sim.species, seed, flights: out };
        } finally {
          Math.random = random;
        }
      },
      // In development: the frame as it is drawn now against the shell, with how far each sample of the head is from it.
      now() {
        const sp = SPECIES[sim.species];
        const toPod = new THREE.Matrix4().copy(rig.pod.matrixWorld).invert();
        const probe = butterfly.probe();
        const found = clashes(sp, pupa.pivots[sim.species], probe, toPod, 1, [], HEAD * sp.wing);
        const where = { piece: 0, t: 0, u: 0, depth: 0 };
        const point = new THREE.Vector3();
        const head: string[] = [];
        let first = 0;
        for (let i = 0; i < probe.count; i++) {
          const chain = probe.chain[i];
          if (i > 0 && probe.chain[i - 1] !== chain) first = i;
          if (!((chain === 0 && i - first < 3) || chain === 1 || chain === 2 || (chain >= 9 && chain <= 16))) continue;
          const w = wall(sp, pupa.pivots[sim.species], point.fromArray(probe.points, i * 3).applyMatrix4(toPod), where, 0.2);
          head.push(`${chainName(chain)}#${i - first} r${(probe.radius[i] / sp.wing).toFixed(3)} ${w ? `piece${w.piece} depth${(w.depth / sp.wing).toFixed(3)}` : "far"}`);
        }
        return { t: sim.t, clashes: found.map((c) => `${chainName(c.chain)} piece${c.piece} ${c.kind} depth${c.depth.toFixed(4)} r${c.radius.toFixed(4)}`), head };
      },
      // In development: the flip planned as a climb. Every pose of a grid (how far it has turned over, where its
      // thorax is in the middle plane, how far its abdomen is curled) is tried against the drawn shell: is anything
      // through a wall, and how many legs could hold from there. Then the cheapest way through poses that are clear
      // and held by at least three legs, from where it comes out to head-up. The result is written into FLIP below.
      plan(layers = 13, minFeet = 3, headFrom = 0.7, grid = 9, long = false) {
        const sp = SPECIES[sim.species];
        const FL = sp.wing;
        const L = sp.pupa;
        const b = butterfly;
        const pivots = pupa.pivots[sim.species];
        const build = BUILD[sp.column] ?? BUILD[1];
        const at = OUT.drawn[0];
        openShell(at);
        pose.gait.reset();
        poseEmerging(at, 0);
        // (Through the flip every leg may hold wherever it can: the hind legs' rule for the way out is over.)
        pose.gait.forward = false;
        pose.gait.rim = long;
        const from = { y: b.object.position.y, z: b.object.position.z, turn: pose.way.pitch - Math.PI * 2 * Math.round(pose.way.pitch / (Math.PI * 2)), curl: pose.way.tuck };
        const to = Math.PI - LEAN;
        const tipY = -L;
        const ys = Array.from({ length: grid }, (_, i) => tipY - 0.42 * FL + ((0.5 * L + 0.42 * FL) * i) / (grid - 1));
        const zs = Array.from({ length: grid }, (_, i) => 0.06 + ((0.72 * FL - 0.06) * i) / (grid - 1));
        const curls = [0.14, 0.55, 0.95, 1.35, 1.75];
        const toPod = new THREE.Matrix4();
        const found: Clash[] = [];
        const head = new THREE.Vector3();
        const back = new THREE.Vector3();
        const X = new THREE.Vector3(1, 0, 0);
        const m = new THREE.Matrix4();
        const test = (y: number, z: number, turn: number, curl: number, hung = false, off = 0, full = 0): number => {
          // (The last pose must also be clear with its wings let out of their pads and hanging, as they will be there.)
          if (hung && test(y, z, turn, curl, false, off) < 0) return -1;
          // (And, for the hang at arm's length, with its wings at their full size, hanging and then raised to dry.)
          if (hung && long && !full && (test(y, z, turn, curl, true, off, 1) < 0 || test(y, z, turn, curl, true, off, 2) < 0)) return -1;
          live.pack.value = hung ? 0 : 1;
          live.crumple.value = hung && !full ? 1 : full ? 0 : 0.2;
          live.expand.value = full ? 1 : 0;
          b.fold = full === 2 ? 0.45 : hung ? HUNG : FOLDED;
          b.object.position.set(0, y, z);
          head.set(0, -Math.cos(turn), Math.sin(turn));
          back.set(0, -Math.sin(turn), -Math.cos(turn));
          b.object.quaternion.setFromRotationMatrix(m.makeBasis(X, head, back));
          b.object.scale.setScalar(FL);
          live.tuck.value = curl;
          b.tucked = 1;
          rig.hang.updateMatrixWorld(true);
          b.update(camera.position);
          toPod.copy(rig.pod.matrixWorld).invert();
          found.length = 0;
          // (Everything a little stouter than it measures, so that what passes here passes between the poses tried too.)
          clashes(sp, pivots, b.probe(), toPod, 1.07, found, off);
          let hits = 0;
          for (const c of found) if (c.chain < 3 || c.chain > 8) hits++;
          if (hits) return -1;
          b.object.updateMatrix();
          b.object.updateMatrixWorld();
          let feet = 0;
          for (let k = 2; k < 6; k++) if (pose.gait.couldHold(sp, pivots, k, b.object, FL, build.leg)) feet++;
          return feet;
        };
        // feet[i][j][k][c], and the cheapest cost to reach each.
        const size = ys.length * zs.length * curls.length;
        const index = (j: number, k: number, c: number) => (j * zs.length + k) * curls.length + c;
        const feet: Int8Array[] = [];
        const cost: Float32Array[] = [];
        const prev: Int32Array[] = [];
        const open: number[] = [];
        const between = new Map<string, boolean>();
        for (let i = 0; i < layers; i++) {
          const turn = from.turn + ((to - from.turn) * i) / (layers - 1);
          const f = new Int8Array(size);
          let n = 0;
          for (let j = 0; j < ys.length; j++)
            for (let k = 0; k < zs.length; k++)
              for (let c = 0; c < curls.length; c++) {
                f[index(j, k, c)] = test(ys[j], zs[k], turn, curls[c], i === layers - 1, i >= headFrom * (layers - 1) ? HEAD * FL : 0);
                if (f[index(j, k, c)] >= minFeet) n++;
              }
          feet.push(f);
          open.push(n);
          cost.push(new Float32Array(size).fill(Infinity));
          prev.push(new Int32Array(size).fill(-1));
        }
        // It begins at the first turn of the grid that has a pose near where it comes out (the turns before that are
        // crossed on the way from the scripted pose to it).
        let first = 0;
        for (; first < layers - 1; first++) {
          let any = false;
          for (let j = 0; j < ys.length; j++)
            for (let k = 0; k < zs.length; k++)
              for (let c = 0; c < curls.length; c++) {
                const far = Math.hypot(ys[j] - from.y, zs[k] - from.z);
                if (feet[first][index(j, k, c)] < minFeet || far >= 0.36 * FL) continue;
                // (And the way to it from where it comes out must be clear.)
                const turn = from.turn + ((to - from.turn) * first) / (layers - 1);
                let clear = true;
                for (const f of [0.25, 0.5, 0.75]) if (clear && test(from.y + (ys[j] - from.y) * f, from.z + (zs[k] - from.z) * f, from.turn + (turn - from.turn) * f, from.curl + (curls[c] - from.curl) * f) < 0) clear = false;
                if (clear) {
                  cost[first][index(j, k, c)] = far * 4 + Math.abs(curls[c] - from.curl);
                  any = true;
                }
              }
          if (any) break;
        }
        for (let i = first + 1; i < layers; i++)
          for (let j = 0; j < ys.length; j++)
            for (let k = 0; k < zs.length; k++)
              for (let c = 0; c < curls.length; c++) {
                const here = index(j, k, c);
                if (feet[i][here] < minFeet) continue;
                for (let dj = -1; dj <= 1; dj++)
                  for (let dk = -1; dk <= 1; dk++)
                    for (let dc = -1; dc <= 1; dc++) {
                      const pj = j + dj;
                      const pk = k + dk;
                      const pc = c + dc;
                      if (pj < 0 || pk < 0 || pc < 0 || pj >= ys.length || pk >= zs.length || pc >= curls.length) continue;
                      const before = cost[i - 1][index(pj, pk, pc)];
                      if (!Number.isFinite(before)) continue;
                      const step = before + 0.3 * (Math.abs(dj) + Math.abs(dk)) + 0.2 * Math.abs(dc) + (4 - feet[i][here]) * 0.6;
                      if (step < cost[i][here]) {
                        // The way between the two must be clear too, not only its ends: tried at a third and two thirds.
                        if (dj || dk || dc) {
                          const key = `${i}:${here}:${index(pj, pk, pc)}`;
                          let clear = between.get(key);
                          if (clear === undefined) {
                            const t0 = from.turn + ((to - from.turn) * (i - 1)) / (layers - 1);
                            const t1 = from.turn + ((to - from.turn) * i) / (layers - 1);
                            clear = true;
                            for (const f of [0.2, 0.4, 0.6, 0.8]) {
                              // (As it is played: the turn goes evenly, the place and the curl ease from one pose to the next.)
                              const e = f * f * (3 - 2 * f);
                              if (clear && test(ys[pj] + (ys[j] - ys[pj]) * e, zs[pk] + (zs[k] - zs[pk]) * e, t0 + (t1 - t0) * f, curls[pc] + (curls[c] - curls[pc]) * e, false, i >= headFrom * (layers - 1) ? HEAD * FL : 0) < 0) clear = false;
                            }
                            between.set(key, clear);
                          }
                          if (!clear) continue;
                        }
                        cost[i][here] = step;
                        prev[i][here] = index(pj, pk, pc);
                      }
                    }
              }
        // The end: head-up, abdomen nearly straight, as cheap as may be.
        let best = -1;
        let least = Infinity;
        for (let n = 0; n < size; n++) {
          const c = n % curls.length;
          // (At arm's length: as low under the shell as its legs will hold it, before anything else.)
          const low = long ? ((ys[Math.floor(n / curls.length / zs.length)] - ys[0]) / FL) * 30 + (4 - feet[layers - 1][n]) * 2 : 0;
          const total = cost[layers - 1][n] + curls[c] * 0.8 + low;
          if (total < least) {
            least = total;
            best = n;
          }
        }
        const way: number[][] = [];
        for (let i = layers - 1, n = best; i >= 0 && n >= 0; n = prev[i][n], i--) {
          const c = n % curls.length;
          const k = Math.floor(n / curls.length) % zs.length;
          const j = Math.floor(n / curls.length / zs.length);
          way.unshift([+((ys[j] - tipY) / FL).toFixed(3), +(zs[k] / FL).toFixed(3), +(from.turn + ((to - from.turn) * i) / (layers - 1)).toFixed(3), curls[c], feet[i][n]]);
        }
        pose.gait.reset();
        // (For the eye: the last turn's poses by height and distance, each with the most feet that could hold there.)
        const ends = ys.map((y, j) => `${((y - tipY) / FL).toFixed(2)} ` + zs.map((_, k) => Math.max(...curls.map((__, c) => feet[layers - 1][index(j, k, c)]))).map((n) => (n < 0 ? "." : n)).join(""));
        return { ends, print: fingerprint(), from: [+((from.y - tipY) / FL).toFixed(3), +(from.z / FL).toFixed(3), +from.turn.toFixed(3), +from.curl.toFixed(2)], open, way };
      },
      // The checker checked: points set a known distance inside and outside the shell as drawn now, all over every
      // piece, must each be found on its piece at that depth. Returns how many were missed and the worst error.
      checker(t = 12, off = 0.005) {
        const sp = SPECIES[sim.species];
        const pivots = pupa.pivots[sim.species];
        openShell(t);
        const out = { point: new THREE.Vector3(), normal: new THREE.Vector3() };
        const where = { piece: 0, t: 0, u: 0, depth: 0 };
        const p = new THREE.Vector3();
        let tried = 0;
        let missed = 0;
        let worst = 0;
        const misses: string[] = [];
        for (let i = 0; i < 40; i++)
          for (let j = 0; j < 48; j++) {
            const st = 0.06 + 0.92 * (i / 39);
            const su = -Math.PI + ((j + 0.5) / 48) * Math.PI * 2;
            shellSurface(sp, st, su, pivots, out);
            if (out.normal.lengthSq() < 0.5) continue;
            for (const side of [-1, 1]) {
              p.copy(out.point).addScaledVector(out.normal, side * off);
              tried++;
              let hit = false;
              const w = wall(sp, pivots, p, where);
              if (w && Math.abs(w.t - st) < 0.03) {
                hit = true;
                worst = Math.max(worst, Math.abs(-side * off - w.depth));
              }
              if (!hit) {
                missed++;
                if (misses.length < 12) misses.push(`t${st.toFixed(2)} u${su.toFixed(2)} ${side > 0 ? "out" : "in"}`);
              }
            }
          }
        return { tried, missed, worst: +worst.toFixed(4), misses };
      },
      tune,
      EXIT: TRY,
      // The body's place, turn, size and curl through the emergence, for finding where it jerks.
      trace(from: number, to: number, step: number) {
        const rows: number[][] = [];
        pose.gait.reset();
        for (let t = from; t <= to; t += step) {
          openShell(t);
          poseEmerging(t, step);
          const o = butterfly.object;
          const e = new THREE.Euler().setFromQuaternion(o.quaternion, "XYZ");
          rows.push([+t.toFixed(3), o.position.y, o.position.z, e.x, live.tuck.value, o.scale.x, butterfly.fold, live.pack.value]);
        }
        pose.gait.reset();
        return rows;
      },
      butterfly,
      view(from: number[], to: number[]) {
        camera.position.set(from[0], from[1], from[2]);
        orbitPoint.current?.set(to[0], to[1], to[2]);
        camera.lookAt(to[0], to[1], to[2]);
      },
      // Where the butterfly and the chrysalis are on the screen, for a test to point at.
      screen() {
        const at = (p: THREE.Vector3) => {
          p.project(camera);
          return [(p.x * 0.5 + 0.5) * size.width, (-p.y * 0.5 + 0.5) * size.height];
        };
        butterfly.object.updateMatrixWorld();
        return { butterfly: at(new THREE.Vector3(0, -0.05, 0.3).applyMatrix4(butterfly.object.matrixWorld)), pupa: at(rig.pod.localToWorld(new THREE.Vector3(0, -SPECIES[sim.species].pupa * 0.55, 0))) };
      }
    };
  });

  const storm = useMemo(() => ({ next: 4, flash: 0, thunder: -1 }), []);
  // A turn of the wheel is the visitor's zoom: the lens stands back for a moment.
  const dom = useThree((state) => state.gl.domElement);
  useEffect(() => {
    const wheel = () => {
      sim.own = 1.4;
    };
    dom.addEventListener("wheel", wheel, { passive: true });
    return () => dom.removeEventListener("wheel", wheel);
  }, [dom, sim]);
  // In development: values tried from the console before they are written down.
  const tune = useMemo(() => ({}) as { pulled?: boolean; pulls?: number; duty?: number; depth?: number; lid?: number; sides?: number; lean?: number; hangAt?: number; hangOut?: number; hangDown?: number; park?: boolean; bump?: number; feet?: number; gate?: boolean; rest?: number; flip?: boolean; arm?: boolean; forward?: number; yieldFrom?: number; folded?: number; hind?: number }, []);
  const noHover = useMemo(() => typeof window !== "undefined" && window.matchMedia("(hover: none)").matches, []);

  useFrame((_, rawDelta) => {
    const dt = Math.min(rawDelta, 1 / 20);
    sim.clock += dt;
    const sp = SPECIES[sim.species];
    const L = sp.pupa;
    const FL = sp.wing;
    const b = butterfly;
    // Behind the loader everything is drawn once, so that nothing is built the first time it is called for.
    const warm = scenePhase.current !== "live";
    // (The engine itself draws whatever is hidden for its first frames behind the loader, so nothing is built the first
    // time it is called for; showing more than that here would slow the frames it judges the quality tier by.)
    for (const name of SPECIES_NAMES) pupa.groups[name].visible = name === sim.species;

    // The chrysalis after its butterfly: falling, or drawn back; then the next one growing out of the pad.
    if (sim.pod === "falling") {
      sim.podT += dt;
      // The shell lets go and falls by itself (pupa.tsx); heard landing in the leaves below.
      if (sim.podT > 1.5 && sim.podT - dt <= 1.5) sound.play("rustle", { gain: 0.1, pitch: 1.4, pan: 0.1 });
      if (pupa.dropped || sim.podT > 4) {
        sim.pod = "waiting";
        rig.hang.visible = false;
      }
    } else if (sim.pod === "fading") {
      sim.podT += dt;
      live.fade.value = ease(clamp01(sim.podT / 0.9));
      if (sim.podT > 0.9) {
        sim.pod = "waiting";
        rig.hang.visible = false;
        if (sim.stage === "shell") sim.stage = "none";
      }
    } else if (sim.pod === "waiting") {
      // The wings in the air are this butterfly's: the next one's colours wait until it has gone.
      if (sim.stage === "none") {
        const chosen = store.get("emergeSpecies") as SpeciesName;
        const next = chosen !== sim.species ? chosen : ROTATION[(ROTATION.indexOf(sim.species) + 1) % ROTATION.length];
        applySpecies(next);
        if (chosen !== next) store.set("emergeSpecies", next);
        rig.pod.add(b.object);
        b.object.visible = false;
        sim.t = 0;
        sim.pod = "growing";
        sim.podT = 0;
        sim.grow = 0;
        pupa.grow(0);
        sim.sx = sim.sz = sim.vx = sim.vz = 0;
        live.fade.value = 0;
        rig.hang.visible = true;
        sound.play("creak", { gain: 0.05, pitch: 1.9 });
      }
    } else if (sim.pod === "growing") {
      sim.podT += dt;
      sim.grow = clamp01(sim.podT / 3.5);
      pupa.grow(sim.grow);
      if (sim.podT > 3.5) {
        sim.pod = "idle";
        sim.grow = 1;
      }
    }

    // The emergence, as a pure function of its time.
    const opening = sim.pod === "open" || sim.pod === "falling" || (sim.pod === "fading" && sim.stage === "shell");
    if (sim.pod === "open" && sim.stage === "shell" && !warm) {
      const before = sim.t;
      // In whole steps of a fixed length (at most a few in one frame: a long frame is not caught up on).
      sim.owed = Math.min(sim.owed + dt, 4.5 * TICK);
      if (sim.hold) {
        sim.owed = 0;
        if (!sim.frozen) stepEmerging(false);
      } else
        for (; sim.owed >= TICK; sim.owed -= TICK) stepEmerging(true);
      cues(before, sim.t, sim.t - before < 0.2);
    }
    const t = opening ? sim.t : -1;

    // The chrysalis: clearing, stretching, cracking, opening, emptied.
    live.clear.value = opening ? ease(span(KEY.clear, t)) : 0;
    live.stretch.value = opening ? ease(span(KEY.pleats, t)) : 0;
    live.core.value = t >= KEY.crack ? 0 : 1;
    // Clear above the tail as it comes down; once the abdomen is all out, the last of it clears too.
    const front = !opening || t < KEY.crack || sim.front < 0 ? -1 : sim.front + (1.15 - sim.front) * smooth(OUT.drawn[1], OUT.drawn[1] + 1.2, t);
    shell.front.value = front;
    live.empty.value = clamp01(front);
    openShell(t);
    dustSince.value = t >= KEY.crack ? t - KEY.crack : 0;

    // Sway: a pendulum on the cremaster, nudged by twitches, more restless just before it opens.
    if (sim.pod !== "falling") {
      const waiting = sim.pod === "idle" || (sim.pod === "open" && t < KEY.crack);
      const restless = sim.pod === "open" && t < KEY.crack ? 0.3 + span(KEY.pleats, t) * 1.2 : 0.15;
      sim.twitchAt -= dt * (sim.pod === "open" && t < KEY.crack ? 3 : 1);
      if (sim.twitchAt <= 0 && (waiting || (sim.pod === "open" && t < KEY.lid[1]))) {
        sim.twitchAt = 5 + Math.random() * 7;
        sim.vx += (Math.random() - 0.5) * 0.35 * restless * 3;
        sim.vz += (Math.random() - 0.5) * 0.25 * restless * 3;
        if (sim.pod === "open") sound.play("tick", { gain: 0.08, pitch: 0.45 });
      }
      const wind = Math.sin(sim.clock * 0.6) * Math.sin(sim.clock * 0.23 + 1) * 0.004 * (look.wind + 0.2);
      sim.vx += (-9 * sim.sx - 0.9 * sim.vx + wind * 9) * dt;
      sim.vz += (-9 * sim.sz - 0.9 * sim.vz) * dt;
      sim.sx += sim.vx * dt;
      sim.sz += sim.vz * dt;
      rig.hang.rotation.set(sim.sx * 0.12, 0, sim.sz * 0.12);
    }
    rig.hang.updateMatrixWorld();

    // The eye in the chrysalis' space.
    scratch.inv.copy(rig.pod.matrixWorld).invert();
    live.eye.value.copy(camera.position).applyMatrix4(scratch.inv);

    // The butterfly.
    if (warm) {
      // Behind the loader it is drawn once as it will first be seen, packed and wet inside the shell, so that what it
      // is made of is built now and not at the moment the shell splits.
      b.object.visible = true;
      poseEmerging(KEY.crack, 0);
    }
    else if (sim.stage === "shell") b.object.visible = t >= KEY.crack - 0.05 && live.fade.value < 0.6;
    else if (sim.stage === "hop") flyUp(dt);
    else if (sim.stage === "perched") stroll(dt);
    else if (sim.stage === "leaving") flyAway(dt);
    else if (sim.pod === "idle" && sim.ready > 0.3 && (sim.primed !== sim.species || sim.prime > 0)) {
      // While its chrysalis hangs waiting it is drawn for a few frames inside the still opaque shell, as it will first
      // be seen: whatever the renderer must build for it is built now, not at the moment the shell splits.
      if (sim.primed !== sim.species) {
        sim.primed = sim.species;
        sim.prime = 4;
      }
      sim.prime--;
      b.object.visible = true;
      poseEmerging(KEY.crack, 0);
    } else b.object.visible = false;
    // What the visitor on the branch needs to know: whether this one is busy, where it is on the branch, its species.
    visitGate.busy = warm || sim.stage === "shell" || sim.stage === "hop" || sim.stage === "leaving";
    visitGate.heroS = sim.stage === "perched" ? butterfly.s : sim.stage === "hop" ? sim.fly.landS : NaN;
    visitGate.species = sim.species;
    // In development the rig's own studio poses it, so it is kept shown and updating whatever the scene is doing.
    const studio = process.env.NODE_ENV !== "production" && !!(window as Window & { __bfly?: { studio?: unknown } }).__bfly?.studio;
    if (studio) b.object.visible = true;
    // The wings' pictures go to the GPU where no frame of them is seen: whole, behind the loader; the next species' only
    // once the last butterfly has gone, while its shell falls and the new chrysalis grows (look.ts: wingPace). While the
    // butterfly is drawn the rig carries the copying on; while it is not, it is carried on from here.
    wingPace.next = warm || (sim.stage === "none" && sim.pod !== "idle");
    if (warm || !b.object.visible) wingUpload(renderer, warm);
    // The shell's wall as the feet first test it (opened full, at the lid's end) is sampled a few rows a frame while the
    // chrysalis is not open, so that no step of the emergence has to make the whole of it at once.
    if (sim.walled !== sim.species && sim.pod !== "open") {
      const keep = SPECIES_NAMES.map((name) => pupa.pivots[name].map((p) => [p.rotation.x, p.rotation.z]));
      openShell(KEY.lid[1]);
      if (prepareWall(sp, pupa.pivots[sim.species])) sim.walled = sim.species;
      SPECIES_NAMES.forEach((name, i) => pupa.pivots[name].forEach((p, j) => p.rotation.set(keep[i][j][0], 0, keep[i][j][1])));
    }
    // (On the shell its head is close under a flap: the rig keeps its own head and antenna movements small there.)
    b.headRoom = sim.stage === "shell" ? 0.25 : 1;
    // (On the shell it was posed and updated step by step, above.)
    if (b.object.visible && (sim.stage !== "shell" || studio || warm)) b.update(camera.position);

    // A hand on it: the pointer passing close, once it has had a moment to be seen waiting.
    const subject = scratch.subject;
    const out = b.object.visible && sim.stage !== "none";
    if (out) {
      b.object.updateMatrixWorld();
      subject.set(0, -0.02, 0.06).applyMatrix4(b.object.matrixWorld);
    }
    const can = !warm && canAct();
    if (can) {
      if (sim.armed === 0) sim.armedAt = performance.now();
      sim.armed += dt;
      // Its wings, on the screen.
      scratch.v.set(0, -0.05, 0.32).applyMatrix4(b.object.matrixWorld).project(camera);
      scratch.w
        .set(0, -0.05, 0.32 + 0.5)
        .applyMatrix4(b.object.matrixWorld)
        .project(camera);
      const px = (scratch.v.x - pointer.ndc.x) * size.width * 0.5;
      const py = (scratch.v.y - pointer.ndc.y) * size.height * 0.5;
      const reach = Math.max(46, Math.hypot((scratch.w.x - scratch.v.x) * size.width * 0.5, (scratch.w.y - scratch.v.y) * size.height * 0.5) * 0.9, FL * 60);
      const near = pointer.active && !pointer.touch && !pointer.down && pointer.moved > sim.armedAt + 700 && Math.hypot(px, py) < Math.min(reach, 170);
      sim.dwell = near ? sim.dwell + dt : 0;
      if (sim.armed > 0.9 && sim.dwell > 0.12) act();
    } else {
      sim.armed = 0;
      sim.dwell = 0;
    }
    // What to do next, in a line beside the thing to do it to: under the chrysalis whenever one is ready, then beside
    // the butterfly once it has waited a moment.
    const touch = pointer.touch || noHover;
    sim.ready = sim.pod === "idle" && sim.stage === "none" && !warm ? sim.ready + dt : 0;
    if (sim.ready > 1 && sim.fetched !== sim.species) {
      sim.fetched = sim.species;
      b.preload(SPECIES[ROTATION[(ROTATION.indexOf(sim.species) + 1) % ROTATION.length]]);
    }
    let say: string | null = null;
    if (sim.ready > 0.5) {
      say = touch ? "Tap the chrysalis to start the transformation" : "Click the chrysalis to start the transformation";
      scratch.a.copy(HANG);
      scratch.a.y -= STALK + L;
      scratch.a.project(camera);
      anchor.x = (scratch.a.x * 0.5 + 0.5) * size.width;
      anchor.y = (-scratch.a.y * 0.5 + 0.5) * size.height + 22;
    } else if (can && sim.armed > (sim.stage === "shell" ? 2.2 : 5)) {
      say = sim.stage === "shell" ? (touch ? "Tap the butterfly to send it up to the branch" : "Hover over the butterfly to send it up to the branch") : touch ? "Tap it again to let it fly away" : "Hover over it again to let it fly away";
      // Under its hanging wings; under the branch behind it, beside the shell.
      if (sim.stage === "shell") scratch.a.copy(subject).add(scratch.b.set(0, -1.05 * FL, 0));
      else
        scratch.a
          .copy(subject)
          .add(scratch.b.set(0, -0.2 * FL - 0.32, 0))
          .addScaledVector(scratch.right.setFromMatrixColumn(camera.matrixWorld, 0), -0.62 * FL);
      scratch.a.project(camera);
      anchor.x = (scratch.a.x * 0.5 + 0.5) * size.width;
      anchor.y = (-scratch.a.y * 0.5 + 0.5) * size.height;
    }
    card.hint(say);
    status(t);
    // The card about it comes in with the chrysalis itself: at the start, and whenever a new one begins to grow.
    if (!warm && sim.carded !== sim.species && (sim.pod === "idle" || sim.pod === "growing")) {
      sim.carded = sim.species;
      card.show(sim.species);
    }

    // The lens: on the chrysalis, then on both it and the butterfly, wherever that goes; never in a hurry.
    const orbit = orbitPoint.current;
    const podAt = scratch.w.copy(HANG);
    podAt.y -= STALK + L * 0.5;
    if (orbit && !warm && !sim.hold) {
      if (sim.home === 0) sim.home = camera.position.distanceTo(orbit);
      const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const tanH = tanV * camera.aspect;
      // How far back the eye must be to hold a thing so tall and so wide.
      const hold = (tall: number, wide: number) => Math.max(tall / tanV, wide / tanH) * 1.12;
      const want = scratch.aim.copy(podAt);
      let far = 0;
      let rate = 1.3;
      let back = false;
      let closer = false;
      if (sim.stage === "shell" && sim.pod === "open") {
        const k = ease(span([13.8, 19.8], t)) * 0.7;
        want.lerp(subject, out ? k : 0);
        // It comes in close to watch the chrysalis change, and as it splits draws back to the wide view for what
        // comes out.
        // (Not too close: the whole chrysalis with room round it and the branch above it, a third of the frame's height.)
        const close = hold(L * 1.5, L * 1.0);
        const wide = hold(L * 0.5 + 1.0 * FL, (0.5 + 0.55 * ease(span(KEY.dry, t))) * FL + 0.25);
        if (t < KEY.crack) {
          far = THREE.MathUtils.lerp(sim.home, close, ease(span([0.15, 3.4], t)));
          closer = true;
        } else far = THREE.MathUtils.lerp(Math.min(close, sim.home), Math.max(wide, sim.home), ease(span([KEY.crack + 0.4, KEY.crack + 7], t)));
      } else if (sim.stage === "hop" || sim.stage === "perched") {
        // The chrysalis and the butterfly above it, together.
        // (On its way up, already where it will land: the eye is there to meet it.)
        const at = sim.stage === "hop" ? sim.fly.goal : subject;
        // (More room above on the way up, for the top of its arc before it comes down onto the branch.)
        const top = at.y + (sim.stage === "hop" ? 1.6 : 1.0) * FL;
        const bottom = HANG.y - STALK - L;
        want.set(at.x * 0.75, (top + bottom) / 2, at.z * 0.5);
        far = hold((top - bottom) / 2 + 0.12, 0.8 * FL + Math.abs(at.x) * 0.25);
        rate = sim.stage === "hop" ? 1.8 : 1.1;
      } else if (sim.stage === "leaving") {
        // Follows it off for a moment, then lets it go.
        const follow = 1 - smooth(0.5, 1.7, sim.fly.t);
        want.lerp(subject, 0.6 * follow);
        rate = 1.6;
        back = follow < 0.05;
      } else back = true;
      // Carried, not turned: the eye and what it looks at move together, so the view never swings; and only by what
      // this adds, so wherever the visitor has taken the view is left alone.
      // The visitor's hand comes first: while they turn or zoom the view, and for a moment after, nothing here moves it;
      // then it takes up again from rest.
      if (pointer.down) sim.own = 1.4;
      sim.own = Math.max(0, sim.own - dt);
      const mine = sim.own <= 0;
      if (!mine) {
        sim.shiftV.set(0, 0, 0);
        sim.drawnV.v = 0;
      }
      const before = scratch.a.copy(sim.shift);
      if (mine) springVector(sim.shift, sim.shiftV, scratch.b.copy(want).sub(podAt), rate * 1.7, dt);
      const step = scratch.b.copy(sim.shift).sub(before);
      orbit.add(step);
      camera.position.add(step);
      // And drawn back, or let come forward again, the same way: only by what this has added to the visitor's distance.
      const d = camera.position.distanceTo(orbit);
      const own = d - sim.drawn;
      const wish = far > 0 ? (closer ? Math.min(0, far - own) : Math.max(0, far - own)) : back ? 0 : sim.drawn;
      if (mine) sim.drawn = spring(sim.drawn, sim.drawnV, wish, 1.5, dt);
      if (own + sim.drawn > 1.2 && d > 0.05)
        camera.position
          .sub(orbit)
          .multiplyScalar((own + sim.drawn) / d)
          .add(orbit);
    }
    // Focus on the butterfly once it is out, held on the branch as it flies off.
    const sharp = out && !(sim.stage === "shell" && t < 13.8) && !(sim.stage === "leaving" && sim.fly.t > 1.2) ? subject : podAt;
    springVector(focus.point, sim.focusV, sharp, sim.stage === "hop" ? 9 : 5, dt);
    focus.blur = 1.3;

    // Storm: lightning, as in Tension.
    if (look.air === "rain") {
      storm.next -= dt;
      if (storm.next <= 0) {
        storm.next = 7 + Math.random() * 12;
        storm.flash = 1;
        storm.thunder = 0.6 + Math.random() * 1.5;
      }
      storm.flash = Math.max(0, storm.flash - dt * 3.5);
      sky.flash.value = storm.flash * (storm.flash > 0.7 || (storm.flash > 0.35 && storm.flash < 0.5) ? 1 : 0.35);
      if (storm.thunder > 0) {
        storm.thunder -= dt;
        if (storm.thunder <= 0) sound.play("thud", { gain: 1, pitch: 0.25, size: 1 });
      }
    } else sky.flash.value = 0;
  });

  // The shell's pieces at a time of the emergence: the face plate swung open like a lid, the two sides sprung apart.
  // What a plan of the flip depends on, as one number: the shell as it is opened then, the holds on it, the body's
  // build and the rig's own measure of it in the pose it comes out in. (Called with no butterfly in sight.)
  const plans = useMemo(() => ({ ok: {} as Partial<Record<SpeciesName, boolean>>, print: {} as Partial<Record<SpeciesName, number>> }), []);
  function fingerprint() {
    const sp = SPECIES[sim.species];
    const b = butterfly;
    const build = BUILD[sp.column] ?? BUILD[1];
    const pivots = pupa.pivots[sim.species];
    const { x, z } = rig.hang.rotation;
    rig.hang.rotation.set(0, 0, 0);
    openShell(OUT.drawn[0]);
    pose.gait.reset();
    poseEmerging(OUT.drawn[0], 0);
    rig.hang.updateMatrixWorld(true);
    b.object.updateMatrixWorld(true);
    b.update(camera.position, 0);
    pose.gait.rim = false;
    let sum = sp.pupa * 3 + sp.wing * 5 + build.leg * 7 + build.long * 11 + build.girth * 13 + SIDES[sim.species] * 17 + LID * 19 + HEAD * 23 + TOE * 29 + pose.gait.count(sp, pivots) * 0.001;
    const out = { point: new THREE.Vector3(), normal: new THREE.Vector3() };
    for (const t of [0.5, 0.7, 0.9]) for (const u of [-2.2, -1.2, 1.2, 2.2]) sum += shellSurface(sp, t, u, pivots, out).point.length();
    const probe = b.probe();
    const inv = new THREE.Matrix4().copy(b.object.matrixWorld).invert();
    const v = new THREE.Vector3();
    for (let i = 0; i < probe.count; i++) if (probe.chain[i] === 0 || probe.chain[i] === 1 || probe.chain[i] === 2 || probe.chain[i] === 15) sum += probe.radius[i] / sp.wing + v.fromArray(probe.points, i * 3).applyMatrix4(inv).length() * 0.1;
    // (Only its core: its legs and its coat are as its last moments left them.)
    sum += probe.count * 0.01;
    rig.hang.rotation.set(x, 0, z);
    openShell(sim.pod === "open" ? sim.t : -1);
    pose.gait.reset();
    return +sum.toFixed(3);
  }
  // Whether this species' plan is to be walked: made, and still true to what it was made against.
  // Whether it is to hang at arm's length (and has a plan for it).
  function arm() {
    return (tune.arm ?? ARM[sim.species]) && FLIP_ARM[sim.species].length > 0;
  }
  function planned() {
    return PLANNED[sim.species] && plans.ok[sim.species] !== false;
  }

  // One step of the emergence. It is worked out with the chrysalis hanging plumb (its sway is put back after, and
  // carries shell, body and feet together), so that nothing of it depends on the sway, the frame rate or the clock.
  const diary = useMemo(() => ({ on: false, lines: [] as string[] }), []);
  function diaryLine(t: number) {
    const b = butterfly;
    const own = b.selfClash();
    const feet = [2, 3, 4, 5].map((k) => (pose.gait.feet[k].held ? pose.gait.feet[k].count : "-")).join(",");
    return `${t.toFixed(4)} r${sim.rate.toFixed(3)} ${b.planted.map((p) => (p ? 1 : 0)).join("")} [${feet}] g${b.give.toFixed(3)} s${own.count}:${own.leg}:${own.wing} y${b.object.position.y.toFixed(5)}`;
  }
  function stepEmerging(advance: boolean) {
    const b = butterfly;
    const { x, z } = rig.hang.rotation;
    rig.hang.rotation.set(0, 0, 0);
    rig.hang.updateMatrixWorld(true);
    openShell(sim.t);
    poseEmerging(sim.t, TICK);
    b.object.updateMatrixWorld(true);
    b.update(camera.position, TICK);
    // In development: a line for each step (where it is, which feet are down and on which hold, how far the wings
    // have yielded, what crosses), to set one run beside another.
    if (diary.on && advance && sim.t >= KEY.crack) diary.lines.push(diaryLine(sim.t));
    followTail(sim.t);
    rig.hang.rotation.set(x, 0, z);
    if (advance) sim.t += TICK * sim.rate;
  }

  // The case empties from the top down behind the body as it draws itself out: its front is where the tail's tip is,
  // along the shell (shellProbe's t), as posed this step, never going back up. (Only what is drawn: nothing of the
  // emergence reads it.)
  // (Measured from where the tail lay when it split, so that the clearing starts at the top of the case, not at the
  // tail's old place: the top empties first, and the clear part reaches the tip as the tail comes past it.)
  const tailAt = useMemo(() => ({ point: new THREE.Vector3(), toPod: new THREE.Matrix4(), probe: { t: 0, u: 0, d: 0, piece: 0 }, rest: 0 }), []);
  function followTail(t: number) {
    if (t < KEY.crack) {
      sim.front = -1;
      tailAt.rest = -1;
      return;
    }
    const probe = butterfly.probe();
    let last = -1;
    for (let i = 0; i < probe.count; i++) if (probe.chain[i] === 0) last = i;
    if (last < 0) return;
    tailAt.toPod.copy(rig.pod.matrixWorld).invert();
    tailAt.point.fromArray(probe.points, last * 3).applyMatrix4(tailAt.toPod);
    const at = clamp01(shellProbe(SPECIES[sim.species], tailAt.point, tailAt.probe).t);
    if (tailAt.rest < 0) tailAt.rest = at;
    sim.front = Math.max(sim.front, (at - tailAt.rest) / Math.max(0.05, 1 - tailAt.rest));
  }

  function openShell(t: number) {
    const lid = t < KEY.lid[0] ? 0 : lidCurve(span(KEY.lid, t));
    // (The sides spring wide for the wings to pass, and once the thorax is out ease back to a split tube.)
    const sides = (t < KEY.sides[0] ? 0 : sidesCurve(span(KEY.sides, t))) * (1 - (1 - (tune.rest ?? REST)) * ease(span(OUT.close, t)));
    for (const name of SPECIES_NAMES) {
      const p = pupa.pivots[name];
      p[1].rotation.set(-lid * (tune.lid ?? LID), 0, 0);
      p[2].rotation.set(0, 0, sides * (tune.sides ?? SIDES[name]));
      p[3].rotation.set(0, 0, -sides * (tune.sides ?? SIDES[name]));
    }
  }

  // In development: the whole emergence gone through a step at a time, the butterfly probed at each and tested against
  // the shell's wall (clash.ts). Reports every time anything touches or passes through it; must find nothing.
  function clash(from: number = KEY.crack, to: number = KEY.ready, step = 0.1, detail = false, raw = false) {
    const sp = SPECIES[sim.species];
    const keep = sim.t;
    const b = butterfly;
    const toPod = new THREE.Matrix4();
    const found: Clash[] = [];
    const times: Record<string, string> = {};
    const samples: string[] = [];
    const diary: string[] = [];
    const parts: Record<string, { count: number; worst: number; from: number; to: number }> = {};
    let total = 0;
    pose.gait.reset();
    // (At the scene's own step it is the very emergence that is played; and plumb, as that is worked out.)
    if (Math.abs(step - TICK) < 0.001) step = TICK;
    const swayed = { x: rig.hang.rotation.x, z: rig.hang.rotation.z };
    rig.hang.rotation.set(0, 0, 0);
    const support = { first: -1, least: 9, under2: 0, flipLeast: 9, flipUnder3: 0, miss: 0, real: 0 };
    // Its own legs against its own wings (the rig's check), with when.
    const self = { count: 0, worst: 0, from: -1, to: -1, pressed: 0, when: {} as Record<string, string> };
    const tip = new THREE.Vector3();
    sim.rate = 1;
    let turns = 0;
    // (At the scene's own step it is played from the very beginning, as it is for a visitor, and judged from `from`.)
    const lines: string[] = [];
    for (let t = step === TICK ? 0 : from; t <= to + 1e-6 && turns < 20000; t += step * sim.rate, turns++) {
      openShell(t);
      poseEmerging(t, step);
      rig.hang.updateMatrixWorld(true);
      b.object.updateMatrixWorld(true);
      b.update(camera.position, step);
      if (t < from) continue;
      if (step === TICK && raw) lines.push(diaryLine(t));
      toPod.copy(rig.pod.matrixWorld).invert();
      found.length = 0;
      const own = b.selfClash();
      if (own.count) {
        self.count += own.count;
        self.worst = Math.max(self.worst, own.worst);
        self.when[t.toFixed(1)] = `leg${own.leg} wing${own.wing} ${own.worst.toFixed(3)}`;
        if (self.from < 0) self.from = +t.toFixed(1);
        self.to = +t.toFixed(1);
      }
      const probe = b.probe();
      clashes(sp, pupa.pivots[sim.species], probe, toPod, 1, found, t >= OUT.flip[1] ? HEAD * sp.wing : 0, t >= KEY.head[1], -1, Infinity, live.pack.value > 0.5);
      // (Packed pads pressing on the flaps are counted by themselves.)
      for (let i = found.length - 1; i >= 0; i--)
        if (found[i].kind === "press") {
          self.pressed++;
          found.splice(i, 1);
        }
      // Feet: how many hold the shell (planted, and the toe as drawn within two toes' thickness of its hold), and how
      // far the worst planted toe is from its hold.
      let down = 0;
      for (let k = 2; k < 6; k++) {
        const foot = pose.gait.feet[k];
        if (!foot.held || foot.step < 1 || !b.planted[k - 2]) continue;
        let last = -1;
        for (let i = 0; i < probe.count; i++) if (probe.chain[i] === 3 + k) last = i;
        if (last < 0) continue;
        const miss =
          tip
            .fromArray(probe.points, last * 3)
            .applyMatrix4(toPod)
            .distanceTo(foot.to) / sp.wing;
        support.miss = Math.max(support.miss, miss);
        if (miss < 0.022) down++;
      }
      if (down > 0 && support.first < 0) support.first = +t.toFixed(1);
      if (support.first >= 0 && t < OUT.flip[1] + 1.5) {
        support.least = Math.min(support.least, down);
        if (down < 2) support.under2 += step;
        if (t >= OUT.flip[0]) {
          support.flipLeast = Math.min(support.flipLeast, down);
          if (down < 3) support.flipUnder3 += step;
        }
      }
      support.real += step;
      if (Math.floor(support.real / 1.5) !== Math.floor((support.real - step) / 1.5) && diary.length < 80) {
        const hipAt = new THREE.Vector3();
        diary.push(
          `${support.real.toFixed(1)}s t${t.toFixed(2)} rate${sim.rate.toFixed(2)} down${down} ` +
            [2, 3, 4, 5]
              .map((k) => {
                const f = pose.gait.feet[k];
                if (!f.held) return "-";
                const far = b.legReach(k, hipAt);
                return `${f.step < 1 ? "~" : ""}${(hipAt.distanceTo(tip.copy(f.to).applyMatrix4(rig.pod.matrixWorld)) / far).toFixed(2)}`;
              })
              .join(" ")
        );
      }
      if (!found.length) continue;
      total += found.length;
      for (const c of found) {
        if (samples.length >= 60) break;
        let first = c.index;
        while (first > 0 && probe.chain[first - 1] === c.chain) first--;
        samples.push(`t${t.toFixed(2)} chain${c.chain}#${c.index - first} piece${c.piece} ${c.kind} depth${c.depth.toFixed(4)} r${c.radius.toFixed(4)} at(t${c.t.toFixed(2)},u${c.u.toFixed(2)})`);
      }
      const here: Record<string, number> = {};
      for (const c of found) {
        const name = `${chainName(c.chain)}/piece${c.piece}/${c.kind}`;
        here[name] = (here[name] ?? 0) + 1;
        const part = (parts[name] ??= { count: 0, worst: 0, from: t, to: t });
        part.count++;
        part.to = t;
        // How far past merely touching: its own thickness less the gap.
        part.worst = Math.max(part.worst, c.radius - Math.abs(c.depth));
      }
      times[t.toFixed(1)] = Object.entries(here)
        .map(([k, n]) => `${k}:${n}`)
        .join(" ");
    }
    sim.t = keep;
    rig.hang.rotation.set(swayed.x, 0, swayed.z);
    openShell(sim.pod === "open" ? keep : -1);
    const round = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, { count: v.count, worst: +v.worst.toFixed(4), from: +v.from.toFixed(1), to: +v.to.toFixed(1) }]));
    pose.gait.reset();
    const feet = {
      first: support.first,
      least: support.least,
      under2: +support.under2.toFixed(2),
      flipLeast: support.flipLeast,
      flipUnder3: +support.flipUnder3.toFixed(2),
      miss: +support.miss.toFixed(3),
      seconds: +support.real.toFixed(1)
    };
    return detail ? { total, self, parts: round, times, support: feet, samples, diary, lines } : { total, self, parts: round, support: feet, samples, diary, lines };
  }

  // The making of the butterfly as a bar of its stages (card.tsx: STAGES), with real time beside it: the days it has
  // hung, then the minutes and hours of coming out (species.ts: LIFE). Each stage is one unit of the bar.
  function status(t: number) {
    const sp = SPECIES[sim.species];
    const days = sp.pupaDays;
    const before = days - LIFE.colourDays;
    const of = `of ${days} days`;
    const clock = (minutes: number): [string, string] =>
      minutes < 60
        ? [`${Math.floor(minutes)}:${String(Math.floor((minutes % 1) * 60)).padStart(2, "0")}`, "minutes since it split"]
        : [`${Math.floor(minutes / 60)} h ${String(Math.floor((minutes % 60) / 5) * 5).padStart(2, "0")}`, "since it split"];
    const say = (progress: number, count: string, unit: string, saying: string, chrysalis = true) => card.status(sim.species, progress, count, unit, saying, chrysalis);
    if (sim.pod === "growing") {
      // Forms, hardens, and the butterfly is built inside: the days before its colours show.
      const g = sim.grow;
      const day = `Day ${1 + Math.floor((before - 1) * g)}`;
      if (g < 0.3) say(g / 0.3, day, of, "The chrysalis forms");
      else if (g < 0.62) say(1 + (g - 0.3) / 0.32, day, of, "Its skin hardens");
      else say(2 + ((g - 0.62) / 0.38) * 0.96, day, of, "The butterfly forms inside");
    } else if (sim.pod === "idle" && sim.stage === "none") say(2.96, `Day ${before}`, of, "Ready to transform");
    else if (sim.pod === "open" && sim.stage === "shell") {
      const turn = KEY.pleats[0] * (1 - LIFE.clearDays / LIFE.colourDays);
      if (t < turn) say(3 + t / turn, `Day ${before + Math.floor((LIFE.colourDays - LIFE.clearDays) * (t / turn))}`, of, "Wing colours showing through");
      else if (t < KEY.pleats[0]) say(4 + 0.6 * span([turn, KEY.pleats[0]], t), `Day ${days}`, of, "The case turning clear");
      else if (t < KEY.crack) say(4.6 + 0.4 * span([KEY.pleats[0], KEY.crack], t), `${Math.max(1, Math.ceil(LIFE.pleatsMinutes * (1 - span([KEY.pleats[0], KEY.crack], t))))} min`, `to go, day ${days}`, "Its pleats stretching apart");
      else if (t < KEY.head[0]) say(5 + span([KEY.crack, KEY.head[0]], t), ...clock(LIFE.outMinutes * 0.15 * span([KEY.crack, KEY.head[0]], t)), "The case splits");
      else if (t < OUT.hang[1]) say(6 + span([KEY.head[0], OUT.hang[1]], t), ...clock(LIFE.outMinutes * (0.15 + 0.85 * span([KEY.head[0], OUT.hang[1]], t))), "Climbing out", false);
      else if (t < KEY.expand[1]) say(7 + span([OUT.hang[1], KEY.expand[1]], t), ...clock(LIFE.outMinutes + (LIFE.filledMinutes - LIFE.outMinutes) * span([OUT.hang[1], KEY.expand[1]], t)), "Its wings filling", false);
      else if (t < KEY.ready) say(8 + span([KEY.expand[1], KEY.ready], t), ...clock(LIFE.filledMinutes + (LIFE.dryMinutes - LIFE.filledMinutes) * span([KEY.expand[1], KEY.ready], t)), "Its wings drying", false);
      else say(9.05, "2 h", "old", "Ready to fly", false);
    } else if (sim.stage === "hop" || sim.stage === "perched") say(sim.stage === "hop" && !sim.earned ? 9.5 : 10, "2 h", "old", "Its first flight", false);
    else card.noStatus();
  }

  // Sounds, each when its moment is reached.
  function cues(a: number, b: number, live: boolean) {
    if (!live) return;
    const at = (k: number) => a < k && b >= k;
    const pan = -0.3;
    if (at(0.35)) sound.play("creak", { gain: 0.07, pitch: 1.9, pan });
    if (at(2.4)) sound.play("creak", { gain: 0.05, pitch: 2.2, pan });
    if (at(KEY.pleats[0] + 0.5)) sound.play("creak", { gain: 0.08, pitch: 1.6, pan });
    // Each piece as it comes open: the two sides, then the lid peeling up.
    if (at(KEY.sides[0] + 0.05)) sound.play("fold", { gain: 0.3, pitch: 0.8, pan: pan - 0.2 });
    if (at(KEY.sides[0] + 0.75)) sound.play("fold", { gain: 0.26, pitch: 0.95, pan: pan + 0.3 });
    if (at(KEY.crack)) {
      sound.play("crack", { gain: 0.9, pitch: 0.95, pan });
      sound.play("snap", { gain: 0.45, pitch: 0.8, pan });
    }
    if (at(KEY.crack + 0.12)) sound.play("crack", { gain: 0.45, pitch: 1.3, pan });
    if (at(KEY.lid[0] + 0.1)) sound.play("peel", { variant: "paper", gain: 0.3, pitch: 1.1, pan });
    // The lid's catches as it lifts, and the sides' second pull.
    for (const x of [0.3, 0.62]) if (at(KEY.lid[0] + x * (KEY.lid[1] - KEY.lid[0]))) sound.play("crack", { gain: 0.22, pitch: 1.5 + x, pan });
    if (at(KEY.sides[0] + 0.45 * (KEY.sides[1] - KEY.sides[0]))) sound.play("snap", { gain: 0.2, pitch: 1.3, pan });
    for (const k of [10.1, 10.6, 11.3, 12.2]) if (at(k)) sound.play("tick", { gain: 0.14, pitch: 1.7, pan });
    for (const k of [13.4, 14.5, 15.6]) if (at(k)) sound.play("rustle", { gain: 0.22, pitch: 1.1, pan });
    if (at(16.6)) sound.play("fold", { gain: 0.22, pitch: 0.9, pan });
    for (let k = KEY.expand[0] + 0.4; k < KEY.expand[1]; k += 1.7) if (at(k)) sound.play("fold", { gain: 0.08 + 0.06 * Math.random(), pitch: 1.2 + Math.random() * 0.3, pan });
    for (let i = 0; i < 3; i++) {
      const c = KEY.test[0] + i * 2.67;
      if (at(c + 0.1)) sound.play("brush", { gain: 0.3, pitch: 1.2, pan });
      if (at(c + 1.75)) sound.play("brush", { gain: 0.25, pitch: 1.0, pan });
    }
  }

  // The butterfly's pose through the emergence, from the time alone.
  const pose = useMemo(
    () => ({
      way: makeWay(),
      curl: { x: 0, v: 0 },
      lipsFor: "",
      lip: new THREE.Vector3(),
      front: new THREE.Vector3(),

      m: new THREE.Matrix4(),
      head: new THREE.Vector3(),
      out: new THREE.Vector3(),
      hang: new THREE.Vector3(),
      q: new THREE.Quaternion(),
      qa: new THREE.Quaternion(),
      x: new THREE.Vector3(1, 0, 0),
      y: new THREE.Vector3(0, 1, 0),
      z: new THREE.Vector3(0, 0, 1),
      gait: new Grip(),
      foul: [0, 0, 0, 0, 0, 0],
      clearFor: SPECIES.morpho,
      clearance: (point: THREE.Vector3): number => point.x * 0,
      where: { piece: 0, t: 0, u: 0, depth: 0 },
      // Its own chance, begun again at each emergence from the species' own number.
      chance: 1,
      random: (): number => 0,
      asked: new THREE.Vector3(),
      found: [] as Clash[],
      toPod: new THREE.Matrix4(),
      shiftIn: 6,
      roll: 0,
      goal: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
      body: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
      holds: Array.from({ length: 4 }, () => ({ point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), id: -1 })),
      going: new THREE.Vector3(),
      was: new THREE.Vector3(),
      grip: Array.from({ length: 6 }, () => new THREE.Vector3()),
      normal: Array.from({ length: 6 }, () => new THREE.Vector3()),
      tmp: new THREE.Vector3(),
      tmp2: new THREE.Vector3(),
      bodyInv: new THREE.Matrix4(),
      bodyRot: new THREE.Quaternion()
    }),
    []
  );

  // How far a point of the world is from the nearest wall of the shell as it is drawn: less than nothing inside one.
  pose.clearance = (point) => {
    const sp = pose.clearFor;
    const hit = wall(sp, pupa.pivots[sim.species], pose.asked.copy(point).applyMatrix4(pose.toPod), pose.where, 0.06);
    return hit ? Math.abs(hit.depth) - WALL * sp.pupa : 0.06;
  };

  // (A small seeded generator: the same numbers in the same order from the same beginning.)
  pose.random = () => {
    let x = (pose.chance = (pose.chance + 0x6d2b79f5) | 0);
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };

  // How far along the flip's way at a share x of its time: evenly, or in pulls (PULLED).
  function pulledAt(x: number) {
    if (!(tune.pulled ?? PULLED)) return x;
    const n = tune.pulls ?? PULLS.count;
    const duty = tune.duty ?? PULLS.duty;
    const whole = Math.min(n - 1, Math.floor(x * n));
    const part = x * n - whole;
    const stepped = (whole + easeInOut(clamp01(part / duty))) / n;
    return x + (stepped - x) * (tune.depth ?? PULLS.depth);
  }
  // Where it is in a pull (0 to 1 through each), and how hard it heaves there (0 in the breath between).
  function pullPhase(t: number) {
    const stretching = t < KEY.thorax[1];
    const pulled = (tune.pulled ?? PULLED) && t >= OUT.flip[0];
    const at = stretching ? span([KEY.head[0], KEY.thorax[1]], t) * 4 : pulled ? span(OUT.flip, t) * (tune.pulls ?? PULLS.count) : (t - KEY.thorax[1]) / 1.1;
    const phase = at - Math.floor(at);
    const duty = stretching ? 0.625 : pulled ? (tune.duty ?? PULLS.duty) : 0.625;
    return t >= KEY.head[0] && t < OUT.flip[1] + 1 && phase < duty ? Math.sin((Math.PI * phase) / duty) : 0;
  }

  function poseEmerging(t: number, dt: number) {
    const sp = SPECIES[sim.species];
    const L = sp.pupa;
    const FL = sp.wing;
    const b = butterfly;
    if (b.object.parent !== rig.pod) rig.pod.add(b.object);
    const P = pose;
    // Where the body is at a time of the emergence, as the script has it: a pure function of that time (but for what
    // it remembers of the opening), so that it can be asked where the body will be before it goes there.
    const place = (t: number, pos: THREE.Vector3, turn: THREE.Quaternion) => {
      // Effort: pushes with pauses between.
      const effort = (k: number) => {
        const pulses = 4;
        const x = k * pulses;
        const whole = Math.floor(x);
        const part = x - whole;
        return (whole + easeInOut(clamp01(part * 1.6))) / pulses;
      };
      // The way out (exit.ts): it stretches out of the shell to full size, its tail where it lay; then its thorax is
      // carried to where it will hang, close in front of the lower end of the slit it came out of, within easy reach of
      // the slit's lips (found from the opening as it is); and there, its feet on the shell, it straightens, head up, its
      // abdomen swinging out and down under it.
      const swell = 1 - ease(span([KEY.expand[0], KEY.expand[1] + 2], t));
      const grown = effort(span([KEY.head[0], KEY.thorax[1]], t));
      const drawn = span(OUT.drawn, t);
      const lips = `${sim.species}:${pupa.pivots[sim.species][2].rotation.z.toFixed(3)}:${tune.hangAt ?? HANG_AT}:${tune.hangDown ?? HANG_DOWN}`;
      if (P.lipsFor !== lips && t > KEY.lid[1]) {
        P.lipsFor = lips;
        const rim = rimPoints(sp, pupa.pivots[sim.species], 12);
        const i = Math.round(11 * (tune.hangAt ?? HANG_AT));
        P.lip.copy(rim.right[i]).add(rim.left[i]).multiplyScalar(0.5);
        pupaAxis(sp, 0.9, P.tmp, P.tmp2);
        // Out from the shell's front there, and a little down.
        P.front.set(0, P.tmp2.z - (tune.hangDown ?? HANG_DOWN), -P.tmp2.y).normalize();
      }
      const stand = 0.37 * (BUILD[sp.column] ?? BUILD[1]).leg * FL * (tune.hangOut ?? HANG_OUT) + 0.08 * FL;
      // (PARK: the thorax carried straight to its hanging place and held there while the abdomen comes out. Its feet
      // then never leave the shell, but the abdomen, longer than the slit, swings out through the slit's lips: off until
      // the body is shortened to its true proportion.)
      let end = null;
      if (P.lipsFor === lips) {
        P.hang.copy(P.lip).addScaledVector(P.front, stand);
        if (tune.park ?? PARK) {
          end = endFor(sp, P.hang.y, P.hang.z, 1);
          P.hang.set(0, end.y, end.z);
        }
      }
      if (t < OUT.drawn[0]) P.curl.x = P.curl.v = 0;
      const way = wayOut(sp, grown, drawn, swell, P.way, end, P.curl, dt);
      if (P.lipsFor !== lips) P.hang.copy(way.position);
      const rows = (tune.flip ?? planned()) ? (arm() ? FLIP_ARM : FLIP)[sim.species] : null;
      if (rows && t >= OUT.flip[0]) {
        // The flip (FLIP above): from where it came out, turning over close in front of the slit along the planned
        // poses, a smooth curve through them by how far it has turned.
        const begin = wayOut(sp, 1, 0, swell, P.way, null);
        const from = begin.pitch - Math.PI * 2 * Math.round(begin.pitch / (Math.PI * 2));
        const x = pulledAt(span(OUT.flip, t));
        const k = x * x * x * (x * (x * 6 - 15) + 10);
        const last = rows[rows.length - 1];
        const turned = from + (last[2] - from) * k;
        // Row 0 is where it came out; the planned rows it has not already turned past follow.
        let skip = 0;
        while (skip < rows.length - 1 && rows[skip][2] <= from + 0.06) skip++;
        const count = rows.length - skip + 1;
        const row = (i: number, c: number) => {
          const n = Math.min(count - 1, Math.max(0, i));
          if (n === 0) return c === 0 ? (begin.position.y + L) / FL : c === 1 ? begin.position.z / FL : c === 2 ? from : begin.tuck;
          return rows[skip + n - 1][c];
        };
        let i = 0;
        while (i < count - 2 && row(i + 1, 2) < turned) i++;
        const u = clamp01((turned - row(i, 2)) / Math.max(1e-4, row(i + 1, 2) - row(i, 2)));
        // Straight from each planned pose to the next (each was tried; a curve through them would stray between), the
        // corners rounded off a little.
        const e = u * u * (3 - 2 * u);
        const through = (c: number) => row(i, c) + (row(i + 1, c) - row(i, c)) * e;
        const y = through(0);
        const z = through(1);
        const curl = Math.max(0, through(3));
        pos.set(0, -L + y * FL, z * FL);
        P.head.set(0, -Math.cos(turned), Math.sin(turned));
        P.out.set(0, -Math.sin(turned), -Math.cos(turned));
        turn.setFromRotationMatrix(P.m.makeBasis(P.x, P.head, P.out));
        way.scale = 1;
        way.tuck = curl;
        return { way, swell, kf: 0 };
      }
      const kf = easeInOut(span(OUT.hang, t));
      pos.lerpVectors(way.position, P.hang, kf);
      // As it straightens it leans out from the shell on its legs, so that its abdomen swings down clear of the shell's
      // tip, and comes back in to hang.
      pos.addScaledVector(P.front, Math.sin(Math.PI * kf) ** 2 * (tune.bump ?? BUMP) * FL);
      const lean = Math.PI - (tune.lean ?? LEAN);
      P.head.set(0, -Math.cos(lean), Math.sin(lean));
      P.out.set(0, -Math.sin(lean), -Math.cos(lean));
      P.qa.setFromRotationMatrix(P.m.makeBasis(P.x, P.head, P.out));
      turn.slerpQuaternions(way.turn, P.qa, kf);
      // Once it is out it sways on its legs a little as it works.
      const wobble = span([OUT.drawn[1], OUT.drawn[1] + 1], t) * (1 - smooth(OUT.hang[1] + 0.5, OUT.hang[1] + 2.5, t)) * Math.sin(t * 7.3) * Math.sin(t * 2.1) * 0.04;
      P.qa.setFromAxisAngle(P.z, wobble);
      turn.premultiply(P.qa);
      return { way, swell, kf };
    };
    const { way, swell, kf } = place(t, b.object.position, b.object.quaternion);
    // Hanging, it leans a very little off a foot it is shifting.
    let lean = 0;
    if (t > OUT.flip[1] + 3) for (let k = 2; k < 6; k++) if (P.gait.feet[k].held && P.gait.feet[k].step < 1) lean = (k % 2 === 0 ? -1 : 1) * 0.035 * Math.sin(Math.PI * P.gait.feet[k].step);
    P.roll += (lean - P.roll) * (dt > 0 ? 1 - Math.exp(-dt * 6) : 0);
    if (Math.abs(P.roll) > 1e-5) b.object.quaternion.multiply(P.qa.setFromAxisAngle(P.y, P.roll));
    b.object.scale.setScalar(FL * way.scale);
    live.swell.value = swell;
    live.tuck.value = way.tuck + (0.14 - way.tuck) * kf;

    // Wings: crumpled stubs along the body, hanging down while they fill, then raised over the back to dry.
    const expand = easeOut(ease(span(KEY.expand, t)));
    const dry = ease(span(KEY.dry, t));
    live.expand.value = expand;
    live.crumple.value = 1 - ease(span([KEY.expand[0] + 1, KEY.expand[1] + 1], t));
    live.wet.value = 1 - dry;
    // Pads the size of the wing case while they are inside, let out to stubs once clear of it.
    live.pack.value = 1 - ease(span(OUT.unpack, t));
    // (And grown from the size of the case to the pad it hangs with, from when their roots are out of the slit: read by
    // the rig once its quilted pads are in.)
    live.pad.value = ease(span([OUT.flip[0], 19], t));
    live.crumple.value *= 1 - 0.8 * live.pack.value;
    // Out, they hang down behind its back, away from the shell it holds; dry, they are raised over it.
    // (Turned from lying along its flanks to hanging behind its back while they are still small pads, then let out.)
    b.fold = (tune.folded ?? FOLDED) + (HUNG - (tune.folded ?? FOLDED)) * ease(span(OUT.refold, t)) - 0.2 * expand - (HUNG - 0.45) * dry;
    b.sweep = -0.05 + 0.1 * dry;
    // (The hind pads are held a little forward while they are let out, clear of the flaps beside them, and ease back
    // to their place as the wings fill.)
    b.hindSweep = tune.hind ?? 0.1 - 0.22 * ease(span([OUT.unpack[1] + 0.5, OUT.unpack[1] + 4], t));
    b.pitch = 0;
    live.bend.value = 0;
    live.twist.value = 0;
    live.camber.value = -0.05 * dry;
    // Testing them: three slow opens and closes, each wider than the last; then, perched, now and then.
    let flap = Math.PI / 2 - 0.035;
    if (t >= KEY.test[0]) {
      const k = t - KEY.test[0];
      if (k < 8) {
        const i = Math.floor(k / 2.67);
        const c = k - i * 2.67;
        const width = [0.75, 1.1, 1.35][Math.min(2, i)];
        const open = c < 0.85 ? easeInOut(c / 0.85) : c < 1.75 ? 1 : c < 2.45 ? 1 - easeInOut((c - 1.75) / 0.7) : 0;
        flap -= open * width;
      } else {
        sim.perch += dt;
        if (sim.perch > sim.nextOpen) {
          sim.openAt = sim.perch;
          sim.nextOpen = sim.perch + 9 + P.random() * 7;
        }
        const c = sim.perch - sim.openAt;
        const open = c < 1.1 ? easeInOut(c / 1.1) : c < 3 ? 1 : c < 4 ? 1 - easeInOut(c - 3) : 0;
        flap -= open * 1.25;
        if (Math.abs(c - 0.05) < dt * 0.6) sound.play("brush", { gain: 0.22, pitch: 1.2, pan: -0.3 });
      }
    }
    b.flap = flap;
    b.hindLag = 0.04;

    // Antennae: stowed back along the body, drawn out of their sheaths and unwound.
    const ka = easeInOut(span(KEY.antennae, t));
    for (let k = 0; k < 2; k++) {
      const a = b.antenna[k];
      const drift = t > KEY.antennae[1] ? Math.sin(t * (0.6 + k * 0.17) + k * 2) * 0.06 + Math.sin(t * 2.3 + k) * 0.015 : 0;
      a.yaw = 0.06 + (0.32 - 0.06) * ka + drift * 0.6;
      a.pitch = Math.PI + 0.35 + (0.5 - Math.PI - 0.35) * ka + drift;
      a.curl = -0.2 + 0.65 * ka;
    }
    // Proboscis: two loose halves, curled and uncurled until they zip into one coil.
    if (t < KEY.proboscis[0]) {
      // (Wound close while it is still inside, so it lies clear of the lid; let loose as it comes out.)
      b.coil = 0.75 - 0.4 * ease(span([KEY.lid[1], KEY.head[1]], t));
      b.split = 1;
    } else if (t < KEY.proboscis[1]) {
      const k = (t - KEY.proboscis[0]) / 3.8;
      // Winding up for good over the last of it.
      b.coil = 0.66 - 0.3 * Math.cos(k * Math.PI * 2);
      b.coil += (1 - b.coil) * ease(span([KEY.proboscis[1] - 2.5, KEY.proboscis[1]], t));
      b.split = 1 - ease(span([KEY.proboscis[1] - 4, KEY.proboscis[1]], t));
    } else {
      b.coil = 1;
      b.split = 0;
    }

    // Legs and body together (grip.ts). Each foot holds a real point of the shell, and the body is never taken where a
    // planted foot could not hold it: before the emergence moves on, the body's next place is looked at, and if any
    // planted foot could not reach its hold from there the clock stops, and waits for a leg to step on (one at a time,
    // the others holding). So it hauls itself out: reach, plant, and only then the body follows.
    const name = sim.species;
    const pivots = pupa.pivots[name];
    const build = BUILD[sp.column] ?? BUILD[1];
    const size = FL * way.scale;
    rig.pod.updateMatrixWorld();
    b.object.updateMatrix();
    b.object.updateMatrixWorld();
    // (The rig's own say on each hold: within the leg's true reach, and never behind a wing.)
    P.gait.girth = build.girth;
    P.gait.rim = arm();
    P.gait.forward = t < (tune.forward ?? OUT.flip[0]);
    // (While its pads squeeze out between the flaps they are not parted for the legs: there is no room to part them.)
    b.yield = t >= (tune.yieldFrom ?? YIELD);
    P.gait.ok ??= (k, point) => b.holdOk(k, P.asked.copy(point).applyMatrix4(rig.pod.matrixWorld));
    P.bodyInv.copy(b.object.matrix).invert();
    P.bodyRot.copy(b.object.quaternion).invert();
    if (t < KEY.lid[1]) {
      P.gait.reset();
      sim.rate = 1;
      sim.stuck = 0;
      sim.waited = 0;
      sim.perch = 0;
      sim.nextOpen = 8;
      sim.openAt = -10;
      for (let k = 0; k < 6; k++) P.foul[k] = 0;
      // Everything left to chance begins again here, from the species' own number: every emergence of a species is
      // the same one.
      P.chance = 1 + SPECIES_NAMES.indexOf(sim.species) * 7919;
      b.reseed(P.chance);
      P.shiftIn = 6;
      P.roll = 0;
    } else {
      // The legs as they were drawn a moment ago: one that reaches through a wall of the shell to its hold gives that
      // hold up for another.
      if (dt > 0) {
        P.toPod.copy(rig.pod.matrixWorld).invert();
        P.found.length = 0;
        clashes(sp, pivots, b.probe(), P.toPod, 1, P.found, 0, false, 5, 8);
        for (let k = 2; k < 6; k++) {
          const foot = P.gait.feet[k];
          let hit = false;
          for (const c of P.found) if (c.chain === 3 + k) hit = true;
          P.foul[k] = hit && foot.held && foot.step >= 1 ? P.foul[k] + dt : 0;
          if (P.foul[k] > 0.15) {
            P.gait.foul(k);
            P.foul[k] = 0;
          }
        }
      }
      // Where it will be in a little while: what the feet must be ready for.
      // (Once it hangs it is going nowhere, and the way is not asked again.)
      const still = t > OUT.flip[1] + 1 && !!(tune.flip ?? planned());
      let sizeSoon = size;
      if (still) {
        P.goal.position.copy(b.object.position);
        P.goal.quaternion.copy(b.object.quaternion);
      } else sizeSoon = FL * place(t + 0.7, P.goal.position, P.goal.quaternion).way.scale;
      sim.planted = P.gait.update(dt, sp, pivots, b.object, size, build.leg, P.goal, sizeSoon);
      // Hanging there, now and then it shifts one foot a little to a hold close by, the others holding.
      if (dt > 0 && t > OUT.flip[1] + 3 && sim.planted >= 3) {
        P.shiftIn -= dt;
        if (P.shiftIn <= 0) P.shiftIn = P.gait.shift(sp, pivots, 2 + Math.floor(P.random() * 4), b.object, size, build.leg) ? 5 + P.random() * 9 : 1;
      }
      if (still) {
        sim.stuck = 0;
        sim.rate += (1 - sim.rate) * (dt > 0 ? 1 - Math.exp(-dt * 12) : 1);
      } else {
        // And in the next instant: may it go there?
        const next = place(t + 0.05, P.body.position, P.body.quaternion);
        const most = REACH * build.leg * FL * next.way.scale * 0.95;
        let free = true;
        let holding = 0;
        for (let k = 2; k < 6; k++) {
          const foot = P.gait.feet[k];
          if (!foot.held) continue;
          holding++;
          // (A foot in the air holds nothing back; its hold was chosen for where the body is going.)
          if (foot.step < 1) continue;
          const hip = P.tmp
            .set(HIPS[(k >> 1) - 1][0] * (k % 2 === 0 ? 1 : -1), HIPS[(k >> 1) - 1][1], HIPS[(k >> 1) - 1][2])
            .multiplyScalar(FL * next.way.scale)
            .applyQuaternion(P.body.quaternion)
            .add(P.body.position);
          if (hip.distanceTo(foot.to) > most) free = false;
        }
        // It does not leave the shell on fewer than three feet: until then it waits for them.
        if (t > OUT.flip[0] && t < OUT.flip[1] && sim.planted < (tune.feet ?? FEET)) free = false;
        sim.stuck = free ? 0 : sim.stuck + dt;
        // (Should no hold ever serve, it goes on slowly rather than hang there for ever, and after a few seconds at its
      // own pace: the wait is never without end.)
        // (Nor once it hangs: nothing moves then for a foot to hold back.)
        // All its waits together are bounded too: past that the feet no longer hold the clock at all.
      const held = !free && t <= OUT.flip[1] + 0.3 && sim.waited < WAIT && (tune.gate ?? (GATE && planned()));
      if (held && dt > 0) sim.waited += dt;
      const want = !held ? 1 : sim.stuck > 3 ? 1 : sim.stuck > 1.5 ? 0.3 : 0;
        sim.rate += (want - sim.rate) * (dt > 0 ? 1 - Math.exp(-dt * 12) : 1);
        // The script's own place again (the looks ahead used the same scratch).
        place(t, P.body.position, P.body.quaternion);
      }
    }
    // The rig carries each foot to its hold and steps it there (a damped arc, the diagonal pairs in turn); a leg not
    // yet out of the shell stays drawn up close under the chest, as it lies in the chrysalis.
    for (let i = 0; i < 4; i++) {
      const foot = P.gait.feet[i + 2];
      const hold = P.holds[i];
      // (Stood a toe's thickness off the surface: the shell is thinner than a toe, and one set into it would show
      // through the other side.)
      hold.point
        .copy(foot.to)
        .addScaledVector(foot.toNormal, TOE * FL * way.scale)
        .applyMatrix4(rig.pod.matrixWorld);
      hold.normal.copy(foot.toNormal).transformDirection(rig.pod.matrixWorld);
      hold.id = foot.held ? foot.count : -1;
    }
    if (t < KEY.lid[1]) b.gripReset();
    P.gait.random = P.random;
    // (With how far any point is from the nearest wall of the shell, for the rig to swing each foot clear of it.)
    P.toPod.copy(rig.pod.matrixWorld).invert();
    P.clearFor = sp;
    b.grip(dt, P.holds, P.clearance);
    // The legs work through every pull: a planted foot clenches its claws as the body heaves and eases them, feeling
    // for a better purchase, in the pause after; a leg not yet holding works in its place, reaching for the opening.
    // (The pulls are the stretch's own, while it stretches; after that a pull every 1.1 s while it climbs out.)
    const heave = pullPhase(t);
    const working = smooth(KEY.legs[0], KEY.legs[1], t);
    let free = 0;
    for (let k = 0; k < 6; k++) {
      const side = k % 2 === 0 ? 1 : -1;
      const pair = k >> 1;
      const leg = b.legs[k];
      const foot = P.gait.feet[k];
      const reach = k > 1 && foot.held ? foot.free : 0;
      P.tmp.set(side * 0.03, [0.13, 0.06, -0.03][pair], -0.088);
      P.tmp2.set(0, 0, -1);
      // (Not once it turns over: then the legs not holding are close against the shell's walls.)
      if (k > 1 && working > 0 && t < OUT.flip[0]) {
        // (Its own rhythm, a little out of step with the others.)
        const own = Math.sin((t * 2.6 + k * 1.3) * Math.PI);
        P.tmp.y += working * (0.018 * own + 0.012 * heave * (pair === 1 ? 1 : -1));
        P.tmp.z -= working * 0.008 * (0.5 + 0.5 * own);
      }
      if (reach > 0) {
        leg.target.lerpVectors(P.tmp, leg.target, reach);
        leg.normal.lerpVectors(P.tmp2, leg.normal, reach).normalize();
      } else {
        leg.target.copy(P.tmp);
        leg.normal.copy(P.tmp2);
      }
      // (Only while it pulls itself out, before it turns over: through the turn its toes are close against the walls.)
      if (k > 1 && working > 0 && t < OUT.flip[0]) {
        const hooked = leg.curl ?? 0;
        const adjust = 0.14 * Math.sin(t * 5.3 + k * 1.7) * Math.sin(t * 1.9 + k);
        if (hooked > 0.5) leg.curl = hooked * (0.72 + 0.32 * heave) + working * adjust * (1 - heave);
        else if (reach === 0) leg.curl = working * (0.3 + 0.25 * Math.sin(t * 3.1 + k * 2.1));
      }
      leg.lift = 0;
      free = Math.max(free, reach);
    }
    b.tucked = PACKED * (1 - free);
  }

  // A point of a piece of the shell in its rest place, carried to where that piece now is (pod space).
  function onPiece(pivot: THREE.Group, rest: THREE.Vector3, out: THREE.Vector3) {
    out.copy(rest).sub(pivot.position).applyEuler(pivot.rotation).add(pivot.position);
    return out;
  }

  // The wings through one stroke (the rig's own), with what the rig leaves to the scene: dry, full, unfolded wings.
  function stroke(p: number, glide: number, power: number) {
    const b = butterfly;
    b.fold = 0;
    live.expand.value = 1;
    live.crumple.value = 0;
    live.pack.value = 0;
    live.wet.value = 0;
    live.swell.value = 0;
    b.coil = 1;
    b.split = 0;
    return b.flight(p, glide, power);
  }

  // The lift of one stroke as a push up and down about nothing: up through the downstroke, down through the upstroke.
  const heave = (p: number) => (p < 0.6 ? Math.sin((Math.PI * p) / 0.6) * (0.4 / 0.6) : -Math.sin((Math.PI * (p - 0.6)) / 0.4));

  // The body's attitude in flight: which way it heads, how steeply its head is raised, how far it is rolled.
  function attitude(yaw: number, pitch: number, bank: number, out: THREE.Quaternion) {
    const { h, head, right, back, up, m, q2 } = scratch;
    h.set(Math.sin(yaw), 0, Math.cos(yaw));
    head.copy(h).multiplyScalar(Math.cos(pitch)).addScaledVector(up, Math.sin(pitch));
    right.crossVectors(h, up).normalize();
    back.crossVectors(right, head).normalize();
    out.setFromRotationMatrix(m.makeBasis(right, head, back));
    return out.multiply(q2.setFromAxisAngle(up, bank));
  }

  // A wingbeat heard, quieter with distance.
  function flutter(f: typeof sim.fly, loud: number) {
    if (Math.floor(f.phase) === Math.floor(f.lastPhase)) return;
    f.beats++;
    const far = camera.position.distanceTo(f.pos);
    if (f.beats < 22) sound.play("brush", { gain: Math.max(0.03, (loud * 0.5) / (1 + far * 0.5)), pitch: 1.1 + Math.random() * 0.2, pan: THREE.MathUtils.clamp(f.pos.x * 0.25, -0.7, 0.7) });
  }

  // The way's curve at k (0 to 1 through its points): Catmull-Rom, its ends held.
  function wayAt(f: typeof sim.fly, k: number, out: THREE.Vector3) {
    const n = f.ways - 1;
    const seg = Math.min(n - 0.001, Math.max(0, k) * n);
    const i = Math.floor(seg);
    const x = seg - i;
    const p0 = f.way[Math.max(0, i - 1)];
    const p1 = f.way[i];
    const p2 = f.way[i + 1];
    const p3 = f.way[Math.min(n, i + 2)];
    const x2 = x * x;
    const x3 = x2 * x;
    return out
      .copy(p0)
      .multiplyScalar(-0.5 * x3 + x2 - 0.5 * x)
      .addScaledVector(p1, 1.5 * x3 - 2.5 * x2 + 1)
      .addScaledVector(p2, -1.5 * x3 + 2 * x2 + 0.5 * x)
      .addScaledVector(p3, 0.5 * x3 - 0.5 * x2);
  }
  // How far along the curve each of its 64 steps lies: so that it is flown at a pace of its own, not its points'.
  function layWay(f: typeof sim.fly) {
    f.arc[0] = 0;
    wayAt(f, 0, scratch.a);
    for (let i = 1; i <= 64; i++) {
      wayAt(f, i / 64, scratch.b);
      f.arc[i] = f.arc[i - 1] + scratch.b.distanceTo(scratch.a);
      scratch.a.copy(scratch.b);
    }
  }
  // Where on the curve a distance along it falls (0 to 1).
  function wayAlong(f: typeof sim.fly, d: number) {
    let i = 1;
    while (i < 64 && f.arc[i] < d) i++;
    return (i - 1 + clamp01((d - f.arc[i - 1]) / Math.max(1e-6, f.arc[i] - f.arc[i - 1]))) / 64;
  }
  // The room round a body in flight for its wings: how far it is from the bark, and from the shell while it hangs.
  function room(at: THREE.Vector3) {
    const h = scratch.hold;
    let s = at.x;
    for (let i = 0; i < 4; i++) {
      branchPath(s, h);
      s += scratch.c.copy(at).sub(h.point).addScaledVector(h.normal, h.radius).dot(h.tangent);
    }
    branchPath(s, h);
    scratch.c.copy(at).sub(h.point).addScaledVector(h.normal, h.radius);
    scratch.c.addScaledVector(h.tangent, -scratch.c.dot(h.tangent));
    let near = scratch.c.length() - h.radius;
    if (sim.pod === "open") {
      const L = SPECIES[sim.species].pupa;
      const y = THREE.MathUtils.clamp(at.y, HANG.y - STALK - L, HANG.y);
      near = Math.min(near, Math.hypot(at.x - HANG.x, at.y - y, at.z - HANG.z) - 0.55 * L);
    }
    return near;
  }

  // Up to the branch (and the little loops off it and back): it lets go with its wings up over its back and drops away
  // into open air before the first stroke, beats round in front of the branch and over it, and comes down onto its top
  // with its wings raised to brake and its legs out. Carried along the way at its own pace, bobbed by every stroke; its
  // wings open only as far as there is room for them, so that nothing of them is ever through the shell or the bark.
  function flyUp(rawDt: number) {
    const f = sim.fly;
    const sp = SPECIES[sim.species];
    const FL = sp.wing;
    const b = butterfly;
    const dt = rawDt;
    const length = f.arc[64];
    const T = 0.6 + length / (1.25 + 0.4 * FL);
    f.t += dt;
    // First the leap: wings up over its back, its legs throw it clear (f.dest to the way's start) far enough that the
    // first stroke is a full one; then along the way.
    const leap = clamp01(f.t / f.held);
    const u = clamp01((f.t - f.held) / T);
    // Along the way: from rest, quickest through the middle, slowing in to the landing.
    const w = 1 - Math.pow(1 - u, 1.3);
    const along = length * (w - Math.sin(Math.PI * 2 * w) / (Math.PI * 2));
    const left = length - along;
    const brake = 1 - smooth(0.12 * FL, 1.1 * FL, left);
    const lead = wayAt(f, wayAlong(f, along), scratch.a);
    if (leap < 1) lead.lerpVectors(f.dest, f.way[0], leap * leap * (3 - 2 * leap));
    // Coming down onto the bark there is less and less room: the strokes shorten and rise over its back.
    const open = 1 - smooth(0, 0.25, brake) * (1 - smooth(0.4 * FL, 1.15 * FL, room(lead)));
    // Full wingbeats from the end of the leap, the first a downstroke; shallower and quicker into the brake.
    const beat = sp.beat * SLOW * (1 + 0.35 * brake + 0.6 * (1 - open)) * (1.15 - 0.15 * smooth(0.3, 0.8, f.t));
    f.lastPhase = f.phase;
    if (leap >= 1) f.phase += beat * dt;
    const p = f.phase % 1;
    flutter(f, 1 - 0.4 * brake);
    const power = (1.25 - 0.45 * smooth(0.25, 0.9, u)) * (0.45 + 0.55 * open);
    const rock = stroke(p, 0, power) * (0.2 + 0.8 * open);
    easeIn(dt);
    // The bob of each stroke (to a set height, whatever the wingbeat), on a spring of its own about the way.
    const bob = 0.05 * FL * (1 - 0.6 * brake) * (2 * Math.PI * beat) ** 2 * open;
    f.bobV += (heave(p) * bob - 60 * f.bob - 2 * Math.sqrt(60) * f.bobV) * dt;
    f.bob += f.bobV * dt;
    lead.y += f.bob;
    f.vel.copy(lead).sub(f.pos).divideScalar(Math.max(1e-4, dt));
    f.pos.copy(lead);
    b.object.position.copy(f.pos);
    // Heading: round to face the branch as it climbs, then along it as it comes in. Steep in the air, as a butterfly
    // flying slowly is; reared further back to brake.
    f.yaw = f.yaw0 + (f.yawMid - f.yaw0) * smooth(0.02, 0.42, w) + (f.yaw1 - f.yawMid) * smooth(0.55, 0.95, w);
    const pitch = 1.45 - 0.5 * smooth(0.05, 0.4, w) + 0.28 * Math.sin(Math.PI * brake) + rock;
    attitude(f.yaw, pitch, 0, scratch.q);
    // (Not turned while still close to the shell or the bark: a body swung up or over there would be swung into it.)
    f.clear = Math.max(f.clear, smooth(0.35 * FL, 1.0 * FL, room(f.pos)));
    b.object.quaternion.slerpQuaternions(f.start, scratch.q, ease(clamp01(f.t / 0.4)) * f.clear);
    // Coming down, level on its legs by the time they reach the bark.
    b.object.quaternion.slerp(f.goalTurn, smooth(0.25, 1, brake));
    b.object.scale.setScalar(FL);
    // Legs: folded as it lets go, then out for the bark.
    b.tucked = sim.hand.tucked + (1 - sim.hand.tucked) * ease(clamp01(f.t / 0.3));
    if (brake > 0) {
      b.flare(brake);
      b.reach(surface, f.landS, f.facing, smooth(0.1, 0.9, brake));
    }
    // Where there is little room, the strokes are short and high over its back.
    // (Eased over from however they were held when it let go: quickly, as it raises them to spring off.)
    const from = ease(clamp01(f.t / (HAND * 0.6)));
    const amp = 0.15 + 0.85 * open;
    b.flap = sim.hand.flap + (WINGS_UP + (b.flap - WINGS_UP) * amp - sim.hand.flap) * from;
    b.hindLag = sim.hand.hindLag + (0.05 + (b.hindLag - 0.05) * amp - sim.hand.hindLag) * from;
    // And its abdomen is raised off the bark coming down, as it is held standing.
    live.tuck.value += (-0.3 - live.tuck.value) * smooth(0.3, 0.9, brake);
    if (u >= 1) {
      b.land(surface, f.landS, f.facing);
      shakeDew(0.8, b.object.position);
      sim.stage = "perched";
      const st = sim.stroll;
      st.mode = "settle";
      st.t = 0;
      st.until = 1.1;
      st.since = 0;
      st.dir = f.facing;
      st.speed = 0;
      st.loopAt = 30 + Math.random() * 20;
      st.wasMoving = false;
      sound.play("tick", { gain: 0.3, pitch: 1.5, pan: -0.1 });
      sound.play("brush", { gain: 0.22, pitch: 0.9, pan: -0.1 });
      if (!sim.earned) {
        sim.earned = true;
        shareResult.set("I watched a butterfly come out of its chrysalis and fly up onto a branch, in Emerge");
        followPrompt.earn();
      }
      if (sim.sendOff) {
        sim.sendOff = false;
        leave();
      }
    }
  }

  // On the branch: it settles, fans its wings a few times, walks a few steps one way, stops, fans, walks back.
  function stroll(dt: number) {
    const sp = SPECIES[sim.species];
    const FL = sp.wing;
    const b = butterfly;
    const st = sim.stroll;
    st.t += dt;
    st.since += dt;
    if (st.since > st.loopAt && st.mode === "pause" && !b.fanning && !b.moving && !b.turning && b.acting === "") {
      loop();
      return;
    }
    const pace = sp.pace;
    if (st.t >= st.until && !(st.mode === "fan" && b.fanning && st.t < st.until + 6)) {
      st.t = 0;
      if (st.mode === "settle" || st.mode === "pause") {
        // It fans its wings when it first settles, and after that only now and then: the rest of its quiet spells are
        // the rig's own (basking, tasting, preening and the rest).
        if (st.mode === "settle" || Math.random() < 0.25) b.fan(st.mode === "settle" ? 3 : 2);
        st.mode = "fan";
        st.until = 1.2;
      } else if (st.mode === "fan") {
        // A few steps: toward whichever end of its beat is further off.
        st.mode = "walk";
        st.dir = b.s < ((STROLL[0] + STROLL[1]) / 2) * FL + (Math.random() - 0.5) * 0.4 ? 1 : -1;
        const room = st.dir > 0 ? STROLL[1] * FL - b.s : b.s - STROLL[0] * FL;
        const far = Math.min(room, (0.55 + Math.random() * 0.6) * FL);
        st.until = far / pace;
        st.speed = pace * st.dir;
        // Its feet on the bark, once a walk (the recording runs about four seconds, as long as most walks).
        if (sim.clock - st.lastScurry > 3.5) {
          st.lastScurry = sim.clock;
          sound.sample(SCURRY, 1.4);
        }
      } else {
        st.mode = "pause";
        st.until = 4 + Math.random() * 4;
      }
    }
    // The rig holds the wings and the legs while it stands and walks.
    b.walk(dt, st.mode === "walk" && !(b.s > STROLL[1] * FL + 0.05 && st.dir > 0) && !(b.s < STROLL[0] * FL - 0.05 && st.dir < 0) ? st.speed : 0);
    b.idle(dt);
    b.object.scale.setScalar(FL);
    // Its feet on the bark: the faintest ticks, never a rattle.
    if (b.moving && !st.wasMoving && sim.clock - st.lastStep > 0.18) {
      st.lastStep = sim.clock;
      shakeDew(0.3, b.object.position);
      sound.play("tick", { gain: 0.035 + Math.random() * 0.02, pitch: 2.1 + Math.random() * 0.5, pan: THREE.MathUtils.clamp(b.object.position.x * 0.25, -0.6, 0.6) });
    }
    st.wasMoving = b.moving;
  }

  // Away for good: a push off the bark and a steep climb on full strokes, then out past the eye in its own way of
  // flying, beats and glides, each stroke lifting it and each glide letting it sink.
  function flyAway(rawDt: number) {
    const f = sim.fly;
    const sp = SPECIES[sim.species];
    const FL = sp.wing;
    const b = butterfly;
    const dt = rawDt * (SLOW + 0.3 * smooth(1.2, 4, f.t));
    f.t += dt;
    const beat = sp.beat * (1.15 - 0.15 * smooth(0.3, 0.8, f.t));
    // Bouts of beats with glides between; the first bout long and full.
    f.bout -= dt;
    if (f.bout <= 0) {
      const glides = f.flapping && f.t > 0.9 && sp.glide > 0.05;
      f.flapping = !glides;
      const beats = sp.bout;
      const rest = sp.glideFor;
      f.bout = f.flapping ? (beats[0] + Math.random() * (beats[1] - beats[0])) / beat : rest[0] + Math.random() * (rest[1] - rest[0]);
    }
    f.lastPhase = f.phase;
    const mid = f.phase % 1 > 0.03;
    // (Wings held up through the leap; full strokes from its end, the first a downstroke.)
    const leap = clamp01(f.t / f.held);
    const space = room(f.pos);
    if ((f.flapping || mid) && leap >= 1) f.phase += beat * dt;
    const p = f.phase % 1;
    const gliding = !f.flapping && !mid;
    f.glide += ((gliding ? 1 : 0) - f.glide) * (1 - Math.exp(-dt * 12));
    flutter(f, 1);
    const rock = stroke(p, f.glide, 1.3 - 0.3 * smooth(0.4, 0.9, f.t));
    easeIn(dt);
    b.tucked = sim.hand.tucked + (1 - sim.hand.tucked) * ease(clamp01(f.t / 0.3));
    // Steering: round toward the way out, wandering as butterflies do, never turning faster than it can.
    const to = scratch.a.copy(f.dest).sub(f.pos);
    const ahead = Math.hypot(to.x, to.z) > 0.8;
    let turn = ahead ? Math.atan2(to.x, to.z) - f.yaw : 0;
    turn -= Math.PI * 2 * Math.round(turn / (Math.PI * 2));
    // (Wandering by slow waves, not by dice: the same at any frame rate, and never a twitch.)
    const wander = 0.9 * Math.sin(f.t * 2.3 + f.seed) + 0.6 * Math.sin(f.t * 5.1 + f.seed * 2.7);
    f.yawRate += (THREE.MathUtils.clamp(turn * 2.2, -2.4, 2.4) + wander - f.yawRate) * (1 - Math.exp(-dt * 2.5));
    f.yaw += f.yawRate * dt * smooth(0.25, 0.9, f.t);
    const speed = (0.7 + 2.9 * smooth(0.1, 2.2, f.t)) * (0.75 + 0.25 * FL);
    const climb = 0.75 + ((gliding ? -0.16 : 0.3) - 0.75) * smooth(0.3, 0.7, f.t);
    f.climb += (climb - f.climb) * (1 - Math.exp(-dt * 5));
    const h = scratch.h.set(Math.sin(f.yaw), 0, Math.cos(f.yaw));
    const want = scratch.b.copy(h).multiplyScalar(Math.cos(f.climb) * speed);
    want.y = Math.sin(f.climb) * speed;
    // (Until it is clear of what it left, it keeps on the way it pushed off.)
    want.lerp(scratch.v.copy(f.push).multiplyScalar(speed + 0.6), 1 - f.clear);
    const acc = want.sub(f.vel).multiplyScalar(3.2);
    const bob = 0.055 * FL * (2 * Math.PI * beat) ** 2;
    acc.y += heave(p) * bob * (1 - f.glide);
    acc.addScaledVector(h, Math.max(0, heave(p)) * bob * 0.35 * (1 - f.glide));
    // The push of its legs, spent in the first moment.
    acc.addScaledVector(f.push, 9 * (1 - smooth(0, 0.22, f.t)));
    if (leap < 1) {
      // The leap: carried by its legs, leaving them still moving out (s = 2.7x² - 1.7x³).
      f.pos.lerpVectors(f.way[0], f.way[1], leap * leap * (2.7 - 1.7 * leap));
      f.vel
        .copy(f.way[1])
        .sub(f.way[0])
        .multiplyScalar((leap * (5.4 - 5.1 * leap)) / f.held);
    } else {
      f.vel.addScaledVector(acc, dt);
      f.pos.addScaledVector(f.vel, dt);
    }
    b.object.position.copy(f.pos);
    // Steep in the climb, nearly level in a glide, rocked by each stroke and banked into its turns.
    const pitch = 0.55 + 0.5 * (1 - smooth(0.25, 0.8, f.t)) - 0.4 * f.glide + rock;
    f.bank += (-f.yawRate * 0.14 - f.bank) * (1 - Math.exp(-dt * 6));
    attitude(f.yaw, pitch, f.bank, scratch.q);
    // (As on the way up: turned, and its wings opened, only as far as it is clear of the bark and the shell.)
    f.clear = Math.max(f.clear, smooth(0.35 * FL, 1.0 * FL, space));
    b.object.quaternion.slerpQuaternions(f.start, scratch.q, ease(clamp01(f.t / 0.45)) * f.clear);
    b.object.scale.setScalar(FL);
    const from = ease(clamp01(f.t / HAND));
    b.flap = sim.hand.flap + (b.flap - sim.hand.flap) * from;
    b.hindLag = sim.hand.hindLag + (b.hindLag - sim.hand.hindLag) * from;
    if (f.t > 1.15 && sim.pod === "open") drop();
    // Gone once it is out of the view, wings and all, or behind the eye.
    scratch.c.copy(f.pos).sub(camera.position);
    const front = -scratch.c.dot(scratch.v.setFromMatrixColumn(camera.matrixWorld, 2));
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const edge = 1 + (1.15 * FL) / Math.max(0.2, front * tanV * Math.min(1, camera.aspect));
    scratch.v.copy(f.pos).project(camera);
    if (front < 0.3 || (f.t > 0.5 && (Math.abs(scratch.v.x) > edge || Math.abs(scratch.v.y) > edge)) || f.t > 9) {
      sim.stage = "none";
      b.object.visible = false;
      card.hide();
      sim.carded = "";
      if (sim.pod === "open") drop();
    }
  }

  const v = weather;
  return (
    <>
      <SkyDome />
      <Tree version={v} fine={tier === "low" ? 0.5 : tier === "medium" ? 0.75 : 1} />
      <Twig version={v} fine={fine} />
      {/* Soft warm motes and far discs in every weather (motes.tsx); of Tension's air only the storm's rain is kept. */}
      <Motes tier={tier} />
      <group visible={v === "storm"}>
        <Air look={LOOKS.storm} tier={tier} />
      </group>
      <Swarm tier={tier} />
      <primitive object={rig.hang} />
    </>
  );
}

// The lid swings open with a little overshoot, as it springs free.
function lidCurve(x: number) {
  const pull = (from: number, to: number) => ease(clamp01((x - from) / (to - from)));
  const last = clamp01((x - 0.62) / 0.38);
  return 0.2 * pull(0, 0.2) + 0.3 * pull(0.3, 0.54) + 0.5 * (easeOut(last) + Math.sin(Math.PI * last) * 0.1 * (1 - last));
}
// The sides part in two pulls.
function sidesCurve(x: number) {
  const pull = (from: number, to: number) => ease(clamp01((x - from) / (to - from)));
  return 0.32 * pull(0, 0.3) + 0.68 * pull(0.45, 1);
}

// Each weather sounds as it does in Tension: birds at dawn, insects in the jungle, crickets and an owl by moonlight,
// rain and thunder in the storm.
function useAmbience(version: Version) {
  useBed("wind", { dawn: 0.1, golden: 0.04, moonlit: 0.05, storm: 0.38 }[version]);
  useBed("crickets", { dawn: 0.02, golden: 0.16, moonlit: 0.15, storm: 0 }[version]);
  useBed("rain", version === "storm" ? 0.42 : 0);
  const pan = () => Math.random() * 1.6 - 0.8;
  useEvery(1, 4, () => sound.play("chirp", { gain: 0.15 + Math.random() * 0.12, pan: pan(), pitch: 0.85 + Math.random() * 0.4 }), version === "dawn");
  useEvery(4, 10, () => sound.play("chirp", { gain: 0.1, pan: pan(), pitch: 0.6 + Math.random() * 0.3 }), version === "golden");
  useEvery(0.6, 2.5, () => sound.play("drip", { gain: 0.06 + Math.random() * 0.06, pan: pan(), pitch: 0.7 + Math.random() * 0.8 }), version === "golden");
  useEvery(10, 24, () => sound.play("hoot", { gain: 0.35 + Math.random() * 0.2, pan: pan(), pitch: 0.9 + Math.random() * 0.15 }), version === "moonlit");
}

const emerge: Variant = {
  Scene,
  Overlay,
  passes: { overlay: true },
  // Auto starts a phone low and never raises it; on a desktop a tier down does not make this scene faster, and the
  // step itself shows.
  autoFloor: "high",
  // A phone (which starts on Low) draws it at one pixel per CSS pixel: a retina phone's full density is more than twice
  // the shading, for a difference its small screen hardly shows. Desktops keep theirs.
  maxDpr: initialTier() === "low" ? 1 : undefined,
  settings: {
    emergeSpecies: { type: "choice", label: "Butterfly", short: "Butterfly", value: "morpho", options: ROTATION.map((name) => SPECIES_OPTIONS.find((o) => o.value === name)!) },
    emergeShell: { type: "choice", label: "Chrysalis", short: "Shell", value: "wax", options: SHELL_OPTIONS },
    emergeWeather: { type: "choice", label: "Weather", value: "dawn", options: VERSIONS.map((o) => ({ ...o, label: o.value === "golden" ? "Golden" : o.label })) },
    emergeRegrow: { type: "action", label: "New chrysalis", short: "New" }
  },
  // No pills on a phone: the species come round in turn by themselves, and the settings stay in the panel. Eight pills
  // down its side covered the butterfly on the branch.
  phonePills: [],
  view: { position: [0.36, 0.36, 4.15], target: [0, 0.5, 0], fov: 38 },
  phoneView: { position: [0.42, 0.62, 5.5], target: [0, 0.8, 0], fov: 46 },
  look: { ...LOOK, exposure: 1.05, bloom: 0.45 },
  // Its hint, notes and technical overview are the day's own, in ../index.tsx, where the build and the repo sync read them.
};

export default emerge;
