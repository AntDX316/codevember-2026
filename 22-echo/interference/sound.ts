import { sound } from "../../shared/engine/sound";

// The beacons' voices, built on the engine's context and ending in its master. A ping is a glassy sine with a soft
// octave above it, ringing out over a second and repeating twice more down a darkening delay, as an echo does in a
// hall; the sound coming back off the form is the same note, quieter and muffled. A held beacon sings a steady tone,
// with a slow shimmer, until it is let go.

function stereo(context: AudioContext, out: AudioNode, pan: number) {
  const panner = context.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  panner.connect(out);
  return panner;
}

export function ping(pitch: number, pan: number, gain = 1) {
  sound.custom((context, out, at) => {
    const bus = stereo(context, out, pan * 0.6);
    const dry = context.createGain();
    dry.gain.value = 0.32 * gain;
    dry.connect(bus);
    // The echo: a delay feeding back through a low-pass, so each repeat is quieter and duller.
    const delay = context.createDelay(1);
    delay.delayTime.value = 0.31;
    const back = context.createGain();
    back.gain.value = 0.38;
    const dull = context.createBiquadFilter();
    dull.type = "lowpass";
    dull.frequency.value = 1800;
    dry.connect(delay);
    delay.connect(dull);
    dull.connect(back);
    back.connect(delay);
    const wet = context.createGain();
    wet.gain.value = 0.5;
    dull.connect(wet);
    wet.connect(bus);
    const partial = (ratio: number, level: number, decay: number) => {
      const osc = context.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(pitch * ratio * 1.012, at);
      osc.frequency.exponentialRampToValueAtTime(pitch * ratio, at + 0.08);
      const env = context.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(level, at + 0.006);
      env.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      osc.connect(env);
      env.connect(dry);
      osc.start(at);
      osc.stop(at + decay + 0.05);
    };
    partial(1, 0.9, 1.4);
    partial(2.01, 0.22, 0.5);
    partial(3.98, 0.05, 0.18);
    // The delay line is let go once its repeats have died away.
    window.setTimeout(() => {
      back.disconnect();
      bus.disconnect();
    }, 3200);
  });
}

export function echoBack(pitch: number, pan: number) {
  sound.custom((context, out, at) => {
    const bus = stereo(context, out, pan * 0.4);
    const dull = context.createBiquadFilter();
    dull.type = "lowpass";
    dull.frequency.value = 900;
    dull.connect(bus);
    const osc = context.createOscillator();
    osc.type = "sine";
    osc.frequency.value = pitch;
    const env = context.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.11, at + 0.03);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.9);
    osc.connect(env);
    env.connect(dull);
    osc.start(at);
    osc.stop(at + 1);
  });
}

// A held tone: returns a function that lets it go, fading over a moment.
export function tone(pitch: number, pan: number) {
  let release: (() => void) | null = null;
  sound.custom((context, out, at) => {
    const bus = stereo(context, out, pan * 0.6);
    const env = context.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.13, at + 0.25);
    env.connect(bus);
    const osc = context.createOscillator();
    osc.type = "sine";
    osc.frequency.value = pitch;
    const shimmer = context.createOscillator();
    shimmer.type = "sine";
    shimmer.frequency.value = pitch * 2.003;
    const upper = context.createGain();
    upper.gain.value = 0.18;
    const wobble = context.createOscillator();
    wobble.frequency.value = 4.2;
    const depth = context.createGain();
    depth.gain.value = pitch * 0.004;
    wobble.connect(depth);
    depth.connect(osc.frequency);
    osc.connect(env);
    shimmer.connect(upper);
    upper.connect(env);
    osc.start(at);
    shimmer.start(at);
    wobble.start(at);
    release = () => {
      const now = context.currentTime;
      env.gain.cancelScheduledValues(now);
      env.gain.setValueAtTime(env.gain.value, now);
      env.gain.linearRampToValueAtTime(0, now + 0.45);
      for (const o of [osc, shimmer, wobble]) o.stop(now + 0.5);
    };
  });
  return () => release?.();
}
