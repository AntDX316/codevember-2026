import * as THREE from "three/webgpu";
import { abs, cos, exp, float, fract, fwidth, length, max, mix, pow, smoothstep, uniform, uniformArray, vec3 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// Every call and echo is a sphere of sound spreading from where it was made at the speed of sound in this little
// world, slowed down so it can be watched. Up to PULSES sound at once: where each began (xyz) and when (w), and its
// colour (rgb) and strength (w). A slot not in use has no strength.
export const PULSES = 8;
// Metres a second: slow enough to watch the front roll out across the floor.
export const SPEED = 15;
// How long a surface the front has passed stays drawn, in seconds.
export const LINGER = 3.2;

export const echo = {
  time: uniform(0),
  pulse: uniformArray(
    Array.from({ length: PULSES }, () => new THREE.Vector4(0, -1000, 0, -100)),
    "vec4"
  ),
  tone: uniformArray(
    Array.from({ length: PULSES }, () => new THREE.Vector4(0, 0, 0, 0)),
    "vec4"
  ),
  // The faint light still coming down from far above, and the colour of the deep water it fades into.
  water: uniform(new THREE.Color("#020a12")),
  // The camera's frame, for things drawn to face it.
  right: uniform(new THREE.Vector3(1, 0, 0)),
  up: uniform(new THREE.Vector3(0, 1, 0))
};

// A thin line every `spacing` along `x`, kept a pixel or so wide on screen, and fading to its average where the lines
// crowd closer than a few pixels, so the far floor never shimmers.
export function lines(x: any, spacing: number, width = 1.1) {
  const v = (x as any).div(spacing) as any;
  const fw = max(fwidth(v), 1e-5) as any;
  const d = abs(fract(v.add(0.5)).sub(0.5)) as any;
  const line = float(1).sub(smoothstep(fw.mul(width * 0.5), fw.mul(width * 0.5 + 1), d)) as any;
  const crowd = smoothstep(0.08, 0.3, fw) as any;
  return line.mul(float(1).sub(crowd)).add(crowd.mul(0.18 * width)) as any;
}

// The light a point gives back as the fronts pass it: a bright band where a front is touching it now, a few weaker
// ripples behind (the call is a long, slow wave train, not one click), and then the scan lines it is drawn in,
// lingering and fading. `pattern(d)` gives the lines to draw at a point that lies d metres from a pulse's centre;
// `fill` is how much of the band lights the whole surface rather than only its lines.
export function revealAt(P: any, pattern: (d: any) => any, fill = 0.3, reach = 1) {
  let total: any = vec3(0, 0, 0);
  for (let i = 0; i < PULSES; i++) {
    const p = echo.pulse.element(i) as any;
    const c = echo.tone.element(i) as any;
    const age = (echo.time as any).sub(p.w) as any;
    const d = length(P.sub(p.xyz)) as any;
    const behind = age.mul(SPEED).sub(d) as any;
    const front = exp(behind.div(1.6).pow2().negate()) as any;
    const passed = smoothstep(-0.4, 0.6, behind) as any;
    const ripples = passed.mul(exp(behind.div(-9))).mul(cos(behind.mul((2 * Math.PI) / 5.5)).mul(0.5).add(0.5)) as any;
    const linger = passed.mul(exp(behind.div(-SPEED * LINGER))) as any;
    // Weaker the further it has spread, but slowly, so a big call still reaches the far floor.
    const fall = c.w.div(d.mul(0.018 / reach).add(1)) as any;
    const drawn = pattern(d) as any;
    const light = front.mul(drawn.mul(1 - fill).add(fill)).mul(1.8).add(ripples.mul(drawn).mul(0.55)).add(linger.mul(drawn).mul(0.45)) as any;
    total = total.add(c.xyz.mul(light.mul(fall)));
  }
  return total;
}

// The water seen along a direction: black below, the faintest blue-green toward the far-off light overhead.
export const SUN = new THREE.Vector3(0.25, 1, -0.45).normalize();
export function waterColour(dir: any) {
  const up = smoothstep(-0.25, 1, dir.y) as any;
  const toward = max(dir.dot(vec3(SUN.x, SUN.y, SUN.z)), 0) as any;
  const deep = mix(vec3(0.0004, 0.0012, 0.002), vec3(0.006, 0.02, 0.03), pow(up, 1.6)) as any;
  return deep.add(vec3(0.02, 0.05, 0.06).mul(pow(toward, 6))) as any;
}
