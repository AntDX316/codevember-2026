import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  cameraPosition,
  clamp,
  cos,
  cross,
  dot,
  exp,
  float,
  hash,
  instanceIndex,
  instancedArray,
  length,
  max,
  min,
  mix,
  mx_noise_vec3,
  positionGeometry,
  pow,
  sin,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec3,
  vec4
} from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The swarm: tens of thousands of motes, each a thread on the graphics card. Every mote keeps to a layer of an egg-shaped
// shell, pulled back to it by a soft spring; along the shell it is carried by two crossing spirals, like silk wound two
// ways, and stirred by a curl-noise field that slowly changes, so the weave keeps coming undone and re-knitting. A hand
// passing through pushes motes out of its way and drags them with it; holding draws them into a whirl round the
// pointer; letting go throws them out, and the shell's springs, loosened for a moment, bring them spiralling home.

// The shell's half-widths: a cocoon a little over two units tall.
export const SHELL = new THREE.Vector3(0.8, 1.12, 0.8);

export type Palette = { rest: string; hot: string; shadow: string; core: string };

export const PALETTES: Record<string, Palette> = {
  ember: { rest: "#ffae3d", hot: "#fff3dc", shadow: "#5a2390", core: "#ff8a2e" },
  moonlight: { rest: "#9fc2ff", hot: "#f4f8ff", shadow: "#2b2a8c", core: "#bcd6ff" },
  aurora: { rest: "#3df2a8", hot: "#eafff6", shadow: "#7a22b0", core: "#5cffc8" },
  rose: { rest: "#ff6f9e", hot: "#fff0f5", shadow: "#3a1a7a", core: "#ff9ab8" }
};

export function createSwarm(count: number) {
  // Where each mote is (xyz) and which mote it is (w, a whole number its hashes are drawn from); how it is moving (xyz)
  // and how fast it has lately been going (w), which sets its colour.
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    // Scattered over the shell to begin with, so the first frame is already a cocoon.
    const u = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = 0.85 + Math.random() * 0.2;
    seeds[i * 4] = Math.cos(a) * s * SHELL.x * r;
    seeds[i * 4 + 1] = u * SHELL.y * r;
    seeds[i * 4 + 2] = Math.sin(a) * s * SHELL.z * r;
    seeds[i * 4 + 3] = i;
  }
  // A typed array in place of a count fills the buffer with it.
  const pos = instancedArray(seeds as any, "vec4") as any;
  const vel = instancedArray(count, "vec4") as any;

  const u = {
    time: uniform(0),
    dt: uniform(1 / 60),
    // 0 calm to 1 wild.
    wild: uniform(0.35),
    // The shell's scale this moment, as it breathes.
    breath: uniform(1),
    // The two spiral axes the silk is wound round, which slowly precess.
    weaveA: uniform(new THREE.Vector3(0.5, 1, 0.2).normalize()),
    weaveB: uniform(new THREE.Vector3(-0.5, 1, -0.2).normalize()),
    // The pointer as a ray, how strongly it parts the swarm, how fast the hand is moving at the cocoon, and how far along
    // the ray the cocoon begins.
    rayO: uniform(new THREE.Vector3()),
    rayD: uniform(new THREE.Vector3(0, 0, -1)),
    sweep: uniform(0),
    hand: uniform(new THREE.Vector3()),
    front: uniform(5),
    // Holding: the point the swarm is drawn to, how strongly, and the way the eye looks, which the whirl turns round.
    holdAt: uniform(new THREE.Vector3()),
    hold: uniform(0),
    eye: uniform(new THREE.Vector3(0, 0, -1)),
    // A burst: where from and how hard, given for a single step; and how loose the shell's springs still are after one.
    burstAt: uniform(new THREE.Vector3()),
    burst: uniform(0),
    loosen: uniform(0),
    // Drawing: the colours, a world size for one pixel at unit distance, and how bright a mote is at this density.
    rest: uniform(new THREE.Color()),
    hot: uniform(new THREE.Color()),
    shadow: uniform(new THREE.Color()),
    pixel: uniform(0.002),
    gain: uniform(1)
  };

  // A mote's own random numbers, 0 to 1.
  const rnd = (seed: any, k: number) => hash(seed.mul(16).add(k));
  // What part of the swarm it is: a few strays drifting wide (0), some swirling inside near the core (1), the rest the
  // shell itself (2); and the layer of the shell it keeps to.
  const role = (seed: any) => {
    const pick = rnd(seed, 1) as any;
    const kind = pick.lessThan(0.035).select(float(0), pick.lessThan(0.11).select(float(1), float(2))) as any;
    const h = rnd(seed, 2) as any;
    const layer = kind.equal(0).select(h.mul(0.9).add(1.3), kind.equal(1).select(h.mul(0.5).add(0.22), pow(h, float(0.6)).mul(0.15).add(0.88))) as any;
    return { kind, layer };
  };

  // Curl noise: the curl of a slowly drifting vector noise, a flow with no sources or sinks, so motes swirl in eddies
  // rather than bunching up.
  const curl = (x: any) => {
    const e = 0.07;
    const dx = vec3(e, 0, 0);
    const dy = vec3(0, e, 0);
    const dz = vec3(0, 0, e);
    const x0 = mx_noise_vec3(x.sub(dx)) as any;
    const x1 = mx_noise_vec3(x.add(dx)) as any;
    const y0 = mx_noise_vec3(x.sub(dy)) as any;
    const y1 = mx_noise_vec3(x.add(dy)) as any;
    const z0 = mx_noise_vec3(x.sub(dz)) as any;
    const z1 = mx_noise_vec3(x.add(dz)) as any;
    return vec3(y1.z.sub(y0.z).sub(z1.y.sub(z0.y)), z1.x.sub(z0.x).sub(x1.z.sub(x0.z)), x1.y.sub(x0.y).sub(y1.x.sub(y0.x))).div(2 * e) as any;
  };

  const step = Fn(() => {
    const P = pos.element(instanceIndex) as any;
    const V = vel.element(instanceIndex) as any;
    const seed = P.w as any;
    const p = P.xyz.toVar() as any;
    const v = V.xyz.toVar() as any;
    const dt = u.dt as any;
    const { kind, layer } = role(seed);
    const stray = kind.equal(0) as any;
    const inner = kind.equal(1) as any;

    // Where it is against the shell: its distance out in shell units (1 on the shell) and the way out.
    const R = vec3(SHELL.x, SHELL.y, SHELL.z).mul(u.breath) as any;
    const q = p.div(R) as any;
    const r = length(q) as any;
    const g = q.div(R) as any;
    const n = g.div(length(g).add(1e-5)) as any;

    // Along the shell: wound round one of two tilted axes, each mote its own way, and stirred by the noise.
    const family = rnd(seed, 3).lessThan(0.5) as any;
    const axis = family.select(u.weaveA, u.weaveB) as any;
    const wrap = cross(axis, n) as any;
    const wrapLength = length(wrap) as any;
    const wrapDir = wrap.div(wrapLength.add(1e-4)).mul(smoothstep(0.04, 0.35, wrapLength)) as any;
    const flowAt = p
      .mul(mix(float(1.4), float(2.6), u.wild))
      .add(vec3(u.time.mul(0.05), u.time.mul(0.13), u.time.mul(-0.07)))
      .add(stray.select(vec3(17), vec3(0))) as any;
    const f = curl(flowAt).mul(0.25) as any;
    const fAlong = f.sub(n.mul(dot(f, n))) as any;
    const wrapSpeed = stray.select(float(0.05), inner.select(float(0.25), float(0.32))).mul(rnd(seed, 4).mul(0.6).add(0.7)) as any;
    const turbulence = mix(float(0.18), float(2), u.wild).mul(stray.select(float(0.6), inner.select(float(1.4), float(1)))) as any;
    const want = wrapDir.mul(wrapSpeed).add(fAlong.mul(turbulence)) as any;
    const outward = dot(v, n) as any;
    const along = v.sub(n.mul(outward)) as any;
    // After a burst the springs and the steering go slack, so motes fly free before they are gathered back.
    const slack = u.loosen as any;
    const steer = stray.select(float(0.8), float(2.6)).mul(mix(float(1), float(0.12), slack)) as any;
    const a = want.sub(along).mul(steer).toVar() as any;

    // Back to its layer: a spring and a damper along the way out.
    const k = stray.select(float(2.5), float(30)).mul(mix(float(1), float(0.06), slack)) as any;
    const c = stray.select(float(1), float(5.5)).mul(mix(float(1), float(0.15), slack)) as any;
    // Holding loosens the shell near the pointer, so motes can leave it for the whirl.
    const toHold = u.holdAt.sub(p) as any;
    const holdDistance = length(toHold) as any;
    const holdReach = u.hold.mul(exp(holdDistance.mul(-0.75))) as any;
    const pull = float(1).sub(holdReach.mul(0.92)) as any;
    a.addAssign(n.mul(layer.sub(r).mul(k).mul(pull).sub(outward.mul(c))));
    // Displaced motes spiral home rather than falling straight back: the further out, the faster they circle.
    const home = cross(vec3(0, 1, 0), n) as any;
    a.addAssign(home.mul(clamp(r.sub(layer), 0, 2.5).mul(2.2)));

    // The hand: motes near the pointer's ray are pushed out from it and carried along with it, mostly on the near side.
    const rel = p.sub(u.rayO) as any;
    const s = dot(rel, u.rayD) as any;
    const off = rel.sub(u.rayD.mul(s)) as any;
    const offLength = length(off) as any;
    const reach = float(0.3).add(min(length(u.hand), float(4)).mul(0.04)) as any;
    const near = float(1).sub(smoothstep(0, reach, offLength)) as any;
    const depth = exp(max(s.sub(u.front).sub(0.45), float(0)).mul(-2.2)) as any;
    const hit = near.mul(near).mul(depth).mul(u.sweep).mul(s.greaterThan(0).select(float(1), float(0))) as any;
    a.addAssign(off.div(offLength.add(1e-3)).mul(hit.mul(16)));
    a.addAssign(u.hand.sub(v).mul(hit.mul(3.5)));

    // Holding: drawn in to the pointer and whirled round it, slowing as they gather there so they make a knot of light
    // rather than a point.
    const inward = toHold.div(holdDistance.add(1e-3)) as any;
    const draw = smoothstep(0.06, 0.45, holdDistance).div(holdDistance.mul(0.6).add(1)) as any;
    a.addAssign(inward.mul(u.hold.mul(draw).mul(20)));
    const whirl = cross(u.eye, toHold) as any;
    a.addAssign(whirl.div(length(whirl).add(1e-3)).mul(u.hold.mul(exp(holdDistance.mul(-1.4))).mul(7)));
    v.mulAssign(float(1).sub(u.hold.mul(exp(holdDistance.mul(-3))).mul(dt).mul(2.5)));

    // A burst: thrown out from where it went off, harder the nearer, each mote at its own pace.
    const fromBurst = p.sub(u.burstAt).add(vec3(rnd(seed, 5), rnd(seed, 6), rnd(seed, 7)).sub(0.5).mul(0.02)) as any;
    const burstDistance = length(fromBurst) as any;
    const burstDir = fromBurst.div(burstDistance.add(1e-4)) as any;
    v.addAssign(burstDir.mul(u.burst.mul(exp(burstDistance.mul(-0.55))).mul(rnd(seed, 8).mul(0.8).add(0.6))));

    // Step: a little air drag, a ceiling on speed, then move.
    v.addAssign(a.mul(dt));
    v.mulAssign(exp(dt.mul(-0.35)));
    const speed = length(v) as any;
    v.mulAssign(min(float(1), float(11).div(speed.add(1e-4))));
    p.addAssign(v.mul(dt));

    // Anything flung too far, or gone wrong, comes back as a new mote on the shell.
    const lost = length(p.div(R)).greaterThan(6).or(speed.notEqual(speed)) as any;
    If(lost, () => {
      const z = rnd(seed, 9).mul(2).sub(1).toVar() as any;
      const turn = rnd(seed, 10).add(u.time.mul(0.013)).mul(Math.PI * 2) as any;
      const ring = max(float(1).sub(z.mul(z)), float(0)).sqrt() as any;
      p.assign((vec3 as any)(cos(turn).mul(ring), z, sin(turn).mul(ring)).mul(R).mul(layer));
      v.assign(vec3(0));
    });

    const heat = mix(V.w, length(v), float(1).sub(exp(dt.mul(-8)))) as any;
    P.assign(vec4(p, seed));
    V.assign(vec4(v, heat));
  })().compute(count);

  // Drawing: a little square for each mote, turned to the eye and stretched back along the way it is moving, glowing
  // brighter the faster it goes.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);

  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false });
  {
    const P = pos.element(instanceIndex) as any;
    const V = vel.element(instanceIndex) as any;
    const seed = P.w as any;
    const centre = P.xyz as any;
    const moving = V.xyz as any;
    const { kind } = role(seed);
    const stray = kind.equal(0) as any;
    const inner = kind.equal(1) as any;
    const toEye = cameraPosition.sub(centre) as any;
    const distance = length(toEye) as any;
    const facing = toEye.div(distance) as any;
    // The motion seen across the view, which the streak is drawn along.
    const across = moving.sub(facing.mul(dot(moving, facing))) as any;
    const acrossLength = length(across) as any;
    const sideways = normalize0(cross(vec3(0, 1, 0), facing), vec3(1, 0, 0)) as any;
    const longAxis = acrossLength.greaterThan(1e-4).select(across.div(acrossLength.add(1e-6)), sideways) as any;
    const shortAxis = normalize0(cross(facing, longAxis), vec3(0, 1, 0)) as any;
    // Its size: tiny, a few millimetres, but never under about a pixel so far motes do not flicker away.
    const size = stray.select(float(0.011), inner.select(float(0.006), float(0.0045))).mul(rnd(seed, 11).mul(0.8).add(0.6)) as any;
    const radius = max(size, distance.mul(u.pixel).mul(1.1)) as any;
    const streak = acrossLength.mul(0.045) as any;
    const corner = positionGeometry as any;
    const reachBack = corner.x.lessThan(0).select(radius.add(streak.mul(2)), radius) as any;
    (material as any).positionNode = centre.add(longAxis.mul(corner.x.mul(reachBack))).add(shortAxis.mul(corner.y.mul(radius)));

    // Its colour: gold at rest, white-hot when fast, deep violet on the side turned from the moon; a slow firefly
    // flicker of its own, and now and then one that flares.
    const heat = smoothstep(0.35, 3.2, V.w) as any;
    const key = vec3(-0.55, 0.65, 0.5).normalize() as any;
    const out = centre.div(length(centre).add(1e-4)) as any;
    const dark = smoothstep(0.3, -0.65, dot(out, key)).mul(float(1).sub(heat)) as any;
    const tint = mix(mix(u.rest, u.hot.mul(2.6), heat), u.shadow.mul(0.85), dark.mul(0.85)) as any;
    const rate = rnd(seed, 12).mul(3).add(0.8) as any;
    const flicker = sin(u.time.mul(rate).add(rnd(seed, 13).mul(6.283))).mul(0.5).add(0.5) as any;
    const flare = rnd(seed, 14).lessThan(0.03).select(pow(flicker, float(10)).mul(5), float(0)) as any;
    const twinkle = flicker.mul(0.6).add(0.45).add(flare) as any;
    // Close to the core they catch more of its light.
    const lit = exp(length(centre).mul(-2.4)).mul(2.2).add(0.75) as any;
    // A mote smaller than a pixel is spread over one and dims; a streak spreads the same light along its length.
    const spread = size.div(radius).mul(radius.div(radius.add(streak))) as any;
    const kindGain = stray.select(float(0.35), inner.select(float(0.8), float(1))) as any;
    const brightness = twinkle.mul(lit).mul(spread).mul(kindGain).mul(u.gain) as any;
    material.colorNode = varying(tint.mul(brightness)) as any;
    // A soft round glow, its tail fading.
    const uvq = varying(vec2(corner.x, corner.y)) as any;
    const glow = exp(dot(uvq, uvq).mul(-4.2)) as any;
    material.opacityNode = glow.mul(smoothstep(-1.1, 0.4, uvq.x).mul(0.75).add(0.25)) as any;
  }

  const mesh = new THREE.Mesh(geometry, material);
  mesh.count = count;
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.raycast = () => null;

  const dispose = () => {
    geometry.dispose();
    material.dispose();
    (step as any).dispose?.();
  };
  return { u, step, mesh, count, dispose };
}

// A direction, or a fallback where it would be zero.
function normalize0(v: any, fallback: any) {
  const l = length(v) as any;
  return l.greaterThan(1e-5).select(v.div(l.add(1e-7)), fallback);
}

export type Swarm = ReturnType<typeof createSwarm>;

// The core: a hot breathing light at the middle, a billboard of two falloffs, a soft wide glow and a white-hot heart.
export function createCore() {
  const geometry = new THREE.PlaneGeometry(2, 2);
  const u = { colour: uniform(new THREE.Color()), glow: uniform(1) };
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false });
  const at = varying(positionGeometry.xy) as any;
  const d = length(at) as any;
  const fade = smoothstep(1, 0.55, d) as any;
  const wide = exp(d.mul(-5.5)).mul(0.5) as any;
  const heart = exp(d.mul(d).mul(-160)).mul(3.5) as any;
  const halo = exp(d.mul(d).mul(-28)).mul(1.2) as any;
  const white = vec3(1, 0.96, 0.88) as any;
  material.colorNode = u.colour.mul(wide.add(halo)).add(white.mul(heart)).mul(fade).mul(u.glow) as any;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  mesh.raycast = () => null;
  const dispose = () => {
    geometry.dispose();
    material.dispose();
  };
  return { u, mesh, dispose };
}
