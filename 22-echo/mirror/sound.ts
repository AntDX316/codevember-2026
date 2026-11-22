import { sound } from "../../shared/engine/sound";

// The pop and its echoes, built on the engine's context and ending in its master (from the pop version, stretched for a
// hall of mirrors). The pop is a wet click: a burst of air through a bright band, a tone falling fast from high to low,
// and a soft thump. Each echo plays it again a beat later, as the next ring of reflections bursts: quieter, darker, a
// little lower and swinging side to side, under a hard room's hiss of a tail. Pumping creaks: a rubbery stick-slip drone
// that rises as the film stretches.

let noise: AudioBuffer | null = null;
function air(context: AudioContext) {
  if (noise && noise.sampleRate === context.sampleRate) return noise;
  noise = context.createBuffer(1, Math.floor(context.sampleRate * 0.5), context.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return noise;
}

const envelope = (context: AudioContext, into: AudioNode, at: number, level: number, attack: number, decay: number) => {
  const env = context.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(level, at + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  env.connect(into);
  return env;
};

const sweep = (context: AudioContext, into: AudioNode, at: number, from: number, to: number, glide: number, level: number, decay: number) => {
  const osc = context.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + glide);
  osc.connect(envelope(context, into, at, level, 0.0015, decay));
  osc.start(at);
  osc.stop(at + decay + 0.05);
};

const burst = (context: AudioContext, into: AudioNode, at: number, centre: number, q: number, level: number, decay: number, offset = 0) => {
  const src = context.createBufferSource();
  src.buffer = air(context);
  const band = context.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = centre;
  band.Q.value = q;
  src.connect(band);
  band.connect(envelope(context, into, at, level, 0.001, decay));
  src.start(at, offset);
  src.stop(at + decay + 0.05);
};

function one(context: AudioContext, out: AudioNode, at: number, k: number, size: number) {
  const level = k === 0 ? 1 : 0.5 * Math.pow(0.68, k - 1);
  const shade = k === 0 ? 16000 : 5600 / (1 + (k - 1) * 0.45);
  const pitch = Math.pow(0.955, k) * (1.15 - size * 0.3);
  const pan = k === 0 ? 0 : (k % 2 ? -1 : 1) * Math.min(0.75, 0.25 + k * 0.08);
  const panner = context.createStereoPanner();
  panner.pan.value = pan;
  panner.connect(out);
  const dark = context.createBiquadFilter();
  dark.type = "lowpass";
  dark.frequency.value = shade;
  dark.connect(panner);
  // The wet pop: the tone falling fast, its octave, the air's crack, and the soft thump under it.
  sweep(context, dark, at, 1500 * pitch, 210 * pitch, 0.04, 0.5 * level, 0.09);
  sweep(context, dark, at, 2900 * pitch, 520 * pitch, 0.025, 0.12 * level, 0.05);
  burst(context, dark, at, 3400 * pitch, 0.8, 0.55 * level, 0.03, Math.random() * 0.3);
  sweep(context, dark, at, 150 * pitch, 62 * pitch, 0.09, 0.42 * level, 0.16);
  // Echoes come back smeared: a breath of the room after each.
  if (k > 0) burst(context, dark, at + 0.01, 1800 * pitch, 0.6, 0.07 * level, 0.22 + k * 0.05, Math.random() * 0.2);
  window.setTimeout(() => panner.disconnect(), (at - context.currentTime + 1.2) * 1000);
}

// A pop at once and its echoes every `delay` seconds after. `size` 0 to 1: a pumped bubble pops a little lower.
export function pop(delay: number, echoes: number, size: number) {
  sound.custom((context, out, at) => {
    for (let k = 0; k <= echoes; k++) one(context, out, at + k * delay, k, size);
    // The hard room's tail: hiss darkening as it dies away over the echoes.
    const src = context.createBufferSource();
    src.buffer = air(context);
    src.loop = true;
    const dark = context.createBiquadFilter();
    dark.type = "lowpass";
    dark.frequency.setValueAtTime(5000, at);
    dark.frequency.exponentialRampToValueAtTime(500, at + delay * echoes);
    src.connect(dark);
    const env = context.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.035, at + 0.03);
    env.gain.exponentialRampToValueAtTime(0.0001, at + delay * echoes + 0.4);
    dark.connect(env);
    env.connect(out);
    src.start(at);
    src.stop(at + delay * echoes + 0.5);
    // Droplets: a few glassy ticks scattered through the first moments.
    for (let i = 0; i < 7; i++) {
      const when = at + 0.04 + Math.random() * 0.5;
      const f = 3800 + Math.random() * 3200;
      const panner = context.createStereoPanner();
      panner.pan.value = Math.random() * 1.4 - 0.7;
      panner.connect(out);
      sweep(context, panner, when, f, f * 0.92, 0.02, 0.018 + Math.random() * 0.02, 0.05);
      window.setTimeout(() => panner.disconnect(), (when - context.currentTime + 0.5) * 1000);
    }
  });
}

// The creak while pumping: returns its controls, to set how hard it strains and to let it go.
export function creak() {
  let control: { set: (level: number, stretch: number) => void; stop: () => void } | null = null;
  sound.custom((context, out, at) => {
    const master = context.createGain();
    master.gain.setValueAtTime(0, at);
    master.connect(out);
    const rub = context.createOscillator();
    rub.type = "sawtooth";
    rub.frequency.value = 95;
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 700;
    band.Q.value = 5;
    // Stick-slip: the sound comes in rapid catches, not a steady tone.
    const catches = context.createGain();
    catches.gain.value = 0;
    const slip = context.createOscillator();
    slip.type = "square";
    slip.frequency.value = 19;
    const slipDepth = context.createGain();
    slipDepth.gain.value = 0.5;
    slip.connect(slipDepth);
    slipDepth.connect(catches.gain);
    const bias = context.createConstantSource();
    bias.offset.value = 0.5;
    bias.connect(catches.gain);
    rub.connect(band);
    band.connect(catches);
    catches.connect(master);
    // And the film's faint squeak above it.
    const squeak = context.createOscillator();
    squeak.type = "triangle";
    squeak.frequency.value = 900;
    const squeakGain = context.createGain();
    squeakGain.gain.value = 0.18;
    squeak.connect(squeakGain);
    squeakGain.connect(catches);
    rub.start(at);
    slip.start(at);
    bias.start(at);
    squeak.start(at);
    control = {
      set: (level, stretch) => {
        const now = context.currentTime;
        const wander = 1 + Math.sin(now * 3.1) * 0.04 + Math.sin(now * 7.3) * 0.02;
        rub.frequency.setTargetAtTime((85 + stretch * 95) * wander, now, 0.08);
        band.frequency.setTargetAtTime((600 + stretch * 900) * wander, now, 0.08);
        slip.frequency.setTargetAtTime(16 + stretch * 14 + Math.sin(now * 5) * 3, now, 0.05);
        squeak.frequency.setTargetAtTime((820 + stretch * 700) * wander, now, 0.1);
        master.gain.setTargetAtTime(0.07 * level, now, 0.06);
      },
      stop: () => {
        const now = context.currentTime;
        master.gain.cancelScheduledValues(now);
        master.gain.setTargetAtTime(0, now, 0.05);
        for (const node of [rub, slip, bias, squeak]) node.stop(now + 0.4);
      }
    };
  });
  return {
    set: (level: number, stretch: number) => control?.set(level, stretch),
    stop: () => control?.stop()
  };
}
