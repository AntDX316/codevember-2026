import { sound } from "../../shared/engine/sound";

// Thunder, close by: a hard crack as the return stroke tears the air, a sub drop under it, then a long, uneven roll as
// the sound comes back from the channel's far parts. Noise is made once a context and kept.
let cached: { context: AudioContext; white: AudioBuffer; brown: AudioBuffer } | null = null;
function buffers(context: AudioContext) {
  if (cached?.context === context) return cached;
  const length = Math.floor(context.sampleRate * 4);
  const white = context.createBuffer(1, length, context.sampleRate);
  const brown = context.createBuffer(1, length, context.sampleRate);
  const w = white.getChannelData(0);
  const b = brown.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i++) {
    w[i] = Math.random() * 2 - 1;
    last = (last + 0.02 * w[i]) / 1.02;
    b[i] = last * 3.5;
  }
  cached = { context, white, brown };
  return cached;
}

const envelope = (context: AudioContext, at: number, points: [number, number][]) => {
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  for (const [time, value] of points) gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, value), at + time);
  return gain;
};

export function thunder() {
  sound.custom((context, out, at) => {
    const { white, brown } = buffers(context);
    // The crack: bright noise, gone in a fifth of a second.
    const crack = context.createBufferSource();
    crack.buffer = white;
    const high = context.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 1200;
    const crackGain = envelope(context, at, [
      [0.003, 0.9],
      [0.05, 0.35],
      [0.22, 0.0001]
    ]);
    crack.connect(high).connect(crackGain).connect(out);
    crack.start(at);
    crack.stop(at + 0.25);

    // The drop: a sine falling under the crack.
    const sub = context.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(70, at);
    sub.frequency.exponentialRampToValueAtTime(32, at + 1.2);
    const subGain = envelope(context, at, [
      [0.01, 0.8],
      [1.4, 0.0001]
    ]);
    sub.connect(subGain).connect(out);
    sub.start(at);
    sub.stop(at + 1.5);

    // The roll: low noise swelling in uneven waves for a few seconds.
    const roll = context.createBufferSource();
    roll.buffer = brown;
    const low = context.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.setValueAtTime(420, at);
    low.frequency.exponentialRampToValueAtTime(110, at + 3.6);
    const points: [number, number][] = [[0.04, 0.9]];
    let t = 0.04;
    while (t < 3.4) {
      t += 0.18 + Math.random() * 0.35;
      points.push([t, (0.2 + Math.random() * 0.6) * Math.exp(-t / 1.6)]);
    }
    points.push([3.9, 0.0001]);
    const rollGain = envelope(context, at, points);
    roll.connect(low).connect(rollGain).connect(out);
    roll.start(at, Math.random());
    roll.stop(at + 4);
  });
}
