import { sound } from "../../shared/engine/sound";

// The drop's voices, built on the engine's context and ending in its master. A tap is a liquid plink (a sine sweeping
// up, as a drop's bubble does) over a soft metal bell, ringing on down a darkening delay; when the rings meet on the far
// side, the same note comes back quieter and duller, and again when they return. A held press sings a pure tone that
// steps from one of the drop's own notes to the next.

function stereo(context: AudioContext, out: AudioNode, pan: number) {
  const panner = context.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  panner.connect(out);
  return panner;
}

export function plink(pitch: number, pan: number, gain = 1, dull = 0) {
  sound.custom((context, out, at) => {
    const bus = stereo(context, out, pan * 0.5);
    const tone = context.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 9000 * Math.pow(0.18, dull);
    tone.connect(bus);
    const dry = context.createGain();
    dry.gain.value = 0.5 * gain;
    dry.connect(tone);
    const delay = context.createDelay(1);
    delay.delayTime.value = 0.23;
    const back = context.createGain();
    back.gain.value = 0.32;
    const darker = context.createBiquadFilter();
    darker.type = "lowpass";
    darker.frequency.value = 2200;
    dry.connect(delay);
    delay.connect(darker);
    darker.connect(back);
    back.connect(delay);
    const wet = context.createGain();
    wet.gain.value = 0.42;
    darker.connect(wet);
    wet.connect(tone);

    // The plink: up an octave and a half in a few hundredths of a second, gone in a quarter.
    const drop = context.createOscillator();
    drop.type = "sine";
    drop.frequency.setValueAtTime(pitch * 1.5, at);
    drop.frequency.exponentialRampToValueAtTime(pitch * 3.4, at + 0.05);
    const dropEnv = context.createGain();
    dropEnv.gain.setValueAtTime(0, at);
    dropEnv.gain.linearRampToValueAtTime(0.55 * (1 - dull * 0.6), at + 0.004);
    dropEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    drop.connect(dropEnv);
    dropEnv.connect(dry);
    drop.start(at);
    drop.stop(at + 0.2);

    // The bell under it: a few inharmonic partials, the high ones shortest.
    const partial = (ratio: number, level: number, decay: number) => {
      const osc = context.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(pitch * ratio * 1.006, at);
      osc.frequency.exponentialRampToValueAtTime(pitch * ratio, at + 0.3);
      const env = context.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(level, at + 0.003);
      env.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      osc.connect(env);
      env.connect(dry);
      osc.start(at);
      osc.stop(at + decay + 0.05);
    };
    partial(1, 0.5, 2.2);
    partial(2.76, 0.16, 1.1);
    partial(5.4, 0.06, 0.45);
    partial(8.93, 0.025, 0.2);
    window.setTimeout(() => {
      back.disconnect();
      bus.disconnect();
    }, 3600);
  });
}

// A held tone: returns its controls, to move its note and let it go.
export function singer(pitch: number) {
  let control: { note: (pitch: number, level: number) => void; stop: () => void } | null = null;
  sound.custom((context, out, at) => {
    const env = context.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.11, at + 0.4);
    env.connect(out);
    const osc = context.createOscillator();
    osc.type = "sine";
    osc.frequency.value = pitch;
    const upper = context.createOscillator();
    upper.type = "sine";
    upper.frequency.value = pitch * 2.002;
    const upperGain = context.createGain();
    upperGain.gain.value = 0.12;
    const wobble = context.createOscillator();
    wobble.frequency.value = 5.1;
    const depth = context.createGain();
    depth.gain.value = pitch * 0.003;
    wobble.connect(depth);
    depth.connect(osc.frequency);
    osc.connect(env);
    upper.connect(upperGain);
    upperGain.connect(env);
    for (const o of [osc, upper, wobble]) o.start(at);
    control = {
      note: (next, level) => {
        const now = context.currentTime;
        osc.frequency.setTargetAtTime(next, now, 0.08);
        upper.frequency.setTargetAtTime(next * 2.002, now, 0.08);
        env.gain.setTargetAtTime(0.11 * level, now, 0.1);
      },
      stop: () => {
        const now = context.currentTime;
        env.gain.cancelScheduledValues(now);
        env.gain.setValueAtTime(env.gain.value, now);
        env.gain.linearRampToValueAtTime(0, now + 0.6);
        for (const o of [osc, upper, wobble]) o.stop(now + 0.65);
      }
    };
  });
  return {
    note: (next: number, level: number) => control?.note(next, level),
    stop: () => control?.stop()
  };
}
