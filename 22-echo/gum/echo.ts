import * as THREE from "three/webgpu";
import { exp, float, length, max, smoothstep, uniform } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The hall, and the snap's sound in it. The room is a round tiled hall; the snap's front runs out from where the gum
// broke, meets the wall half a period later and runs back in to the middle, where it is heard again and sets off once
// more, weaker each time: so the echoes come a round trip apart, as they would in a real room slowed for the eye.

export const ROOM = { radius: 8, floor: -2, ceiling: 7, oculus: 2.1 };
// One round trip, in seconds, and how fast the front must run for it.
export const PERIOD = 0.56;
export const SPEED = (2 * ROOM.radius) / PERIOD;
export const ECHOES = 5;
// Each return keeps this much.
export const KEEP = 0.58;

// Where the snap was, in the room, and how long ago (negative: none yet, or long gone).
export const echo = { at: uniform(new THREE.Vector3()), age: uniform(-100) };

// How strongly the passing sound lights a point: a bright band at each front and a fading wake behind the outgoing
// ones. `inward` adds the fronts coming back off the wall, which read on the floor and ceiling as rings closing in.
// `sharp` narrows the band, for the grout lines.
export function wave(p: any, inward: any, sharp = 1) {
  const age = echo.age as any;
  const fromSnap = length(p.sub(echo.at)) as any;
  const fromAxis = length(p.xz) as any;
  const width = float(0.55 / sharp) as any;
  let sum: any = float(0);
  for (let k = 0; k < ECHOES; k++) {
    const since = age.sub(k * PERIOD) as any;
    const live = smoothstep(0, 0.02, since) as any;
    const amp = Math.pow(KEEP, k);
    // Out from the snap, for half a round trip and a little past the wall.
    const front = since.mul(SPEED) as any;
    const out = fromSnap.sub(front) as any;
    const band = exp(out.mul(out).div(width.mul(width)).negate()) as any;
    const wake = exp(max(out.negate(), 0).mul(-0.3 * sharp * sharp)).mul(smoothstep(0, 0.5, out.negate())).mul(0.45) as any;
    const outgoing = band.add(wake).mul(float(1).sub(smoothstep(PERIOD * 0.62, PERIOD * 0.9, since))) as any;
    // Back in off the wall.
    const back = since.sub(PERIOD / 2) as any;
    const inFront = float(ROOM.radius).sub(back.mul(SPEED)) as any;
    const inn = fromAxis.sub(inFront) as any;
    const inBand = exp(inn.mul(inn).div(width.mul(width)).negate()).mul(smoothstep(0, 0.03, back)).mul(float(1).sub(smoothstep(PERIOD * 0.42, PERIOD * 0.5, back))) as any;
    sum = sum.add(outgoing.add(inBand.mul(inward).mul(0.7)).mul(live).mul(amp));
  }
  return sum.mul(float(1).sub(smoothstep(PERIOD * ECHOES, PERIOD * (ECHOES + 0.6), age)));
}
