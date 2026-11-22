import { sound } from "../../shared/engine/sound";

// Sonar. A pulse is a bright glassy ping with a soft thump under it; each echo is the same ping coming back from a knot
// in the smoke, at the moment its shell is seen to leave that knot: quieter, duller, lower, and off to the side the knot
// lies, each knot with a note of its own, so the cloud's inside is heard as a chord spelled out in time.

function ping(context: AudioContext, out: AudioNode, at: number, pitch: number, level: number, dull: number, pan: number, thump: number) {
  const panner = context.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  panner.connect(out);
  const tone = context.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = dull;
  tone.Q.value = 0.5;
  tone.connect(panner);
  const env = context.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(level, at + 0.004);
  env.gain.exponentialRampToValueAtTime(level * 0.3, at + 0.12);
  env.gain.exponentialRampToValueAtTime(0.0001, at + 1.4);
  env.connect(tone);
  const body = context.createOscillator();
  body.type = "sine";
  body.frequency.setValueAtTime(pitch * 1.03, at);
  body.frequency.exponentialRampToValueAtTime(pitch, at + 0.05);
  body.frequency.exponentialRampToValueAtTime(pitch * 0.985, at + 1.4);
  body.connect(env);
  // A glassy partial, slightly out of tune with the body so it beats, gone quickly.
  const glass = context.createOscillator();
  glass.type = "sine";
  glass.frequency.value = pitch * 2.76;
  const glassEnv = context.createGain();
  glassEnv.gain.setValueAtTime(0, at);
  glassEnv.gain.linearRampToValueAtTime(0.28, at + 0.003);
  glassEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.4);
  glass.connect(glassEnv);
  glassEnv.connect(env);
  const nodes: OscillatorNode[] = [body, glass];
  if (thump > 0) {
    const low = context.createOscillator();
    low.type = "sine";
    low.frequency.setValueAtTime(140, at);
    low.frequency.exponentialRampToValueAtTime(48, at + 0.25);
    const lowEnv = context.createGain();
    lowEnv.gain.setValueAtTime(0, at);
    lowEnv.gain.linearRampToValueAtTime(thump, at + 0.006);
    lowEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.4);
    low.connect(lowEnv);
    lowEnv.connect(out);
    nodes.push(low);
  }
  for (const o of nodes) {
    o.start(at);
    o.stop(at + 1.5);
  }
}

export type Return = { delay: number; pitch: number; level: number; pan: number };

// A pulse and its echoes, each at its own delay.
export function sonar(pitch: number, level: number, returns: Return[]) {
  sound.custom((context, out, at) => {
    ping(context, out, at, pitch, 0.3 * level, 5200, 0, 0.32 * level);
    for (const r of returns) ping(context, out, at + r.delay, r.pitch, 0.3 * level * r.level, 1500 + r.level * 1800, r.pan, 0);
  });
}
