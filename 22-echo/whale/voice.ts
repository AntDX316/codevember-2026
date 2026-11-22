import { sound } from "../../shared/engine/sound";

// Two sounds, made here: the ping of a call sent into the dark (and, quieter and duller, its echo coming back), and
// the whale's answer, a long rising and falling moan. Both go through a long wash of reverb, as sound carries in deep
// water.

let hall: { context: AudioContext; buffer: AudioBuffer } | null = null;

// A reverb's impulse: noise dying away over a few seconds, darker as it goes.
function wash(context: AudioContext) {
  if (hall && hall.context === context) return hall.buffer;
  const seconds = 4.5;
  const buffer = context.createBuffer(2, Math.round(context.sampleRate * seconds), context.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    let low = 0;
    for (let i = 0; i < data.length; i++) {
      const t = i / context.sampleRate;
      low += (Math.random() * 2 - 1 - low) * Math.max(0.04, 0.5 * Math.exp(-t * 1.2));
      data[i] = low * Math.exp(-t * 1.3) * (t < 0.02 ? t / 0.02 : 1);
    }
  }
  hall = { context, buffer };
  return buffer;
}

function route(context: AudioContext, out: AudioNode, pan: number, wet: number) {
  const input = context.createGain();
  const panner = context.createStereoPanner ? context.createStereoPanner() : null;
  if (panner) {
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    input.connect(panner);
    panner.connect(out);
  } else input.connect(out);
  const verb = context.createConvolver();
  verb.buffer = wash(context);
  const send = context.createGain();
  send.gain.value = wet;
  input.connect(send);
  send.connect(verb);
  verb.connect(out);
  return input;
}

// The ping: a clean high tone struck and ringing away, with a soft knock at its start. `far` from 0 (sent here) to 1
// (an echo from far off: quieter, duller, more of it reverb).
export function ping(gain: number, pitch: number, pan: number, far = 0) {
  sound.custom((context, out, at) => {
    const dest = route(context, out, pan, 0.5 + far * 0.6);
    const tone = context.createOscillator();
    tone.type = "sine";
    const f = 1180 * pitch * (1 - far * 0.08);
    tone.frequency.setValueAtTime(f * 1.01, at);
    tone.frequency.exponentialRampToValueAtTime(f, at + 0.08);
    const over = context.createOscillator();
    over.type = "sine";
    over.frequency.value = f * 2.76;
    const dull = context.createBiquadFilter();
    dull.type = "lowpass";
    dull.frequency.value = 6000 - far * 4200;
    const env = context.createGain();
    const ring = 1.3 - far * 0.4;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + 0.006 + far * 0.03);
    env.gain.exponentialRampToValueAtTime(gain * 0.3, at + 0.18);
    env.gain.exponentialRampToValueAtTime(0.0001, at + ring);
    const overEnv = context.createGain();
    overEnv.gain.setValueAtTime(gain * 0.12 * (1 - far), at);
    overEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
    tone.connect(env);
    over.connect(overEnv);
    overEnv.connect(env);
    env.connect(dull);
    dull.connect(dest);
    tone.start(at);
    over.start(at);
    tone.stop(at + ring + 0.05);
    over.stop(at + 0.3);
  });
}

// The whale's call: a voiced moan through two formants, gliding up, swelling and falling away, with a slow wobble.
export function moan(gain: number, pan: number, variant: number) {
  sound.custom((context, out, at) => {
    const dest = route(context, out, pan, 0.7);
    const seconds = 3.2 + variant * 0.8;
    const base = 150 + variant * 60;
    const voice = context.createOscillator();
    voice.type = "sawtooth";
    const glide = voice.frequency;
    glide.setValueAtTime(base * 0.8, at);
    glide.exponentialRampToValueAtTime(base * 1.6, at + seconds * 0.35);
    glide.exponentialRampToValueAtTime(base * 1.35, at + seconds * 0.6);
    glide.exponentialRampToValueAtTime(base * (variant > 0.5 ? 2.1 : 0.7), at + seconds);
    const wobble = context.createOscillator();
    wobble.frequency.value = 4.2;
    const wobbleDepth = context.createGain();
    wobbleDepth.gain.value = base * 0.025;
    wobble.connect(wobbleDepth);
    wobbleDepth.connect(glide);
    // Two formants, the second sweeping, which gives the call its vowel.
    const low = context.createBiquadFilter();
    low.type = "bandpass";
    low.frequency.value = 420;
    low.Q.value = 3;
    const high = context.createBiquadFilter();
    high.type = "bandpass";
    high.frequency.setValueAtTime(700, at);
    high.frequency.exponentialRampToValueAtTime(1300, at + seconds * 0.5);
    high.frequency.exponentialRampToValueAtTime(800, at + seconds);
    high.Q.value = 5;
    const soft = context.createBiquadFilter();
    soft.type = "lowpass";
    soft.frequency.value = 2400;
    const env = context.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + seconds * 0.3);
    env.gain.exponentialRampToValueAtTime(gain * 0.7, at + seconds * 0.7);
    env.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
    voice.connect(low);
    voice.connect(high);
    const highLevel = context.createGain();
    highLevel.gain.value = 0.6;
    high.connect(highLevel);
    low.connect(soft);
    highLevel.connect(soft);
    soft.connect(env);
    env.connect(dest);
    // A deep body under it that the speakers feel.
    const body = context.createOscillator();
    body.type = "sine";
    body.frequency.setValueAtTime(base * 0.4, at);
    body.frequency.exponentialRampToValueAtTime(base * 0.62, at + seconds * 0.4);
    body.frequency.exponentialRampToValueAtTime(base * 0.45, at + seconds);
    const bodyEnv = context.createGain();
    bodyEnv.gain.setValueAtTime(0.0001, at);
    bodyEnv.gain.exponentialRampToValueAtTime(gain * 0.9, at + seconds * 0.35);
    bodyEnv.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
    body.connect(bodyEnv);
    bodyEnv.connect(dest);
    for (const node of [voice, wobble, body]) {
      node.start(at);
      node.stop(at + seconds + 0.1);
    }
  });
}
