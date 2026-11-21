import { sound } from "../../shared/engine/sound";

// The day's own metal sounds, made through the engine's `custom` one-shot so they go through its master and mute.

// A struck piece of small hardware: the inharmonic partials of a free bar (1, 2.76, 5.40, 8.93), each dying away faster
// than the one below it, over a sharp tick of noise. Bright and clean, like a nut tapped with a key.
export function ting(gain: number, pitch = 1) {
  sound.custom((context, out, at) => {
    const base = 1850 * pitch * (0.97 + Math.random() * 0.06);
    const partials: [number, number, number][] = [
      [1, 0.5, 1.5],
      [2.76, 0.32, 0.9],
      [5.4, 0.16, 0.45],
      [8.93, 0.08, 0.22]
    ];
    for (const [ratio, level, decay] of partials) {
      const osc = context.createOscillator();
      osc.frequency.value = base * ratio * (1 + (Math.random() - 0.5) * 0.004);
      const env = context.createGain();
      env.gain.setValueAtTime(0.0001, at);
      env.gain.exponentialRampToValueAtTime(level * gain, at + 0.002);
      env.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      osc.connect(env);
      env.connect(out);
      osc.start(at);
      osc.stop(at + decay + 0.05);
    }
    // The contact itself.
    const click = context.createBufferSource();
    const length = Math.floor(context.sampleRate * 0.012);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3);
    click.buffer = buffer;
    const filter = context.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 3500;
    const env = context.createGain();
    env.gain.value = 0.35 * gain;
    click.connect(filter);
    filter.connect(env);
    env.connect(out);
    click.start(at);
  });
}

// The thread running through the nut: a tiny dry metal tick, a little brighter the faster it turns.
export function threadTick(gain: number, pitch = 1) {
  sound.custom((context, out, at) => {
    const osc = context.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(4200 * pitch, at);
    osc.frequency.exponentialRampToValueAtTime(2600 * pitch, at + 0.02);
    const env = context.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(0.09 * gain, at + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.03);
    osc.connect(env);
    env.connect(out);
    osc.start(at);
    osc.stop(at + 0.05);
  });
}

// The spin heard as a soft airy whirr whose colour follows the speed, fluttering as the wings pass (twice a turn).
// Long-lived nodes, made once audio is running and kept until the scene goes.
export class Whirr {
  private nodes: { filter: BiquadFilterNode; level: GainNode; flutter: OscillatorNode; depth: GainNode; context: AudioContext; stop: () => void } | null = null;

  // Called every frame: starts itself once sound is awake, then glides to the asked level and speed.
  set(level: number, turnsPerSecond: number, blades: number) {
    if (!this.nodes) {
      if (level < 0.002) return;
      sound.custom((context, out) => {
        const length = context.sampleRate * 2;
        const buffer = context.createBuffer(1, length, context.sampleRate);
        const data = buffer.getChannelData(0);
        // Pink-ish noise, so it is breath rather than hiss.
        let b0 = 0;
        let b1 = 0;
        let b2 = 0;
        for (let i = 0; i < length; i++) {
          const white = Math.random() * 2 - 1;
          b0 = 0.99765 * b0 + white * 0.099046;
          b1 = 0.963 * b1 + white * 0.2965164;
          b2 = 0.57 * b2 + white * 1.0526913;
          data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.18;
        }
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        const filter = context.createBiquadFilter();
        filter.type = "bandpass";
        filter.Q.value = 1.6;
        filter.frequency.value = 600;
        const shape = context.createGain();
        shape.gain.value = 0.6;
        const flutter = context.createOscillator();
        flutter.frequency.value = 4;
        const depth = context.createGain();
        depth.gain.value = 0.35;
        flutter.connect(depth);
        depth.connect(shape.gain);
        const level = context.createGain();
        level.gain.value = 0;
        source.connect(filter);
        filter.connect(shape);
        shape.connect(level);
        level.connect(out);
        source.start();
        flutter.start();
        this.nodes = {
          filter,
          level,
          flutter,
          depth,
          context,
          stop: () => {
            level.gain.setTargetAtTime(0, context.currentTime, 0.1);
            source.stop(context.currentTime + 0.6);
            flutter.stop(context.currentTime + 0.6);
          }
        };
      });
      if (!this.nodes) return;
    }
    const n = this.nodes;
    const now = n.context.currentTime;
    n.level.gain.setTargetAtTime(level, now, 0.08);
    n.filter.frequency.setTargetAtTime(380 + Math.min(turnsPerSecond, 12) * 170, now, 0.1);
    n.flutter.frequency.setTargetAtTime(Math.max(0.5, Math.min(turnsPerSecond * blades, 40)), now, 0.05);
    n.depth.gain.setTargetAtTime(blades > 0 ? 0.4 : 0.05, now, 0.2);
  }

  stop() {
    this.nodes?.stop();
    this.nodes = null;
  }
}
