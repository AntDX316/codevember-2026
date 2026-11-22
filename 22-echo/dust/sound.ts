import { sound } from "../../shared/engine/sound";

// A soft sonar ping: a pure tone struck like a glass bell, with a faint inharmonic shimmer and a little low body, ringing
// out through a short watery delay. The echo is the same ping come back: lower, duller and further off.
export function ping({ gain = 1, pitch = 1, echo = false, pan = 0 }: { gain?: number; pitch?: number; echo?: boolean; pan?: number }) {
  sound.custom((context, out, at) => {
    const level = gain * (echo ? 0.32 : 0.5);
    const f = (echo ? 1180 : 1320) * pitch;
    const bus = context.createGain();
    bus.gain.value = level;
    const tone = context.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = echo ? 1900 : 6000;
    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    bus.connect(tone);
    tone.connect(panner);
    panner.connect(out);
    // A short feedback delay, darkened each time round: the ping rings away into water.
    const delay = context.createDelay(1);
    delay.delayTime.value = echo ? 0.23 : 0.17;
    const back = context.createGain();
    back.gain.value = 0.38;
    const damp = context.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 1500;
    tone.connect(delay);
    delay.connect(damp);
    damp.connect(back);
    back.connect(delay);
    damp.connect(panner);

    const partials: [number, number, number][] = [
      [f, 1, 0.9],
      [f * 2.76, 0.18, 0.25],
      [f * 0.5, 0.22, 0.35]
    ];
    const stop = at + 2.6;
    for (const [freq, amp, decay] of partials) {
      const osc = context.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq * 1.01, at);
      osc.frequency.exponentialRampToValueAtTime(freq, at + 0.08);
      const env = context.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(amp, at + (echo ? 0.02 : 0.004));
      env.gain.exponentialRampToValueAtTime(0.0001, at + decay * 2.4);
      osc.connect(env);
      env.connect(bus);
      osc.start(at);
      osc.stop(stop);
    }
    // A soft low knock under the strike, for weight.
    const knock = context.createOscillator();
    knock.type = "sine";
    knock.frequency.setValueAtTime(echo ? 140 : 190, at);
    knock.frequency.exponentialRampToValueAtTime(70, at + 0.12);
    const kenv = context.createGain();
    kenv.gain.setValueAtTime(echo ? 0.12 : 0.35, at);
    kenv.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    knock.connect(kenv);
    kenv.connect(bus);
    knock.start(at);
    knock.stop(at + 0.2);
    // Let the delay loop go once it has died away.
    window.setTimeout(() => {
      back.gain.value = 0;
      bus.disconnect();
      panner.disconnect();
    }, 4200);
  });
}
