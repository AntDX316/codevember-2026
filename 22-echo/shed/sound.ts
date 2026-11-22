import { sound } from "../../shared/engine/sound";

// The form's voice, built on the engine's context. A strike is a stone knock: a dull thump, a click, and a few
// inharmonic partials as a lithophone rings, with a hiss of dust coming off behind it. Each time the front closes on
// itself (at the far side, then back where it was struck) the knock comes again, quieter, duller and to one side.

let noise: AudioBuffer | null = null;
function noiseOf(context: AudioContext) {
  if (noise && noise.sampleRate === context.sampleRate) return noise;
  noise = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
  const data = noise.getChannelData(0);
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    // Pink-ish: white noise lightly smoothed.
    b = b * 0.6 + (Math.random() * 2 - 1) * 0.4;
    data[i] = b;
  }
  return noise;
}

const PARTIALS = [
  [1, 1, 1.6],
  [2.76, 0.45, 0.8],
  [5.4, 0.22, 0.45],
  [8.93, 0.1, 0.25]
];

function knock(context: AudioContext, out: AudioNode, at: number, pitch: number, level: number, dull: number, pan: number) {
  const panner = context.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  panner.connect(out);
  const tone = context.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = dull;
  tone.connect(panner);
  // The thump.
  const body = context.createOscillator();
  body.type = "sine";
  body.frequency.setValueAtTime(140, at);
  body.frequency.exponentialRampToValueAtTime(52, at + 0.18);
  const bodyEnv = context.createGain();
  bodyEnv.gain.setValueAtTime(0, at);
  bodyEnv.gain.linearRampToValueAtTime(level * 0.9, at + 0.004);
  bodyEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.32);
  body.connect(bodyEnv);
  bodyEnv.connect(tone);
  body.start(at);
  body.stop(at + 0.35);
  // The ring of the stone.
  for (const [ratio, gain, length] of PARTIALS) {
    const o = context.createOscillator();
    o.type = "sine";
    o.frequency.value = pitch * ratio;
    const env = context.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(level * gain * 0.32, at + 0.003);
    env.gain.exponentialRampToValueAtTime(0.0001, at + length);
    o.connect(env);
    env.connect(tone);
    o.start(at);
    o.stop(at + length + 0.05);
  }
  // The click.
  const click = context.createBufferSource();
  click.buffer = noiseOf(context);
  const clickFilter = context.createBiquadFilter();
  clickFilter.type = "bandpass";
  clickFilter.frequency.value = 3200;
  clickFilter.Q.value = 0.9;
  const clickEnv = context.createGain();
  clickEnv.gain.setValueAtTime(level * 0.5, at);
  clickEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.03);
  click.connect(clickFilter);
  clickFilter.connect(clickEnv);
  clickEnv.connect(tone);
  click.start(at, Math.random());
  click.stop(at + 0.05);
}

// Dust coming away: a soft rising hiss with grains in it, about as long as a pass.
function hiss(context: AudioContext, out: AudioNode, at: number, level: number, length: number, pan: number) {
  const panner = context.createStereoPanner();
  panner.pan.value = pan;
  panner.connect(out);
  const src = context.createBufferSource();
  src.buffer = noiseOf(context);
  const band = context.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.setValueAtTime(2200, at);
  band.frequency.linearRampToValueAtTime(5200, at + length);
  band.Q.value = 0.7;
  const env = context.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(level, at + length * 0.25);
  env.gain.exponentialRampToValueAtTime(0.0001, at + length);
  src.connect(band);
  band.connect(env);
  env.connect(panner);
  src.start(at, Math.random());
  src.stop(at + length + 0.05);
  // Grains: tiny ticks of dust.
  for (let i = 0; i < 10; i++) {
    const t = at + Math.random() * length * 0.9;
    const g = context.createBufferSource();
    g.buffer = noiseOf(context);
    const f = context.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = 4500 + Math.random() * 3000;
    const e = context.createGain();
    e.gain.setValueAtTime(level * (0.6 + Math.random()), t);
    e.gain.exponentialRampToValueAtTime(0.0001, t + 0.012 + Math.random() * 0.02);
    g.connect(f);
    f.connect(e);
    e.connect(panner);
    g.start(t, Math.random());
    g.stop(t + 0.05);
  }
}

// A strike and its echoes: one knock now, then one each time the front closes, `pass` seconds apart, each `fall` of
// the last.
export function strike(pitch: number, level: number, passes: number, pass: number, fall: number) {
  sound.custom((context, out, at) => {
    for (let k = 0; k <= passes; k++) {
      const a = level * Math.pow(fall, k);
      const pan = k === 0 ? 0 : (k % 2 ? 0.45 : -0.35) * Math.min(1, 0.6 + k * 0.15);
      if (k > 0) knock(context, out, at + k * pass, pitch * (k % 2 ? 0.995 : 1.0), a * 0.9, 2600 / (1 + k * 0.6), pan);
      else knock(context, out, at, pitch, a, 6000, 0);
      if (k < passes) hiss(context, out, at + k * pass + 0.02, a * 0.05, pass * 0.95, -pan * 0.5);
    }
  });
}

// A hum while held: the stone's two lowest partials sounding together with a slow beat. Returns the function that
// lets it go.
export function hum(pitch: number) {
  let release: (() => void) | null = null;
  sound.custom((context, out, at) => {
    const env = context.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.11, at + 0.35);
    env.connect(out);
    const parts = [
      [1, 1],
      [1.004, 0.7],
      [2.76, 0.18]
    ].map(([ratio, gain]) => {
      const o = context.createOscillator();
      o.type = "sine";
      o.frequency.value = pitch * ratio;
      const g = context.createGain();
      g.gain.value = gain;
      o.connect(g);
      g.connect(env);
      o.start(at);
      return o;
    });
    // The dust coming off all the while.
    const src = context.createBufferSource();
    src.buffer = noiseOf(context);
    src.loop = true;
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 3800;
    band.Q.value = 0.6;
    const level = context.createGain();
    level.gain.value = 0.16;
    src.connect(band);
    band.connect(level);
    level.connect(env);
    src.start(at);
    release = () => {
      const now = context.currentTime;
      env.gain.cancelScheduledValues(now);
      env.gain.setValueAtTime(env.gain.value, now);
      env.gain.linearRampToValueAtTime(0, now + 0.25);
      for (const o of parts) o.stop(now + 0.3);
      src.stop(now + 0.3);
    };
  });
  return () => release?.();
}
