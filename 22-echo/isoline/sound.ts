import { sound } from "../../shared/engine/sound";
import { ECHO_DELAY } from "./blob";

// A sonar ping: a clean sine struck with a glassy overtone and a soft click, ringing out, then coming back twice down a
// darkening delay timed to the echoes drawn on the form.
export function ping(pitch: number, pan: number, gain = 1) {
  sound.custom((context, out, at) => {
    const bus = context.createStereoPanner();
    bus.pan.value = Math.max(-1, Math.min(1, pan * 0.6));
    bus.connect(out);
    const dry = context.createGain();
    dry.gain.value = 0.3 * gain;
    dry.connect(bus);
    const delay = context.createDelay(1);
    delay.delayTime.value = ECHO_DELAY;
    const dull = context.createBiquadFilter();
    dull.type = "lowpass";
    dull.frequency.value = 2200;
    const back = context.createGain();
    back.gain.value = 0.42;
    dry.connect(delay);
    delay.connect(dull);
    dull.connect(back);
    back.connect(delay);
    const wet = context.createGain();
    wet.gain.value = 0.55;
    dull.connect(wet);
    wet.connect(bus);
    const partial = (ratio: number, level: number, decay: number) => {
      const osc = context.createOscillator();
      osc.frequency.setValueAtTime(pitch * ratio * 1.015, at);
      osc.frequency.exponentialRampToValueAtTime(pitch * ratio, at + 0.06);
      const env = context.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(level, at + 0.004);
      env.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      osc.connect(env);
      env.connect(dry);
      osc.start(at);
      osc.stop(at + decay + 0.05);
    };
    partial(1, 0.9, 1.6);
    partial(2.76, 0.12, 0.35);
    partial(5.4, 0.03, 0.08);
    window.setTimeout(() => {
      back.disconnect();
      bus.disconnect();
    }, 3500);
  });
}
