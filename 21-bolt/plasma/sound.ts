import { sound } from "../../shared/engine/sound";

// The globe's voice, built on the shared engine's context and ending in its master. Near silent left alone: a faint fizz
// of the gas and a stray crackle now and then. Under each hand, the buzz of the high-voltage drive coming through the
// glass: a mains hum with a rasping, bandpassed, lightly overdriven saw on top, a gritty sizzle chopped at the same hum,
// and fast crackles riding over it. It swells in over 150 ms, grows with the hold, pulses with the bundle's flicker, and
// climbs a little in pitch and brightness as the hand slides. Each further finger is another voice, slightly detuned.
// One-shots: a sharp "tick-zzt" as a hand lands, a falling fizz as it lets go, soft ticks as new filaments strike, a
// crackle swell in a surge, and a whoosh on a change of room. Everything passes through a compressor of its own, so
// several hands at once never push the engine's limiter.
//
// Where the recorded buzz is present (touch-buzz.mp3, the site's own licensed asset, not shipped in the open-source
// repo), it is the buzz under each hand instead of the synthesised one: decoded at load, made into a seamless loop, and
// played one voice a finger. Without it, the synthesised buzz stands in.

const HANDS = 5;
// The level of everything under a touching hand (buzz, sizzle, its crackles, the landing), about 4.5 dB under the
// first mix, which was too loud.
const TOUCH = 0.6;
const MAINS = 60;

// What the scene tells the voice each frame.
export type VoiceState = {
  // Per hand: how firmly it is there (0 to 1), and how long it has been pressed.
  hands: { strength: number; held: number }[];
  // How fast the hand slides, 0 to 1; the Storm setting; the bundle's flicker, about 1.
  moving: number;
  storm: number;
  flicker: number;
  // New filaments struck this frame, and how far into a surge the globe is (0 to 1).
  struck: number;
  surging: number;
  // Forks struck this frame.
  forked: number;
};

type Hand = { gain: GainNode; tone: BiquadFilterNode | null; saw: OscillatorNode | null; hum: OscillatorNode | null; loop: AudioBufferSourceNode | null; level: number };

const SAMPLE_URL = "/assets/21-bolt/touch-buzz.mp3";
// The recorded buzz, decoded and looped, once per page; null if it is not there.
let sample: Promise<{ buffer: AudioBuffer; trim: number } | null> | null = null;
export function loadBuzz() {
  if (sample) return sample;
  sample = fetch(SAMPLE_URL)
    .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error("missing"))))
    // Decoded on an offline context, so it needs no press to wake audio; the buffer plays on any context.
    .then((bytes) => new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes))
    .then((decoded) => seamless(decoded))
    .catch(() => null);
  return sample;
}

// Make a recording loop without a seam: its last stretch is crossfaded (equal power) into its start, and the loop is
// that much shorter. Also measures its loudness, so it plays at a known level whatever the file.
function seamless(source: AudioBuffer) {
  const rate = source.sampleRate;
  const fade = Math.min(Math.floor(rate * 0.3), Math.floor(source.length / 3));
  const length = source.length - fade;
  const looped = new AudioBuffer({ length, numberOfChannels: source.numberOfChannels, sampleRate: rate });
  let sum = 0;
  for (let c = 0; c < source.numberOfChannels; c++) {
    const from = source.getChannelData(c);
    const to = looped.getChannelData(c);
    to.set(from.subarray(0, length));
    for (let i = 0; i < fade; i++) {
      const x = i / fade;
      to[i] = from[i] * Math.sin((x * Math.PI) / 2) + from[length + i] * Math.cos((x * Math.PI) / 2);
    }
    for (let i = 0; i < length; i++) sum += to[i] * to[i];
  }
  const rms = Math.sqrt(sum / (length * source.numberOfChannels)) || 1;
  // To about -18 dB RMS at full level.
  return { buffer: looped, trim: 0.126 / rms };
}

// The graph, on any context, sending to `out`. Times are passed in so the same code can be rendered offline to check
// its levels.
export function buildVoice(context: BaseAudioContext, out: AudioNode, recorded: { buffer: AudioBuffer; trim: number } | null = null) {
  const rate = context.sampleRate;
  const noise = context.createBuffer(1, rate * 2, rate);
  const samples = noise.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  const loop = () => {
    const source = context.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    source.start(0, Math.random() * 2);
    return source;
  };

  // The voice's own bus: a gentle compressor, then a trim.
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -14;
  compressor.knee.value = 8;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.15;
  const bus = context.createGain();
  bus.gain.value = 0.9;
  compressor.connect(bus).connect(out);

  // A soft clipping curve, for the drive's grit.
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
  }

  // The gas's fizz: thin, high, always there but barely.
  const fizzSource = loop();
  const fizzBand = context.createBiquadFilter();
  fizzBand.type = "bandpass";
  fizzBand.frequency.value = 5200;
  fizzBand.Q.value = 0.8;
  const fizz = context.createGain();
  fizz.gain.value = 0;
  fizzSource.connect(fizzBand).connect(fizz).connect(compressor);

  // The sizzle, shared by every hand: noise chopped at the mains, high-passed, its level the sum of the hands'.
  const sizzleSource = loop();
  const chop = context.createGain();
  chop.gain.value = 0.5;
  const chopper = context.createOscillator();
  chopper.type = "sawtooth";
  chopper.frequency.value = MAINS * 2;
  const chopDepth = context.createGain();
  chopDepth.gain.value = 0.5;
  chopper.connect(chopDepth).connect(chop.gain);
  const sizzleHigh = context.createBiquadFilter();
  sizzleHigh.type = "highpass";
  sizzleHigh.frequency.value = 2600;
  const sizzle = context.createGain();
  sizzle.gain.value = 0;
  sizzleSource.connect(chop).connect(sizzleHigh).connect(sizzle).connect(compressor);
  chopper.start();

  // One buzz per hand, each a little detuned from the last and a little quieter: the recording looped where it is
  // here, the synthesised buzz where it is not.
  const hands: Hand[] = [];
  for (let k = 0; k < HANDS; k++) {
    const detune = 1 + (k - 2) * 0.012;
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(compressor);
    if (recorded) {
      const loop = context.createBufferSource();
      loop.buffer = recorded.buffer;
      loop.loop = true;
      loop.playbackRate.value = 1 + k * 0.015;
      const trim = context.createGain();
      trim.gain.value = recorded.trim;
      loop.connect(trim).connect(gain);
      loop.start(0, ((k * 0.37) % 1) * recorded.buffer.duration);
      hands.push({ gain, tone: null, saw: null, hum: null, loop, level: 0 });
      continue;
    }
    const saw = context.createOscillator();
    saw.type = "sawtooth";
    saw.frequency.value = MAINS * 2 * detune;
    const shaper = context.createWaveShaper();
    shaper.curve = curve;
    const drive = context.createGain();
    drive.gain.value = 1.6;
    const tone = context.createBiquadFilter();
    tone.type = "bandpass";
    tone.frequency.value = 900;
    tone.Q.value = 0.7;
    const hum = context.createOscillator();
    hum.type = "sine";
    hum.frequency.value = MAINS * detune;
    const humLevel = context.createGain();
    humLevel.gain.value = 0.6;
    saw.connect(drive).connect(shaper).connect(tone).connect(gain);
    hum.connect(humLevel).connect(gain);
    saw.start();
    hum.start();
    hands.push({ gain, tone, saw, hum, loop: null, level: 0 });
  }
  const sources: AudioScheduledSourceNode[] = [fizzSource, sizzleSource, chopper, ...hands.flatMap((h) => [h.saw, h.hum, h.loop].filter((n): n is NonNullable<typeof n> => n !== null))];

  // One crackle: a click of noise a few milliseconds long, its pitch and loudness at random.
  const crackle = (at: number, gain: number) => {
    const source = context.createBufferSource();
    source.buffer = noise;
    const filter = context.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 1600 + Math.random() * 3600;
    const level = context.createGain();
    const length = 0.002 + Math.random() * 0.01;
    level.gain.setValueAtTime(0, at);
    level.gain.linearRampToValueAtTime(gain, at + 0.0006);
    level.gain.exponentialRampToValueAtTime(0.0005, at + length);
    source.connect(filter).connect(level).connect(compressor);
    source.start(at, Math.random() * 1.9, length + 0.01);
  };

  let owed = 0;
  let surgeOwed = 0;
  let wasPressing = 0;
  return {
    update(dt: number, state: VoiceState, at: number) {
      let total = 0;
      let pressing = 0;
      for (let k = 0; k < HANDS; k++) {
        const h = hands[k];
        const hand = state.hands[k] ?? { strength: 0, held: 0 };
        // Swells in fast (about 80 ms with the recording, 150 synthesised), on with the hold, pulsing with the bundle's
        // flicker; fades over about a fifth of a second when let go.
        const target = hand.strength * (0.55 + 0.45 * Math.min(1, hand.held / 2.5)) * (0.85 + 0.3 * (state.flicker - 1) * 4);
        const rise = recorded ? 0.025 : 0.05;
        h.level += (Math.max(0, target) - h.level) * (1 - Math.exp(-dt / (target > h.level ? rise : 0.07)));
        // Each further finger a little quieter.
        const quieter = 1 / (1 + k * 0.35);
        const lift = 1 + state.moving * 0.06;
        if (h.loop) {
          h.gain.gain.setTargetAtTime(h.level * 1.6 * TOUCH * quieter, at, 0.015);
          h.loop.playbackRate.setTargetAtTime((1 + k * 0.015) * lift * (1 + Math.min(hand.held, 3) * 0.008), at, 0.08);
        } else {
          h.gain.gain.setTargetAtTime(h.level * 0.22 * TOUCH * quieter, at, 0.02);
          h.saw?.frequency.setTargetAtTime(MAINS * 2 * (1 + (k - 2) * 0.012) * lift, at, 0.05);
          h.tone?.frequency.setTargetAtTime(900 * (1 + state.moving * 0.9 + h.level * 0.4), at, 0.05);
        }
        total += h.level;
        pressing = Math.max(pressing, hand.strength);
      }
      sizzle.gain.setTargetAtTime(Math.min(1.5, total) * (recorded ? 0.03 : 0.1) * TOUCH, at, 0.03);
      fizz.gain.setTargetAtTime(0.0025 + state.storm * 0.004 + Math.min(1, total) * 0.03, at, 0.15);

      // Crackles: a stray one at rest, a stream under a hand that quickens with the hold and the slide, a swell in a
      // surge, and a soft tick for each new filament.
      const build = Math.min(1.5, total);
      owed += dt * (0.4 + state.storm * 1.2 + build * (16 + Math.min(1, state.moving) * 30));
      surgeOwed += dt * state.surging * 14;
      while (owed >= 1) {
        owed -= 1;
        crackle(at + Math.random() * dt, (0.015 + build * (recorded ? 0.07 : 0.12)) * TOUCH * (0.4 + Math.random()));
      }
      while (surgeOwed >= 1) {
        surgeOwed -= 1;
        crackle(at + Math.random() * dt, 0.02 * (0.5 + Math.random()));
      }
      for (let i = 0; i < Math.min(state.struck, 2); i++) crackle(at + Math.random() * dt, 0.012);
      // A fork breaking off: a tiny crackle of its own.
      for (let i = 0; i < Math.min(state.forked, 2); i++) crackle(at + Math.random() * dt, 0.035);

      // A hand let go: a fizz falling away as the strands peel off.
      if (wasPressing > 0.6 && pressing < wasPressing - 0.25) this.release(at);
      wasPressing = pressing < wasPressing ? Math.max(pressing, wasPressing - dt * 2) : pressing;
    },
    // A hand landing: a sharp tick, a "zzt" of rasping noise falling in pitch, and a burst of crackles.
    strike(at: number) {
      const tick = context.createBufferSource();
      tick.buffer = noise;
      const tickHigh = context.createBiquadFilter();
      tickHigh.type = "highpass";
      tickHigh.frequency.value = 3000;
      const tickLevel = context.createGain();
      tickLevel.gain.setValueAtTime(0.5 * TOUCH, at);
      tickLevel.gain.exponentialRampToValueAtTime(0.001, at + 0.012);
      tick.connect(tickHigh).connect(tickLevel).connect(compressor);
      tick.start(at, Math.random(), 0.03);
      const zzt = context.createOscillator();
      zzt.type = "square";
      zzt.frequency.setValueAtTime(2200, at + 0.004);
      zzt.frequency.exponentialRampToValueAtTime(420, at + 0.09);
      const zztBand = context.createBiquadFilter();
      zztBand.type = "bandpass";
      zztBand.frequency.value = 1800;
      zztBand.Q.value = 0.9;
      const zztLevel = context.createGain();
      zztLevel.gain.setValueAtTime(0, at);
      zztLevel.gain.linearRampToValueAtTime(0.16 * TOUCH, at + 0.006);
      zztLevel.gain.exponentialRampToValueAtTime(0.001, at + 0.11);
      zzt.connect(zztBand).connect(zztLevel).connect(compressor);
      zzt.start(at);
      zzt.stop(at + 0.13);
      for (let i = 0; i < 5; i++) crackle(at + 0.004 + Math.random() * 0.06, (0.15 + Math.random() * 0.1) * TOUCH);
    },
    // A hand letting go: a fizz of noise whose band falls from bright to dull over four tenths of a second.
    release(at: number) {
      const source = context.createBufferSource();
      source.buffer = noise;
      const band = context.createBiquadFilter();
      band.type = "bandpass";
      band.Q.value = 1.4;
      band.frequency.setValueAtTime(5200, at);
      band.frequency.exponentialRampToValueAtTime(700, at + 0.4);
      const level = context.createGain();
      level.gain.setValueAtTime(0, at);
      level.gain.linearRampToValueAtTime(0.09, at + 0.02);
      level.gain.exponentialRampToValueAtTime(0.001, at + 0.42);
      source.connect(band).connect(level).connect(compressor);
      source.start(at, Math.random(), 0.45);
    },
    stop(at: number) {
      bus.gain.setTargetAtTime(0, at, 0.1);
      for (const node of sources) node.stop(at + 0.6);
    },
    bus
  };
}

type Built = ReturnType<typeof buildVoice>;

// The voice on the live engine: built once audio has woken, then driven every frame. Built with the recording once it
// has decoded; if audio wakes first, the synthesised buzz plays until the recording is ready, then the voice is rebuilt.
export function createVoice() {
  let made: { context: AudioContext; voice: Built; recorded: boolean } | null = null;
  let recorded: { buffer: AudioBuffer; trim: number } | null = null;
  void loadBuzz().then((r) => (recorded = r));
  const make = () =>
    sound.custom((context, out) => {
      if (made && (made.recorded || !recorded)) return;
      if (made) retire(made);
      made = { context, voice: buildVoice(context, out, recorded), recorded: !!recorded };
    });
  const retire = (old: { context: AudioContext; voice: Built }) => {
    old.voice.stop(old.context.currentTime);
    window.setTimeout(() => old.voice.bus.disconnect(), 900);
  };
  return {
    update(dt: number, state: VoiceState) {
      if (!made || (!made.recorded && recorded)) make();
      if (!made) return;
      made.voice.update(dt, state, made.context.currentTime);
    },
    strike() {
      if (!made) make();
      if (made) made.voice.strike(made.context.currentTime + 0.002);
    },
    // A change of room: a soft whoosh through the engine's own.
    whoosh() {
      sound.play("whoosh", { gain: 0.1, pitch: 1.2 });
    },
    stop() {
      if (!made) return;
      retire(made);
      made = null;
    }
  };
}
