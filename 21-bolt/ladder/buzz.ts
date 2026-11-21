import { sound } from "../../shared/engine/sound";

// The arc's voice, made in the engine's audio context and played through its master (so the mute button holds): the
// mains buzz of the arc at 120 Hz, harsh with harmonics, and a crackle and hiss that grow as it stretches. It starts
// the moment an arc strikes and cuts dead when it snaps, which is what gives a Jacob's ladder its rhythm.
type Graph = {
  context: AudioContext;
  out: GainNode;
  buzz: GainNode;
  tone: BiquadFilterNode;
  hiss: GainNode;
  crackle: GainNode;
  zap: GainNode;
  sources: AudioScheduledSourceNode[];
};

function noiseBuffer(context: AudioContext, seconds: number) {
  const buffer = context.createBuffer(1, Math.floor(context.sampleRate * seconds), context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

// Sparse clicks of every size, a few hundred a second: the spitting of an arc in air.
function crackleBuffer(context: AudioContext, seconds: number, rate: number) {
  const buffer = context.createBuffer(1, Math.floor(context.sampleRate * seconds), context.sampleRate);
  const data = buffer.getChannelData(0);
  const count = Math.floor(seconds * rate);
  for (let c = 0; c < count; c++) {
    const at = Math.floor(Math.random() * data.length);
    const amp = Math.pow(Math.random(), 3) * (Math.random() < 0.5 ? -1 : 1);
    const span = Math.floor(context.sampleRate * (0.0006 + Math.random() * 0.003));
    for (let i = 0; i < span && at + i < data.length; i++) data[at + i] += amp * Math.exp((-i / span) * 4) * (Math.random() * 2 - 1);
  }
  return buffer;
}

function distortion(amount: number) {
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}

export class Buzz {
  private graph: Graph | null = null;

  // Built the first time the engine's audio is running; until then, nothing.
  private build() {
    sound.custom((context, master) => {
      const out = context.createGain();
      out.gain.value = 0;
      out.connect(master);
      const sources: AudioScheduledSourceNode[] = [];

      // The buzz: a sawtooth at twice the mains, a square an octave up a hair sharp, through a soft clip and a band.
      const drive = context.createGain();
      drive.gain.value = 1.4;
      for (const [type, frequency, level] of [
        ["sawtooth", 120, 0.6],
        ["square", 240.4, 0.25],
        ["sawtooth", 360.2, 0.12]
      ] as [OscillatorType, number, number][]) {
        const o = context.createOscillator();
        o.type = type;
        o.frequency.value = frequency;
        const g = context.createGain();
        g.gain.value = level;
        o.connect(g);
        g.connect(drive);
        o.start();
        sources.push(o);
      }
      const shaper = context.createWaveShaper();
      shaper.curve = distortion(3);
      const tone = context.createBiquadFilter();
      tone.type = "bandpass";
      tone.frequency.value = 900;
      tone.Q.value = 0.6;
      const low = context.createBiquadFilter();
      low.type = "highpass";
      low.frequency.value = 90;
      const buzz = context.createGain();
      buzz.gain.value = 0;
      drive.connect(shaper);
      shaper.connect(tone);
      tone.connect(low);
      low.connect(buzz);
      buzz.connect(out);

      // The hiss of the plasma, brighter as it stretches.
      const hissSource = context.createBufferSource();
      hissSource.buffer = noiseBuffer(context, 2);
      hissSource.loop = true;
      const hissBand = context.createBiquadFilter();
      hissBand.type = "bandpass";
      hissBand.frequency.value = 5200;
      hissBand.Q.value = 0.7;
      const hiss = context.createGain();
      hiss.gain.value = 0;
      hissSource.connect(hissBand);
      hissBand.connect(hiss);
      hiss.connect(out);
      hissSource.start();
      sources.push(hissSource);

      // The crackle.
      const crackleSource = context.createBufferSource();
      crackleSource.buffer = crackleBuffer(context, 3, 260);
      crackleSource.loop = true;
      const crackleBand = context.createBiquadFilter();
      crackleBand.type = "highpass";
      crackleBand.frequency.value = 1400;
      const crackle = context.createGain();
      crackle.gain.value = 0;
      crackleSource.connect(crackleBand);
      crackleBand.connect(crackle);
      crackle.connect(out);
      crackleSource.start();
      sources.push(crackleSource);

      // The spark to a hand: a denser, sharper crackle of its own, outside the arc's gate.
      const zapSource = context.createBufferSource();
      zapSource.buffer = crackleBuffer(context, 2, 700);
      zapSource.loop = true;
      const zapBand = context.createBiquadFilter();
      zapBand.type = "highpass";
      zapBand.frequency.value = 2200;
      const zap = context.createGain();
      zap.gain.value = 0;
      zapSource.connect(zapBand);
      zapBand.connect(zap);
      zap.connect(master);
      zapSource.start();
      sources.push(zapSource);

      this.graph = { context, out, buzz, tone, hiss, crackle, zap, sources };
    });
  }

  // Each frame: whether the arc burns, how bright, how stretched (0 to 1), and how hard a spark is jumping to the hand.
  set(on: boolean, level: number, stretch: number, zap: number, slow: boolean) {
    if (!this.graph) this.build();
    const g = this.graph;
    if (!g || g.context.state !== "running") return;
    const now = g.context.currentTime;
    // The gate opens and shuts in a few milliseconds: the snap is heard as the buzz cutting out.
    g.out.gain.setTargetAtTime(on ? 1 : 0, now, on ? 0.004 : 0.008);
    const s = Math.min(1.2, stretch);
    g.buzz.gain.setTargetAtTime(level * (0.075 + 0.05 * s), now, 0.03);
    g.tone.frequency.setTargetAtTime(700 + s * 1500, now, 0.05);
    g.hiss.gain.setTargetAtTime(level * (0.012 + 0.04 * s * s), now, 0.04);
    g.crackle.gain.setTargetAtTime(level * (0.05 + 0.22 * s * s) * (slow ? 0.5 : 1), now, 0.03);
    g.zap.gain.setTargetAtTime(zap * 0.3, now, 0.02);
  }

  stop() {
    const g = this.graph;
    if (!g) return;
    g.out.gain.setTargetAtTime(0, g.context.currentTime, 0.02);
    g.zap.gain.setTargetAtTime(0, g.context.currentTime, 0.02);
    for (const s of g.sources) s.stop(g.context.currentTime + 0.2);
    window.setTimeout(() => {
      g.out.disconnect();
      g.zap.disconnect();
    }, 400);
    this.graph = null;
  }
}

// The crack of a strike: a hard click of noise and a thump under it.
export function strikeSound(gain: number) {
  sound.custom((context, out, at) => {
    const n = context.createBufferSource();
    n.buffer = noiseBuffer(context, 0.08);
    const band = context.createBiquadFilter();
    band.type = "highpass";
    band.frequency.value = 1800;
    const env = context.createGain();
    env.gain.setValueAtTime(gain * 0.5, at);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
    n.connect(band);
    band.connect(env);
    env.connect(out);
    n.start(at);
    n.stop(at + 0.08);
    const o = context.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(180, at);
    o.frequency.exponentialRampToValueAtTime(60, at + 0.08);
    const body = context.createGain();
    body.gain.setValueAtTime(gain * 0.35, at);
    body.gain.exponentialRampToValueAtTime(0.0001, at + 0.1);
    o.connect(body);
    body.connect(out);
    o.start(at);
    o.stop(at + 0.12);
  });
}

// The snap at the top: a soft, airy pop as the long arc lets go.
export function snapSound(gain: number) {
  sound.custom((context, out, at) => {
    const n = context.createBufferSource();
    n.buffer = noiseBuffer(context, 0.2);
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.setValueAtTime(3000, at);
    band.frequency.exponentialRampToValueAtTime(500, at + 0.15);
    band.Q.value = 0.9;
    const env = context.createGain();
    env.gain.setValueAtTime(gain * 0.4, at);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    n.connect(band);
    band.connect(env);
    env.connect(out);
    n.start(at);
    n.stop(at + 0.2);
  });
}
