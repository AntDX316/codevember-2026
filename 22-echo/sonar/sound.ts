import { sound } from "../../shared/engine/sound";

// The chamber's voices, built on the engine's context and ending in its master. The pop is a sharp wet crack over a
// low thump; the hall hands it back as discrete echoes, one each time the visible wave comes home, each darker and
// quieter and from the other side, over a long hard-room tail. Pumping creaks like a stretched balloon.

let noise: AudioBuffer | null = null;
function hiss(context: AudioContext) {
  if (noise && noise.sampleRate === context.sampleRate) return noise;
  noise = context.createBuffer(1, Math.floor(context.sampleRate * 1.2), context.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return noise;
}

// A concrete hall's tail: stereo noise dying away over a few seconds, its top end dying first.
let hall: AudioBuffer | null = null;
function impulse(context: AudioContext) {
  if (hall && hall.sampleRate === context.sampleRate) return hall;
  const length = Math.floor(context.sampleRate * 3.2);
  hall = context.createBuffer(2, length, context.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = hall.getChannelData(c);
    let low = 0;
    for (let i = 0; i < length; i++) {
      const t = i / context.sampleRate;
      const white = Math.random() * 2 - 1;
      const dark = Math.min(1, t / 2.4);
      low += (white - low) * (0.6 - dark * 0.5);
      data[i] = (white * (1 - dark) + low * dark) * Math.exp(-t * 2.1) * (t < 0.012 ? t / 0.012 : 1);
    }
  }
  return hall;
}

function crack(context: AudioContext, into: AudioNode, at: number, level: number, bright: number) {
  const src = context.createBufferSource();
  src.buffer = hiss(context);
  const high = context.createBiquadFilter();
  high.type = "highpass";
  high.frequency.value = 700;
  const shade = context.createBiquadFilter();
  shade.type = "lowpass";
  shade.frequency.value = bright;
  const env = context.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(level, at + 0.002);
  env.gain.exponentialRampToValueAtTime(level * 0.2, at + 0.018);
  env.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
  src.connect(high);
  high.connect(shade);
  shade.connect(env);
  env.connect(into);
  src.start(at, Math.random() * 0.5);
  src.stop(at + 0.2);
  // The thump of the air let go.
  const osc = context.createOscillator();
  osc.frequency.setValueAtTime(150, at);
  osc.frequency.exponentialRampToValueAtTime(48, at + 0.18);
  const thump = context.createGain();
  thump.gain.setValueAtTime(0, at);
  thump.gain.linearRampToValueAtTime(level * 0.9, at + 0.004);
  thump.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
  osc.connect(thump);
  thump.connect(into);
  osc.start(at);
  osc.stop(at + 0.32);
}

// The pop, and its echoes `round` seconds apart, `strength` up to about 2 when it was pumped up first.
export function pop(round: number, levels: number[], pan: number, strength: number) {
  sound.custom((context, out, at) => {
    const tail = context.createConvolver();
    tail.buffer = impulse(context);
    const wet = context.createGain();
    wet.gain.value = 0.5;
    tail.connect(wet);
    wet.connect(out);
    const loud = Math.min(1.25, 0.7 + strength * 0.25);
    levels.forEach((level, k) => {
      const panner = context.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, k === 0 ? pan * 0.5 : (k % 2 ? -1 : 1) * 0.55 * Math.sign(pan || 1)));
      panner.connect(out);
      panner.connect(tail);
      crack(context, panner, at + k * round, loud * level * (k === 0 ? 1 : 0.85), k === 0 ? 14000 : 5200 / k);
    });
    window.setTimeout(() => wet.disconnect(), (levels.length * round + 3.6) * 1000);
  });
}

// The balloon's rubber creak while pumping: returns its controls, to set how hard and to let go.
export function creak() {
  let control: { set: (level: number) => void; stop: () => void } | null = null;
  sound.custom((context, out, at) => {
    const env = context.createGain();
    env.gain.setValueAtTime(0, at);
    env.connect(out);
    // Rubber sliding on itself: a buzzy tone through a narrow band that wanders, and a little friction hiss.
    const saw = context.createOscillator();
    saw.type = "sawtooth";
    saw.frequency.value = 96;
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 9;
    band.frequency.value = 900;
    const wander = context.createOscillator();
    wander.frequency.value = 3.1;
    const wanderDepth = context.createGain();
    wanderDepth.gain.value = 380;
    wander.connect(wanderDepth);
    wanderDepth.connect(band.frequency);
    const stutter = context.createOscillator();
    stutter.type = "square";
    stutter.frequency.value = 13;
    const stutterDepth = context.createGain();
    stutterDepth.gain.value = 22;
    stutter.connect(stutterDepth);
    stutterDepth.connect(saw.frequency);
    const g = context.createGain();
    g.gain.value = 0.14;
    saw.connect(band);
    band.connect(g);
    g.connect(env);
    const fric = context.createBufferSource();
    fric.buffer = hiss(context);
    fric.loop = true;
    const fricBand = context.createBiquadFilter();
    fricBand.type = "bandpass";
    fricBand.frequency.value = 2400;
    fricBand.Q.value = 2;
    const fricGain = context.createGain();
    fricGain.gain.value = 0.05;
    fric.connect(fricBand);
    fricBand.connect(fricGain);
    fricGain.connect(env);
    for (const o of [saw, wander, stutter]) o.start(at);
    fric.start(at);
    control = {
      set: (level) => {
        const now = context.currentTime;
        env.gain.setTargetAtTime(level * 0.5, now, 0.08);
        saw.frequency.setTargetAtTime(86 + level * 60, now, 0.2);
        band.frequency.setTargetAtTime(700 + level * 900, now, 0.2);
      },
      stop: () => {
        const now = context.currentTime;
        env.gain.cancelScheduledValues(now);
        env.gain.setTargetAtTime(0, now, 0.06);
        for (const o of [saw, wander, stutter, fric]) o.stop(now + 0.4);
      }
    };
  });
  return {
    set: (level: number) => control?.set(level),
    stop: () => control?.stop()
  };
}

// A new bubble starting to blow: a soft breath rising.
export function breath() {
  sound.custom((context, out, at) => {
    const src = context.createBufferSource();
    src.buffer = hiss(context);
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 1.2;
    band.frequency.setValueAtTime(500, at);
    band.frequency.exponentialRampToValueAtTime(1400, at + 1.1);
    const env = context.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.05, at + 0.4);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 1.2);
    src.connect(band);
    band.connect(env);
    env.connect(out);
    src.start(at);
    src.stop(at + 1.2);
  });
}
