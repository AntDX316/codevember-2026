import * as THREE from "three/webgpu";
import { ABDOMEN, JOINT, bodyGeometry, bodyMaterial, bodyRadius, eyeMaterial, plateMaterial, furGeometry, furMaterial, palpPoint, palpRadius, Tubes, tubeMaterial } from "./body";
import { atlas, live } from "./live";
import { BUILD, look, preloadWings, setLook, wingCost, wingDetail, wingUpload, wingsWaiting } from "./look";
import { SPECIES, type Species, type SpeciesName } from "./species";
import { branchPath, branchSurface } from "./twig";
import { glassMaterial, wingGeometry, wingMaterial } from "./wings";

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// API for the scene (index.tsx). Everything below is a method or field of `Butterfly`; all the old pose fields (flap,
// hindLag, fold, sweep, hindSweep, pitch, antenna, coil, split, legs, tucked) still work and are what these helpers write.
// Call order each frame: [your pose code and/or the helpers below] → butterfly.update(eye).
//
// SURFACE  A branch is given as a function of the distance s along it (scene units, world space):
//   type Hold = { point, normal, tangent, radius }
//   type Surface = (s: number, out: Hold) => void
//     point   on the bark, along the line the butterfly stands on (the top of the branch)
//     normal  unit, out of the bark there        tangent  unit, toward increasing s
//     radius  of the branch there, scene units (feet wrap round it and grip its sides; 1e3 for a flat thing)
//   Better: give a function of three arguments, (s, out, phi) — when phi is passed, answer with the true bark point
//   and outward normal at that angle round the branch from the top (positive toward tangent × normal), e.g. twig.tsx's
//   branchSurface(s, phi, out). Feet are then planted exactly on the drawn bark; without it they sit on a circle of
//   `radius` about the path, which floats or sinks wherever the real branch is not that circle.
//   It is called ~10 times a frame: keep it cheap and allocation-free, and let it follow the branch if it sways (feet are
//   stored as surface coordinates, so they stay planted on a moving branch).
//
// PERCHING AND WALKING
//   perchFrame(surface, s, facing, outPosition, outQuaternion)  World pose of the body standing at s. facing +1 = head
//       toward +s, -1 = toward -s. Aim a landing flight at this.
//   reach(surface, s, facing, k)   In flight, coming in: legs swing forward and stretch for the footholds they will take
//       at s (k 0 tucked … 1 fully out). Sets tucked and legs[]; feet that cannot reach yet simply stay short of the
//       bark (segments never stretch). Call every frame of the approach, after setting object position/quaternion.
//   land(surface, s, facing)       Touch down: from this frame the rig owns object.position/quaternion (written in the
//       parent's space, any parent; scale untouched). Eases from wherever the body is to the stance over ~0.25 s, feet
//       planted where reach() put them.
//   walk(dt, speed)                Call EVERY frame while perched (speed 0 to stand). speed in scene units/s along s,
//       signed; about sp.pace is natural (see species.ts). If the sign is against its facing it first turns round on the
//       spot, stepping (≈1.5 s), then walks. Four legs in diagonal pairs (mid-right + hind-left, then the others); a foot
//       only moves while lifted; body rides at a fixed height with a slight sway. Speed changes are eased inside.
//   s, facing, moving, turning     Read-only state: where it is along the branch, which way it faces, whether any foot
//       is in the air, whether it is mid about-face.
//   release()                      Take-off: the rig lets go of the object transform (you fly it again); legs push then
//       tuck as you raise `tucked`.
//
// GRIPPING ANY SURFACE (the shell, while it comes out and hangs)
//   holdOk(k, point) → canReach, and the point lies on the belly side of the wing roots and not across the body:
//       only offer holds that pass, and a leg can never be sent through a wing.
//   regripDue(dt) → -1, or now and then a leg (0-3) that wants to shift its foot: give it a nearby hold with a new id.
//       (On a branch the rig does this by itself inside walk(): one foot at a time lifts a little, shifts a few
//       hundredths of a wing length, plants and hooks on.)
//   legReach(k, outHip) → farthest a foot of leg k can be set from its hip (world units; hip written to outHip), and
//   canReach(k, point) → whether that leg can hold a world point from where the body now is. Use them when choosing
//   holds; probe() chains 3–8 give every leg as drawn (fore legs and tucked legs included).
//   grip(dt, holds)   holds: four { point, normal, id } in WORLD space, for mid-right, mid-left, hind-right, hind-left
//       (the object passed may be reused; give them every frame, after setting object position/quaternion). A planted
//       foot follows its hold's point, so it rides a swinging shell. Change a hold's `id` to make that leg step to the
//       new point: it lifts, swings over ~0.24 s on an eased arc off the surface and plants; a leg waits its turn while
//       the other diagonal pair is in the air, so changing all four ids at once gives a proper two-beat step.
//       Writes legs[2..5] only (not `tucked`: ease that yourself, it is damped inside too). `moving` is true while
//       any foot is in the air; `planted[i]` says which feet are down. Optional third argument `clearance(worldPoint)`
//       → distance to the nearest shell wall (world units, positive in free space): given it, each full step's arc is
//       chosen at lift-off from 13 ways round, the one keeping the foot's path farthest from shell and wings alike. A hold may be changed at any time: a leg that
//       cannot lift yet steps as soon as the other pair is down, to the latest point given. Call gripReset() before the first use so feet start planted rather than swinging in.
//
// SMOOTHING  All helper poses blend in over 0.4 s from whatever posed the butterfly last (another helper, or your own
//   code); speed, sway, wing opening, abdomen, antennae and `tucked` run on critically damped springs. If you switch
//   from a helper back to writing pose fields yourself, ease that hand-over on your side. `fold` is never written by
//   a helper: it is the scene's (keep it 0 on the branch and in flight).
//
// WINGS AND THE REST (optional helpers; each writes the pose fields and live.bend/twist/camber/tuck)
//   idle(dt)        Perched: wings held closed over the back, antennae sweeping, a leg shuffle now and then, and any
//                   fanning in progress. Call every frame while perched (with walk()).
//   fan(times = 3)  Start that many slow open-and-close wing fans (≈2.2 s each, species-dependent). `fanning` is true
//                   until they finish. Fine to call while walking (it fans as it goes).
//   beat(phase, power = 1)   Flapping flight at wingbeat phase (in cycles; only the fraction is used; 0 = top of the
//                   upstroke, downstroke lasts 0.6). power 0…1.3 scales the stroke amplitude (1.3 = take-off). Returns
//                   the body pitch to add (radians, nose-up +) so the body rocks against the wings.
//   glide(time)     Gliding: wings in the species' shallow V, small trembles. Mix with beat() through flight().
//   flare(k)        Landing brake, k 0…1: wings spread and tilted back, body reared up; combine with reach().
//   flight(phase, glideK, power = 1)   One call for flap-glide: beat pose mixed toward the glide pose by glideK (0 all
//                   flapping, 1 all gliding). Returns body pitch as beat().
//   wingSize = 2048    (default 4096) the wing texture's top level, for low tier and phones; set before preload().
//   preload(species)   Fetches and decodes that species' own wing texture ahead of setSpecies(), and uploads it on a
//                   quiet frame; call it for the next species while the current one is on the branch.
//   Per species (species.ts): beat (Hz), glide (fraction of time gliding), bout ([min,max] beats per flapping bout),
//   glideFor ([min,max] seconds per glide), pace (walking speed, scene units/s), dihedral (glide V, radians).
//
// PROBE (for intersection tests on the CPU; valid right after update())
//   probe(): { count, points: Float32Array (xyz, WORLD), radius: Float32Array (world units: half-thickness of the mesh
//       there), chain: Int16Array } — arrays reused, nothing allocated. Consecutive samples with the same chain id are
//       joined by mesh; chain -1 marks a wing-grid sample that falls outside the wing's outline (skip it).
//       Head, for anything close in front of it: 15 skull (7 samples, true radii) · 16 the same out to the fur's tips
//       · eyes 1, 2 · antennae 9, 10 (15 samples each) · proboscis 11, 12 · palps 13, 14 (5 each, fur included).
//       Set `headRoom` (1 free … 0 none) when a surface is close ahead: the rig's own head and antenna movements shrink.
//       Chains: 0 spine head→tail (16, true radii with girth and live.swell, bent by live.tuck) · 1, 2 eyes · 3–8 legs
//       as drawn (hip, coxa, knee, ankle, mid-tarsus, tip) · 9, 10 antennae (7 each) · 11, 12 proboscis halves (7 each)
//       · 13, 14 palps (3 each) · wings w = 0…3 (fore R, fore L, hind R, hind L): 7×7 grid, rows as chains
//       20 + 20w + row, then the same points again by column as chains 30 + 20w + column.
//       Wing samples follow the vertex shader exactly (live.wing[w], expand, bend, twist, camber, wet) except its
//       noise: instead each sample's radius is the most the crumple can displace it there, so sphere tests are safe.
//   Folded-wing envelope (forewing lengths, from the wing root, expand = 0): the stub reaches 0.39 × its full radius
//       (so ≤ 0.40 for a forewing tip, ≤ 0.34 hind) and at crumple = 1 is displaced up to ±(0.08 + 0.05 r) out of its
//       plane; at crumple c that is × c. Width does not shrink separately: the stub is the wing scaled toward its root.
//       live.pack (0…1, the scene's): at 1 the stub is 0.21 × full radius and its crumple × 0.35; no effect at 0. No
//       wrap round the body.
//   Legs: reach from the hip is 0.37 × build.leg (coxa 0.034 + femur 0.105 + tibia 0.115 + tarsus 0.118); a target
//       beyond it is never stretched to: the foot stops short.
//
//   The rig keeps wings and legs apart by itself every frame (`give`, 0…1, says how far the wings have had to yield:
//   folded wings are drawn back toward lying along the back, never past the legs to the belly side). So a `fold` much
//   beyond 1.5 will not be shown as asked while the legs are out. While live.pack > 0.5 only the hind pads yield. Set `yield = false` to switch this off for a phase.
// REPEATABLE RUNS  Pass a fixed step to update(eye, dt) and the rig counts time only from those steps (its springs,
//   the wing-yield limiter, the leg-tuck easing); give grip(dt, …) the same fixed dt; call reseed(n) at the start.
//   Then everything the rig does to the pose depends only on the sequence of calls and their arguments: not on the
//   frame rate, the wall clock, the camera (the eye only turns the fur's ribbons) or Math.random (the rig has its own
//   seeded generator). Take one update() per fixed step, even when that is several in a rendered frame.
//   selfClash(): { count, worst, leg, wing } — legs against wings as drawn this frame (see the method); 0 is the rule.
//
// DEV  window.__bfly = { rig, studio }: set studio = { species, at: [x, y, z], mode, ... } to pose the butterfly on a
//   test branch whatever the scene is doing (see `Studio` below); null to hand it back.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// One butterfly, posed every frame: where its wings are, how its legs reach, its antennae and proboscis. Body space as
// in body.ts, in forewing lengths; the group is scaled to the species.

// Hips: front, middle, hind; right then left.
const HIPS = [
  [0.026, 0.07, -0.05],
  [0.034, 0.012, -0.056],
  [0.034, -0.058, -0.052]
];
// A walking leg, in forewing lengths: coxa, femur, tibia, and the five joints of the tarsus.
const COXA = 0.034;
const FEMUR = 0.105;
const TIBIA = 0.115;
const TARSUS = [0.046, 0.021, 0.017, 0.014, 0.02];
const TARSUS_LENGTH = TARSUS.reduce((a, b) => a + b, 0);
// Twenty rings down a leg: hip, coxa, femur, knee, tibia, ankle, the tarsal joints, the tip.
const LEG_RINGS = 20;
const LEG_RADII = [0.017, 0.0165, 0.0115, 0.0135, 0.012, 0.0108, 0.0122, 0.0098, 0.009, 0.0082, 0.0092, 0.0068, 0.0074, 0.0062, 0.0067, 0.006, 0.0056, 0.005, 0.004, 0.0012];
const WING_ROOT = new THREE.Vector3(0.062, 0.005, 0.046);
// Where the feet stand, in forewing lengths from under the thorax: forward and out, for the middle and hind pairs.
const STANCE = [
  [0.15, 0.23],
  [-0.19, 0.2]
];
// A few points of the wings (x out, y toward the head, in forewing lengths; then 1 for a hindwing): where they come
// nearest the perch.
const WING_POINTS = [
  [0.85, 0.5, 0],
  [0.7, 0.05, 0],
  [0.7, -0.2, 1],
  [0.5, -0.5, 1],
  [0.25, -0.62, 1]
];
// Samples of the head for the probe: offsets from its centre and each one's radius as a fraction of the skull's.
const HEAD_POINTS = [
  [0, 0, 0, 1],
  [0, 0.022, 0, 0.85],
  [0, 0.012, -0.022, 0.75],
  [0, -0.012, -0.022, 0.75],
  [0.02, 0, -0.012, 0.7],
  [-0.02, 0, -0.012, 0.7],
  [0, 0.006, 0.02, 0.75],
  [0, -0.026, -0.028, 0.6],
  [0.016, -0.02, -0.024, 0.55],
  [-0.016, -0.02, -0.024, 0.55]
];
const RIDE = 0.128; // thorax above the bark
const TILT = 0.22; // head up
const CLOSED = Math.PI / 2 - 0.03;
// How close a wing may come to the body's middle plane: half the gap between two wings pressed back to back.
const MIDLINE = 0.002;

// What it does of its own accord while perched (idle() picks by weight, never the same twice running; or call
// act(name)). Seconds each lasts: [least, most].
export const ACTIONS = [
  { name: "bask", weight: 3, time: [3, 6] }, // slow open, held to the light, slow close
  { name: "flutter", weight: 2, time: [0.9, 0.9] }, // quick double flutter
  { name: "shiver", weight: 2, time: [0.9, 1.6] }, // fast shiver, wings barely apart
  { name: "pump", weight: 2, time: [2.5, 4.5] }, // half-open pumping
  { name: "snap", weight: 1, time: [0.7, 0.7] }, // one snap open and shut
  { name: "taste", weight: 1.5, time: [2.4, 3.6] }, // proboscis uncoiled to the bark and coiled again
  { name: "tail", weight: 1.5, time: [1.2, 2] }, // abdomen lifted and twitched
  { name: "preen", weight: 1.5, time: [1.6, 2.2] }, // one antenna drawn down through a foreleg, cleaned, let go
  { name: "look", weight: 1.5, time: [2.2, 3.4] } // the body turned a little one way, then the other, feet where they are
] as const;

// curl (0…1, optional): the tarsus arched over and hooked onto what it holds, as round a rim.
export type Leg = { target: THREE.Vector3; normal: THREE.Vector3; lift: number; curl?: number };
export type Hold = { point: THREE.Vector3; normal: THREE.Vector3; tangent: THREE.Vector3; radius: number };
// (A surface function that takes a third argument is asked for the true bark: phi is the angle round the branch from
// the top line, positive toward tangent × normal, and it answers with the point and outward normal there.)
export type Surface = (s: number, out: Hold, phi?: number) => void;

type WingPose = { flap: number; hindLag: number; sweep: number; hindSweep: number; pitch: number; bend: number; twist: number; camber: number; tuck: number; body: number };
const wingPose = (): WingPose => ({ flap: 0, hindLag: 0, sweep: 0, hindSweep: 0, pitch: 0, bend: 0, twist: 0, camber: 0, tuck: 0, body: 0 });
type Foot = { small?: boolean; settle?: number; s: number; w: number; fromS: number; fromW: number; toS: number; toW: number; t: number; dur: number; homeS: number; homeW: number; lift: number };

// Dev: pose it on a test branch. mode: "closed" | "open" | "walk" | "fly" | "glide" | "fresh" | "land".
export type Studio = {
  species?: SpeciesName;
  at: [number, number, number];
  mode: string;
  // The branch runs along +x through `at` unless turned (radians about y); radius in scene units.
  turn?: number;
  radius?: number;
  // Frozen wingbeat phase or walk time, for a still.
  phase?: number;
  expand?: number;
  pack?: number;
  dry?: boolean;
  fold?: number;
  open?: number;
  speed?: number;
  pitch?: number;
  yaw?: number;
  branch?: boolean;
  // Fetch this species' wings ahead, as the scene would.
  preload?: SpeciesName;
  // Stand on the scene's real branch instead of the test one (`at` is then ignored for perched modes).
  real?: boolean;
  act?: string;
};

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const smoother = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
// A critically damped spring toward a target: reaches it in about `time` seconds without overshoot, the same at any
// frame rate.
type Spring = { x: number; v: number };
function damp(s: Spring, target: number, time: number, dt: number) {
  const w = 2 / Math.max(1e-4, time);
  const x = w * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = s.x - target;
  const t = (s.v + w * change) * dt;
  s.v = (s.v - w * t) * e;
  s.x = target + (change + t) * e;
  return s.x;
}

export class Butterfly {
  object = new THREE.Group();
  // The pose.
  flap = CLOSED;
  hindLag = 0;
  fold = 0;
  sweep = 0;
  hindSweep = 0;
  pitch = 0;
  antenna = [
    { yaw: 0.32, pitch: 0.55, curl: 0.4 },
    { yaw: 0.32, pitch: 0.55, curl: 0.4 }
  ];
  coil = 1;
  split = 0;
  legs: Leg[] = Array.from({ length: 6 }, () => ({ target: new THREE.Vector3(), normal: new THREE.Vector3(0, 0, -1), lift: 0 }));
  // 1 folds the legs up under the body whatever their targets (flight, inside the pupa).
  tucked = 1;
  six = false;
  bodyColour = new THREE.Color();
  furColour = new THREE.Color();
  markColour = new THREE.Color();
  // Walking state (read-only outside).
  s = 0;
  facing: 1 | -1 = 1;
  moving = false;
  turning = false;
  fanning = false;
  // How much room there is in front of the head (1 free … 0 none): set it low when a surface is close ahead, and the
  // rig's own head and antenna movements (look-around, preening dips, antenna sweeps) shrink to match, eased.
  headRoom = 1;
  // Perch behaviour: left true, idle() picks from ACTIONS by itself; `acting` names the one under way ("" for none).
  auto = true;
  acting = "";
  // Which walking feet are down right now: mid-right, mid-left, hind-right, hind-left (walk() and grip() keep it).
  planted = [true, true, true, true];

  private species: Species = SPECIES.morpho;
  private scale = 1;
  private build = BUILD[0];
  private tubes = new Tubes([...Array(6).fill(LEG_RINGS), 30, 30, 40, 40, 8, 8, ...Array(8).fill(4), ...Array(8).fill(3), ...Array(24).fill(2)], 14);
  private wings: THREE.Mesh;
  private glass: THREE.Mesh;
  private plates: THREE.Mesh[] = [];
  private wingsNear!: THREE.BufferGeometry;
  private wingsFar!: THREE.BufferGeometry;
  private fur: THREE.Mesh;
  private eyes: THREE.Mesh[];
  private furCount = 30000;
  private scratch = {
    m: new THREE.Matrix4(),
    r: new THREE.Matrix4(),
    s: new THREE.Matrix4().makeScale(-1, 1, 1),
    inv: new THREE.Matrix4(),
    q: new THREE.Quaternion(),
    q2: new THREE.Quaternion(),
    v: new THREE.Vector3(),
    w: new THREE.Vector3(),
    a: new THREE.Vector3(),
    b: new THREE.Vector3(),
    c: new THREE.Vector3(),
    d: new THREE.Vector3(),
    e: new THREE.Vector3(),
    f: new THREE.Vector3(),
    g: new THREE.Vector3(),
    h: new THREE.Vector3(),
    hip: new THREE.Vector3(),
    coxa: new THREE.Vector3(),
    knee: new THREE.Vector3(),
    ankle: new THREE.Vector3(),
    foot: new THREE.Vector3(),
    target: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    pole: new THREE.Vector3(),
    points: Array.from({ length: 40 }, () => new THREE.Vector3()),
    radii: new Array<number>(40).fill(0),
    colours: Array.from({ length: 40 }, () => new THREE.Color()),
    pale: new THREE.Color(),
    hold: { point: new THREE.Vector3(), normal: new THREE.Vector3(), tangent: new THREE.Vector3(), radius: 1 } as Hold,
    pos: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    basis: new THREE.Matrix4(),
    x: new THREE.Vector3(),
    y: new THREE.Vector3(),
    z: new THREE.Vector3(),
    footP: new THREE.Vector3(),
    footN: new THREE.Vector3(),
    beat: wingPose(),
    glide: wingPose()
  };
  // Standing and walking on a surface.
  private perch = {
    surface: null as Surface | null,
    active: false,
    girth: 1e3,
    yaw: 0,
    yawFrom: 0,
    yawTo: 0,
    turnT: 1,
    speed: { x: 0, v: 0 } as Spring,
    settle: 1,
    fromPos: new THREE.Vector3(),
    fromQuat: new THREE.Quaternion(),
    sway: { x: 0, v: 0 } as Spring,
    still: 0,
    nextShuffle: 3,
    lastA: 1,
    feet: Array.from({ length: 4 }, (): Foot => ({ s: 0, w: 0, fromS: 0, fromW: 0, toS: 0, toW: 0, t: -1, dur: 0.15, homeS: 0, homeW: 0, lift: 0 }))
  };
  // Perched wings and antennae.
  private rest = { clock: 0, fans: 0, fanT: 0, open: 0 as number, nextBask: 3, bask: -1, baskHold: 2, lastAct: "", twitch: [-1, -1], nextTwitch: 2, room: { x: 1, v: 0 } as Spring, floor: { x: -1, v: 0 } as Spring, side: 0, look: { x: 0, v: 0 } as Spring, act: "", actT: 0, actFor: 1, coil: { x: 1, v: 0 } as Spring, dipScale: 1, tuck: { x: -0.3, v: 0 } as Spring, opened: { x: 0, v: 0 } as Spring, pose: wingPose(), last: -1, feelers: [0, 1, 2, 3, 4, 5].map((): Spring => ({ x: 0, v: 0 })), stir: { x: 0, v: 0 } as Spring };
  private studio = { last: 0, clock: 0, branch: null as THREE.Mesh | null, key: "", shown: wingPose() };
  disposables: { dispose(): void }[] = [];

  constructor() {
    const body = new THREE.Mesh(bodyGeometry(), bodyMaterial());
    const eyeGeo = new THREE.IcosahedronGeometry(1, 10);
    const eyeMat = eyeMaterial();
    this.eyes = [1, -1].map(() => new THREE.Mesh(eyeGeo, eyeMat));
    this.fur = new THREE.Mesh(furGeometry(this.furCount), furMaterial());
    this.fur.frustumCulled = false;
    const tubes = new THREE.Mesh(this.tubes.geometry, tubeMaterial());
    tubes.frustumCulled = false;
    const wingGeo = wingGeometry();
    // A quarter of the vertices for when it is too far off for the ribs to show.
    this.wingsFar = wingGeometry(48);
    this.wingsNear = wingGeo;
    this.disposables.push(this.wingsFar);
    this.wings = new THREE.Mesh(wingGeo, wingMaterial());
    this.wings.frustumCulled = false;
    // The glasswing's clear panes: the same wings again, drawn after everything opaque.
    this.glass = new THREE.Mesh(wingGeo, glassMaterial());
    this.glass.frustumCulled = false;
    this.glass.renderOrder = 2;
    body.frustumCulled = false;
    // The tegulae: a small scaled plate over each forewing's hinge, so a wing grows out from under a shoulder and
    // not out of bare fur.
    const plateGeo = new THREE.SphereGeometry(1, 20, 14);
    const plateMat = plateMaterial();
    this.plates = [1, -1].map((side) => {
      const plate = new THREE.Mesh(plateGeo, plateMat);
      plate.rotation.set(0.25, 0, side * -0.5);
      plate.frustumCulled = false;
      return plate;
    });
    this.disposables.push(plateGeo, plateMat);
    this.object.add(body, ...this.eyes, this.fur, tubes, this.wings, this.glass, ...this.plates);
    for (const mesh of [body, this.eyes[0], this.fur, tubes, this.wings, this.glass]) this.disposables.push(mesh.geometry, mesh.material as THREE.Material);
    // The studio's say is the last before a draw, whatever the scene set this frame.
    // (Also here: a wing texture fetched ahead is handed to the GPU on this frame, not on the one that first shows it.)
    body.onBeforeRender = (renderer) => {
      this.studioLook();
      // A species shown before its wings were sent ahead gets them all at once (one long frame, but never a butterfly
      // without wings); otherwise the copying trickles in a strip or two a frame.
      wingUpload(renderer, wingsWaiting() && this.object.visible && this.wings.visible && live.hidden.value < 0.5 && this.shown > 2);
      this.shown = this.object.visible ? this.shown + 1 : 0;
    };
    this.wings.onBeforeRender = () => this.studioLook();
    if (typeof window !== "undefined") (globalThis as Record<string, unknown>).__bfly = { rig: this, studio: null, hide: {}, wingCost };
    this.setSpecies(SPECIES.morpho);
  }

  // The side of the wing texture's largest level, 4096 (default) or 2048: set it once, before the first preload or
  // setSpecies that should use it (low tier, phones). Species already loaded keep what they have.
  set wingSize(size: number) {
    wingDetail.top = size >= 4096 ? 4096 : 2048;
  }
  get wingSize() {
    return wingDetail.top;
  }
  // Fetch the wings of the species that comes next, ahead of the change (call it during the walk).
  preload(sp: Species) {
    preloadWings(sp);
  }

  setSpecies(sp: Species) {
    this.species = sp;
    this.six = sp.legs === 6;
    this.scale = sp.wing;
    this.build = BUILD[sp.column] ?? BUILD[1];
    this.object.scale.setScalar(sp.wing);
    this.bodyColour.set(sp.body);
    this.furColour.set(sp.fur);
    this.markColour.set(sp.mark);
    setLook(sp);
    // The pane pass is only ever drawn for a species that has panes.
    this.glass.visible = sp.glass > 0;
    this.posed = NaN;
    const g = this.build.girth;
    this.plates.forEach((plate, i) => {
      const side = i === 0 ? 1 : -1;
      // Small, and sunk into the coat so that the hair laps over its edge.
      plate.position.set(side * 0.05 * g, 0.034, 0.044 * g);
      plate.scale.set(0.017 * g, 0.034, 0.013 * g);
    });
    this.eyes.forEach((eye, i) => {
      const side = i === 0 ? 1 : -1;
      eye.position.set(side * 0.027 * g, 0.169, 0.006);
      eye.scale.set(side * 0.036 * g, 0.043 * (0.5 + 0.5 * g), 0.04 * g);
    });
  }

  // Where the root of the right wing is and how it turns: then the left as its mirror image.
  // Wings and legs never pass through one another. `give` (0…1) is how far the wings have yielded to the legs this
  // frame: folded wings are drawn back from the belly side toward lying along the back, and open or shut wings are
  // eased off whichever extreme brought them onto a leg. It rises within the frame until nothing touches, and falls
  // back slowly once there is room.
  give = 0;
  // All the rig's chance comes from here: a small seeded generator, so a run can be repeated exactly. reseed(n) at the
  // start of anything that must replay the same (the scene does it at the crack, with a seed of its own per species).
  private seed = 20261119;
  reseed(seed: number) {
    this.seed = seed >>> 0 || 1;
    this.restart();
  }
  // Every piece of the rig's own state that can touch the pose, put back to a fixed start: springs at their targets
  // and at rest, the limiter, timers, the step clock, the shell-stepping feet, the perched actions and the pose blend.
  // (It does not touch what the scene sets: pose fields, legs[], the object's transform, species.) reseed() calls it.
  restart() {
    this.give = 0;
    this.foldShown = this.fold;
    this.tuckedNow.x = this.tucked;
    this.tuckedNow.v = 0;
    const folded = smooth((Math.abs(this.fold) - 0.3) / 0.9);
    this.sleek.x = Math.max(live.pack.value, live.wet.value, folded);
    this.sleek.v = 0;
    this.stepClock = 0;
    this.clock = 0;
    this.frameDt = 1 / 60;
    this.posed = NaN;
    this.shown = 0;
    this.fidget.wait = 2;
    for (const f of this.held) {
      f.id = NaN;
      f.t = -1;
      f.small = false;
      f.fresh = false;
      f.curl.x = f.curl.v = 0;
      f.from.set(0, 0, 0);
      f.at.set(0, 0, 0);
      f.n.set(0, 1, 0);
      f.fromN.set(0, 1, 0);
    }
    for (const l of this.legs) {
      l.lift = 0;
      l.curl = 0;
    }
    for (const p of this.preen) p.x = p.v = 0;
    this.planted.fill(true);
    this.moving = this.turning = this.fanning = false;
    this.acting = "";
    this.headRoom = 1;
    const P = this.perch;
    P.active = false;
    P.surface = null;
    P.speed.x = P.speed.v = P.sway.x = P.sway.v = 0;
    P.settle = 1;
    P.still = 0;
    P.nextShuffle = 3;
    P.turnT = 1;
    P.lastA = 1;
    for (const f of P.feet) Object.assign(f, { t: -1, lift: 0, small: false, settle: 0 });
    const R = this.rest;
    Object.assign(R, { clock: 0, fans: 0, fanT: 0, open: 0, nextBask: 3, bask: -1, baskHold: 2, lastAct: "", nextTwitch: 2, side: 0, act: "", actT: 0, actFor: 1, last: -1 });
    R.twitch[0] = R.twitch[1] = -1;
    for (const sp of [R.room, R.floor, R.look, R.coil, R.tuck, R.opened, R.stir, ...R.feelers]) sp.v = 0;
    R.room.x = 1;
    R.floor.x = -1;
    R.look.x = 0;
    R.coil.x = 1;
    R.tuck.x = -0.3;
    R.opened.x = 0;
    R.stir.x = 0;
    const B = this.blend;
    B.mode = "";
    B.t = 1;
    B.last = -1;
    B.body = 0;
  }
  private rand() {
    let t = (this.seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  // Time as the rig counts it: the sum of the steps it has been given (update's dt), or the wall clock if none is.
  private stepClock = 0;
  private stepped = false;
  // Set false to stop the wings yielding to the legs (default true, packed pads included).
  yield = true;
  private foldShown = 0;
  private placeWings(give: number) {
    const fold = this.fold;
    // (A hindwing already points toward the tail: folded down as far as a forewing it would swing round to the belly,
    // across the legs. So it is the hindwings that give most, back to lying behind the legs.)
    const foreFold = fold > 1.5 ? lerp(fold, 1.5, give) : fold;
    const hindFold = fold > 0.4 ? lerp(fold, 0.4, Math.min(1, give * 1.5)) : fold;
    // (Folded down along the body, the pads are parted sideways by the legs coming out between them.)
    const folded = Math.abs(fold) > 0.8;
    const flap = folded ? this.flap - 0.6 * give : lerp(this.flap, Math.min(1.2, Math.max(0.5, this.flap)), give);
    // While the pads are still packed in the slit there is no room sideways: the forewing pads stay exactly as posed
    // and only the hind pads give, swung back off the legs.
    const packed = live.pack.value > 0.5;
    this.foldShown = packed ? fold : foreFold;
    this.wing(0, packed ? this.flap : flap, this.sweep, this.pitch);
    this.foldShown = hindFold;
    this.wing(2, (packed ? this.flap : flap) - this.hindLag * (1 - give), this.hindSweep, this.pitch * 0.5);
  }
  private keepClear() {
    // (The scene may switch the yielding off for a phase: selfClash() still reports whatever then crosses.)
    if (!this.yield) {
      this.give = 0;
      this.placeWings(0);
      return;
    }
    if (this.give > 0) {
      // Is there room to give less?
      // (By time, not by frame: 1.8 a second.)
      const less = Math.max(0, this.give - 1.8 * this.frameDt);
      this.placeWings(less);
      if (this.selfClash().count === 0) this.give = less;
    }
    for (let i = 0; i < 8; i++) {
      this.placeWings(this.give);
      if (this.give >= 1 || this.selfClash().count === 0) break;
      this.give = Math.min(1, this.give + 0.13);
    }
    this.placeWings(this.give);
  }

  // How near the body's middle plane a wing posed by m comes (body space; negative past it): the least over its grid
  // as the vertex shader bends it (probe's own rule, without the noise), less what a crumple can billow it.
  private midline(m: THREE.Matrix4, hind: boolean) {
    if (!this.outline) this.readOutline();
    const frame = hind ? look.hind.value : look.fore.value;
    const expand = live.expand.value;
    const pack = live.pack.value;
    const column = Math.round(live.column.value);
    const e = m.elements;
    let least = 9;
    for (let j = 0; j < 7; j++)
      for (let i = 0; i < 7; i++) {
        if (this.outline && this.outline[(column * 4 + (hind ? 2 : 0)) * 49 + j * 7 + i] !== 1) continue;
        const x0 = frame.x + (i / 6) * frame.z;
        const y0 = frame.y - (j / 6) * frame.z;
        const r = Math.hypot(x0, y0);
        const grown = Math.min(1, Math.max(0, expand * 1.5 - r * 0.5));
        const stub = 0.39 - 0.18 * pack;
        const along = stub + (1 - stub) * Math.pow(grown, 0.7);
        const sst = (a: number, b: number, t: number) => smooth((t - a) / (b - a));
        const gutter = hind ? sst(0.17, 0, x0) * sst(-0.03, -0.3, y0) * look.shut.value * grown : 0;
        const x = x0 * along - gutter * 0.055;
        const y = y0 * along;
        const rr = r * along;
        const chord = x * 0.62 - y * 0.78;
        const z = live.bend.value * rr * rr + live.twist.value * rr * chord + live.camber.value * chord * chord * (hind ? 0.6 : 1) + (hind ? -0.004 : 0.004) - gutter * 0.012 - live.wet.value * 0.05 * rr * rr;
        const billow = live.crumple.value * ((1 - grown) * 0.85 + 0.15) * (1 - 0.65 * pack) * (0.091 + r * 0.05);
        const bx = e[0] * x + e[4] * y + e[8] * z + e[12];
        // (Where the hindwing's gutter wraps round the abdomen, the body lies between the two.)
        if (hind && Math.hypot(bx, e[2] * x + e[6] * y + e[10] * z + e[14]) < 0.07) continue;
        least = Math.min(least, bx - billow);
      }
    return least;
  }

  private wing(index: number, flap: number, sweep: number, pitch: number) {
    const { m, r, s } = this.scratch;
    const g = this.build.girth;
    const pose = (f: number, p: number) => {
      m.makeTranslation(WING_ROOT.x * g, WING_ROOT.y, WING_ROOT.z * g);
      m.multiply(r.makeRotationX(this.foldShown));
      m.multiply(r.makeRotationY(-f));
      m.multiply(r.makeRotationZ(sweep));
      m.multiply(r.makeRotationX(p));
    };
    pose(flap, pitch);
    // Left and right wings meet back to back over the body and are pressed flat together there, never through each
    // other: posed past the middle plane, a wing is first untilted (the feathering that swings its trailing edge
    // across), then, if that is not enough, held down to where it meets the plane. (Not while the pads are still
    // packed and folded in the case: there the emergence's own poses rule.)
    const hind = index > 1;
    if (live.pack.value < 0.5 && Math.abs(this.foldShown) < 0.3 && this.midline(m, hind) < MIDLINE) {
      pose(flap, 0);
      if (this.midline(m, hind) >= MIDLINE) {
        let lo = 0;
        let hi = 1;
        for (let k = 0; k < 8; k++) {
          const t = (lo + hi) / 2;
          pose(flap, pitch * t);
          if (this.midline(m, hind) >= MIDLINE) lo = t;
          else hi = t;
        }
        pose(flap, pitch * lo);
      } else {
        let lo = flap - 1.2;
        let hi = flap;
        pose(lo, 0);
        // (Clear lowered: found between. Not even then: nothing a lower wing would mend; left as it is, untilted.)
        if (this.midline(m, hind) < MIDLINE) hi = lo = flap;
        for (let k = 0; k < 11; k++) {
          const t = (lo + hi) / 2;
          pose(t, 0);
          if (this.midline(m, hind) >= MIDLINE) lo = t;
          else hi = t;
        }
        pose(lo, 0);
      }
    }
    live.wing[index].value.copy(m);
    live.wing[index + 1].value.multiplyMatrices(s, m);
  }

  update(eye: THREE.Vector3, step?: number) {
    this.stepped = step !== undefined;
    if (step !== undefined) this.stepClock += step;
    this.runStudio();
    // Wings whose own picture has not arrived are not drawn at all, never drawn with another species' picture. (The
    // scene fetches each species' wings long before it is shown; this is for a change with no warning.)
    if (wingsWaiting()) this.wings.visible = this.glass.visible = false;
    else if (!this.wings.visible && !this.studioOf()) {
      this.wings.visible = true;
      this.glass.visible = this.species.glass > 0;
    }
    this.placeWings(this.give);
    // The eye, in body space, so the hair can turn to it; and how many hairs are worth drawing from there.
    this.object.updateMatrixWorld();
    const { inv, v } = this.scratch;
    inv.copy(this.object.matrixWorld).invert();
    v.copy(eye).applyMatrix4(inv);
    const far = v.length();
    look.view.value.copy(v).normalize();
    // Beyond about four wing lengths (with a little slack either way, so it does not flicker between the two).
    // (The wings keep their fine mesh at every distance: the coarse one showed its squares wherever relief was left on.)
    if (this.wings.geometry !== this.wingsNear) this.wings.geometry = this.glass.geometry = this.wingsNear;
    (this.fur.geometry as THREE.InstancedBufferGeometry).instanceCount = Math.round(this.furCount * Math.min(1, Math.max(0.15, 2.4 / Math.max(far, 0.01))));
    // Sudden changes in how far the legs are drawn up are eased; so is how sleek and gathered the coat is.
    const now = this.stepped ? this.stepClock : typeof performance !== "undefined" ? performance.now() / 1000 : 0;
    const dt = step !== undefined ? step : Math.min(0.05, Math.max(0, now - this.clock));
    this.clock = now;
    this.frameDt = dt;
    damp(this.tuckedNow, this.tucked, 0.07, dt);
    const folded = smooth((Math.abs(this.fold) - 0.3) / 0.9);
    look.sleek.value = damp(this.sleek, Math.max(live.pack.value, live.wet.value, folded), 0.25, dt);
    look.shut.value = smooth((Math.min(this.flap, this.flap - this.hindLag) - 0.75) / 0.45);
    // Legs, antennae and tongue are rebuilt and sent to the GPU only when something about them has changed.
    let key = this.tuckedNow.x * 7.1 + this.coil * 3.3 + this.split * 5.7 + this.build.girth;
    for (let k = 0; k < 6; k++) {
      const l = this.legs[k];
      key += (l.target.x * 1.3 + l.target.y * 2.1 + l.target.z * 3.7 + l.normal.x * 0.9 + l.normal.y * 1.7 + l.lift * 4.3 + (l.curl ?? 0) * 2.9) * (k + 1);
    }
    for (let k = 0; k < 2; k++) key += (this.antenna[k].yaw * 1.9 + this.antenna[k].pitch * 2.3 + this.antenna[k].curl * 3.1 + this.preen[k].x * 4.7) * (k + 1);
    if (key !== this.posed) {
      const first = Number.isNaN(this.posed);
      this.posed = key;
      this.cap.n = 0;
      this.writeLegs();
      this.writeHead();
      this.tubes.commit(first);
    }
    this.keepClear();
  }

  // ── Legs ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  private writeLegs() {
    const S = this.scratch;
    const { points, radii, colours, hip, coxa, knee, ankle, foot, target, normal, pole, a, b, c } = S;
    const dark = this.bodyColour;
    const light = this.furColour;
    const g = this.build.girth;
    const L = this.build.leg;
    const dotted = this.species.marks > 0;
    for (let k = 0; k < 6; k++) {
      const pair = k >> 1;
      const side = k % 2 === 0 ? 1 : -1;
      const brush = pair === 0 && !this.six;
      hip.set(HIPS[pair][0] * side * g, HIPS[pair][1], HIPS[pair][2] * g);
      if (brush) {
        // A nymphalid's forelegs: small, furred, folded against the chest and never set down.
        coxa.set(hip.x + side * 0.006, hip.y + 0.012, hip.z - 0.022);
        knee.set(hip.x + side * 0.012, hip.y + 0.05, hip.z - 0.03);
        ankle.set(hip.x + side * 0.006, hip.y + 0.012, hip.z - 0.045);
        foot.set(hip.x + side * 0.002, hip.y - 0.012, hip.z - 0.04);
        // Cleaning an antenna: the little foreleg comes up beside the face and the antenna is drawn down through it.
        const up = this.preen[side > 0 ? 0 : 1].x;
        if (up > 0.001) {
          knee.lerp(a.set(side * 0.034 * g, hip.y + 0.075, hip.z - 0.04), up);
          ankle.lerp(a.set(side * 0.03 * g, 0.155, -0.05 * g), up);
          foot.lerp(a.set(side * 0.022 * g, 0.19, -0.022 * g), up);
        }
        const pts = [hip, coxa, knee, ankle, foot];
        const rr = [0.011, 0.01, 0.0085, 0.007, 0.004];
        for (let i = 0; i < 5; i++) {
          points[i].copy(pts[i]);
          radii[i] = rr[i];
          colours[i].copy(dark).lerp(light, 0.6);
        }
        this.tubes.write(k, points, radii, colours, 5);
        for (let i = 0; i < 5; i++) this.note(3 + k, points[i], radii[i]);
        continue;
      }
      const leg = this.legs[k];
      const tucked = Math.min(1, Math.max(0, this.tuckedNow.x));
      const out = 1 - tucked;
      // Folded for flight: drawn up under the thorax, the hind pair trailing back along the belly.
      target.set(side * 0.05 * g, pair === 1 ? 0.085 : -0.13, -0.1 * g - 0.01).lerp(leg.target, out);
      normal.set(0, pair === 1 ? 0.35 : -0.35, -1).normalize().lerp(leg.normal, out).normalize();
      // The coxa: a short stout joint down and out from the chest.
      a.set(side * 0.56, pair === 1 ? 0.18 : -0.22, -0.8).normalize();
      coxa.copy(hip).addScaledVector(a, COXA * L);
      // The tarsus lies out along the surface from the ankle, which stands a little off it; steeper when lifted.
      b.subVectors(target, coxa);
      b.addScaledVector(normal, -b.dot(normal));
      if (b.lengthSq() < 1e-8) b.set(side, 0, 0);
      b.normalize();
      const curl = leg.curl ?? 0;
      const rise = 0.36 + leg.lift * 0.5 + tucked * 0.5 + curl * 0.3;
      c.copy(b).multiplyScalar(Math.cos(rise)).addScaledVector(normal, -Math.sin(rise));
      const T = TARSUS_LENGTH * L;
      ankle.copy(target).addScaledVector(c, -T);
      if (leg.lift > 0) ankle.addScaledVector(normal, leg.lift * 0.03);
      // Knee: up and out, as an insect's.
      pole.set(side * 0.8, 0, 0.75).normalize();
      solveKnee(coxa, ankle, FEMUR * L, TIBIA * L, pole, knee);
      // Folded for flight, each joint has its place: femur back along the chest, tibia doubled forward against it (the
      // hind pair's trailing straight back instead), tarsus trailing. Blended joint by joint, then every segment is
      // given its own length again, so nothing ever stretches.
      if (tucked > 0) {
        const t = smooth(tucked);
        const mid = pair === 1;
        a.set(coxa.x + side * (mid ? 0.012 : 0), coxa.y - (mid ? 0.085 : 0.095), coxa.z - (mid ? 0.03 : 0.03));
        knee.lerp(a, t);
        a.set(a.x + side * 0.004, a.y + (mid ? 0.1 : -0.11), a.z - (mid ? 0.016 : 0.014));
        ankle.lerp(a, t);
        a.set(a.x, a.y - 0.11, a.z - (mid ? 0.014 : 0.004)).sub(ankle).normalize();
        c.lerp(a, t).normalize();
        a.subVectors(knee, coxa).normalize();
        knee.copy(coxa).addScaledVector(a, FEMUR * L);
      }
      // Never stretched: the tibia ends where its length takes it, and the tarsus goes on from there.
      a.subVectors(ankle, knee).normalize();
      ankle.copy(knee).addScaledVector(a, TIBIA * L);
      foot.copy(ankle).addScaledVector(c, T);
      // Rings: hip, coxa, femur, knee, tibia, ankle.
      points[0].copy(hip);
      points[1].lerpVectors(hip, coxa, 0.55);
      points[2].copy(coxa);
      points[3].lerpVectors(coxa, knee, 0.14);
      points[4].lerpVectors(coxa, knee, 0.58);
      points[5].lerpVectors(coxa, knee, 0.93);
      points[6].copy(knee);
      points[7].lerpVectors(knee, ankle, 0.08);
      points[8].lerpVectors(knee, ankle, 0.55);
      points[9].lerpVectors(knee, ankle, 0.94);
      points[10].copy(ankle);
      // The tarsus: five joints, arched a little off the surface, the last hooking down to its claws.
      let run = 0;
      const marks = [0.5, 1, 1.5, 2, 3, 4, 4.5, 5];
      for (let i = 0; i < 8; i++) {
        const m = marks[i];
        const whole = Math.floor(m);
        run = 0;
        for (let j = 0; j < whole; j++) run += TARSUS[j];
        if (m > whole) run += TARSUS[whole] * (m - whole);
        const u = run / TARSUS_LENGTH;
        points[11 + i].copy(ankle).addScaledVector(c, T * u).addScaledVector(normal, Math.sin(Math.PI * u) * (0.007 + 0.016 * curl) * L);
      }
      points[19].copy(foot).addScaledVector(c, 0.002);
      // A femur bows a little; so does a tibia.
      points[4].addScaledVector(pole, 0.004 * L);
      points[8].addScaledVector(pole, -0.003 * L);
      for (let i = 0; i < LEG_RINGS; i++) {
        // (Slender: a butterfly's leg is a thread beside its body.)
        radii[i] = LEG_RADII[i] * 0.68 * (0.82 + 0.18 * g);
        colours[i].copy(dark).lerp(light, i < 3 ? 0.35 : i > 10 ? 0.12 : 0.06).multiplyScalar(0.85);
      }
      // The monarch's and the paper kite's legs: black, white-spotted where they meet the body.
      if (dotted) {
        colours[4].lerp(this.markColour, 0.12);
        colours[8].lerp(this.markColour, 0.1);
      }
      if (tucked < 0.01) this.miss = Math.max(this.miss, foot.distanceTo(leg.target));
      this.tubes.write(k, points, radii, colours, LEG_RINGS);
      for (const i of [0, 2, 6, 10, 14, 18]) this.note(3 + k, points[i], radii[i]);
      // Spurs at the end of the tibia and fine spines down it and the tarsus: what a leg looks like close to.
      a.crossVectors(c, normal).normalize();
      b.subVectors(ankle, knee).normalize();
      const w4 = k - 2;
      for (let j = 0; j < 2; j++) {
        const sgn = j === 0 ? 1 : -1;
        points[0].copy(ankle).addScaledVector(b, -0.004 * L);
        points[2].copy(c).multiplyScalar(0.7).addScaledVector(a, sgn * 0.55).addScaledVector(normal, -0.25).normalize();
        points[1].copy(points[0]).addScaledVector(points[2], 0.008 * L);
        points[2].multiplyScalar(0.017 * L).add(points[0]);
        radii[0] = 0.0018;
        radii[1] = 0.0011;
        radii[2] = 0.0003;
        for (let i = 0; i < 3; i++) colours[i].copy(dark).multiplyScalar(0.7);
        this.tubes.write(20 + w4 * 2 + j, points, radii, colours, 3);
      }
      for (let j = 0; j < 6; j++) {
        const sgn = j % 2 === 0 ? 1 : -1;
        const onTibia = j < 3;
        const u = onTibia ? 0.35 + 0.22 * j : 0.15 + 0.25 * (j - 3);
        if (onTibia) points[0].lerpVectors(knee, ankle, u);
        else points[0].copy(ankle).addScaledVector(c, T * u);
        points[1].copy(onTibia ? b : c).multiplyScalar(0.75).addScaledVector(a, sgn * 0.6).addScaledVector(normal, -0.2).normalize().multiplyScalar((onTibia ? 0.011 : 0.008) * L).add(points[0]);
        radii[0] = onTibia ? 0.0015 : 0.0012;
        radii[1] = 0.0002;
        colours[0].copy(dark).multiplyScalar(0.7);
        colours[1].copy(dark).multiplyScalar(0.7);
        this.tubes.write(28 + w4 * 6 + j, points, radii, colours, 2);
      }
      // Two claws at the tip, hooked into the surface.
      for (let j = 0; j < 2; j++) {
        const w = j === 0 ? 1 : -1;
        points[0].copy(foot);
        points[1].copy(foot).addScaledVector(c, 0.005 * L).addScaledVector(a, w * 0.0035 * L).addScaledVector(normal, 0.0015 * L);
        points[2].copy(foot).addScaledVector(c, 0.009 * L).addScaledVector(a, w * 0.006 * L).addScaledVector(normal, -0.002 * L);
        points[3].copy(foot).addScaledVector(c, 0.0095 * L).addScaledVector(a, w * 0.0065 * L).addScaledVector(normal, -0.007 * L);
        radii[0] = 0.0022;
        radii[1] = 0.0017;
        radii[2] = 0.0012;
        radii[3] = 0.0003;
        for (let i = 0; i < 4; i++) colours[i].copy(dark).multiplyScalar(0.6);
        this.tubes.write(12 + (k - 2) * 2 + j, points, radii, colours, 4);
      }
    }
  }

  // ── Head ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  private writeHead() {
    const { points, radii, colours, v, w, a, pale } = this.scratch;
    const dark = this.bodyColour;
    const g = this.build.girth;
    pale.copy(this.furColour).multiplyScalar(1.5);
    // Antennae: from between the eyes, each a fine ringed shaft bending along its length, swelling into a club.
    for (let k = 0; k < 2; k++) {
      const an = this.antenna[k];
      const side = k === 0 ? 1 : -1;
      const p = v.set(side * 0.017 * g, 0.205, 0.03 * g);
      const dir = w.set(Math.sin(an.yaw) * side, Math.cos(an.yaw) * Math.cos(an.pitch), Math.cos(an.yaw) * Math.sin(an.pitch)).normalize();
      const n = 30;
      const length = 0.36 * this.build.leg;
      for (let i = 0; i < n; i++) {
        points[i].copy(p);
        const s = i / (n - 1);
        const club = Math.max(0, (s - 0.8) / 0.2);
        radii[i] = 0.0027 - 0.0005 * s + 0.0048 * Math.sin(Math.min(1, club * 1.12) * Math.PI * 0.6) * (s > 0.985 ? 0.45 : 1);
        colours[i].copy(dark).multiplyScalar(i % 2 ? 0.5 : 0.8);
        if (club > 0.55) colours[i].lerp(pale, 0.35);
        // Bend toward the back as it goes.
        a.set(dir.y, -dir.x, 0);
        if (a.lengthSq() > 1e-6) dir.applyAxisAngle(a.normalize(), (-an.curl * length) / n);
        p.addScaledVector(dir, length / (n - 1));
      }
      this.tubes.write(6 + k, points, radii, colours, n);
      for (let i = 0; i < 15; i++) this.note(9 + k, points[Math.min(n - 1, i * 2 + (i > 13 ? 1 : 0))], radii[Math.min(n - 1, i * 2 + (i > 13 ? 1 : 0))]);
    }
    // The proboscis: two halves, zipped into one coil once settled, uncurling and curling while still apart.
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? 1 : -1;
      const n = 40;
      const length = 0.33;
      let ang = -Math.PI / 2 + 0.45;
      let y = 0.149;
      let z = -0.046 * g;
      const coil = this.coil * (1 + side * this.split * 0.12);
      for (let i = 0; i < n; i++) {
        const s = i / (n - 1);
        points[i].set(side * (0.0035 + this.split * 0.012 * s), y, z);
        radii[i] = 0.0042 * (1 - s * 0.5);
        colours[i].copy(dark).multiplyScalar(0.9);
        const ds = length / (n - 1);
        ang -= coil * (32 + 230 * s * s) * ds;
        y += Math.cos(ang) * ds;
        z += Math.sin(ang) * ds;
      }
      this.tubes.write(8 + k, points, radii, colours, n);
      for (let i = 0; i < 7; i++) this.note(11 + k, points[Math.min(n - 1, Math.round(i * 6.5))], radii[Math.min(n - 1, Math.round(i * 6.5))]);
    }
    // Palps: under their fur.
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? 1 : -1;
      for (let i = 0; i < 8; i++) {
        palpPoint(side, i / 7, points[i]);
        radii[i] = palpRadius(i / 7);
        colours[i].copy(this.furColour).lerp(dark, 0.4);
      }
      this.tubes.write(10 + k, points, radii, colours, 8);
      // (With their fur: the palps' own radius and the length of the hair on them.)
      for (const i of [0, 2, 4, 6, 7]) this.note(13 + k, points[i], radii[i] + 0.013 * look.shag.value);
    }
  }

  // ── Standing and walking ──────────────────────────────────────────────────────────────────────────────────────────

  // The body's place standing at s, turned by yaw from facing along the branch: world position and quaternion.
  private stance(surface: Surface, s: number, yaw: number, sway: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion) {
    const { hold, x, y, z, a, basis } = this.scratch;
    surface(s, hold);
    const FL = this.scale;
    // Across the branch, fixed to it: T × N.
    a.crossVectors(hold.tangent, hold.normal).normalize();
    // Heading, then the body's right.
    y.copy(hold.tangent).multiplyScalar(Math.cos(yaw)).addScaledVector(a, -Math.sin(yaw));
    x.crossVectors(y, hold.normal).normalize();
    outPos.copy(hold.point).addScaledVector(hold.normal, RIDE * this.build.leg * FL).addScaledVector(x, sway * 0.007 * FL);
    // Head up a little, and rolled with the sway.
    z.copy(hold.normal).multiplyScalar(Math.cos(TILT)).addScaledVector(y, -Math.sin(TILT));
    y.multiplyScalar(Math.cos(TILT)).addScaledVector(hold.normal, Math.sin(TILT));
    z.addScaledVector(x, sway * 0.03).normalize();
    x.crossVectors(y, z).normalize();
    basis.makeBasis(x, y, z);
    outQuat.setFromRotationMatrix(basis);
  }

  // A foothold by its surface coordinates: s along the branch and w round it (as arc length from the top line).
  private foothold(surface: Surface, s: number, w: number, lift: number, outPoint: THREE.Vector3, outNormal: THREE.Vector3) {
    const { hold, a } = this.scratch;
    surface(s, hold);
    a.crossVectors(hold.tangent, hold.normal).normalize();
    const R = Math.max(hold.radius, 1e-4);
    const angle = Math.min(1.75, Math.max(-1.75, w / R));
    if (surface.length >= 3) {
      // The bark itself, relief and all: the foot goes exactly where the branch is drawn.
      surface(s, hold, angle);
      outNormal.copy(hold.normal);
      outPoint.copy(hold.point).addScaledVector(hold.normal, lift);
      return;
    }
    outNormal.copy(hold.normal).multiplyScalar(Math.cos(angle)).addScaledVector(a, Math.sin(angle));
    outPoint.copy(hold.point).addScaledVector(hold.normal, -R).addScaledVector(outNormal, R + lift);
  }

  // Where foot i belongs for the body at s and yaw: in surface coordinates.
  private home(i: number, s: number, yaw: number, out: { s: number; w: number }) {
    const side = i % 2 === 0 ? 1 : -1;
    const k = this.scale * this.build.leg;
    const f = STANCE[i >> 1][0] * k;
    // On a thin branch the feet come in to grip its upper flanks.
    const l = Math.min(STANCE[i >> 1][1] * k, this.perch.girth * 0.5) * side;
    out.s = s + f * Math.cos(yaw) + l * Math.sin(yaw);
    out.w = -f * Math.sin(yaw) + l * Math.cos(yaw);
  }
  private homeOut = { s: 0, w: 0 };

  perchFrame(surface: Surface, s: number, facing: 1 | -1, outPosition: THREE.Vector3, outQuaternion: THREE.Quaternion) {
    this.stance(surface, s, facing > 0 ? 0 : Math.PI, 0, outPosition, outQuaternion);
  }

  // Leg targets from footholds in the world, for wherever the body now is.
  private aimLegs(surface: Surface) {
    const { inv, footP, footN } = this.scratch;
    this.object.updateWorldMatrix(true, false);
    inv.copy(this.object.matrixWorld).invert();
    for (let i = 0; i < 4; i++) {
      const foot = this.perch.feet[i];
      this.foothold(surface, foot.s, foot.w, foot.lift, footP, footN);
      const leg = this.legs[i + 2];
      leg.target.copy(footP).applyMatrix4(inv);
      leg.normal.copy(footN).transformDirection(inv);
      leg.lift = 0;
      foot.settle = Math.max(0, (foot.settle ?? 0) - 0.02);
      leg.curl = 0.12 + 0.5 * smooth(foot.settle);
    }
  }

  reach(surface: Surface, s: number, facing: 1 | -1, k: number) {
    const P = this.perch;
    const yaw = facing > 0 ? 0 : Math.PI;
    surface(s, this.scratch.hold);
    P.girth = this.scratch.hold.radius;
    for (let i = 0; i < 4; i++) {
      this.home(i, s, yaw, this.homeOut);
      const foot = P.feet[i];
      foot.s = foot.homeS = this.homeOut.s;
      foot.w = foot.homeW = this.homeOut.w;
      foot.t = -1;
      foot.lift = 0;
    }
    this.aimLegs(surface);
    this.tucked = 1 - Math.min(1, Math.max(0, k));
  }

  land(surface: Surface, s: number, facing: 1 | -1) {
    const P = this.perch;
    P.surface = surface;
    P.active = true;
    this.s = s;
    this.facing = facing;
    P.yaw = P.yawFrom = P.yawTo = facing > 0 ? 0 : Math.PI;
    P.turnT = 1;
    P.speed.x = P.speed.v = 0;
    P.sway.x = P.sway.v = 0;
    P.still = 0;
    P.settle = 0;
    this.turning = false;
    this.moving = false;
    this.object.updateWorldMatrix(true, false);
    this.object.matrixWorld.decompose(P.fromPos, P.fromQuat, this.scratch.v);
    surface(s, this.scratch.hold);
    P.girth = this.scratch.hold.radius;
    for (let i = 0; i < 4; i++) {
      this.home(i, s, P.yaw, this.homeOut);
      const foot = P.feet[i];
      foot.s = foot.homeS = this.homeOut.s;
      foot.w = foot.homeW = this.homeOut.w;
      foot.t = -1;
      foot.lift = 0;
    }
  }

  release() {
    this.perch.active = false;
    this.moving = false;
    this.turning = false;
  }

  walk(dt: number, speed: number) {
    const P = this.perch;
    const surface = P.surface;
    if (!P.active || !surface) return;
    const FL = this.scale * this.build.leg;
    dt = Math.min(dt, 0.05);
    // Turning round first if asked to go the way it is not facing.
    if (!this.turning && Math.abs(speed) > 1e-4 && Math.sign(speed) !== this.facing) {
      this.turning = true;
      P.yawFrom = P.yaw;
      P.yawTo = P.yaw + (P.lastA > 0 ? Math.PI : -Math.PI);
      P.lastA = -P.lastA;
      P.turnT = 0;
    }
    if (this.turning) {
      damp(P.speed, 0, 0.14, dt);
      if (Math.abs(P.speed.x) < 0.02 * FL) P.turnT = Math.min(1, P.turnT + dt / 1.5);
      P.yaw = lerp(P.yawFrom, P.yawTo, smoother(P.turnT));
      if (P.turnT >= 1) {
        this.turning = false;
        this.facing = this.facing > 0 ? -1 : 1;
        // Keep the angle small: the same facing, a whole turn back.
        P.yaw = this.facing > 0 ? 0 : Math.PI;
      }
    } else damp(P.speed, speed, 0.3, dt);
    this.s += P.speed.x * dt;

    // Each foot's place under the body now, and how fast that place is moving over the bark.
    const trigger = (Math.abs(speed) < 1e-4 && !this.turning ? 0.03 : 0.06) * FL;
    let anySwing = false;
    const err = [0, 0, 0, 0];
    const velS = [0, 0, 0, 0];
    const velW = [0, 0, 0, 0];
    surface(this.s, this.scratch.hold);
    P.girth = this.scratch.hold.radius;
    for (let i = 0; i < 4; i++) {
      const foot = P.feet[i];
      this.home(i, this.s, P.yaw, this.homeOut);
      velS[i] = dt > 0 ? (this.homeOut.s - foot.homeS) / dt : 0;
      velW[i] = dt > 0 ? (this.homeOut.w - foot.homeW) / dt : 0;
      foot.homeS = this.homeOut.s;
      foot.homeW = this.homeOut.w;
      err[i] = Math.hypot(foot.s - foot.homeS, foot.w - foot.homeW);
    }
    // Diagonal pairs take turns: a pair lifts only while the other pair is down.
    const groups = [
      [0, 3],
      [1, 2]
    ];
    for (let gi = 0; gi < 2; gi++) {
      const mine = groups[gi];
      const other = groups[1 - gi];
      const down = (i: number) => P.feet[i].t < 0;
      if (!mine.every(down) || !other.every(down)) continue;
      const worst = Math.max(err[mine[0]], err[mine[1]]);
      const theirs = Math.max(err[other[0]], err[other[1]]);
      if (worst < trigger || worst < theirs) continue;
      for (const i of mine) {
        if (err[i] < trigger * 0.3) continue;
        const foot = P.feet[i];
        const v = Math.hypot(velS[i], velW[i]);
        foot.dur = Math.min(0.24, Math.max(0.1, (0.7 * trigger) / Math.max(v, 1e-5)));
        foot.fromS = foot.s;
        foot.fromW = foot.w;
        // Set down ahead of where it will belong, so the body walks over it.
        const lead = v > 1e-5 ? (trigger * 0.85) / v + foot.dur : 0;
        foot.toS = foot.homeS + velS[i] * lead;
        foot.toW = foot.homeW + velW[i] * lead;
        foot.t = 0;
      }
    }
    for (let i = 0; i < 4; i++) {
      const foot = P.feet[i];
      if (foot.t < 0) continue;
      foot.t += dt / foot.dur;
      if (foot.t >= 1) {
        foot.s = foot.toS;
        foot.w = foot.toW;
        foot.t = -1;
        foot.lift = 0;
        foot.small = false;
        // It settles: the tarsus hooks on, then eases.
        foot.settle = 1;
        continue;
      }
      anySwing = true;
      const k = smoother(foot.t);
      foot.s = lerp(foot.fromS, foot.toS, k);
      foot.w = lerp(foot.fromW, foot.toW, k);
      foot.lift = Math.sin(Math.PI * foot.t) ** 2 * (foot.small ? 0.022 : 0.04) * FL;
    }
    for (let i = 0; i < 4; i++) this.planted[i] = P.feet[i].t < 0;
    this.moving = anySwing;
    // Standing: now and then one foot is lifted and set down a little way off.
    if (!anySwing && Math.abs(P.speed.x) < 0.01 * FL && !this.turning) {
      P.still += dt;
      if (P.still > P.nextShuffle) {
        P.still = 0;
        P.nextShuffle = 1.6 + this.rand() * this.rand() * 7;
        const i = Math.floor(this.rand() * 4);
        const foot = P.feet[i];
        foot.fromS = foot.s;
        foot.fromW = foot.w;
        foot.toS = foot.homeS + (this.rand() - 0.5) * 0.045 * FL;
        foot.toW = foot.homeW + (this.rand() - 0.5) * 0.03 * FL;
        foot.dur = 0.34;
        foot.small = true;
        foot.t = 0;
      }
    } else P.still = 0;
    // The body leans off the lifted pair, a little.
    const lean = (P.feet[0].t >= 0 || P.feet[3].t >= 0 ? 1 : 0) - (P.feet[1].t >= 0 || P.feet[2].t >= 0 ? 1 : 0);
    damp(P.sway, lean, 0.16, dt);

    const { pos, quat } = this.scratch;
    this.stance(surface, this.s, P.yaw + this.rest.look.x, P.sway.x, pos, quat);
    if (P.settle < 1) {
      P.settle = Math.min(1, P.settle + dt / 0.28);
      const k = smoother(P.settle);
      pos.lerpVectors(P.fromPos, pos, k);
      quat.copy(this.scratch.q2.copy(P.fromQuat).slerp(quat, k));
    }
    this.setWorld(pos, quat);
    this.aimLegs(surface);
    this.tucked = 0;
  }

  // Where leg k's hip is in the world, and how far from it a foot can be set: the answer is the farthest (world
  // units); the nearest is about a sixth of that. k as in `legs`: 2 mid-right, 3 mid-left, 4 hind-right, 5 hind-left.
  legReach(k: number, outHip: THREE.Vector3) {
    const pair = k >> 1;
    const side = k % 2 === 0 ? 1 : -1;
    const g = this.build.girth;
    this.object.updateWorldMatrix(true, false);
    outHip.set(HIPS[pair][0] * side * g, HIPS[pair][1], HIPS[pair][2] * g).applyMatrix4(this.object.matrixWorld);
    return (COXA + (FEMUR + TIBIA) * 0.985 + TARSUS_LENGTH * 0.9) * this.build.leg * this.object.matrixWorld.getMaxScaleOnAxis() * 0.94;
  }
  // Whether leg k could hold a point in the world from where the body now is, without being asked to stretch or to
  // fold up on itself.
  canReach(k: number, point: THREE.Vector3) {
    const far = this.legReach(k, this.scratch.e);
    const d = this.scratch.e.distanceTo(point);
    return d < far && d > far * 0.17;
  }

  // Whether a point in the world is a fit hold for leg k from where the body now is: within reach, and on the belly
  // side of the wing roots, so that reaching for it cannot take the leg through a wing.
  holdOk(k: number, point: THREE.Vector3) {
    if (!this.canReach(k, point)) return false;
    const { v, inv } = this.scratch;
    inv.copy(this.object.matrixWorld).invert();
    v.copy(point).applyMatrix4(inv);
    const side = k % 2 === 0 ? 1 : -1;
    return v.z < 0.025 * this.build.girth && v.x * side > -0.05;
  }

  private held = Array.from({ length: 4 }, () => ({ id: NaN, t: -1, from: new THREE.Vector3(), at: new THREE.Vector3(), n: new THREE.Vector3(0, 1, 0), fromN: new THREE.Vector3(), small: false, fresh: false, detour: new THREE.Vector3(0, 0, -1), detourBy: 0.12, liftBy: 0.045, curl: { x: 0, v: 0 } as Spring }));
  // For idling on any surface you supply holds for: call every frame while it stands still; now and then (irregular,
  // a few seconds apart) it answers with a leg (0-3, as in grip's holds) that would like to shift its foot a little.
  // Give that leg a nearby hold with a new id and grip() does the small step; otherwise it answers -1.
  private fidget = { wait: 2 };
  regripDue(dt: number) {
    const F = this.fidget;
    if (this.moving) return -1;
    F.wait -= dt;
    if (F.wait > 0) return -1;
    F.wait = 1.6 + this.rand() * this.rand() * 7;
    return Math.floor(this.rand() * 4);
  }
  gripReset() {
    for (const f of this.held) {
      f.id = NaN;
      f.t = -1;
    }
  }
  // How far out of its straight path a swinging foot is, through a step (0…1).
  private arcEnv(fresh: boolean, t: number) {
    const u = Math.min(1, t / 0.8);
    return (fresh ? Math.cos((Math.PI / 2) * u) : Math.sin(Math.PI * u)) ** 2;
  }
  // Scoring the whole leg (knee, shin, tarsus) and two lift heights in the search. Measured worse than scoring the
  // foot's path alone (monarch 34 shell hits against 24, Morpho's first steps back through the pads), so it is off.
  static WHOLE_LEG = false;
  // The ways round that are tried (body space; the x is turned to the leg's own side), and the sizes.
  private static ARCS = [
    [0, 0, -1],
    [0.3, 0, -0.95],
    [0.4, 0.3, -0.85],
    [0.3, -0.4, -0.85],
    [0.9, 0, -0.42],
    [0.8, 0.5, -0.3]
  ];
  private pickArc(i: number, f: (typeof this.held)[number], h: { point: THREE.Vector3; normal: THREE.Vector3 }, clearance: (point: THREE.Vector3) => number) {
    const { a, b, c, d } = this.scratch;
    const tri = this.clashScratch.tri;
    const near = this.clashScratch.near;
    const P = this.probed;
    const FL = this.scale * this.build.leg;
    const side = i % 2 === 0 ? 1 : -1;
    const world = this.object.matrixWorld;
    const at = (k: number, v: THREE.Vector3) => v.set(P.points[k * 3], P.points[k * 3 + 1], P.points[k * 3 + 2]);
    const wings = (point: THREE.Vector3) => {
      let least = Infinity;
      if (!P.count) return least;
      for (let w = 0; w < 4; w++) {
        const first = this.wingAt[w];
        if (at(first + 24, d).distanceTo(point) > this.scale * 1.1) continue;
        for (let j = 0; j < 6; j++)
          for (let x = 0; x < 6; x++) {
            const i00 = first + j * 7 + x;
            for (let t = 0; t < 2; t++) {
              const p0 = t === 0 ? i00 : i00 + 1;
              const p1 = t === 0 ? i00 + 1 : i00 + 8;
              const p2 = i00 + 7;
              if (P.chain[p0] < 0 || P.chain[p1] < 0 || P.chain[p2] < 0) continue;
              at(p0, tri.a);
              at(p1, tri.b);
              at(p2, tri.c);
              least = Math.min(least, tri.closestPointToPoint(point, near).distanceTo(point));
            }
          }
      }
      return least;
    };
    // The leg as it would be drawn with its foot at a world point (as writeLegs does it, untucked), tested at knee,
    // mid-shin, ankle, mid-tarsus and tip, each with its own thickness: the least room any of them has.
    const k = i + 2;
    const pair = k >> 1;
    const g = this.build.girth;
    const L = this.build.leg;
    const inv = this.scratch.inv.copy(world).invert();
    const { hip, coxa, knee, ankle, foot, target, normal, pole, e: joint } = this.scratch;
    const radii = [0.012, 0.009, 0.009, 0.006, 0.004];
    const room = (point: THREE.Vector3, n: THREE.Vector3, shell: number) => {
      target.copy(point).applyMatrix4(inv);
      normal.copy(n).transformDirection(inv);
      hip.set(HIPS[pair][0] * side * g, HIPS[pair][1], HIPS[pair][2] * g);
      coxa.set(side * 0.56, pair === 1 ? 0.18 : -0.22, -0.8).normalize().multiplyScalar(COXA * L).add(hip);
      d.subVectors(target, coxa);
      d.addScaledVector(normal, -d.dot(normal));
      if (d.lengthSq() < 1e-8) d.set(side, 0, 0);
      d.normalize();
      const rise = 0.36 + 0.5 * 0.5;
      d.multiplyScalar(Math.cos(rise)).addScaledVector(normal, -Math.sin(rise));
      const T = TARSUS_LENGTH * L;
      ankle.copy(target).addScaledVector(d, -T);
      pole.set(side * 0.8, 0, 0.75).normalize();
      solveKnee(coxa, ankle, FEMUR * L, TIBIA * L, pole, knee);
      ankle.sub(knee).normalize().multiplyScalar(TIBIA * L).add(knee);
      foot.copy(ankle).addScaledVector(d, T);
      let least = Infinity;
      for (let q = 0; q < 5; q++) {
        if (q === 0) joint.copy(knee);
        else if (q === 1) joint.lerpVectors(knee, ankle, 0.5);
        else if (q === 2) joint.copy(ankle);
        else if (q === 3) joint.lerpVectors(ankle, foot, 0.5);
        else joint.copy(foot);
        joint.applyMatrix4(world);
        const r = radii[q] * this.scale;
        least = Math.min(least, (clearance(joint) - r) * shell, wings(joint) - r);
      }
      return least;
    };
    let best = -Infinity;
    let bestDir = 0;
    let bestBy = 0;
    let bestLift = 0.045;
    const sizes = [0, 0.06, 0.12];
    for (const lift of Butterfly.WHOLE_LEG ? [0.045, 0.08] : [0.045])
      for (let n = 0; n < Butterfly.ARCS.length; n++)
        for (const by of sizes) {
          if (by === 0 && n > 0) continue;
          const dir = Butterfly.ARCS[n];
          b.set(dir[0] * side, dir[1], dir[2]).transformDirection(world);
          let score = Infinity;
          for (const t of [0.2, 0.45, 0.7]) {
            const reach = smoother(Math.min(1, t / 0.55));
            c.copy(f.fromN).lerp(h.normal, reach).normalize();
            a.lerpVectors(f.from, h.point, reach)
              .addScaledVector(c, Math.sin(Math.PI * Math.min(1, t / 0.55)) ** 2 * lift * FL)
              .addScaledVector(b, this.arcEnv(f.fresh, t) * FL * by);
            // (A first step out of the tucked pose is judged mostly by the wings: the pad it passes is the nearer danger.)
            score = Math.min(score, Butterfly.WHOLE_LEG ? room(a, c, f.fresh ? 3 : 1) : Math.min(clearance(a) * (f.fresh ? 3 : 1), wings(a)));
          }
          // (The plainer step wins a tie, by a hair.)
          score -= (by + (lift - 0.045)) * 0.001 * this.scale;
          if (score > best) {
            best = score;
            bestDir = n;
            bestBy = by;
            bestLift = lift;
          }
        }
    f.liftBy = bestLift;
    const dir = Butterfly.ARCS[bestDir];
    f.detour.set(dir[0] * side, dir[1], dir[2]).normalize();
    f.detourBy = bestBy;
  }
  grip(dt: number, holds: { point: THREE.Vector3; normal: THREE.Vector3; id: number }[], clearance?: (point: THREE.Vector3) => number) {
    const { inv, v } = this.scratch;
    const H = this.held;
    dt = Math.min(dt, 0.05);
    const air = (i: number) => H[i].t >= 0;
    let any = false;
    for (let i = 0; i < 4; i++) {
      const f = H[i];
      const h = holds[i];
      if (!h) continue;
      if (Number.isNaN(f.id)) {
        f.id = h.id;
        f.at.copy(h.point);
        f.n.copy(h.normal);
      } else if (h.id !== f.id && f.t < 0) {
        // Diagonal pairs: 0 with 3, 1 with 2. Lift only while the other pair is down.
        const others = i === 0 || i === 3 ? [1, 2] : [0, 3];
        if (!air(others[0]) && !air(others[1])) {
          // (Coming from no hold at all — a negative id — there is no old foothold to step from: the foot comes in
          // from just off the new one, whatever point the unheld hold happened to carry.)
          const fresh = f.id < 0;
          f.id = h.id;
          if (fresh) {
            // It comes in along the hold's normal, but from the side away from its own forewing's root: so a leg
            // coming out to its first hold never crosses the folded pad.
            const { a, b } = this.scratch;
            a.set((i % 2 === 0 ? 1 : -1) * WING_ROOT.x * this.build.girth, WING_ROOT.y, WING_ROOT.z * this.build.girth).applyMatrix4(this.object.matrixWorld);
            a.sub(h.point).normalize();
            b.copy(h.normal).addScaledVector(a, -Math.max(0, h.normal.dot(a)) - 0.25).normalize();
            f.n.copy(h.normal);
            f.at.copy(h.point).addScaledVector(b, 0.05 * this.scale * this.build.leg);
          }
          f.from.copy(f.at);
          // A small shift of the foot (a re-grip) is a low, slow lift, not a step.
          f.small = !fresh && f.at.distanceTo(h.point) < 0.09 * this.scale * this.build.leg;
          // (A leg coming out to its first hold starts wide of the body and comes in.)
          f.fresh = fresh;
          // Round by the belly, out through the slit's own opening, unless the scene says where the shell is: then the
          // way round is chosen from several, the one that keeps the foot farthest from both shell and wings.
          f.detour.set((i % 2 === 0 ? 1 : -1) * (i < 2 ? 0.4 : 0.3), i < 2 ? 0.3 : 0, i < 2 ? -0.85 : -0.95).normalize();
          // (Used only if the scene supplies the shell's clearance: otherwise a step is the straight eased arc.)
          f.detourBy = 0;
          f.liftBy = 0.045;
          if (clearance && !f.small) this.pickArc(i, f, h, clearance);
          f.fromN.copy(f.n);
          f.t = 0;
        }
      }
      if (f.t >= 0) {
        f.t += dt / (f.small ? 0.4 : 0.46);
        if (f.t >= 1) f.t = -1;
      }
      if (f.t < 0) {
        if (h.id === f.id) {
          f.at.copy(h.point);
          f.n.copy(h.normal);
        }
      } else {
        any = true;
        const k = smoother(f.t);
        f.n.copy(f.fromN).lerp(h.normal, k).normalize();
        // It reaches over in the first half of the step, then feels for the hold: small circles closing in on it, a
        // touch, a lift, and it settles.
        const FL = this.scale * this.build.leg;
        const reach = smoother(f.small ? f.t : Math.min(1, f.t / 0.55));
        const feel = Math.max(0, (f.t - 0.45) / 0.55);
        const search = f.small ? 0 : (1 - feel) * (f.t > 0.45 ? 1 : f.t / 0.45) * 0.022 * FL;
        const tap = Math.abs(Math.sin(Math.PI * 2.5 * feel)) * (1 - feel) * 0.02 * FL;
        this.scratch.g.set(1, 0.3, 0.2).cross(f.n).normalize();
        this.scratch.h.crossVectors(f.n, this.scratch.g);
        void k;
        f.at
          .lerpVectors(f.from, h.point, reach)
          .addScaledVector(f.n, f.small ? Math.sin(Math.PI * f.t) ** 2 * 0.02 * FL : Math.sin(Math.PI * Math.min(1, f.t / 0.55)) ** 2 * f.liftBy * FL + tap)
          // (No way round unless one was chosen at lift-off, from the shell's clearance.)
          .add(
            this.scratch.e
              .copy(f.detour)
              .transformDirection(this.object.matrixWorld)
              .multiplyScalar(f.small ? 0 : this.arcEnv(f.fresh, f.t) * FL * f.detourBy)
          )
          .addScaledVector(this.scratch.g, Math.cos(f.t * 19 + i * 2) * search)
          .addScaledVector(this.scratch.h, Math.sin(f.t * 23 + i) * search);
      }
    }
    for (let i = 0; i < 4; i++) this.planted[i] = H[i].t < 0;
    this.moving = any;
    this.object.updateWorldMatrix(true, false);
    inv.copy(this.object.matrixWorld).invert();
    for (let i = 0; i < 4; i++) {
      const leg = this.legs[i + 2];
      leg.target.copy(H[i].at).applyMatrix4(inv);
      leg.normal.copy(v.copy(H[i].n)).transformDirection(inv);
      leg.lift = 0;
      // Planted, the tarsus hooks over what it holds; lifted, it straightens.
      leg.curl = damp(H[i].curl, H[i].t < 0 && !Number.isNaN(H[i].id) ? 0.85 : 0, 0.12, dt);
    }
  }

  // The object's place given in the world, whatever it hangs from.
  private setWorld(pos: THREE.Vector3, quat: THREE.Quaternion) {
    const o = this.object;
    const { inv, q } = this.scratch;
    if (o.parent) {
      o.parent.updateWorldMatrix(true, false);
      inv.copy(o.parent.matrixWorld).invert();
      o.position.copy(pos).applyMatrix4(inv);
      o.parent.getWorldQuaternion(q).invert();
      o.quaternion.copy(q).multiply(quat);
    } else {
      o.position.copy(pos);
      o.quaternion.copy(quat);
    }
    o.updateMatrix();
    o.updateWorldMatrix(false, false);
  }

  // ── Wings ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  private beatPose(phase: number, power: number, out: WingPose) {
    const sp = this.species;
    const p = phase - Math.floor(phase);
    const top = Math.min(Math.PI / 2 - 0.02, sp.stroke[0] + (power - 1) * 0.4);
    const bottom = sp.stroke[1] * Math.min(1.35, 0.4 + 0.6 * power);
    // The downstroke takes six tenths of the beat: u runs 0 (top) to 0.5 (bottom) to 1 (top) evenly through each.
    const warp = (q: number) => {
      const f = q - Math.floor(q);
      return f < 0.6 ? (f / 0.6) * 0.5 : 0.5 + ((f - 0.6) / 0.4) * 0.5;
    };
    const at = (u: number) => bottom + (top - bottom) * (0.5 + 0.5 * Math.cos(Math.PI * 2 * u));
    const u = warp(p);
    // -1 in the middle of the downstroke, +1 in the middle of the upstroke.
    const vel = -Math.sin(Math.PI * 2 * u);
    out.flap = at(u);
    // The hindwings follow a little behind the forewings, and a little below.
    out.hindLag = out.flap - at(warp(p - 0.04)) + 0.05;
    // The tips lag the roots, the trailing edge lags the leading; cupped back on the way up and into the clap.
    out.bend = -vel * 0.13 * power;
    out.twist = -vel * 0.17 * power;
    out.camber = vel < 0 ? 0.08 * -vel : -0.2 * vel - 0.06 * smooth((u - 0.85) / 0.15);
    // Feathering: leading edge down through the downstroke, flipped up fast at the bottom, held, eased out by the top.
    if (p < 0.5) out.pitch = -0.22 * Math.sin((Math.PI * p) / 0.6);
    else if (p < 0.7) out.pitch = lerp(-0.11, 0.5, smooth((p - 0.5) / 0.2));
    else out.pitch = 0.5 * Math.cos(((p - 0.7) / 0.3) * (Math.PI / 2));
    out.pitch *= Math.min(1.2, power);
    // Forewings swing forward on the way down, back on the way up.
    out.sweep = 0.08 + 0.11 * Math.sin(Math.PI * 2 * u);
    out.hindSweep = -0.08 - 0.04 * Math.sin(Math.PI * 2 * u);
    // The abdomen swings against the wings; the body noses down through the downstroke and up through the upstroke.
    out.tuck = -0.26 * Math.cos(Math.PI * 2 * u) * Math.min(1.2, power);
    out.body = -0.14 * power * Math.sin(Math.PI * 2 * u);
  }

  private glidePose(time: number, out: WingPose) {
    const sp = this.species;
    out.flap = sp.dihedral + 0.018 * Math.sin(time * 29) + 0.012 * Math.sin(time * 17.3 + 1);
    out.hindLag = 0.05;
    out.sweep = 0.2;
    out.hindSweep = -0.04;
    out.pitch = 0.05 + 0.01 * Math.sin(time * 23);
    out.bend = 0.035;
    out.twist = 0;
    out.camber = 0.06;
    out.tuck = -0.04;
    out.body = 0;
  }

  // Every helper's pose goes through here. Coming from another helper, or from the scene's own posing, the wings
  // ease over from wherever they are instead of jumping; within one helper the pose is written as it is, so a
  // wingbeat keeps its snap.
  private blend = { mode: "", t: 1, last: -1, from: wingPose(), body: 0 };
  private setWings(p: WingPose, mode: string) {
    const B = this.blend;
    const now = this.stepped ? this.stepClock : typeof performance !== "undefined" ? performance.now() / 1000 : 0;
    const dt = Math.min(0.05, Math.max(0, now - B.last));
    if (mode !== B.mode || now - B.last > 0.2) {
      const f = B.from;
      f.flap = this.flap;
      f.hindLag = this.hindLag;
      f.sweep = this.sweep;
      f.hindSweep = this.hindSweep;
      f.pitch = this.pitch;
      f.bend = live.bend.value;
      f.twist = live.twist.value;
      f.camber = live.camber.value;
      f.tuck = live.tuck.value;
      f.body = B.mode === "" ? p.body : B.body;
      B.t = B.last < 0 ? 1 : 0;
      B.mode = mode;
    }
    B.last = now;
    B.t = Math.min(1, B.t + dt / 0.4);
    const k = smoother(B.t);
    if (k < 1) for (const key of Object.keys(p) as (keyof WingPose)[]) p[key] = lerp(B.from[key], p[key], k);
    B.body = p.body;
    this.flap = p.flap;
    this.hindLag = p.hindLag;
    this.sweep = p.sweep;
    this.hindSweep = p.hindSweep;
    this.pitch = p.pitch;
    live.bend.value = p.bend;
    live.twist.value = p.twist;
    live.camber.value = p.camber;
    live.tuck.value = p.tuck;
  }

  beat(phase: number, power = 1) {
    const p = this.scratch.beat;
    this.beatPose(phase, power, p);
    this.setWings(p, "flight");
    return p.body;
  }

  glide(time: number) {
    const p = this.scratch.glide;
    this.glidePose(time, p);
    this.setWings(p, "flight");
  }

  private glideClock = 0;
  private frameDt = 1 / 60;
  private preloaded: Species | null = null;
  private shown = 0;
  private posed = NaN;
  private preen: Spring[] = [
    { x: 0, v: 0 },
    { x: 0, v: 0 }
  ];
  private clock = 0;
  private tuckedNow: Spring = { x: 1, v: 0 };
  private sleek: Spring = { x: 0, v: 0 };
  // Dev: the farthest any foot has been from its foothold since this was last zeroed (forewing lengths).
  miss = 0;
  flight(phase: number, glideK: number, power = 1) {
    const a = this.scratch.beat;
    const b = this.scratch.glide;
    this.beatPose(phase, power, a);
    this.glideClock = this.stepped ? this.stepClock : typeof performance !== "undefined" ? performance.now() / 1000 : 0;
    this.glidePose(this.glideClock, b);
    const k = smooth(glideK);
    for (const key of Object.keys(a) as (keyof WingPose)[]) a[key] = lerp(a[key], b[key], k);
    this.setWings(a, "flight");
    return a.body;
  }

  flare(k: number) {
    const t = smooth(k);
    this.flap = lerp(this.flap, 0.85, t * 0.85);
    this.pitch = lerp(this.pitch, 0.5, t);
    this.sweep = lerp(this.sweep, 0.24, t);
    this.hindSweep = lerp(this.hindSweep, -0.1, t);
    this.hindLag = lerp(this.hindLag, 0.12, t);
    live.camber.value = lerp(live.camber.value, 0.13, t);
    live.bend.value = lerp(live.bend.value, 0.06, t);
    live.tuck.value = lerp(live.tuck.value, 0.2, t);
  }

  // Start one of ACTIONS by name now (it blends in through the springs); returns false if the name is unknown.
  act(name: string) {
    const a = ACTIONS.find((x) => x.name === name);
    if (!a) return false;
    const R = this.rest;
    R.act = name;
    R.actT = 0;
    R.actFor = a.time[0] + this.rand() * (a.time[1] - a.time[0]);
    if (name === "bask") R.actFor = 2 + (1.2 + this.rand() * 2.5) * this.species.bask;
    this.acting = name;
    return true;
  }

  // How near the bark the wings come at a given opening (world units; the least over a few points of each wing), and
  // the smallest flap angle that keeps them clear of it.
  clearance = 9;
  private wingGap(flap: number, sweep: number, hindSweep: number, hindLag: number) {
    const P = this.perch;
    const surface = P.surface;
    if (!P.active || !surface) return 9;
    const { m, r, v, w, a, hold } = this.scratch;
    const g = this.build.girth;
    surface(this.s, hold);
    w.copy(hold.point);
    a.copy(hold.tangent);
    let least = 9;
    for (let k = 0; k < WING_POINTS.length; k++) {
      const [x, y, hind] = WING_POINTS[k];
      m.makeTranslation(WING_ROOT.x * g, WING_ROOT.y, WING_ROOT.z * g);
      m.multiply(r.makeRotationY(-(hind ? flap - hindLag : flap)));
      m.multiply(r.makeRotationZ(hind ? hindSweep : sweep));
      for (const side of [1, -1]) {
        v.set(x, y, 0).applyMatrix4(m);
        v.x *= side;
        v.applyMatrix4(this.object.matrixWorld);
        surface(this.s + (v.x - w.x) * a.x + (v.y - w.y) * a.y + (v.z - w.z) * a.z, hold);
        const R = Math.min(hold.radius, 50);
        const cx = hold.point.x - hold.normal.x * R - v.x;
        const cy = hold.point.y - hold.normal.y * R - v.y;
        const cz = hold.point.z - hold.normal.z * R - v.z;
        const along = cx * hold.tangent.x + cy * hold.tangent.y + cz * hold.tangent.z;
        least = Math.min(least, Math.sqrt(Math.max(0, cx * cx + cy * cy + cz * cz - along * along)) - R);
      }
    }
    return least;
  }
  private openLimit(flap: number, sweep: number, hindSweep: number, hindLag: number) {
    const need = 0.035 * this.scale;
    let f = flap;
    for (let i = 0; i < 14 && f < CLOSED; i++) {
      this.clearance = this.wingGap(f, sweep, hindSweep, hindLag);
      if (this.clearance >= need) break;
      f += 0.07;
    }
    return Math.min(f, CLOSED);
  }

  fan(times = 3) {
    const R = this.rest;
    R.fans = Math.max(1, Math.round(times));
    R.fanT = 0;
    R.bask = -1;
    // A fan takes over from whatever small thing it was doing (the springs carry it across).
    R.act = "";
    this.acting = "";
    this.fanning = true;
  }

  idle(dt: number) {
    const R = this.rest;
    const sp = this.species;
    dt = Math.min(dt, 0.05);
    R.clock += dt;
    // Fanning: a slow open, a short hold, a slow close, a pause.
    let open = 0;
    let quick = 0.12;
    let uncoil = 0;
    let lift = 0;
    const dipBy = 1;
    damp(R.room, Math.min(1, Math.max(0, this.headRoom)), 0.3, dt);
    let cleaning = 0;
    let looking = 0;
    const cycle = 2.2;
    if (R.fans > 0) {
      R.fanT += dt;
      const c = R.fanT % cycle;
      open = c < 0.75 ? smooth(c / 0.75) : c < 1.05 ? 1 : c < 1.8 ? 1 - smooth((c - 1.05) / 0.75) : 0;
      if (R.fanT >= R.fans * cycle) {
        R.fans = 0;
        this.fanning = false;
        // (Soon after: the scene fans it every so often, and its own small doings must fit in between.)
        R.nextBask = R.clock + 1.2 + this.rand() * 2.5;
      }
    } else if (R.act) {
      // One of its small doings (see ACTIONS): each shapes how far the wings open, and a few move other things.
      R.actT += dt;
      const c = R.actT;
      const env = Math.sin(Math.PI * Math.min(1, c / R.actFor)) ** 2;
      if (R.act === "bask") {
        open = c < 1.1 ? smooth(c / 1.1) : c < R.actFor - 0.9 ? 1 : 1 - smooth((c - R.actFor + 0.9) / 0.9);
      } else if (R.act === "flutter") {
        open = 0.6 * Math.sin((Math.PI * c) / 0.45) ** 2;
        quick = 0.035;
      } else if (R.act === "shiver") {
        open = (0.07 + 0.045 * Math.sin(c * 75)) * env;
        quick = 0.012;
      } else if (R.act === "pump") {
        open = (0.32 + 0.2 * Math.sin(Math.PI * 2 * c)) * smooth(c / 0.5) * smooth((R.actFor - c) / 0.5);
        quick = 0.09;
      } else if (R.act === "snap") {
        open = c > 0.05 && c < 0.3 ? 0.9 : 0;
        quick = 0.045;
      } else if (R.act === "taste") {
        uncoil = smooth(c / 0.7) * smooth((R.actFor - c) / 0.8);
      } else if (R.act === "tail") {
        lift = env * 0.28 + Math.sin(c * 15) * 0.05 * env;
      } else if (R.act === "preen") {
        if (c < dt * 1.5) R.side = this.rand() < 0.5 ? 0 : 1;
        cleaning = Math.sin(Math.PI * Math.min(1, c / R.actFor)) ** 0.6;
      } else if (R.act === "look") {
        if (c < dt * 1.5) R.side = this.rand() < 0.5 ? 0 : 1;
        looking = Math.sin((Math.PI * 2 * c) / R.actFor) * smooth(c / 0.4) * smooth((R.actFor - c) / 0.4) * (R.side ? 0.2 : -0.2) * R.room.x;
        void R.dipScale;
      }
      if (c >= R.actFor) {
        R.lastAct = R.act;
        R.act = "";
        this.acting = "";
        R.nextBask = R.clock + 1.5 + this.rand() * 3;
      }
    } else if (this.auto && R.clock > R.nextBask) {
      // Its own choice: weighted, never the same twice running; nothing wide while it is turning.
      let pick = "";
      for (let tries = 0; tries < 8 && !pick; tries++) {
        let r = this.rand() * ACTIONS.reduce((sum, a) => sum + a.weight, 0);
        for (const a of ACTIONS) {
          r -= a.weight;
          if (r <= 0) {
            if (a.name !== R.lastAct && !(this.turning && a.name === "bask")) pick = a.name;
            break;
          }
        }
      }
      if (pick) this.act(pick);
    }
    R.open = damp(R.opened, open, quick, dt);
    const wide = sp.bask * 1.3;
    // Closed, the forewings are drawn back between the hindwings; they slide forward as the wings open.
    const breath = Math.sin(R.clock * 1.3) * 0.006 + Math.sin(R.clock * 0.47) * 0.008;
    const p = R.pose;
    p.flap = CLOSED - R.open * wide + breath * (1 + R.open * 3);
    p.sweep = lerp(-0.13, 0.08, R.open);
    p.hindSweep = lerp(0.03, -0.07, R.open);
    p.hindLag = 0.015 + 0.05 * R.open;
    // Never opened so far that a wing would lie into the bark: the opening stops short of it, eased.
    p.flap = Math.max(p.flap, damp(R.floor, this.openLimit(p.flap, p.sweep, p.hindSweep, p.hindLag), 0.15, dt));
    p.pitch = 0;
    p.bend = 0.02 * R.open;
    p.twist = 0;
    p.camber = lerp(-0.035, 0.03, R.open);
    p.body = 0;
    // The abdomen held up off the bark (live.tuck below zero lifts its tip toward the back).
    const nowAt = this.stepped ? this.stepClock : typeof performance !== "undefined" ? performance.now() / 1000 : 0;
    const stale = nowAt - R.last > 0.2;
    R.last = nowAt;
    if (stale) {
      // Picking up from whatever posed it last: the springs start where things are.
      R.tuck.x = live.tuck.value;
      R.tuck.v = 0;
      for (let k = 0; k < 2; k++) {
        R.feelers[k * 3].x = this.antenna[k].yaw;
        R.feelers[k * 3 + 1].x = this.antenna[k].pitch;
        R.feelers[k * 3 + 2].x = this.antenna[k].curl;
        R.feelers[k * 3].v = R.feelers[k * 3 + 1].v = R.feelers[k * 3 + 2].v = 0;
      }
    }
    // The abdomen breathes; walking, it pumps a little with the steps.
    p.tuck = damp(R.tuck, -0.3 - lift, 0.2, dt) + Math.sin(R.clock * 2.1) * 0.012 + R.stir.x * Math.sin(R.clock * 8.5) * 0.02;
    this.setWings(p, "idle");
    damp(R.look, this.moving || this.turning ? 0 : looking, 0.25, dt);
    // Tasting the bark: the tongue let out and drawn back in.
    this.coil = damp(R.coil, 1 - 0.78 * uncoil, 0.18, dt);
    this.split = 0;
    // Antennae: a slow wander each on its own, and now and then one dips and comes back.
    if (R.clock > R.nextTwitch) {
      R.twitch[this.rand() < 0.5 ? 0 : 1] = 0;
      R.nextTwitch = R.clock + 1.8 + this.rand() * 5;
    }
    for (let k = 0; k < 2; k++) {
      const an = this.antenna[k];
      let dip = 0;
      if (R.twitch[k] >= 0) {
        R.twitch[k] += dt / 0.7;
        dip = Math.sin(Math.PI * Math.min(1, R.twitch[k])) ** 2 * dipBy;
        if (R.twitch[k] >= 1) R.twitch[k] = -1;
      }
      const drift = Math.sin(R.clock * (0.6 + k * 0.17) + k * 2) * 0.06 + Math.sin(R.clock * 2.3 + k) * 0.015;
      const clean = k === R.side ? cleaning : 0;
      damp(this.preen[k], clean > 0.2 ? 1 : 0, 0.16, dt);
      dip += clean * (1.15 + 0.12 * Math.sin(R.clock * 11));
      dip *= R.room.x;
      // They nod a little with each step while it walks.
      const stir = k === 0 ? damp(R.stir, this.moving ? 1 : 0, 0.2, dt) : R.stir.x;
      an.yaw = damp(R.feelers[k * 3], 0.3 + drift * 0.6 + dip * 0.08 + stir * Math.sin(R.clock * 9 + k * 3) * 0.02, 0.09, dt);
      an.pitch = damp(R.feelers[k * 3 + 1], 0.52 + drift + dip * 0.4, 0.09, dt);
      an.curl = damp(R.feelers[k * 3 + 2], 0.42 + dip * 0.25, 0.09, dt);
    }
  }

  // ── Probe ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  private cap = { n: 0, at: new Float32Array(220 * 3), r: new Float32Array(220), chain: new Int16Array(220) };
  private note(chain: number, p: THREE.Vector3, r: number) {
    const C = this.cap;
    if (C.n >= 220) return;
    C.at[C.n * 3] = p.x;
    C.at[C.n * 3 + 1] = p.y;
    C.at[C.n * 3 + 2] = p.z;
    C.r[C.n] = r;
    C.chain[C.n++] = chain;
  }
  private probed = { count: 0, points: new Float32Array(700 * 3), radius: new Float32Array(700), chain: new Int16Array(700) };
  // Which cells of each wing tile are wing: 7×7 per tile, read once from the atlas' alpha.
  private outline: Uint8Array | null = null;
  private readOutline() {
    const image = atlas.image as HTMLImageElement | undefined;
    if (!image || !image.width || typeof document === "undefined") return;
    const n = 7 * 4;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = n * 4;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    if (!g) return;
    g.drawImage(image, 0, 0, n * 4, n * 4);
    const data = g.getImageData(0, 0, n * 4, n * 4).data;
    // Sample i of 7 sits at tile coordinate i / 6: read the nearest of the 28 pixels across a tile.
    const out = new Uint8Array(4 * 4 * 49);
    for (let col = 0; col < 4; col++)
      for (let row = 0; row < 4; row++)
        for (let j = 0; j < 7; j++)
          for (let i = 0; i < 7; i++) {
            const px = col * 28 + Math.min(27, Math.round((i / 6) * 27));
            const py = row * 28 + Math.min(27, Math.round((j / 6) * 27));
            out[(col * 4 + row) * 49 + j * 7 + i] = data[(py * n * 4 + px) * 4 + 3] > 20 ? 1 : 0;
          }
    this.outline = out;
  }

  // Where each wing's 7×7 grid starts in the probe's arrays.
  private wingAt = [0, 0, 0, 0];
  private clashScratch = { ray: new THREE.Ray(), tri: new THREE.Triangle(), a: new THREE.Vector3(), b: new THREE.Vector3(), hit: new THREE.Vector3(), near: new THREE.Vector3() };
  private clashOut = { count: 0, worst: 0, leg: -1, wing: -1 };
  // Each wing triangle's centre and reach (x, y, z, radius; radius -1 where the triangle is outside the outline).
  private clashTri = new Float64Array(4 * 72 * 4);
  // Legs against wings, as drawn this frame: every leg segment (all six legs, hip to tarsus tip, with its thickness)
  // against the triangles of each wing's grid. Call after update(). count: how many segment-triangle pairs touch or
  // cross; worst: the deepest, in forewing lengths; leg (0-5) and wing (0 fore R, 1 fore L, 2 hind R, 3 hind L) of it.
  selfClash() {
    const P = this.probe();
    const { ray, tri, a, b, hit, near } = this.clashScratch;
    const out = this.clashOut;
    out.count = 0;
    out.worst = 0;
    out.leg = out.wing = -1;
    const k = this.object.matrixWorld.getMaxScaleOnAxis() || 1;
    const at = (i: number, v: THREE.Vector3) => v.set(P.points[i * 3], P.points[i * 3 + 1], P.points[i * 3 + 2]);
    // A ball round every triangle, once: a leg segment whose own ball cannot touch it is passed over untested. (It
    // could not have crossed or come within its thickness of that triangle, so nothing counted is ever skipped.)
    const T = this.clashTri;
    for (let w = 0; w < 4; w++) {
      const first = this.wingAt[w];
      for (let j = 0; j < 6; j++)
        for (let x = 0; x < 6; x++)
          for (let t = 0; t < 2; t++) {
            const i00 = first + j * 7 + x;
            const p0 = t === 0 ? i00 : i00 + 1;
            const p1 = t === 0 ? i00 + 1 : i00 + 8;
            const p2 = i00 + 7;
            const o = (((w * 6 + j) * 6 + x) * 2 + t) * 4;
            if (P.chain[p0] < 0 || P.chain[p1] < 0 || P.chain[p2] < 0) {
              T[o + 3] = -1;
              continue;
            }
            const cx = (P.points[p0 * 3] + P.points[p1 * 3] + P.points[p2 * 3]) / 3;
            const cy = (P.points[p0 * 3 + 1] + P.points[p1 * 3 + 1] + P.points[p2 * 3 + 1]) / 3;
            const cz = (P.points[p0 * 3 + 2] + P.points[p1 * 3 + 2] + P.points[p2 * 3 + 2]) / 3;
            let far = 0;
            for (let q = 0; q < 3; q++) {
              const pq = q === 0 ? p0 : q === 1 ? p1 : p2;
              far = Math.max(far, Math.hypot(P.points[pq * 3] - cx, P.points[pq * 3 + 1] - cy, P.points[pq * 3 + 2] - cz));
            }
            T[o] = cx;
            T[o + 1] = cy;
            T[o + 2] = cz;
            T[o + 3] = far;
          }
    }
    for (let i = 0; i + 1 < P.count; i++) {
      const leg = P.chain[i];
      if (leg < 3 || leg > 8 || P.chain[i + 1] !== leg) continue;
      at(i, a);
      at(i + 1, b);
      const r = Math.max(P.radius[i], P.radius[i + 1]);
      const length = a.distanceTo(b);
      if (length < 1e-7) continue;
      ray.origin.copy(a);
      ray.direction.subVectors(b, a).divideScalar(length);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const mz = (a.z + b.z) / 2;
      // (A hair over, for rounding.)
      const span = length / 2 + r + 1e-6 * k;
      for (let w = 0; w < 4; w++) {
        const first = this.wingAt[w];
        // Nowhere near this wing: its middle sample and a generous reach.
        at(first + 24, hit);
        if (hit.distanceTo(a) > k * 1.1 + length) continue;
        for (let j = 0; j < 6; j++)
          for (let x = 0; x < 6; x++) {
            const i00 = first + j * 7 + x;
            const i10 = i00 + 1;
            const i01 = i00 + 7;
            const i11 = i01 + 1;
            for (let t = 0; t < 2; t++) {
              const p0 = t === 0 ? i00 : i10;
              const p1 = t === 0 ? i10 : i11;
              const p2 = i01;
              const o = (((w * 6 + j) * 6 + x) * 2 + t) * 4;
              const far = T[o + 3];
              if (far < 0) continue;
              const ex = T[o] - mx;
              const ey = T[o + 1] - my;
              const ez = T[o + 2] - mz;
              if (ex * ex + ey * ey + ez * ez > (far + span) * (far + span)) continue;
              at(p0, tri.a);
              at(p1, tri.b);
              at(p2, tri.c);
              let depth = -1;
              const crossed = ray.intersectTriangle(tri.a, tri.b, tri.c, false, hit);
              if (crossed && a.distanceTo(hit) <= length) depth = r + Math.min(a.distanceTo(hit), b.distanceTo(hit));
              else {
                const da = tri.closestPointToPoint(a, near).distanceTo(a);
                const db = tri.closestPointToPoint(b, near).distanceTo(b);
                const d = Math.min(da, db);
                if (d < r * 0.85) depth = r - d;
              }
              if (depth > 0) {
                out.count++;
                if (depth / k > out.worst) {
                  out.worst = depth / k;
                  out.leg = leg - 3;
                  out.wing = w;
                }
              }
            }
          }
      }
    }
    return out;
  }

  probe() {
    const P = this.probed;
    const C = this.cap;
    const { v, m } = this.scratch;
    const world = this.object.matrixWorld;
    const k = world.getMaxScaleOnAxis();
    let n = 0;
    const put = (chain: number, r: number) => {
      v.applyMatrix4(world);
      P.points[n * 3] = v.x;
      P.points[n * 3 + 1] = v.y;
      P.points[n * 3 + 2] = v.z;
      P.radius[n] = r * k;
      P.chain[n++] = chain;
    };
    // The spine, as body.ts places it: girth, the swollen abdomen, its bend.
    const g = this.build.girth;
    const swell = live.swell.value;
    const tuck = live.tuck.value;
    const top = 0.21;
    const tail = JOINT - ABDOMEN + 0.004;
    for (let i = 0; i < 16; i++) {
      const y = top + (tail - top) * (i / 15);
      const a = y < JOINT ? Math.min(1, (JOINT - y) / ABDOMEN) : 0;
      const fat = 1 + swell * 0.6 * Math.pow(Math.sin(a * Math.PI), 0.6);
      const long = a > 0 ? this.build.long * (1 + swell * 0.18) : 1;
      const ly = (y - JOINT) * long;
      v.set(0, ly * Math.cos(tuck * a) + JOINT, ly * Math.sin(tuck * a));
      put(0, bodyRadius(y) * g * fat);
    }
    this.eyes.forEach((eye, i) => {
      v.copy(eye.position);
      put(1 + i, Math.abs(eye.scale.y));
    });
    // The head itself, densely: skull, crown, face and both cheeks, bare (chain 15) and out to the tips of its fur
    // (chain 16). Radii are true: the skull's, times the species' girth.
    const hr = 0.046 * g;
    const fur = 0.03 * look.shag.value;
    for (const [hx, hy, hz, hk] of HEAD_POINTS) {
      v.set(hx * g, 0.166 + hy, 0.004 + hz * g);
      put(15, hr * hk);
    }
    for (const [hx, hy, hz, hk] of HEAD_POINTS) {
      v.set(hx * g, 0.166 + hy, 0.004 + hz * g);
      put(16, hr * hk + fur);
    }
    for (let i = 0; i < C.n; i++) {
      v.set(C.at[i * 3], C.at[i * 3 + 1], C.at[i * 3 + 2]);
      put(C.chain[i], C.r[i]);
    }
    // The wings: what the vertex shader does, without its noise.
    if (!this.outline) this.readOutline();
    const expand = live.expand.value;
    const crumple = live.crumple.value;
    const pack = live.pack.value;
    const column = Math.round(live.column.value);
    for (let w = 0; w < 4; w++) {
      const hind = w > 1;
      const frame = hind ? look.hind.value : look.fore.value;
      m.multiplyMatrices(world, live.wing[w].value);
      const first = n;
      this.wingAt[w] = first;
      for (let j = 0; j < 7; j++)
        for (let i = 0; i < 7; i++) {
          const x0 = frame.x + (i / 6) * frame.z;
          const y0 = frame.y - (j / 6) * frame.z;
          const r = Math.hypot(x0, y0);
          const e = Math.min(1, Math.max(0, expand * 1.5 - r * 0.5));
          const stub = 0.39 - 0.18 * pack;
          const along = stub + (1 - stub) * Math.pow(e, 0.7);
          // (The hindwing's gutter beside the abdomen, as in the shader.)
          const sst = (a: number, b: number, t: number) => smooth((t - a) / (b - a));
          const gutter = hind ? sst(0.17, 0, x0) * sst(-0.03, -0.3, y0) * look.shut.value * e : 0;
          const x = x0 * along - gutter * 0.055;
          const y = y0 * along;
          const rr = r * along;
          const chord = x * 0.62 - y * 0.78;
          const z = live.bend.value * rr * rr + live.twist.value * rr * chord + live.camber.value * chord * chord * (hind ? 0.6 : 1) + (hind ? -0.004 : 0.004) - gutter * 0.012 - live.wet.value * 0.05 * rr * rr;
          const wrinkle = crumple * ((1 - e) * 0.85 + 0.15) * (1 - 0.65 * pack);
          v.set(x, y, z).applyMatrix4(m);
          P.points[n * 3] = v.x;
          P.points[n * 3 + 1] = v.y;
          P.points[n * 3 + 2] = v.z;
          P.radius[n] = wrinkle * (0.091 + r * 0.05) * k;
          const inside = !this.outline || this.outline[(column * 4 + (hind ? 2 : 0)) * 49 + j * 7 + i] === 1;
          P.chain[n++] = inside ? 20 + 20 * w + j : -1;
        }
      // Again by column.
      for (let i = 0; i < 7; i++)
        for (let j = 0; j < 7; j++) {
          const from = first + j * 7 + i;
          P.points[n * 3] = P.points[from * 3];
          P.points[n * 3 + 1] = P.points[from * 3 + 1];
          P.points[n * 3 + 2] = P.points[from * 3 + 2];
          P.radius[n] = P.radius[from];
          P.chain[n++] = P.chain[from] < 0 ? -1 : 30 + 20 * w + i;
        }
    }
    P.count = n;
    return P;
  }

  // ── Dev studio ────────────────────────────────────────────────────────────────────────────────────────────────────

  private studioOf() {
    if (typeof window === "undefined") return null;
    const hook = (globalThis as Record<string, unknown>).__bfly as { rig: Butterfly; studio: Studio | null; hide: Record<string, boolean> } | undefined;
    if (!hook || hook.rig !== this) return null;
    const hide = hook.hide || {};
    this.fur.visible = !hide.fur;
    this.wings.visible = !hide.wings && !wingsWaiting();
    this.glass.visible = !hide.wings && !hide.glass && this.species.glass > 0 && !wingsWaiting();
    return hook.studio;
  }

  // Dev: the scene's own branch, bark and all (studio.real).
  private realSurface: Surface = (s, out, phi) => {
    if (phi === undefined) branchPath(s, out);
    else branchSurface(s, phi, out);
  };
  private studioSurface: Surface = (s, out) => {
    const hook = (globalThis as Record<string, unknown>).__bfly as { studio: Studio };
    const st = hook.studio;
    const turn = st.turn ?? 0;
    out.tangent.set(Math.cos(turn), 0, -Math.sin(turn));
    out.normal.set(0, 1, 0);
    out.point.set(st.at[0], st.at[1], st.at[2]).addScaledVector(out.tangent, s);
    out.radius = st.radius ?? 0.16;
  };

  // The scene's uniforms as the studio wants them (species, fresh or dry), set again just before drawing.
  private studioLook() {
    const st = this.studioOf();
    if (!st) return;
    const sp = SPECIES[st.species ?? "morpho"];
    live.column.value = sp.column;
    live.fore.value.set(...sp.fore);
    live.hind.value.set(...sp.hind);
    live.structure.value = sp.structure;
    live.peak.value = sp.peak;
    live.through.value = sp.through;
    live.body.value.set(sp.body);
    live.fur.value.set(sp.fur);
    live.hidden.value = 0;
    const fresh = st.mode === "fresh";
    live.expand.value = fresh ? (st.expand ?? 0.3) : 1;
    live.crumple.value = fresh ? 1 - smooth(((st.expand ?? 0.3) - 0.15) / 0.85) : 0;
    live.wet.value = fresh && !st.dry ? 1 : 0;
    live.pack.value = st.pack ?? 0;
    live.swell.value = fresh ? 1 - (st.expand ?? 0.3) : 0;
  }

  private runStudio() {
    const st = this.studioOf();
    const S = this.studio;
    if (S.branch) S.branch.visible = !!st && st.branch !== false && !st.real && st.mode !== "fly" && st.mode !== "glide" && st.mode !== "fresh";
    if (!st) {
      S.key = "";
      return;
    }
    const now = performance.now() / 1000;
    const dt = Math.min(0.05, Math.max(0, now - S.last));
    S.last = now;
    S.clock += dt;
    const sp = SPECIES[st.species ?? "morpho"];
    if (this.species !== sp) this.setSpecies(sp);
    if (st.preload && SPECIES[st.preload] !== this.preloaded) this.preload((this.preloaded = SPECIES[st.preload]));
    // The scene has posed it this frame too: put back what the studio last showed, so its own blends start from there.
    const shown = this.studio.shown;
    if (S.key !== "") {
      this.flap = shown.flap;
      this.hindLag = shown.hindLag;
      this.sweep = shown.sweep;
      this.hindSweep = shown.hindSweep;
      this.pitch = shown.pitch;
      this.fold = shown.body;
      live.bend.value = shown.bend;
      live.twist.value = shown.twist;
      live.camber.value = shown.camber;
      live.tuck.value = shown.tuck;
    }
    this.studioLook();
    this.object.visible = true;
    this.object.scale.setScalar(sp.wing);
    const perched = st.mode !== "fly" && st.mode !== "glide" && st.mode !== "fresh";
    const key = `${st.species}|${st.at.join(",")}|${st.turn ?? 0}|${perched}|${!!st.real}`;
    // A plain branch to stand on.
    if (!S.branch) {
      S.branch = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 24, 1), new THREE.MeshStandardMaterial({ color: "#4a3a2c", roughness: 0.95 }));
      let root: THREE.Object3D = this.object;
      while (root.parent) root = root.parent;
      root.add(S.branch);
    }
    const R = st.radius ?? 0.16;
    S.branch.scale.set(R, 12, R);
    S.branch.rotation.set(0, st.turn ?? 0, Math.PI / 2);
    S.branch.position.set(st.at[0], st.at[1] - R, st.at[2]);
    const { pos, quat, q2, v } = this.scratch;
    if (st.mode !== "fresh") this.fold = 0;
    if (perched) {
      if (key !== S.key || !this.perch.active) {
        this.land(st.real ? this.realSurface : this.studioSurface, 0, 1);
        this.perch.settle = 1;
      }
      let speed = 0;
      if (st.mode === "walk") {
        const pace = st.speed ?? sp.pace;
        const span = 1.2 * sp.wing;
        speed = this.s > span ? -pace : this.s < -span ? pace : this.facing * pace;
      }
      this.walk(dt, speed);
      this.idle(dt);
      if (st.mode === "open") this.rest.opened.x = st.open ?? 1;
      if (st.mode === "closed") this.rest.opened.x = 0;
      if (st.mode === "open" || st.mode === "closed") {
        this.rest.fans = 0;
        this.rest.bask = -1;
        this.rest.nextBask = 1e9;
      } else if (st.mode === "fan" && !this.fanning) this.fan(3);
      if (st.act && !this.acting) this.act(st.act);
      if (st.mode !== "open" && st.mode !== "closed" && this.rest.nextBask > 1e8) this.rest.nextBask = this.rest.clock + 1;
    } else {
      this.release();
      const pitch = st.pitch ?? (st.mode === "fresh" ? Math.PI / 2 : 0.5);
      const phase = st.phase ?? S.clock * sp.beat * 0.25;
      let rock = 0;
      if (st.mode === "fresh") {
        const e = st.expand ?? 0.3;
        this.flap = CLOSED - 0.005;
        this.fold = st.fold ?? 2.45 - 0.25 * e - 1.95 * smooth((e - 0.9) / 0.1);
        this.sweep = -0.05;
        this.hindSweep = -0.12;
        this.pitch = 0;
        this.hindLag = 0.04;
        live.bend.value = 0;
        live.twist.value = 0;
        live.camber.value = 0;
        live.tuck.value = 0;
        this.tucked = 0.6;
      } else {
        rock = this.flight(phase, st.mode === "glide" ? 1 : 0, 1);
        this.tucked = 1;
      }
      v.set(st.at[0], st.at[1], st.at[2]);
      // Heading along +x turned by yaw, nose up by pitch.
      quat.setFromAxisAngle(this.scratch.x.set(0, 1, 0), (st.yaw ?? 0) - Math.PI / 2);
      q2.setFromAxisAngle(this.scratch.x.set(1, 0, 0), -Math.PI / 2 + pitch + rock);
      quat.multiply(q2);
      pos.copy(v);
      this.setWorld(pos, quat);
    }
    S.key = key;
    shown.flap = this.flap;
    shown.hindLag = this.hindLag;
    shown.sweep = this.sweep;
    shown.hindSweep = this.hindSweep;
    shown.pitch = this.pitch;
    shown.body = this.fold;
    shown.bend = live.bend.value;
    shown.twist = live.twist.value;
    shown.camber = live.camber.value;
    shown.tuck = live.tuck.value;
  }
}

// A two-bone chain from a to c with fixed lengths, bending toward the pole.
const K = { d: new THREE.Vector3(), dir: new THREE.Vector3(), perp: new THREE.Vector3() };
function solveKnee(a: THREE.Vector3, c: THREE.Vector3, l1: number, l2: number, pole: THREE.Vector3, out = new THREE.Vector3()) {
  const { d, dir, perp } = K;
  d.subVectors(c, a);
  let dist = d.length();
  if (dist > 1e-6) dir.copy(d).divideScalar(dist);
  else dir.set(0, -1, 0);
  dist = Math.min(Math.max(dist, Math.abs(l1 - l2) + 1e-4), (l1 + l2) * 0.999);
  const cosA = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  perp.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (perp.lengthSq() < 1e-8) perp.set(0, 0, 1).addScaledVector(dir, -dir.z);
  perp.normalize();
  return out.copy(a).addScaledVector(dir, l1 * cosA).addScaledVector(perp, l1 * sinA);
}

export { solveKnee };
