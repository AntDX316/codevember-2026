import { sound } from "../../shared/engine/sound";

// The day's own sounds, made with the engine's `custom` hook: the crack of a discharge, its crackle as the figure runs
// through the block, the block ringing as it cools, the hum of a charge building under a held press, and the odd tick
// of stressed acrylic settling.

const noises = new WeakMap<BaseAudioContext, AudioBuffer>();
function noise(context: BaseAudioContext) {
  let buffer = noises.get(context);
  if (!buffer) {
    buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noises.set(context, buffer);
  }
  return buffer;
}

function burst(context: AudioContext, out: AudioNode, at: number, type: BiquadFilterType, frequency: number, q: number, attack: number, decay: number, gain: number) {
  const source = context.createBufferSource();
  source.buffer = noise(context);
  const filter = context.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0.0001, at);
  envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + attack);
  envelope.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  source.connect(filter);
  filter.connect(envelope);
  envelope.connect(out);
  source.start(at, Math.random() * 1.5);
  source.stop(at + attack + decay + 0.05);
}

function tone(context: AudioContext, out: AudioNode, at: number, type: OscillatorType, from: number, to: number, attack: number, decay: number, gain: number) {
  const oscillator = context.createOscillator();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(from, at);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + attack + decay);
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0.0001, at);
  envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + attack);
  envelope.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  oscillator.connect(envelope);
  envelope.connect(out);
  oscillator.start(at);
  oscillator.stop(at + attack + decay + 0.05);
}

// The strike: a hard, bright snap with a low thump under it, bigger for a bigger charge.
export function crack(size: number) {
  sound.custom((context, out, at) => {
    burst(context, out, at, "highpass", 1800, 0.7, 0.001, 0.07 + size * 0.05, 0.75);
    burst(context, out, at, "bandpass", 4200, 1.2, 0.001, 0.03, 0.5);
    tone(context, out, at, "sine", 140, 42, 0.003, 0.28 + size * 0.2, 0.55 + size * 0.25);
    tone(context, out, at, "square", 3100, 600, 0.001, 0.03, 0.06);
  });
}

// The discharge running through the block: a dense electric crackle that thins as it spreads, over `seconds`. One
// noise source whose loudness jumps about at random, so it costs a handful of nodes however long it runs.
export function crackle(seconds: number, size: number) {
  sound.custom((context, out, at) => {
    const source = context.createBufferSource();
    source.buffer = noise(context);
    source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.setValueAtTime(2600, at);
    filter.frequency.exponentialRampToValueAtTime(5200, at + seconds);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    const steps = Math.round(20 + seconds * 40);
    for (let i = 0; i < steps; i++) {
      const f = i / steps;
      const t = at + f * seconds;
      const pop = Math.random() < 0.35 ? (0.08 + Math.random() * 0.22) * (1 - f * 0.7) * (0.7 + size * 0.5) : 0.002;
      envelope.gain.setValueAtTime(Math.max(0.0002, pop), t);
      envelope.gain.setValueAtTime(0.0002, t + 0.004 + Math.random() * 0.012);
    }
    envelope.gain.setValueAtTime(0.0001, at + seconds + 0.02);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(out);
    source.start(at, Math.random());
    source.stop(at + seconds + 0.05);
    // A thin buzz under it, falling as the figure spreads.
    tone(context, out, at, "sawtooth", 180, 70, 0.01, seconds + 0.1, 0.035);
  });
}

// The block rings as the figure locks in: a few glassy partials, soft and long.
export function ring(size: number) {
  sound.custom((context, out, at) => {
    const base = 1650 + Math.random() * 500;
    [1, 2.76, 5.4, 8.9].forEach((ratio, i) => {
      const f = base * ratio * (0.995 + Math.random() * 0.01);
      tone(context, out, at + i * 0.004, "sine", f, f * 0.998, 0.002, 0.9 - i * 0.15, (0.05 - i * 0.009) * (0.7 + size * 0.4));
    });
    tone(context, out, at, "sine", 92, 60, 0.01, 0.5, 0.18);
  });
}

// Stressed acrylic settling now and then: a tiny high tick.
export function settle() {
  sound.custom((context, out, at) => {
    const f = 3800 + Math.random() * 3000;
    tone(context, out, at, "sine", f, f * 0.97, 0.001, 0.05 + Math.random() * 0.05, 0.02 + Math.random() * 0.02);
    burst(context, out, at, "highpass", 6000, 0.7, 0.001, 0.01, 0.025);
  });
}

// A charge building under a held press: a hum that rises and brightens until let go. Returns a stop.
export function charging(): () => void {
  let stop = () => {};
  sound.custom((context, out, at) => {
    const hum = context.createOscillator();
    hum.type = "sawtooth";
    hum.frequency.setValueAtTime(70, at);
    hum.frequency.exponentialRampToValueAtTime(240, at + 1.6);
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(300, at);
    filter.frequency.exponentialRampToValueAtTime(2400, at + 1.6);
    const fizz = context.createBufferSource();
    fizz.buffer = noise(context);
    fizz.loop = true;
    const fizzFilter = context.createBiquadFilter();
    fizzFilter.type = "highpass";
    fizzFilter.frequency.value = 5000;
    const fizzGain = context.createGain();
    fizzGain.gain.setValueAtTime(0.0001, at);
    fizzGain.gain.exponentialRampToValueAtTime(0.05, at + 1.6);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(0.09, at + 0.25);
    envelope.gain.exponentialRampToValueAtTime(0.16, at + 1.6);
    hum.connect(filter);
    filter.connect(envelope);
    fizz.connect(fizzFilter);
    fizzFilter.connect(fizzGain);
    fizzGain.connect(envelope);
    envelope.connect(out);
    hum.start(at);
    fizz.start(at);
    stop = () => {
      const now = context.currentTime;
      envelope.gain.cancelScheduledValues(now);
      envelope.gain.setValueAtTime(Math.max(0.0002, envelope.gain.value), now);
      envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
      hum.stop(now + 0.08);
      fizz.stop(now + 0.08);
    };
  });
  return () => stop();
}
