import { sound } from "../../shared/engine/sound";

// The clap, made from noise: a sharp crack of hands, a few slaps back off the walls, and the long wet tail of the garden
// ringing. Held longer, it grows a deep thump under it and a longer tail, more thunderclap than hands.

// The raw samples, worked out while the page is idle at the two usual rates, so a clap only copies them into buffers.
const TAIL_SECONDS = 3.2;
const samples = new Map<number, { noise: Float32Array; tail: [Float32Array, Float32Array] }>();

function samplesAt(rate: number) {
  const known = samples.get(rate);
  if (known) return known;
  const noise = new Float32Array(rate * 2);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1;
  // The garden's answer: noise dying away, brighter at first, then only the low end lingering.
  const length = Math.floor(rate * TAIL_SECONDS);
  const channel = () => {
    const data = new Float32Array(length);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      last += (Math.random() * 2 - 1 - last) * (0.85 - t * 0.8);
      data[i] = last * Math.pow(1 - t, 2.4) * Math.min(1, i / (rate * 0.012));
    }
    return data;
  };
  const made = { noise, tail: [channel(), channel()] as [Float32Array, Float32Array] };
  samples.set(rate, made);
  return made;
}

let held: { context: AudioContext; noise: AudioBuffer; tail: AudioBuffer } | null = null;

function buffers(context: AudioContext) {
  if (held && held.context === context) return held;
  const raw = samplesAt(context.sampleRate);
  const noise = context.createBuffer(1, raw.noise.length, context.sampleRate);
  noise.copyToChannel(raw.noise as Float32Array<ArrayBuffer>, 0);
  const tail = context.createBuffer(2, raw.tail[0].length, context.sampleRate);
  tail.copyToChannel(raw.tail[0] as Float32Array<ArrayBuffer>, 0);
  tail.copyToChannel(raw.tail[1] as Float32Array<ArrayBuffer>, 1);
  held = { context, noise, tail };
  return held;
}

// Works the samples out ahead of time, while the page is idle.
export function prepareClap() {
  const work = () => {
    samplesAt(48000);
    samplesAt(44100);
  };
  const idle = (window as unknown as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(work, { timeout: 3000 });
  else window.setTimeout(work, 1000);
}

// Makes the buffers as a press begins, so the clap on letting go never waits on them.
export function warmClap() {
  sound.custom((context) => {
    buffers(context);
  });
}

// `strength` from about 0.5 (a light clap) to 1.6 (held long).
export function clap(strength: number, pan: number) {
  sound.custom((context, out, at) => {
    const { noise } = buffers(context);
    const panner = context.createStereoPanner ? context.createStereoPanner() : null;
    if (panner) {
      panner.pan.value = Math.max(-0.8, Math.min(0.8, pan));
      panner.connect(out);
    }
    const dest: AudioNode = panner ?? out;
    const level = 0.55 + strength * 0.35;

    // The garden's tail, fed by the crack below.
    const room = context.createConvolver();
    room.buffer = buffers(context).tail;
    // A light clap's tail is cut short; a held one rings out.
    const roomLevel = context.createGain();
    roomLevel.gain.setValueAtTime(0.35 + strength * 0.25, at);
    roomLevel.gain.setTargetAtTime(0.0001, at + 0.3 + strength * 0.6, 0.25 + strength * 0.35);
    room.connect(roomLevel);
    roomLevel.connect(dest);

    // The crack of the hands: three bursts a few milliseconds apart, as palms meet.
    const source = context.createBufferSource();
    source.buffer = noise;
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 1100 + Math.random() * 300;
    band.Q.value = 0.9;
    const env = context.createGain();
    env.gain.setValueAtTime(0.0001, at);
    let t = at;
    for (let i = 0; i < 3; i++) {
      const peak = level * (i === 2 ? 1 : 0.5);
      env.gain.exponentialRampToValueAtTime(peak, t + 0.0015);
      t += 0.006 + Math.random() * 0.004;
      env.gain.exponentialRampToValueAtTime(peak * 0.15, t);
    }
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    source.connect(band);
    band.connect(env);
    env.connect(dest);
    env.connect(room);
    source.start(at, Math.random() * 1.5);
    source.stop(t + 0.12);

    // Slaps back off the house, the fence and the far wall, each later, softer and duller.
    for (const [delay, gain, cutoff] of [
      [0.035, 0.32, 3200],
      [0.061, 0.24, 2400],
      [0.083, 0.2, 1800],
      [0.13, 0.12, 1200]
    ]) {
      const d = context.createDelay(0.5);
      d.delayTime.value = delay * (0.9 + Math.random() * 0.2);
      const f = context.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = cutoff;
      const g = context.createGain();
      g.gain.value = gain;
      env.connect(d);
      d.connect(f);
      f.connect(g);
      g.connect(dest);
      g.connect(room);
    }

    // Held longer: a deep thump under it, as a thunderclap.
    const deep = Math.max(0, strength - 0.6);
    if (deep > 0) {
      const thump = context.createOscillator();
      thump.type = "sine";
      thump.frequency.setValueAtTime(95, at);
      thump.frequency.exponentialRampToValueAtTime(34, at + 0.6);
      const thumpEnv = context.createGain();
      thumpEnv.gain.setValueAtTime(0.0001, at);
      thumpEnv.gain.exponentialRampToValueAtTime(deep * 0.9, at + 0.012);
      thumpEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.7 + deep * 0.5);
      thump.connect(thumpEnv);
      thumpEnv.connect(dest);
      thumpEnv.connect(room);
      thump.start(at);
      thump.stop(at + 1.4);
    }
  });
}
