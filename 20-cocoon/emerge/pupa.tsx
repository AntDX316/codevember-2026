"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  abs,
  attribute,
  cameraPosition,
  clamp,
  color,
  cos,
  cross,
  dFdx,
  dFdy,
  dot,
  exp,
  float,
  floor,
  length,
  max,
  min,
  mix,
  modelWorldMatrix,
  mx_fractal_noise_float,
  mx_noise_float,
  mx_noise_vec3,
  mx_worley_noise_float,
  normalLocal,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  reflect,
  sin,
  smoothstep,
  sqrt,
  step,
  texture as textureNode,
  time,
  uniform,
  varying,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { useDispose } from "../../shared/engine/dispose";
import { useSetting } from "../../shared/engine/settings";
import { sky } from "../../14-tension/backdrop";
import { skyAt, useSkyBake } from "./sky";
import { makeMotes } from "./dust";
import { atlasNode, live } from "./live";
import { makeDew } from "./shell-dew";
import { BEND, CASE, MARK_H, MARK_W, SHAPES, buildPupa, markTexture, openAngles, partLine, shapeOf, warmShell, type ShellKey } from "./shell-shape";
import { SPECIES, SPECIES_NAMES, type SpeciesName } from "./species";

export { STALK, WALL, buildPupa, caseMap, cavity, hingeAt, lidHalfAngle, openAngles, pieceProbe, posePoint, pupaAxis, pupaPoint, rimPoints, shellProbe, shellSurface, splitAt, unposePoint, type Piece, type Probe } from "./shell-shape";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The chrysalis, hanging head down from its cremaster, after macro photographs of the real ones: each species its own
// silhouette, creases and markings (shell-shape.ts), one material for all.
//
// FOR THE SCENE (index.tsx):
//   const pupa = usePupa(fine)       -> { groups, pivots, material } as before (pivots: 0 abdomen, 1 lid, 2 and 3 sides)
//   pupa.grow(g)                     g 0..1: the chrysalis forms from a small wet green drop under the pad, swells,
//                                    lengthens and hardens into its shape, its markings coming last. All in the shader:
//                                    call it INSTEAD of scaling the hang group. About 3.5 s of linear g reads well.
//   GROW_STAGES                      what g shows, stage by stage, for the day counter.
//   pupa.dropShell()                 the empty shell lets go of the silk: a moment hanging by its last hooks, then it
//                                    falls, tumbling and fluttering, under gravity and air drag (DROP below, in scene
//                                    units, slowed as a macro film is). It advances itself every frame.
//   pupa.dropped                     true once it is well out of frame (about 1.6 s after dropShell).
//   pupa.resetDrop()                 puts the shell back under the pad (also done by grow(g) with g < 0.5 after a drop).
//   The cremaster stalk is part of the shell (piece 0), from the pod's origin up to the pad STALK above it, so it falls
//   with the shell: do not add a separate stalk.
//   The look (Wax, Glass, Dew) is the `emergeShell` setting, read here; SHELL_OPTIONS are its options.
//   pupaAxis(sp, t) gives the centreline (the glasswing's is hunched, its head end pointing forward and down).
//
// KEEPING THE BUTTERFLY INSIDE THE WALLS (all CPU, in the pod's space, per species):
//   cavity(sp, t)                    the hollow at t: { point, direction } of the centreline and the clear half-widths
//                                    { side, front (ventral, the lid's side), back } with the wall taken off.
//   shellProbe(sp, p)                against the closed shell: { t, u, d, piece }, d the distance outside the outer
//                                    surface (inside the hollow when d < -WALL * sp.pupa), piece the one (t, u) is on.
//   pieceProbe(sp, p, pivots)        the same against the pieces as posed now (pass pupa.pivots[name]): the nearest wall
//                                    actually there; piece -1 when the point faces only the opening. A body point that
//                                    should be inside pokes through when piece >= 0 and d > -WALL * sp.pupa.
//   rimPoints(sp, pivots, n)         the opening's rim now: { right, left } down the side pieces' torn ventral edges and
//                                    { abdomen } round the abdomen's lower edge.
//   lidHalfAngle(t)                  half the angle the lid spans round u = 0 (0.5 rad, widening to 0.78 at the head).
//   HOW THE PIECES OPEN: the pivots are only handles. Turn them as before (lid: rotation.x = -angle; sides:
//   rotation.z = +-angle) and the pieces bend open by those angles like petals, joined to the abdomen along the tear
//   line for good (shell-shape.ts has the rule). So a rest point is NOT at hinge + q * (r - hinge) any more:
//   posePoint(sp, pivots, t, u, point, normal?)   carries a rest point of the shell at (t, u) to where it is drawn;
//   unposePoint(sp, pivots, piece, point, out)    carries a pod-space point back to piece's rest place (pieceProbe
//                                                 and rimPoints already do this);
//   shellSurface(sp, t, u, pivots | null, out)    out.point and out.normal on the outside of the shell or a flap as
//                                                 drawn now (null: the closed shell), for feet to hold.
//   These follow the angles asked for; the drawn pieces reach them on a soft spring (a tenth of overshoot, settled in
//   about half a second). pupa.nudge(strength) knocks the open pieces so they tremble and settle again.
//   The sides bend less toward the back (0.4 of the angle at the dorsal midline); the lid past about 2 rad curls back
//   onto the abdomen.
//
// The shell is alpha-blended rather than transmissive, so nothing is rendered twice for it: whole, it is opaque and its
// depth is faked in the shading (light through it from behind, absorbed by its thickness and shadowed by the butterfly
// folded inside); empty, it is truly see-through, paper-thin and crinkled.

export type ShellLook = "wax" | "glass" | "dew";
export const SHELL_OPTIONS: { value: ShellLook; label: string; short: string }[] = [
  { value: "wax", label: "Wax", short: "Wax" },
  { value: "glass", label: "Glass", short: "Glass" },
  { value: "dew", label: "Dew", short: "Dew" }
];

// Kept for whoever read the old grooves: the Morpho's.
export const GROOVES = SHAPES.morpho.grooves;

// What pupa.grow(g) shows at each g, for a counter to agree with: [from, to, what].
export const GROW_STAGES: [number, number, string][] = [
  [0, 0.06, "a wet bead gathers under the silk pad"],
  [0.06, 0.35, "it swells into a round, glistening drop"],
  [0.35, 0.6, "it lengthens, soft and rippling"],
  [0.6, 0.8, "it hardens into its shape: the creases and the wing cases set, the colour deepens"],
  [0.8, 1, "its markings come (gold, spots, mirror bars) and the gloss settles; dew last"]
];

// The fall of the empty shell, in scene units and seconds: how long it hangs by its last hooks, gravity, the speed at
// which the air holds it (an empty shell weighs a few milligrams), and how far below the pad it counts as gone.
export const DROP = { hold: 0.35, gravity: 14, terminal: 4.2, out: 4.5 };

// What the shell's shaders follow besides `live`: the look, the species' colours, growth.
export const shell = {
  grow: uniform(1),
  // The look: roughness of the cuticle, how glassy (thin, clear, deep) and how wet with dew.
  rough: uniform(0.36),
  glass: uniform(0),
  wet: uniform(0),
  // The species.
  base: uniform(new THREE.Color()),
  deep: uniform(new THREE.Color()),
  pale: uniform(new THREE.Color()),
  glow: uniform(new THREE.Color()),
  absorb: uniform(new THREE.Vector3(1, 1, 1)),
  metal: uniform(0),
  metalTint: uniform(new THREE.Color()),
  stalk: uniform(new THREE.Color()),
  horn: uniform(0),
  tile: uniform(0),
  length: uniform(0.64),
  split: uniform(0.45),
  // How wet its gloss (multiplies the look's roughness), how far it silvers as it clears, and its empty shell.
  sheen: uniform(1),
  chrome: uniform(0),
  husk: uniform(new THREE.Color()),
  paper: uniform(0),
  // Once it has cracked, the pieces that open are already empty film (the butterfly is on its way out of them).
  vacate: uniform(0),
  // How far down the case (its t, 0 at the stalk) the body has drawn itself out: empty above, -1 while it has not begun.
  front: uniform(-1),
  // How far each piece is bent open, as drawn (sprung toward what the scene asks): lid, right side, left side.
  open: uniform(new THREE.Vector3()),
  // The line the sides part round: the centreline where the shell tears.
  spineP: uniform(new THREE.Vector3()),
  spineD: uniform(new THREE.Vector3(0, -1, 0))
};

type Palette = { base: string; deep: string; pale: string; glow: string; absorb: [number, number, number]; metal: number; metalTint: string; stalk: string; sheen: number; chrome: number; husk: string; paper: number };
const PALETTE: Record<ShellKey, Palette> = {
  morpho: { base: "#76b552", deep: "#3d8540", pale: "#b3d6a0", glow: "#cdea62", absorb: [1.7, 0.28, 2.6], metal: 0, metalTint: "#ffffff", stalk: "#9a6c2c", sheen: 1.1, chrome: 0, husk: "#e9e6b8", paper: 0.5 },
  monarch: { base: "#8ccb92", deep: "#5cab78", pale: "#b9e2b4", glow: "#d2f08e", absorb: [1.9, 0.3, 1.7], metal: 0, metalTint: "#ffcf52", stalk: "#0b0a09", sheen: 0.55, chrome: 0, husk: "#e8eee0", paper: 0 },
  glasswing: { base: "#7fcf34", deep: "#4c9f2a", pale: "#a3e052", glow: "#dcff6a", absorb: [1.3, 0.16, 3.2], metal: 0, metalTint: "#fff3e6", stalk: "#15120e", sheen: 0.45, chrome: 0.75, husk: "#eef2ea", paper: 0 },
  paperkite: { base: "#e9b821", deep: "#bb7d10", pale: "#f8dc5a", glow: "#ffdc50", absorb: [0.2, 0.5, 3.2], metal: 0.85, metalTint: "#ffd869", stalk: "#0b0a09", sheen: 0.55, chrome: 0, husk: "#efd9a0", paper: 0.45 }
};

const LOOKS: Record<ShellLook, { rough: number; glass: number; wet: number }> = {
  wax: { rough: 0.36, glass: 0, wet: 0 },
  glass: { rough: 0.11, glass: 1, wet: 0 },
  dew: { rough: 0.3, glass: 0.15, wet: 1 }
};

// One material for every species' chrysalis.
// Made twice over: `film` false for the whole chrysalis, which is opaque and drawn with the solid things, in front of
// what it hides; `film` true for the same shell once it has split, when it is see-through and must be blended over
// what is behind it. usePupa hands each piece whichever it needs.
export function pupaMaterial(marks: THREE.Texture, film = true) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: film, depthWrite: true });
  // What is cut away (each piece to its own side of a tear) is not drawn at all.
  m.alphaTest = 0.02;
  const tuv = attribute("aTU", "vec4") as any;
  const t = tuv.x as any;
  const u = tuv.y as any;
  const au = abs(u) as any;
  const kind = tuv.z as any;
  const surf = attribute("aSurf", "vec4") as any;
  const rest = attribute("aRest", "vec3") as any;
  const packed = attribute("aAxis", "vec4") as any;
  const axis = vec3(0, packed.x, packed.y) as any;
  const groove = surf.x as any;
  const isStalk = step(1.5, kind) as any;
  const isInner = step(0.75, kind).mul(isStalk.oneMinus()) as any;
  const isEdge = step(0.25, kind).mul(step(kind, 0.75)) as any;
  const L = shell.length as any;
  const tc = t.clamp(0, 1) as any;
  // The abdomen's part of the shell (above the tear, which never opens) empties from the top down, as the body draws
  // itself down out of it: clear above its tail (`shell.front`, set from where the tail is), still full below.
  const drained = smoothstep(shell.front.sub(0.06), shell.front.add(0.015), t).oneMinus() as any;
  const empty = max(drained, shell.vacate.mul(smoothstep(shell.split.sub(0.03), shell.split.add(0.03), t))) as any;

  // Growing: from a wet drop under the pad, an ellipsoid that lengthens and swells with a slow ripple, then hardens into
  // its true shape.
  const g = shell.grow as any;
  const harden = smoothstep(0.6, 1, g) as any;
  const lengthen = mix(mix(float(0.12), float(1), smoothstep(0.15, 0.8, g)), float(1), isStalk) as any;
  // Never wider than it is long: a bead, then a round drop, before it draws out.
  const swell = max(min(mix(float(0.35), float(1), smoothstep(0, 0.6, g)), lengthen.mul(0.5 / 0.21)).mul(smoothstep(0, 0.06, g)), 0.001) as any;
  const ripple = sin(tc.mul(9).sub(time.mul(5))).mul(0.06).mul(harden.oneMinus()) as any;
  const radial = rest.sub(axis) as any;
  const rlen = max(length(radial), 1e-5) as any;
  const rdir = radial.div(rlen) as any;
  const ell = sqrt(max(tc.mul(tc.oneMinus()).mul(4), 0.0004)) as any;
  const blob = L.mul(0.21).mul(ell) as any;
  const wide = mix(mix(blob, rlen, harden).mul(swell).mul(ripple.add(1)), rlen.mul(smoothstep(0, 0.08, g)), isStalk) as any;
  const grown = axis.mul(lengthen).add(rdir.mul(wide)) as any;
  const out = normalLocal.mul(isInner.mul(-2).add(1)) as any;
  // Empty, it crinkles and buckles like cellophane, most where it tore open.
  const torn = smoothstep(shell.split.sub(0.08), shell.split.add(0.12), t).mul(0.75).add(0.25) as any;
  const crinkle = mx_noise_float(rest.mul(34)).mul(0.015).add(mx_noise_float(rest.mul(9).add(vec3(3.1, 0, 1.7))).mul(0.02).mul(live.empty)) as any;
  // The pleats stretch apart before it splits.
  const pleat = vec3(0, surf.z.mul(live.stretch).mul(L).mul(0.02), 0) as any;
  // While it is whole nothing of its inside can be seen: those faces are folded away to nothing, and cost nothing.
  const lined = max(isInner.oneMinus(), step(0.001, max(live.empty, shell.vacate))) as any;
  // Opening: each piece bends away from the tear line it stays joined along (shell-shape.ts, HOW THE PIECES OPEN),
  // every point turning about the hinge under it by its share of the piece's angle. Where it bends it creases.
  const bend = vec3(floor(tuv.w.add(0.001)), packed.z, packed.w) as any;
  const carried = tuv.w.sub(bend.x).max(0).div(0.9) as any;
  const hinge = attribute("aHinge", "vec3") as any;
  const hingeAxis = attribute("aHingeAxis", "vec3") as any;
  const asked = shell.open.x
    .mul(max(bend.x.sub(1).abs().oneMinus(), 0))
    .add(shell.open.y.mul(max(bend.x.sub(2).abs().oneMinus(), 0)))
    .add(shell.open.z.mul(max(bend.x.sub(3).abs().oneMinus(), 0))) as any;
  const angle = asked.mul(bend.y) as any;
  const cosA = cos(angle) as any;
  const sinA = sin(angle) as any;
  const bentAbout = (v: any) => v.mul(cosA).add(cross(hingeAxis, v).mul(sinA)).add(hingeAxis.mul(dot(hingeAxis, v)).mul(cosA.oneMinus())) as any;
  // And the sides drawn round the body, away from the ventral midline.
  const round = asked.mul(carried).mul(u.sign().negate()) as any;
  const cosR = cos(round) as any;
  const sinR = sin(round) as any;
  const spine = shell.spineD as any;
  const roundAbout = (v: any) => v.mul(cosR).add(cross(spine, v).mul(sinR)).add(spine.mul(dot(spine, v)).mul(cosR.oneMinus())) as any;
  const turnAbout = (v: any) => roundAbout(bentAbout(v)) as any;
  const creased = bend.z.mul(smoothstep(0, 0.35, asked)).mul(2.2).add(1) as any;
  // Small movements inside in the last moments: the butterfly shifting, pressing the wall out here and there.
  const stir = pow(max(sin(time.mul(2.3)).mul(sin(time.mul(1.1).add(1))), 0), 3).mul(live.clear.mul(0.35).add(live.stretch)).mul(shell.vacate.oneMinus()) as any;
  const pressed = out.mul(sin(tc.mul(13).add(u.mul(2)).add(time.mul(8))).mul(stir).mul(L).mul(0.012)).mul(isStalk.oneMinus()) as any;
  const shaped = positionLocal
    .add(pressed)
    .add(grown.sub(rest))
    .sub(pleat)
    .add(out.mul(crinkle.mul(L).mul(empty).mul(torn).mul(creased)).mul(isStalk.oneMinus())) as any;
  m.positionNode = shell.spineP.add(roundAbout(hinge.add(bentAbout(shaped.sub(hinge))).sub(shell.spineP))).mul(lined) as any;
  // The drop's own normal while it is still a drop.
  const ellN = normalize(rdir.mul(ell.div(swell.mul(0.21))).add(vec3(0, -1, 0).mul(tc.mul(2).sub(1).div(lengthen.mul(0.5))))) as any;
  const nLocal = varying(turnAbout(normalize(mix(ellN.mul(isInner.mul(-2).add(1)), normalLocal, max(harden, isStalk)))) as any, "vShellN") as any;

  const mark = textureNode(marks) as any;
  const markUV = vec2(u.div(Math.PI * 2).add(0.5), shell.tile.add(t.clamp(0.004, 0.996)).div(4)) as any;

  const shade = Fn(() => {
    const V = normalize(cameraPosition.sub(positionWorld)) as any;
    const smoothN = normalize(modelWorldMatrix.mul(vec4(nLocal, 0)).xyz) as any;
    // Crinkled, it shades in facets, as creased film does.
    const facet = normalize(cross(dFdx(positionWorld), dFdy(positionWorld)).add(vec3(1e-9, 0, 0))) as any;
    const facing = facet.mul(dot(facet, smoothN).lessThan(0).select(float(-1), float(1))) as any;
    const N0 = normalize((mix as any)(smoothN, facing, empty.mul(0.45).mul(isStalk.oneMinus()))) as any;

    // Markings, and the height of the beads among them.
    const grownUp = smoothstep(0.78, 1, g).mul(isStalk.oneMinus()) as any;
    const mk = mark.sample(markUV) as any;
    const hu = (mark.sample(markUV.add(vec2(1.5 / MARK_W, 0))) as any).b.sub(mk.b) as any;
    const ht = (mark.sample(markUV.add(vec2(0, 1.5 / (MARK_H * 4)))) as any).b.sub(mk.b) as any;
    const down = vec3(0, -1, 0) as any;
    const Tt = normalize(down.sub(N0.mul(dot(N0, down))).add(vec3(1e-3, 0, 0))) as any;
    const Tu = cross(N0, Tt) as any;
    const black = smoothstep(0.3, 0.46, mk.g).mul(grownUp) as any;
    const pale = smoothstep(0.3, 0.5, mk.a).mul(grownUp) as any;
    const gilt = smoothstep(0.3, 0.46, mk.r) as any;

    // The surface itself: slow undulation, a fine grain, and in the dew a mist of droplets.
    // Everything that only colours the living cuticle is left out once this part of the shell is empty film: up close
    // the empty shell fills the frame, twice over (both its walls show), and none of this would be seen in it.
    const whole = empty.lessThan(0.995) as any;
    const mottle = float(0).toVar() as any;
    const smudge = float(0).toVar() as any;
    const veined = float(0).toVar() as any;
    const grain = float(0).toVar() as any;
    const freckle = float(0).toVar() as any;
    If(whole, () => {
      mottle.assign(mx_fractal_noise_float(rest.mul(9), 2, 2, 0.5));
      smudge.assign(mx_noise_float(rest.mul(23).add(vec3(5.2, 1.3, 8.1))));
      veined.assign(mx_noise_float(vec3(u.mul(16), t.mul(2.5), 1.5)));
      grain.assign(mx_noise_float(rest.mul(260)));
      freckle.assign(smoothstep(0.7, 0.8, mx_noise_float(rest.mul(78))).mul(smoothstep(-0.2, 0.4, mx_noise_float(rest.mul(6.5).add(vec3(3, 9, 1))))));
    });
    // Only worked out when there is dew.
    const wetPatch = float(0).toVar() as any;
    const mist = float(0).toVar() as any;
    const mistN = vec3(0, 0, 0).toVar() as any;
    If(shell.wet.greaterThan(0.01), () => {
      wetPatch.assign(smoothstep(-0.15, 0.35, mx_noise_float(rest.mul(11).add(vec3(7, 0, 3)))).mul(shell.wet));
      mist.assign(smoothstep(0.24, 0.1, mx_worley_noise_float(rest.mul(150))).mul(smoothstep(-0.2, 0.3, mx_noise_float(rest.mul(17)))).mul(shell.wet));
      mistN.assign(mx_noise_vec3(rest.mul(150)).mul(mist.mul(0.45)));
    });
    const waxy = shell.glass.oneMinus().mul(empty.oneMinus()) as any;
    // (Worked out only once it has begun to clear.)
    const fineGrain = vec3(0, 0, 0).toVar() as any;
    If(waxy.greaterThan(0.02), () => {
      fineGrain.assign(mx_noise_vec3(rest.mul(170)).mul(waxy.mul(0.016).add(0.004)));
    });
    const wrinkled = vec3(0, 0, 0).toVar() as any;
    If(live.clear.greaterThan(0.002), () => {
      wrinkled.assign(mx_noise_vec3(vec3(u.mul(34), t.mul(7), 2.5)).mul(live.clear.mul(empty.oneMinus()).mul(0.045)));
    });
    const N = normalize(
      N0.add(mx_noise_vec3(rest.mul(55)).mul(shell.metal.mul(-0.022).add(0.032)))
        .add(fineGrain)
        .add(mistN)
        // The skin thins and wrinkles lengthwise as it clears.
        .add(wrinkled)
        .sub(Tu.mul(hu).add(Tt.mul(ht)).mul(grownUp.mul(2.2)))
    ) as any;
    const NV = abs(dot(N, V)) as any;
    const fresh = harden.oneMinus() as any;

    // What it is cleared to: the butterfly inside. The wing's underside through the case, the dark body elsewhere, the
    // abdomen still greenish, pale bands of membrane where its pleats have pulled apart.
    const wx = live.caseX.x.mul(t).add(live.caseX.y.mul(au)).add(live.caseX.z) as any;
    const wy = live.caseY.x.mul(t).add(live.caseY.y.mul(au)).add(live.caseY.z) as any;
    const fx = wx.sub(live.fore.x).div(live.fore.z) as any;
    const fy = live.fore.y.sub(wy).div(live.fore.z) as any;
    const inTile = smoothstep(0, 0.01, fx).mul(smoothstep(1, 0.99, fx)).mul(smoothstep(0, 0.01, fy)).mul(smoothstep(1, 0.99, fy)) as any;
    const pattern = atlasNode.sample(vec2(live.column.add(fx.clamp(0, 1)).div(4), float(1).sub(float(1).add(fy.clamp(0, 1)).div(4)))) as any;
    const onCase = pattern.a.mul(inTile).mul(smoothstep(0.4, 0.44, t)) as any;
    // The lines it tears along (the same as pieceAt in shell-shape.ts): round between abdomen and thorax, down either
    // side of the face plate, and down the middle of the back. Each piece is cut to its own side of them here, exactly,
    // whatever the mesh's cells; and just before it splits they show as hairline cracks, creeping along in stretches.
    const tearT = shell.split.add(sin(u.mul(5).add(0.7)).mul(0.006)).add(sin(u.mul(13).add(2)).mul(0.004)).add(cos(u).mul(0.02)) as any;
    const tearU = smoothstep(0.78, 0.96, t).mul(0.28).add(0.5).add(sin(t.mul(41).add(1.3)).mul(0.02)).add(sin(t.mul(97)).mul(0.011)) as any;
    const past = step(tearT, t) as any;
    const onLid = step(au, tearU) as any;
    const which = bend.x as any;
    const mine = mix(
      mix(past.oneMinus(), past.mul(onLid), step(0.5, which)),
      past.mul(onLid.oneMinus()),
      step(1.5, which)
    ).max(isStalk) as any;
    const seam = min(t.sub(tearT).abs(), mix(float(1), min(au.sub(tearU).abs(), float(Math.PI).sub(au)).mul(0.17), past)) as any;
    const creep = float(0).toVar() as any;
    If(live.stretch.greaterThan(0.002), () => {
      creep.assign(smoothstep(0, 0.35, live.stretch.mul(1.5).sub(mx_noise_float(rest.mul(6).add(vec3(2, 7, 5))).mul(0.5).add(0.5))));
    });
    const width = live.stretch.mul(0.0028).add(0.0011) as any;
    const crack = smoothstep(width, width.mul(0.35), seam).mul(creep).mul(shell.vacate.oneMinus()).mul(isStalk.oneMinus()) as any;
    const clear = clamp(live.clear.add(shell.glass.mul(0.2)), 0, 1).mul(empty.oneMinus()).mul(isStalk.oneMinus()) as any;
    // How far inside the wing case, by the triangle through its root, apex and tornus.
    const cp = vec2(t, au.mul(0.16)) as any;
    const edge = (a: number[], b: number[]) => {
      const ex = b[0] - a[0];
      const ey = (b[1] - a[1]) * 0.16;
      return cp.x.sub(a[0]).mul(ey).sub(cp.y.sub(a[1] * 0.16).mul(ex)).div(Math.hypot(ex, ey)) as any;
    };
    const caseD = min(min(edge(CASE.root, CASE.apex), edge(CASE.apex, CASE.tornus)), edge(CASE.tornus, CASE.root)) as any;
    const inCase = smoothstep(0, 0.05, caseD) as any;
    const abdomen = smoothstep(shell.split.add(0.04), shell.split.sub(0.2), t) as any;

    // Colour: the species' green (or gold), deeper in the creases and on the back, milky on the wing cases, never even.
    const dorsal = smoothstep(0.3, -0.8, cos(u)) as any;
    let albedo: any = mix(shell.base, shell.deep, clamp(groove.mul(0.55).add(mottle.mul(0.34)).add(dorsal.mul(0.22)).add(0.06), 0, 1));
    albedo = mix(albedo, shell.pale, clamp(inCase.mul(0.6).add(smoothstep(0.78, 1, t).mul(0.25)).add(smudge.mul(0.16)), 0, 1));
    // A fine pale line round the wing case, and yellowish lines along the creases.
    albedo = mix(albedo, mix(shell.pale, color("#e9e07a"), 0.5), clamp(smoothstep(0.007, 0.0, abs(caseD)).mul(smoothstep(0.42, 0.48, t)).mul(0.5).add(groove.mul(0.25)), 0, 1).mul(float(1).sub(shell.metal)).mul(harden));
    // Veins of the wing showing faintly as streaks down the case.
    albedo = albedo.mul(veined.mul(inCase).mul(0.1).add(1));
    albedo = albedo.mul(grain.mul(0.035).add(1));
    // Freckles and small blemishes.
    albedo = mix(albedo, color("#5c3d1e"), freckle.mul(0.4).mul(float(1).sub(shell.metal)));
    albedo = mix(albedo, color("#f4efc4"), pale.mul(0.9));
    albedo = mix(albedo, color("#9a3a16"), smoothstep(0.972, 1, t).mul(shell.horn));
    // Newly formed it is wet, yellow-green and bright.
    albedo = mix(albedo, mix(albedo, shell.glow, 0.45), fresh);
    const dark = (live.cleared as any).mul(0.16) as any;
    // By the time it splits the whole case has cleared, the abdomen's part too: what shows there is the butterfly's
    // dark abdomen, ringed with the pale membrane between its segments, not living green cuticle. (The paper kite's
    // stays gold: that is its own, further down.)
    const living = abdomen.mul(live.clear.mul(0.82).oneMinus()) as any;
    const between = mix(mix(shell.base, color("#d9d28a"), 0.5), color("#b9ab86"), live.clear) as any;
    const membrane = mix(dark, between, clamp(living.mul(0.5).add(groove.mul(abdomen).mul(live.clear.mul(0.3))).add(groove.mul(groove).mul(live.stretch).mul(0.3)), 0, 1)) as any;
    // The wing through the case: its colours pushed a little, as they are when wet and pressed against clear skin.
    const wingLuma = dot(pattern.rgb, vec3(0.3, 0.55, 0.15)) as any;
    const wing = mix(vec3(1, 1, 1).mul(wingLuma), pattern.rgb, 1.35).max(0).mul(1.7) as any;
    const within = mix(membrane, wing, onCase.mul(0.96)) as any;
    albedo = mix(albedo, within, clear.mul(0.94));
    albedo = mix(albedo, color("#0a0806"), max(black, crack.mul(0.9)));
    albedo = mix(albedo, shell.stalk, isStalk);

    // Light: the sun (behind, mostly), the open sky in front, the garden all round.
    const sun = sky.light.mul(sky.power) as any;
    const Ls = sky.toLight as any;
    const Lf = normalize(vec3(1.5, 2, 6)) as any;
    const NdL = dot(N, Ls) as any;
    const wrap = clamp(NdL.add(0.6).div(1.6), 0, 1) as any;
    const skyFront = mix(sky.horizon, vec3(1, 1, 1), 0.35) as any;
    const fill = skyFront.mul(pow(clamp(dot(N, Lf).mul(0.5).add(0.5), 0, 1), 1.5)).mul(0.42) as any;
    const amb = mix(mix(sky.blots[2], sky.blots[3], 0.5).mul(0.3), mix(sky.horizon, sky.zenith, 0.5).mul(0.5), smoothstep(-0.7, 0.7, N.y)) as any;
    const diffuse = albedo.mul(sun.mul(wrap).mul(0.3).add(fill).add(amb.mul(0.8))) as any;

    // Through it from behind: brightest and yellowest at the thin edges, absorbed with depth, and shadowed by the body
    // inside where the line of sight passes near the middle.
    const dir = normalize(rest.sub(live.eye)) as any;
    const rel = rest.sub(axis) as any;
    const pxz = vec2(rel.x, rel.z) as any;
    const dxz = vec2(dir.x, dir.z) as any;
    const along = max(pxz.dot(dxz).negate().div(max(dxz.dot(dxz), 1e-4)), 0) as any;
    const near = pxz.add(dxz.mul(along)).length() as any;
    const R = max(surf.w, 1e-4) as any;
    const body = smoothstep(R.mul(0.82), R.mul(0.4), near).mul(smoothstep(0.05, 0.22, t)).mul(smoothstep(1, 0.88, t)) as any;
    const seen = mix(float(1), float(0.12), body.mul(live.core).mul(clear.mul(0.4).add(0.6))) as any;
    const back = pow(max(dot(V, Ls.negate()), 0), 2) as any;
    const depth = mix(float(0.22), float(1), NV).mul(mix(float(1.15), float(0.6), shell.glass)).mul(fresh.mul(-0.4).add(1)) as any;
    const soaked = exp((shell.absorb as any).negate().mul(depth)) as any;
    const thin = pow(NV.oneMinus(), 1.5) as any;
    const lit = back.mul(mix(float(0.05), float(0.3), thin)).add(0.02).mul(fresh.mul(0.7).add(1)) as any;
    // (Cleared, the abdomen's part lets no more light through than the rest: the body fills it.)
    const opaque = clear.mul(mix(float(0.75), float(0.93), abdomen.mul(live.clear))).mul(living.mul(0.6).oneMinus()) as any;
    const through = sun.mul(shell.glow).mul(soaked).mul(lit).mul(seen).mul(black.oneMinus()).mul(opaque.oneMinus()).mul(isStalk.oneMinus()) as any;

    // Gloss: broken up by smudges and creases, wet where the dew lies, sharp when glassy or newly formed.
    let rough: any = shell.rough.mul(shell.sheen).mul(smudge.mul(0.3).add(1)).add(groove.mul(0.1));
    rough = mix(rough, float(0.07), wetPatch.mul(0.75));
    rough = mix(rough, float(0.03), mist);
    rough = mix(rough, float(0.08), max(fresh, clear.mul(0.5)));
    rough = mix(rough, float(0.16), empty);
    rough = mix(rough, float(0.12), isStalk).clamp(0.03, 1);
    const lobe = (Ldir: any, r: any) => {
      const a2 = r.mul(r).mul(r).mul(r) as any;
      const NdH = max(dot(N, normalize(Ldir.add(V))), 0) as any;
      const d = NdH.mul(NdH).mul(a2.sub(1)).add(1) as any;
      return min(a2.div(d.mul(d).mul(Math.PI)), 60).mul(clamp(dot(N, Ldir).mul(4), 0, 1)).mul(0.25) as any;
    };
    const F = mix(mix(float(0.04), float(0.08), shell.glass), float(1), pow(NV.oneMinus(), 5)) as any;
    const Rv = reflect(V.negate(), N) as any;
    // The twig and its leaves overhead darken what is mirrored from above.
    const overhead = mix(vec3(1, 1, 1), vec3(0.3, 0.22, 0.14), smoothstep(0.5, 0.95, Rv.y).mul(0.85)) as any;
    const mirrored = (skyAt(Rv) as any).mul(overhead) as any;
    const frontLight = skyFront.mul(1.4) as any;
    // The open sky in front mirrored as a long soft window down the body, the highlight a glossy chrysalis always has.
    const flatR = normalize(vec2(Rv.x, Rv.z).add(vec2(1e-4, 0))) as any;
    const flatL = normalize(vec2(Lf.x, Lf.z)) as any;
    const spread = rough.mul(0.9).add(0.05) as any;
    const strip = exp(flatR.dot(flatL).oneMinus().negate().div(spread.mul(spread).mul(0.7)))
      .mul(smoothstep(-0.25, 0.25, Rv.y))
      .mul(smoothstep(0.98, 0.75, Rv.y)) as any;
    const window = skyFront.mul(strip).mul(mix(float(0.3), float(0.85), smoothstep(0.4, 0.08, rough))) as any;
    const glints = sun.mul(lobe(Ls, rough)).add(frontLight.mul(lobe(Lf, rough))) as any;
    const gloss = smoothstep(0.45, 0.08, rough).mul(0.6).add(0.4) as any;
    // The powdery bloom of wax, catching the sky at grazing angles.
    const bloom = amb.add(fill).mul(pow(NV.oneMinus(), 3)).mul(waxy).mul(0.3) as any;
    // Glassy, the garden behind shows through it, bent and turned over as through a bead, tinted by the cuticle.
    const bent = normalize(V.negate().sub(N.mul(0.55))) as any;
    const beyond = vec3(0, 0, 0).toVar() as any;
    If(shell.glass.greaterThan(0.01), () => {
      beyond.assign((skyAt(bent) as any).mul(soaked).mul(seen).mul(1.15));
    });
    const inside = mix(diffuse, beyond.add(diffuse.mul(0.35)), shell.glass.mul(0.55).mul(clear.mul(0.8).oneMinus()).mul(isStalk.oneMinus())) as any;
    let rgb: any = inside.add(through).add(mirrored.mul(F).mul(gloss)).add(glints.mul(F.add(0.02))).add(window).add(bloom);
    // And the wing's pale parts catch the light from behind through the cleared skin.
    rgb = rgb.add(wing.mul(onCase).mul(clear).mul(sun.mul(back.mul(0.05).add(0.02)).add(amb.mul(0.25))));
    // Air between the butterfly and the cleared shell: a silvery sheen in patches just before it splits.
    const air = live.clear.mul(live.clear).mul(smoothstep(0.1, 0.5, mottle.add(live.stretch.mul(0.3)))).mul(empty.oneMinus()).mul(isStalk.oneMinus()) as any;
    rgb = rgb.add(mirrored.add(amb).mul(air).mul(0.22));

    // Metal: the monarch's gold beads, the glasswing's mirror bars, the paper kite gold all over. A mirror of the
    // garden, tinted.
    const patchy = smoothstep(-0.5, 0.2, mottle).mul(0.3).add(0.7).mul(live.clear.mul(abdomen.oneMinus()).mul(0.85).oneMinus()).mul(inCase.mul(0.25).oneMinus()) as any;
    // The glasswing silvers all over as it clears, like glass mirrored from inside, its abdomen in bright rings.
    const silvered = shell.chrome.mul(live.clear).mul(mix(float(0.55), float(1), abdomen.mul(groove.oneMinus()))).mul(onCase.mul(0.8).oneMinus()) as any;
    const metal = clamp(max(gilt.mul(empty.mul(0.35).oneMinus()), max(shell.metal.mul(patchy), silvered).mul(empty.oneMinus())), 0, 1).mul(grownUp).mul(black.oneMinus()) as any;
    const sharp = sun.mul(lobe(Ls, float(0.16))).add(frontLight.mul(lobe(Lf, float(0.16)))) as any;
    // A mirror shows its surroundings with all their contrast: bright sky, dark leaves.
    const grey = mix(mirrored, vec3(1, 1, 1).mul(dot(mirrored, vec3(0.3, 0.55, 0.15))), 0.55) as any;
    const hard = grey.mul(grey).mul(3.4).add(grey.mul(0.45)) as any;
    // Small mirror marks catch some bright thing from every side, so they never go dark.
    const catchlight = skyFront.mul(0.65).add(amb.mul(0.9)).mul(gilt) as any;
    const mirror = (shell.metalTint as any).mul(hard.add(sharp).add(window.mul(2.4)).add(amb.mul(0.2)).add(catchlight)).add(through.mul(0.3)) as any;
    rgb = mix(rgb, mirror, metal);
    // Black pigment stops everything but the gloss on top of it.
    rgb = mix(rgb, rgb.mul(0.03).add(mirrored.mul(F).mul(gloss)).add(window.mul(0.5)), black.mul(isStalk.oneMinus()));

    // Inside faces and torn edges: pale and matt.
    const lining = color("#d9cfb2").mul(sun.mul(wrap).mul(0.3).add(fill).add(amb)) as any;
    rgb = mix(rgb, lining, isInner.mul(0.55).add(isEdge.mul(0.7)).mul(empty.oneMinus()));

    // Empty: a film of clear cuticle. Almost nothing straight on, more at the edges where the eye looks along it, lit
    // up from behind, glinting on every crease; the abdomen stays a little tan and the black marks stay.
    const film = (shell.husk as any).mul(sun.mul(wrap).mul(0.25).add(fill).add(amb)).mul(shell.paper.mul(0.5).add(0.6)) as any;
    // Folds show as pale lines.
    const fold = float(0).toVar() as any;
    const thread = float(0).toVar() as any;
    const stain = float(0).toVar() as any;
    If(empty.greaterThan(0.001), () => {
      fold.assign(smoothstep(0.05, 0.0, abs(mx_noise_float(rest.mul(34)))).mul(0.6).add(smoothstep(0.04, 0.0, abs(mx_noise_float(rest.mul(13).add(vec3(1, 4, 2))))).mul(0.5)));
      // The white threads of the old windpipes, left clinging inside.
      thread.assign(smoothstep(0.9, 0.97, mx_noise_float(vec3(u.mul(5), t.mul(1.3), 4))).mul(isInner).mul(smoothstep(0.06, 0.2, t)));
      // The butterfly's first droppings stain the film where the abdomen lay: a rusty wash, heaviest just above the tear.
      stain.assign(smoothstep(-0.1, 0.5, mx_noise_float(rest.mul(11).add(vec3(6, 2, 9)))).mul(smoothstep(shell.split.sub(0.28), shell.split.sub(0.04), t)).mul(smoothstep(shell.split.add(0.1), shell.split.sub(0.02), t)));
    });
    const lamp = sun.mul(color("#f3e4b4")).mul(back.mul(0.5).add(0.05)).mul(pow(NV.oneMinus(), 1.5).mul(0.7).add(0.3)) as any;
    const shine = mirrored.mul(F).mul(1.3).add(glints.mul(F.add(0.03)).mul(1.4)).add(window.mul(0.8)) as any;
    const stained = mix(vec3(1, 1, 1), vec3(0.62, 0.3, 0.16), stain.mul(0.6)) as any;
    const husk = mix(film.mul(fold.mul(0.5).add(1)).add(lamp).mul(stained).add(shine), color("#0c0a08"), black.mul(0.8)).add(amb.add(fill).mul(thread).mul(1.5)) as any;
    // The gold stays on the empty shell.
    rgb = mix(rgb, mix(husk, mirror, gilt.mul(grownUp).mul(0.65)), empty.mul(isStalk.oneMinus()));
    const shineLuma = dot(shine, vec3(0.3, 0.5, 0.2)) as any;
    const sheer = clamp(shell.paper.add(0.2).add(pow(NV.oneMinus(), 2).mul(0.65)).add(shineLuma.mul(1.2)).add(black.mul(0.7)).add(gilt.mul(0.6)).add(thread.mul(0.6)).add(stain.mul(0.18)).add(abdomen.mul(0.3)).add(isEdge.mul(0.5)).add(fold.mul(0.15)), 0, 0.96) as any;
    const alpha = mix(float(1), sheer, empty.mul(isStalk.oneMinus())).mul(live.fade.oneMinus()).mul(mine) as any;
    return vec4(rgb.add(vec3(1, 1, 1).mul(sky.flash.mul(0.4))), alpha);
  })() as any;
  m.colorNode = shade.rgb;
  m.opacityNode = shade.a;
  return m;
}

// Every species' chrysalis made up front, in pieces hung from pivots: only the one chosen shows, so changing species
// only changes which is shown and the shared colours.
export type PupaRig = {
  groups: Record<SpeciesName, THREE.Group>;
  pivots: Record<SpeciesName, THREE.Group[]>;
  material: THREE.Material;
  grow(g: number): void;
  nudge(strength?: number): void;
  dropShell(): void;
  resetDrop(): void;
  readonly dropped: boolean;
  readonly dropping: boolean;
};

export function usePupa(fine: number): PupaRig {
  const look = (useSetting<ShellLook>("emergeShell") as ShellLook | undefined) ?? "wax";
  const made = useMemo(() => {
    // The looked-up surface the probes and holds use, for every species, now rather than mid-emergence.
    warmShell(SPECIES_NAMES.map((name) => SPECIES[name]));
    const marks = markTexture();
    const material = pupaMaterial(marks, false);
    const filmMaterial = pupaMaterial(marks, true);
    const shells: THREE.Mesh[] = [];
    const dew = makeDew(shell.base);
    const groups = {} as Record<SpeciesName, THREE.Group>;
    const pivots = {} as Record<SpeciesName, THREE.Group[]>;
    const geometries: THREE.BufferGeometry[] = [];
    const holders: THREE.Group[] = [];
    // The pieces' angles as drawn, each on a soft spring toward what is asked, so they open with a little overshoot
    // and settle, and tremble when nudged.
    const sprung = { at: [0, 0, 0], speed: [0, 0, 0], asked: [0, 0, 0, 0] };
    for (const name of SPECIES_NAMES) {
      const group = new THREE.Group();
      const sp = SPECIES[name];
      const pieces = buildPupa(sp, fine);
      pivots[name] = pieces.map((piece) => {
        // The pivot is only the handle the scene turns to say how far the piece is open: the piece itself stays
        // where it is, joined to the abdomen, and bends by that much in the shader.
        const pivot = new THREE.Group();
        pivot.position.copy(piece.pivot);
        const holder = new THREE.Group();
        const mesh = new THREE.Mesh(piece.geometry, material);
        mesh.frustumCulled = false;
        shells.push(mesh);
        holder.add(mesh);
        group.add(pivot, holder);
        holders.push(holder);
        geometries.push(piece.geometry);
        return pivot;
      });
      dew.bead(sp, holders.slice(-4), fine);
      // One triangle of no size in the see-through material rides with every chrysalis from the start, so that
      // material's program is made behind the loader and not at the instant of the crack.
      const first = pieces[0].geometry;
      const seed = new THREE.BufferGeometry();
      for (const key of Object.keys(first.attributes)) seed.setAttribute(key, first.getAttribute(key));
      seed.setIndex([0, 0, 0]);
      geometries.push(seed);
      const seeded = new THREE.Mesh(seed, filmMaterial);
      seeded.frustumCulled = false;
      group.add(seeded);
      groups[name] = group;
    }
    // The fall.
    const drop = {
      active: false,
      done: false,
      t: 0,
      group: null as THREE.Group | null,
      centre: new THREE.Vector3(),
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      turn: new THREE.Quaternion(),
      phase: 0
    };
    const scratch = { q: new THREE.Quaternion(), v: new THREE.Vector3(), axis: new THREE.Vector3() };
    const current = () => SPECIES_NAMES.find((name) => groups[name].visible && groups[name].parent) ?? SPECIES_NAMES[0];
    const rig = {
      groups,
      pivots,
      material,
      target: LOOKS.wax,
      species: "" as string,
      grow(g: number) {
        shell.grow.value = Math.min(1, Math.max(0, g));
        if (drop.done && g < 0.5) rig.resetDrop();
      },
      dropShell() {
        if (drop.active) return;
        const name = current();
        drop.group = groups[name];
        drop.active = true;
        drop.done = false;
        drop.t = 0;
        drop.centre.set(0, -SPECIES[name].pupa * 0.45, 0);
        drop.pos.set(0, 0, 0);
        drop.vel.set((Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.5);
        drop.spin.set((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 2, (Math.random() < 0.5 ? -1 : 1) * (1.5 + Math.random() * 2));
        drop.turn.identity();
        drop.phase = Math.random() * 6.28;
      },
      // A knock to the open pieces (the butterfly letting go of the shell, say): they spring and settle.
      nudge(strength = 1) {
        for (let k = 0; k < 3; k++) sprung.speed[k] += (k === 0 ? -1.2 : 0.9 + k * 0.25) * strength * (sprung.at[k] > 0.05 ? 1 : 0);
      },
      resetDrop() {
        drop.active = false;
        drop.done = false;
        for (const name of SPECIES_NAMES) {
          groups[name].position.set(0, 0, 0);
          groups[name].quaternion.identity();
          groups[name].scale.setScalar(1);
        }
      },
      get dropped() {
        return drop.done;
      },
      get dropping() {
        return drop.active && !drop.done;
      },
      update(dt: number) {
        // The species' colours follow whichever chrysalis is shown.
        const name = current();
        if (name !== rig.species) {
          rig.species = name;
          const sp = SPECIES[name];
          const sh = shapeOf(sp);
          const p = PALETTE[sh.key];
          shell.base.value.set(p.base);
          shell.deep.value.set(p.deep);
          shell.pale.value.set(p.pale);
          shell.glow.value.set(p.glow);
          shell.absorb.value.set(...p.absorb);
          shell.metal.value = p.metal;
          shell.metalTint.value.set(p.metalTint);
          shell.stalk.value.set(p.stalk);
          shell.horn.value = sh.key === "morpho" ? 1 : 0;
          shell.tile.value = sh.tile;
          shell.length.value = sp.pupa;
          shell.split.value = sh.split;
          partLine(sp, shell.spineP.value, shell.spineD.value);
          shell.sheen.value = p.sheen;
          shell.chrome.value = p.chrome;
          shell.husk.value.set(p.husk);
          shell.paper.value = p.paper;
        }
        // The pieces follow the pivots the scene turns, on their springs.
        openAngles(pivots[name], sprung.asked);
        const sub = Math.max(1, Math.ceil(dt / 0.006));
        for (let n = 0; n < sub; n++)
          for (let k = 0; k < 3; k++) {
            const want = sprung.asked[k + 1];
            // Shut at once when the scene shuts them (a new chrysalis); otherwise sprung.
            if (want === 0 && sprung.at[k] < 0.02) {
              sprung.at[k] = 0;
              sprung.speed[k] = 0;
              continue;
            }
            sprung.speed[k] += ((want - sprung.at[k]) * 260 - sprung.speed[k] * 11) * (dt / sub);
            sprung.at[k] = Math.max(0, sprung.at[k] + sprung.speed[k] * (dt / sub));
          }
        shell.open.value.set(sprung.at[0], sprung.at[1], sprung.at[2]);
        // The look glides.
        const k = 1 - Math.exp(-dt * 5);
        shell.rough.value += (rig.target.rough - shell.rough.value) * k;
        shell.glass.value += (rig.target.glass - shell.glass.value) * k;
        shell.wet.value += (rig.target.wet - shell.wet.value) * k;
        shell.vacate.value += ((live.core.value < 0.5 ? 1 : 0) - shell.vacate.value) * (1 - Math.exp(-dt * (live.core.value < 0.5 ? 3 : 30)));
        // Opaque while it is whole; blended from the crack on (or while it is being faded away).
        const wanted = live.empty.value > 0 || shell.vacate.value > 0.0005 || live.fade.value > 0 ? filmMaterial : material;
        if (shells[0].material !== wanted) for (const mesh of shells) mesh.material = wanted;
        // Dew comes last on a new chrysalis, and is shaken off when it splits.
        dew.amount.value = shell.wet.value * Math.min(1, Math.max(0, (shell.grow.value - 0.9) / 0.1)) * (1 - shell.vacate.value);

        if (!drop.active || drop.done || !drop.group) return;
        drop.t += dt;
        const { q, v, axis } = scratch;
        if (drop.t < DROP.hold) {
          // Hanging by its last hooks: it tips and trembles.
          const f = drop.t / DROP.hold;
          drop.group.rotation.set(Math.sin(drop.t * 38) * 0.02 * f, 0, f * f * 0.16 * Math.sign(drop.spin.z) + Math.sin(drop.t * 31) * 0.015 * f);
          drop.turn.copy(drop.group.quaternion);
          return;
        }
        // Falling: gravity against the drag of the air, which soon holds it at a slow, steady speed; the air also
        // pushes it sideways as it turns, and sets it tumbling faster.
        const steps = Math.max(1, Math.ceil(dt / 0.008));
        const h = dt / steps;
        for (let s = 0; s < steps; s++) {
          const drag = DROP.gravity / DROP.terminal;
          drop.phase += h * (5 + drop.spin.length());
          drop.vel.x += (Math.sin(drop.phase) * 5 - drop.vel.x * drag) * h;
          drop.vel.z += (Math.cos(drop.phase * 0.7) * 3.2 - drop.vel.z * drag) * h;
          drop.vel.y += (-DROP.gravity - drop.vel.y * drag) * h;
          drop.pos.addScaledVector(drop.vel, h);
          const speed = Math.min(1, Math.abs(drop.vel.y) / DROP.terminal);
          drop.spin.x += (Math.sin(drop.phase * 0.9) * 14 * speed - drop.spin.x * 0.8) * h;
          drop.spin.z += (Math.sign(drop.spin.z) * 9 * speed - drop.spin.z * 0.9) * h;
          const w = drop.spin.length();
          if (w > 1e-5) {
            axis.copy(drop.spin).multiplyScalar(1 / w);
            drop.turn.premultiply(q.setFromAxisAngle(axis, w * h));
          }
        }
        // Turning about its own middle, not the pad.
        v.copy(drop.centre).applyQuaternion(drop.turn);
        drop.group.quaternion.copy(drop.turn);
        drop.group.position.copy(drop.pos).add(drop.centre).sub(v);
        if (drop.pos.y < -DROP.out) {
          drop.done = true;
          drop.group.scale.setScalar(1e-4);
        }
      }
    };
    // Every species' pieces drawn once into a scrap of a picture as soon as they are made, whichever of them the scene
    // is showing: their vertex buffers go to the GPU then (behind the loader, or at a change of quality) and not at the
    // moment the next species' chrysalis first appears.
    const primer = { scene: new THREE.Scene(), target: new THREE.RenderTarget(4, 4), done: false };
    for (const geometry of geometries) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      primer.scene.add(mesh);
    }
    return { rig, marks, dew, geometries, primer, filmMaterial };
  }, [fine]);
  const renderer = useThree((three) => three.gl) as unknown as THREE.WebGPURenderer;
  const eye = useThree((three) => three.camera);
  useFrame(() => {
    if (made.primer.done) return;
    made.primer.done = true;
    const before = renderer.getRenderTarget();
    renderer.setRenderTarget(made.primer.target);
    renderer.render(made.primer.scene, eye);
    renderer.setRenderTarget(before);
  });
  useDispose(made.rig.material, made.filmMaterial, made.marks, made.dew.material, made.dew.geometry, made.primer.target, ...made.geometries);
  useEffect(() => {
    made.rig.target = LOOKS[look] ?? LOOKS.wax;
  }, [look, made]);
  // The sky everything here mirrors is a picture kept up to date (sky.tsx).
  useSkyBake();
  useFrame((_, delta) => made.rig.update(Math.min(delta, 1 / 20)));
  // A chrysalis made for another quality tier leaves the scene with it.
  useEffect(
    () => () => {
      for (const name of SPECIES_NAMES) made.rig.groups[name].removeFromParent();
    },
    [made]
  );
  // For screenshots in development.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (globalThis as Record<string, unknown>).__shell = {
      shell,
      BEND,
      // Try the new air without the scene's say: hides Tension's specks and bokeh discs, hangs the motes.
      air(scene: THREE.Object3D, tier: "low" | "medium" | "high" = "high", hideOld = true) {
        const motes = makeMotes(tier);
        scene.traverse((o) => {
          const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
          if (hideOld && g && g.attributes.aStart && g.attributes.aDrift) o.visible = false;
        });
        scene.add(motes.group);
        const tick = () => {
          motes.update((globalThis as any).__emerge.camera);
          requestAnimationFrame(tick);
        };
        tick();
        return motes;
      },
      rig: made.rig,
      // Show one species' chrysalis whatever the scene says.
      solo(name: SpeciesName) {
        for (const other of SPECIES_NAMES) Object.defineProperty(made.rig.groups[other], "visible", { get: () => other === name, set: () => {}, configurable: true });
      },
      look(name: ShellLook, now = true) {
        made.rig.target = LOOKS[name];
        if (now) {
          shell.rough.value = LOOKS[name].rough;
          shell.glass.value = LOOKS[name].glass;
          shell.wet.value = LOOKS[name].wet;
        }
      }
    };
  }, [made]);
  return made.rig;
}
