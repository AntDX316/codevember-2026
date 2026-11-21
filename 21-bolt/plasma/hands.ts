// IRL Hands: your real hands, seen by the camera, touch the glass. Loaded only when the setting is turned on; the camera
// is asked for then and released when it is turned off. The landmarker runs in a worker on this device, about 30 times a
// second, and only the latest answer is read by the render loop, so it never waits on it. Nothing is uploaded.

import { BONES, JOINTS, slotOf, TIPS } from "./hand-shape";

// The live camera with the tracked skeleton, in the bottom-right corner (desktop only, like IRL Hands). Kept cheap: the
// camera is a plain <video>, mirrored by CSS and composited by the browser, never drawn by the page; the skeleton is a
// small canvas over it, redrawn only when a new tracking result arrives. (Drawing it every frame cost a 120 Hz window a
// third of its frames.) Set false to hide it.
export const SHOW_DEBUG = true;

// How the tracker runs: which MediaPipe delegate it tries first, and how wide each camera frame is when sent to it
// (MediaPipe works on a 192-256 px picture anyway, so a small frame costs less to copy and upload and loses nothing).
// The CPU delegate: on the GPU, MediaPipe and the globe fought over it, the globe losing frames and the tracker starved
// (175 ms a frame with the render uncapped); on the CPU, in its worker, it costs the render nothing.
// A dev build can override these for profiling with globalThis.__plasmaHandsOptions.
const OPTIONS = {
  delegate: "CPU" as "GPU" | "CPU",
  width: 320,
  rate: 30,
  pixels: true,
  debug: SHOW_DEBUG,
  ...(process.env.NODE_ENV !== "production" ? (globalThis as { __plasmaHandsOptions?: object }).__plasmaHandsOptions : {})
};

// A hand counts only within reach: its palm (wrist to the middle finger's knuckle) at least this tall in the picture, as
// a share of its height. Well inside arm's length from a laptop, so the lightning reaches only for a hand brought in
// close, never one resting further back. Lower to exit.
const PALM_IN = 0.19;
const PALM_OUT = 0.16;
// A finger counts while it is straight: its tip further from the wrist than its middle joint by this ratio. Lower to exit.
const STRAIGHT_IN = 1.12;
const STRAIGHT_OUT = 1.0;
// A pinch (thumb tip to index tip, as a share of the palm's length): on below PINCH_IN, off above PINCH_OUT, and only
// after it has held PINCH_HOLD seconds (PINCH_HOLD_TOUCHING if a fingertip of that hand is on the glass, so closing the
// hand while touching never steers the view by accident).
export const PINCH_IN = 0.25;
export const PINCH_OUT = 0.35;
const PINCH_HOLD = 0.08;
const PINCH_HOLD_TOUCHING = 0.15;
// While any hand pinches (steering the view), no fingertip of either hand touches the glass, nor for this long after
// the last pinch lets go, so letting go of a turn or a zoom never strikes the lightning by accident.
const STEER_REST = 0.5;
// A finger that stops counting, or a hand that is lost, lets go only after this long, so a flicker never breaks a touch.
const HOLD = 0.12;

// One Euro filter (Casiez et al.): steady when still, quick when moving.
class OneEuro {
  private x = NaN;
  private dx = 0;
  constructor(private minCutoff = 1.5, private beta = 0.02, private dCutoff = 1) {}
  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(value: number, dt: number) {
    if (Number.isNaN(this.x) || dt <= 0) {
      this.x = value;
      return value;
    }
    const raw = (value - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (raw - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

export type Hand = {
  filters: OneEuro[];
  // Smoothed landmarks, x and y in the picture (0 to 1, not mirrored).
  points: Float32Array;
  // And each one's depth, relative to the wrist and on the scale of x: smaller is nearer the camera.
  depth: Float32Array;
  seen: number;
  near: boolean;
  straight: boolean[];
  // When each finger last counted.
  counted: number[];
  // Whether it pinches, since when the pinch has been closing, and the pinch's squeeze (tips apart / palm length).
  pinching: boolean;
  pinchFrom: number;
  squeeze: number;
};

const newHand = (): Hand => ({
  filters: Array.from({ length: 63 }, () => new OneEuro()),
  points: new Float32Array(42),
  depth: new Float32Array(21),
  seen: 0,
  near: false,
  straight: [false, false, false, false, false],
  counted: [-1, -1, -1, -1, -1],
  pinching: false,
  pinchFrom: 0,
  squeeze: 1
});

export type Fingertip = { id: number; u: number; v: number };

export type Hands = {
  // The fingertips touching now: id (hand * 5 + finger), and where in the picture as seen in a mirror (0 to 1).
  tips: Fingertip[];
  video: HTMLVideoElement;
  // Ids the scene has on the glass, drawn highlighted in the debug panel.
  onGlass: Set<number>;
  // Every hand in view, by which hand it is, with its smoothed landmarks, for drawing it in the scene.
  skeletons: Map<string, Hand>;
  stop: () => void;
  stats: { sent: number; answered: number; delegate: string; failed: string; found: number; palm: number; inference: number };
};

const reason = (error: unknown) => {
  const name = (error as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "IRL Hands needs the camera, and permission was not given.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "IRL Hands needs a camera, and none was found.";
  if (name === "NotReadableError") return "The camera is in use by another app.";
  return "IRL Hands could not start the camera here.";
};

// The tracker: one worker, which fetches, compiles and starts MediaPipe off the main thread. Kept a minute after IRL
// Hands is turned off, so turning it on again is instant; the files stay in the browser's cache beyond that.
type Tracker = {
  worker: Worker;
  ready: boolean;
  delegate: string;
  failed: string;
  stage: string;
  loaded: number;
  total: number;
  listen: ((data: { type: string; [key: string]: unknown }) => void) | null;
  idle: number;
};
const KEEP = 60_000;
let kept: Tracker | null = null;

function tracker(): Tracker {
  if (kept && !kept.failed) {
    window.clearTimeout(kept.idle);
    return kept;
  }
  const worker = new Worker(new URL("./hands-worker.ts", import.meta.url));
  worker.postMessage({ type: "init", delegate: OPTIONS.delegate, pixels: OPTIONS.delegate === "CPU" && OPTIONS.pixels });
  const t: Tracker = { worker, ready: false, delegate: "", failed: "", stage: "download", loaded: 0, total: 0, listen: null, idle: 0 };
  worker.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (data.type === "progress") {
      t.stage = data.stage;
      if (data.stage === "download") {
        t.loaded = data.loaded;
        t.total = data.total;
      }
    } else if (data.type === "ready") {
      t.ready = true;
      t.delegate = data.delegate;
    } else if (data.type === "error") t.failed = data.stage === "download" ? "The hand tracker could not be downloaded." : "The hand tracker could not start here.";
    t.listen?.(data);
  };
  worker.onerror = () => {
    t.failed = "The hand tracker could not start here.";
    t.listen?.({ type: "error" });
  };
  kept = t;
  return t;
}

function release(t: Tracker) {
  t.listen = null;
  window.clearTimeout(t.idle);
  t.idle = window.setTimeout(() => {
    t.worker.terminate();
    if (kept === t) kept = null;
  }, KEEP);
}

// Where the HUD lives, so what is added here picks up its colours and type.
const root = () => document.querySelector(".cv-root") ?? document.body;

// "Setting up hand interaction": a small card in the HUD's own glass, with a spinner, the stage, and a real progress bar
// (the same thin track as the page's loader). Fades away once the first frame is tracked; says plainly what went wrong.
function setupCard() {
  const card = document.createElement("div");
  card.setAttribute("role", "status");
  Object.assign(card.style, {
    position: "fixed",
    left: "50%",
    bottom: "calc(max(16px, env(safe-area-inset-bottom)) + 96px)",
    transform: "translateX(-50%)",
    width: "min(300px, calc(100vw - 32px))",
    padding: "14px 18px 16px",
    borderRadius: "16px",
    border: "1px solid var(--cv-line)",
    background: "var(--cv-glass)",
    backdropFilter: "blur(16px)",
    webkitBackdropFilter: "blur(16px)",
    color: "var(--cv-ink)",
    fontSize: "12px",
    zIndex: "30",
    pointerEvents: "none",
    opacity: "0",
    transition: "opacity 0.3s var(--cv-ease)"
  });
  const title = document.createElement("div");
  title.textContent = "Setting up hand interaction";
  const row = document.createElement("div");
  Object.assign(row.style, { display: "flex", alignItems: "center", gap: "8px", marginTop: "6px", fontSize: "11px", color: "var(--cv-dim)" });
  const spinner = document.createElement("span");
  spinner.className = "cv-spinner";
  const label = document.createElement("span");
  row.append(spinner, label);
  const track = document.createElement("div");
  track.className = "cv-loader-track";
  Object.assign(track.style, { width: "100%", marginTop: "12px" });
  const bar = document.createElement("span");
  bar.style.transform = "scaleX(0)";
  bar.style.transition = "transform 0.4s var(--cv-ease)";
  track.append(bar);
  card.append(title, row, track);
  root().appendChild(card);
  requestAnimationFrame(() => (card.style.opacity = "1"));
  let gone = false;
  const remove = (after: number) => {
    if (gone) return;
    gone = true;
    window.setTimeout(() => (card.style.opacity = "0"), after);
    window.setTimeout(() => card.remove(), after + 350);
  };
  return {
    show(text: string, fraction: number) {
      if (gone) return;
      if (label.textContent !== text) label.textContent = text;
      bar.style.transform = `scaleX(${Math.min(1, Math.max(0, fraction)).toFixed(3)})`;
    },
    done() {
      if (gone) return;
      bar.style.transform = "scaleX(1)";
      spinner.remove();
      label.textContent = "Ready: reach out and touch the glass";
      remove(600);
    },
    fail(text: string) {
      if (gone) return;
      spinner.remove();
      track.remove();
      title.textContent = "Hand interaction could not start";
      label.textContent = text;
      label.style.color = "var(--cv-accent)";
      remove(4500);
    },
    remove: () => remove(0)
  };
}

const mb = (bytes: number) => (bytes / 1048576).toFixed(1);

// Starts the camera and the tracker, showing how far along it is. Resolves once the camera is on (the tracker may still
// be starting; hands arrive when it is). Rejects with a plain message if the camera is refused or missing; a tracker that
// fails later calls onFail. Aborting cleans up whatever has been started.
export async function startHands({ signal, onFail }: { signal: AbortSignal; onFail: (message: string) => void }): Promise<Hands> {
  const card = setupCard();
  // Fetching and starting the tracker begins at once, alongside the camera permission.
  const t = tracker();
  let cameraOn = false;
  let first = false;
  const paint = () => {
    const downloaded = t.ready || t.stage !== "download" ? 1 : t.total > 0 ? t.loaded / t.total : 0;
    const fraction = (cameraOn ? 0.05 : 0) + downloaded * 0.7 + (t.stage === "start" || t.ready ? 0.1 : 0) + (t.ready ? 0.1 : 0);
    const text = !cameraOn
      ? "Asking for the camera"
      : t.ready
        ? "Waiting for the first hand frame"
        : t.stage === "start"
          ? "Starting the tracker"
          : `Downloading the tracker · ${mb(t.loaded)} of ${mb(t.total || 22.4 * 1048576)} MB`;
    card.show(text, fraction);
  };
  let onData: (data: { type: string; [key: string]: unknown }) => void = () => paint();
  t.listen = (data) => {
    if (data.type === "error") {
      card.fail(t.failed);
      onFail(t.failed);
      return;
    }
    onData(data);
  };
  paint();
  if (t.failed) {
    card.fail(t.failed);
    release(t);
    throw new Error(t.failed);
  }

  const cancel = () => {
    card.remove();
    release(t);
    return new DOMException("Turned off", "AbortError");
  };
  if (!navigator.mediaDevices?.getUserMedia) {
    const message = "IRL Hands needs a camera, and this browser offers none here.";
    card.fail(message);
    release(t);
    throw new Error(message);
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
  } catch (error) {
    if (signal.aborted) throw cancel();
    card.fail(reason(error));
    release(t);
    throw new Error(reason(error));
  }
  if (signal.aborted) {
    for (const track of stream.getTracks()) track.stop();
    throw cancel();
  }
  cameraOn = true;
  paint();

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  video.play().catch(() => {
    // Some browsers resolve play() late; frames still arrive.
  });

  let stopped = false;
  let busy = false;
  // The debug panel is redrawn only when there is a new answer, not every frame.
  let fresh = true;
  let lastSent = 0;
  let inference = 0;
  const answers: number[] = [];
  const hands = new Map<string, Hand>();
  const result: Hands = { tips: [], video, onGlass: new Set(), skeletons: hands, stop: () => {}, stats: { sent: 0, answered: 0, delegate: "", failed: "", found: 0, palm: 0, inference: 0 } };

  // The panel: the picture as in a mirror, the skeleton over it, the fingertips touching picked out.
  const panel = OPTIONS.debug ? document.createElement("div") : null;
  const canvas = OPTIONS.debug ? document.createElement("canvas") : null;
  const label = OPTIONS.debug ? document.createElement("div") : null;
  if (panel && canvas && label) {
    // Bottom right, 300 px wide, clear of the credit line under it. Desktop only: IRL Hands is never offered on a phone.
    Object.assign(panel.style, {
      position: "fixed",
      right: "20px",
      bottom: "96px",
      width: "300px",
      borderRadius: "10px",
      overflow: "hidden",
      background: "#000",
      boxShadow: "0 6px 24px rgba(0, 0, 0, 0.45)",
      zIndex: "40",
      pointerEvents: "none"
    });
    Object.assign(video.style, { display: "block", width: "100%", transform: "scaleX(-1)", opacity: "0.85" });
    Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%" });
    Object.assign(label.style, {
      position: "absolute",
      left: "6px",
      bottom: "4px",
      color: "#f2ecff",
      right: "6px",
      font: "500 10px/1.2 ui-monospace, monospace",
      textShadow: "0 1px 2px #000"
    });
    label.textContent = "IRL Hands: loading tracker";
    panel.append(video, canvas, label);
    root().appendChild(panel);
  }
  // 300 px wide where there is room, smaller in a narrow window. Sized again as the page resizes.
  let panelWidth = 300;
  const place = () => {
    if (!panel) return;
    panelWidth = Math.round(Math.max(150, Math.min(300, window.innerWidth * 0.25)));
    panel.style.width = `${panelWidth}px`;
    fresh = true;
  };
  window.addEventListener("resize", place);
  const placing = window.setInterval(place, 1000);
  requestAnimationFrame(place);

  onData = (data) => {
    if (data.type === "result") {
      busy = false;
      result.stats.answered++;
      inference = result.stats.inference = data.ms as number;
      const now = performance.now();
      answers.push(now);
      while (answers.length && answers[0] < now - 1000) answers.shift();
      take(data.hands as { points: number[]; side: string }[], now / 1000);
      fresh = true;
      if (!first) {
        first = true;
        card.done();
      }
    } else if (!first) paint();
  };

  const take = (found: { points: number[]; side: string }[], t: number) => {
    const aspect = video.videoWidth / Math.max(1, video.videoHeight);
    // Each hand keeps its filters and its fingers' state by which hand it is; two of the same side are told apart by order.
    const used = new Set<string>();
    result.stats.found = found.length;
    for (const f of found) {
      let key = f.side || "Hand";
      if (used.has(key)) key += "2";
      used.add(key);
      let h = hands.get(key);
      if (!h || t - h.seen > 0.5) {
        h = newHand();
        hands.set(key, h);
      }
      const dt = h.seen > 0 ? t - h.seen : 0;
      h.seen = t;
      for (let k = 0; k < 21; k++) {
        h.points[k * 2] = h.filters[k * 2].filter(f.points[k * 3], dt);
        h.points[k * 2 + 1] = h.filters[k * 2 + 1].filter(f.points[k * 3 + 1], dt);
        h.depth[k] = h.filters[42 + k].filter(f.points[k * 3 + 2], dt);
      }
      const p = h.points;
      const dist = (a: number, b: number) => Math.hypot((p[a * 2] - p[b * 2]) * aspect, p[a * 2 + 1] - p[b * 2 + 1]);
      const palm = dist(0, 9);
      result.stats.palm = palm;
      h.near = palm > (h.near ? PALM_OUT : PALM_IN);
      for (let n = 0; n < 5; n++) {
        // The thumb is measured from the index finger's knuckle, the others from the wrist.
        const from = n === 0 ? 5 : 0;
        const ratio = dist(TIPS[n], from) / Math.max(1e-4, dist(JOINTS[n], from));
        h.straight[n] = ratio > (h.straight[n] ? STRAIGHT_OUT : STRAIGHT_IN) * (n === 0 ? 1.05 : 1);
        if (h.near && h.straight[n]) h.counted[n] = t;
      }
      // The pinch, with hysteresis and a short hold.
      h.squeeze = dist(4, 8) / Math.max(1e-4, palm);
      const closed = h.squeeze < (h.pinching ? PINCH_OUT : PINCH_IN);
      if (!closed) {
        h.pinching = false;
        h.pinchFrom = 0;
      } else if (!h.pinching) {
        if (!h.pinchFrom) h.pinchFrom = t;
        const slot = slotOf(key);
        let touching = false;
        for (let n = 0; n < 5; n++) if (result.onGlass.has(slot * 5 + n)) touching = true;
        if (t - h.pinchFrom >= (touching ? PINCH_HOLD_TOUCHING : PINCH_HOLD)) h.pinching = true;
      }
    }
    publish(t);
  };

  // The fingertips touching: every finger that counts, or counted within the hold; none while a pinch steers the view.
  let steering = -Infinity;
  const publish = (t: number) => {
    const tips: Fingertip[] = [];
    for (const [key, h] of hands) if (t - h.seen > HOLD + 0.2) hands.delete(key);
    for (const h of hands.values()) if (h.pinching) steering = t;
    for (const [key, h] of hands) {
      if (t - steering < STEER_REST) break;
      const slot = slotOf(key);
      // Index first, so a single pointing finger always gets a contact.
      for (const n of [1, 2, 3, 0, 4]) {
        if (h.counted[n] < 0 || t - h.counted[n] > HOLD) continue;
        tips.push({ id: slot * 5 + n, u: 1 - h.points[TIPS[n] * 2], v: h.points[TIPS[n] * 2 + 1] });
      }
    }
    result.tips = tips;
  };

  // A frame at a time, at most OPTIONS.rate a second, never more than one in flight.
  let handle = 0;
  const pump = () => {
    if (stopped) return;
    const now = performance.now();
    // Dev only: scripted hands instead of the camera's, for testing gestures the fake camera cannot make.
    const feed = process.env.NODE_ENV !== "production" ? (globalThis as { __plasmaHandsFeed?: (t: number) => { points: number[]; side: string }[] }).__plasmaHandsFeed : undefined;
    if (feed && now - lastSent >= 1000 / 30) {
      lastSent = now;
      take(feed(now / 1000), now / 1000);
      fresh = true;
      if (!first) {
        first = true;
        card.done();
      }
    }
    // A hand that has gone from view lets go even with no new answers.
    publish(now / 1000);
    if (!feed && !busy && t.ready && video.readyState >= 2 && video.videoWidth > 0 && now - lastSent >= 1000 / OPTIONS.rate - 2) {
      busy = true;
      lastSent = now;
      const scale = Math.min(1, OPTIONS.width / Math.max(1, video.videoWidth));
      createImageBitmap(video, { resizeWidth: Math.round(video.videoWidth * scale), resizeHeight: Math.round(video.videoHeight * scale), resizeQuality: "low" }).then(
        (bitmap) => {
          if (stopped) {
            bitmap.close();
            return;
          }
          result.stats.sent++;
          t.worker.postMessage({ type: "frame", bitmap, time: now }, [bitmap]);
        },
        () => (busy = false)
      );
    }
    if (fresh) {
      fresh = false;
      draw();
    }
    handle = requestAnimationFrame(pump);
  };
  handle = requestAnimationFrame(pump);

  const draw = () => {
    if (!canvas || !label) return;
    // The canvas at the panel's own size in device pixels, not the camera's.
    const w = Math.round(panelWidth * Math.min(2, window.devicePixelRatio || 1));
    const h = Math.round((w * (video.videoHeight || 480)) / (video.videoWidth || 640));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const g = canvas.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, w, h);
    for (const [key, hand] of hands) {
      const slot = slotOf(key);
      const p = hand.points;
      const at = (k: number) => [(1 - p[k * 2]) * w, p[k * 2 + 1] * h];
      g.lineWidth = w / 160;
      g.strokeStyle = hand.near ? "rgba(200, 180, 255, 0.9)" : "rgba(200, 180, 255, 0.4)";
      g.beginPath();
      for (const [a, b] of BONES) {
        const [ax, ay] = at(a);
        const [bx, by] = at(b);
        g.moveTo(ax, ay);
        g.lineTo(bx, by);
      }
      g.stroke();
      if (hand.pinching) {
        // The pinch: a bright line between thumb and index tips.
        const [ax, ay] = at(4);
        const [bx, by] = at(8);
        g.strokeStyle = "#8fe9ff";
        g.lineWidth = w / 90;
        g.beginPath();
        g.moveTo(ax, ay);
        g.lineTo(bx, by);
        g.stroke();
      }
      for (let k = 0; k < 21; k++) {
        const [x, y] = at(k);
        const n = TIPS.indexOf(k);
        const touching = n >= 0 && result.onGlass.has(slot * 5 + n);
        const counts = n >= 0 && result.tips.some((tip) => tip.id === slot * 5 + n);
        g.fillStyle = touching ? "#ffffff" : counts ? "#ff6ad5" : "rgba(160, 140, 255, 0.9)";
        g.beginPath();
        g.arc(x, y, (w / 640) * (touching ? 16 : n >= 0 ? 11 : 6), 0, Math.PI * 2);
        g.fill();
        if (touching) {
          g.strokeStyle = "#ff6ad5";
          g.lineWidth = w / 190;
          g.stroke();
        }
      }
    }
    result.stats.delegate = t.delegate;
    let pinches = 0;
    for (const hand of hands.values()) if (hand.pinching) pinches++;
    const status = t.failed || (t.ready ? `${t.delegate} · ${answers.length} Hz · ${inference.toFixed(1)} ms · ${result.tips.length} tips${pinches ? ` · PINCH ×${pinches}` : ""}` : "loading tracker");
    label.textContent = `IRL Hands: ${status}`;
  };

  result.stop = () => {
    stopped = true;
    cancelAnimationFrame(handle);
    card.remove();
    release(t);
    for (const track of stream.getTracks()) track.stop();
    video.pause();
    video.srcObject = null;
    panel?.remove();
    window.clearInterval(placing);
    window.removeEventListener("resize", place);
    result.tips = [];
  };
  return result;
}
