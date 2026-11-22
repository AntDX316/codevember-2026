import { sound } from "../../shared/engine/sound";

// The blob's voice, built on the engine's context. A call is a soft sung "oo": a sine with a breathy, formant-filtered
// edge, sliding down a little as it rings. Its echoes are the same call, scheduled at the very delays the shells leave
// at, each quieter, duller and further to one side, so every ghost you see is one you hear.

function voiceAt(context: AudioContext, out: AudioNode, at: number, pitch: number, level: number, length: number, dull: number, pan: number) {
  const panner = context.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  panner.connect(out);
  const tone = context.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = dull;
  tone.Q.value = 0.4;
  tone.connect(panner);
  const env = context.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(level, at + 0.025);
  env.gain.setTargetAtTime(level * 0.55, at + 0.04, 0.08);
  env.gain.setTargetAtTime(0, at + length * 0.45, length * 0.22);
  env.connect(tone);
  const glide = (osc: OscillatorNode, ratio: number) => {
    osc.frequency.setValueAtTime(pitch * ratio * 1.06, at);
    osc.frequency.exponentialRampToValueAtTime(pitch * ratio, at + 0.09);
    osc.frequency.exponentialRampToValueAtTime(pitch * ratio * 0.97, at + length);
  };
  const body = context.createOscillator();
  body.type = "sine";
  glide(body, 1);
  body.connect(env);
  // The breath of the vowel: a soft sawtooth through two formants of "oo".
  const reed = context.createOscillator();
  reed.type = "sawtooth";
  glide(reed, 1);
  const reedLevel = context.createGain();
  reedLevel.gain.value = 0.16;
  reed.connect(reedLevel);
  for (const [f, q] of [
    [320, 6],
    [880, 9]
  ]) {
    const formant = context.createBiquadFilter();
    formant.type = "bandpass";
    formant.frequency.value = f;
    formant.Q.value = q;
    reedLevel.connect(formant);
    formant.connect(env);
  }
  // A glassy partial an octave and a fifth up, short.
  const glass = context.createOscillator();
  glass.type = "sine";
  glide(glass, 3.0);
  const glassEnv = context.createGain();
  glassEnv.gain.setValueAtTime(0, at);
  glassEnv.gain.linearRampToValueAtTime(0.12, at + 0.01);
  glassEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
  glass.connect(glassEnv);
  glassEnv.connect(env);
  const end = at + length * 1.6 + 0.1;
  for (const o of [body, reed, glass]) {
    o.start(at);
    o.stop(end);
  }
}

// A call and its echoes: `repeats` copies `delay` seconds apart, each `fall` times the last.
export function call(pitch: number, repeats: number, delay: number, fall: number) {
  sound.custom((context, out, at) => {
    for (let k = 0; k < repeats; k++) {
      const level = 0.34 * Math.pow(fall, k);
      voiceAt(context, out, at + k * delay, pitch, level, 0.55 + k * 0.04, 3200 / (1 + k * 0.7), k === 0 ? 0 : (k % 2 ? -1 : 1) * Math.min(0.7, 0.2 + k * 0.12));
    }
  });
}

// A held voice: a steady sung tone with a slow vibrato, until let go. Returns the function that lets it go.
export function hold(pitch: number) {
  let release: (() => void) | null = null;
  sound.custom((context, out, at) => {
    const env = context.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.16, at + 0.3);
    const tone = context.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 2400;
    env.connect(tone);
    tone.connect(out);
    const body = context.createOscillator();
    body.type = "sine";
    body.frequency.value = pitch;
    const reed = context.createOscillator();
    reed.type = "sawtooth";
    reed.frequency.value = pitch;
    const reedLevel = context.createGain();
    reedLevel.gain.value = 0.12;
    reed.connect(reedLevel);
    for (const [f, q] of [
      [320, 6],
      [880, 9]
    ]) {
      const formant = context.createBiquadFilter();
      formant.type = "bandpass";
      formant.frequency.value = f;
      formant.Q.value = q;
      reedLevel.connect(formant);
      formant.connect(env);
    }
    const wobble = context.createOscillator();
    wobble.frequency.value = 5.1;
    const depth = context.createGain();
    depth.gain.setValueAtTime(0, at);
    depth.gain.linearRampToValueAtTime(pitch * 0.012, at + 0.8);
    wobble.connect(depth);
    depth.connect(body.frequency);
    depth.connect(reed.frequency);
    body.connect(env);
    for (const o of [body, reed, wobble]) o.start(at);
    release = () => {
      const now = context.currentTime;
      env.gain.cancelScheduledValues(now);
      env.gain.setValueAtTime(env.gain.value, now);
      env.gain.linearRampToValueAtTime(0, now + 0.12);
      for (const o of [body, reed, wobble]) o.stop(now + 0.15);
    };
  });
  return () => release?.();
}
