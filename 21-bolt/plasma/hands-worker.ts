// IRL Hands, off the main thread: MediaPipe's hand landmarker, fed one camera frame at a time, answering with the 21
// landmarks of up to two hands and how long it took. Everything runs here on the device; nothing is sent anywhere.
// The tracker's files are fetched here too, counted as they stream in so the page can show real progress, and the WASM
// is compiled and the model loaded here, so none of it holds up the page.
import { HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";

const BASE = "/assets/21-bolt/mediapipe";
const WASM = `${BASE}/vision_wasm_internal.wasm`;
const MODEL = `${BASE}/hand_landmarker.task`;
// Sizes to count against if the server does not say.
const SIZES: Record<string, number> = { [WASM]: 14603354, [MODEL]: 7819105 };

type Message = { type: "frame"; bitmap: ImageBitmap; time: number } | { type: "init"; delegate: "GPU" | "CPU"; pixels: boolean };

// With the CPU delegate, frames are handed over as plain pixels read on the CPU here, so MediaPipe never starts a WebGL
// context of its own to convert them (that WebGL work ran on the GPU alongside the globe, every frame).
let pixels: OffscreenCanvasRenderingContext2D | null = null;
let usePixels = false;

let landmarker: HandLandmarker | null = null;
let last = 0;

// Both files at once, streamed, the bytes so far posted a few times a second.
async function download() {
  const loaded: Record<string, number> = { [WASM]: 0, [MODEL]: 0 };
  const total: Record<string, number> = { ...SIZES };
  let posted = 0;
  const report = (force = false) => {
    const now = performance.now();
    if (!force && now - posted < 100) return;
    posted = now;
    self.postMessage({ type: "progress", stage: "download", loaded: loaded[WASM] + loaded[MODEL], total: total[WASM] + total[MODEL] });
  };
  const fetchOne = async (url: string) => {
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`${url.split("/").pop()} could not be downloaded (${response.status})`);
    const length = Number(response.headers.get("content-length"));
    // Ignore a length that is the compressed size of a file sent compressed.
    if (length > 0 && !response.headers.get("content-encoding")) total[url] = length;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded[url] += value.byteLength;
      if (loaded[url] > total[url]) total[url] = loaded[url];
      report();
    }
    const bytes = new Uint8Array(loaded[url]);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return bytes;
  };
  const [wasm, model] = await Promise.all([fetchOne(WASM), fetchOne(MODEL)]);
  report(true);
  return { wasm, model };
}

const create = (wasmUrl: string, model: Uint8Array, delegate: "GPU" | "CPU") =>
  HandLandmarker.createFromOptions(
    { wasmLoaderPath: `${BASE}/vision_wasm_internal.js`, wasmBinaryPath: wasmUrl },
    {
      baseOptions: { modelAssetBuffer: model, delegate },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    }
  );

// Started by the page's first message, which says which delegate to try first.
const start = async (prefer: "GPU" | "CPU") => {
  let stage = "download";
  try {
    const { wasm, model } = await download();
    stage = "start";
    self.postMessage({ type: "progress", stage });
    const wasmUrl = URL.createObjectURL(new Blob([wasm as BlobPart], { type: "application/wasm" }));
    let delegate = prefer;
    try {
      landmarker = await create(wasmUrl, model, delegate);
    } catch {
      delegate = delegate === "GPU" ? "CPU" : "GPU";
      landmarker = await create(wasmUrl, model, delegate);
    }
    // One frame through it now, so the GPU builds its shaders before the first real frame.
    const blank = await createImageBitmap(new ImageData(320, 240));
    landmarker.detectForVideo(blank, ++last);
    blank.close();
    self.postMessage({ type: "ready", delegate });
  } catch (error) {
    self.postMessage({ type: "error", stage, message: error instanceof Error ? error.message : String(error) });
  }
};
let ready: Promise<void> | null = null;

self.onmessage = async (event: MessageEvent<Message>) => {
  if (event.data.type === "init") {
    usePixels = event.data.pixels;
    ready ??= start(event.data.delegate);
    return;
  }
  const { bitmap, time } = event.data;
  await ready;
  if (!landmarker) {
    bitmap.close();
    return;
  }
  // Video timestamps must only ever increase.
  const stamp = Math.max(time, last + 1);
  last = stamp;
  const began = performance.now();
  let result: HandLandmarkerResult | null = null;
  try {
    if (usePixels) {
      if (!pixels || pixels.canvas.width !== bitmap.width || pixels.canvas.height !== bitmap.height) {
        pixels = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d", { willReadFrequently: true });
      }
      if (pixels) {
        pixels.drawImage(bitmap, 0, 0);
        result = landmarker.detectForVideo(pixels.getImageData(0, 0, bitmap.width, bitmap.height), stamp);
      }
    } else result = landmarker.detectForVideo(bitmap, stamp);
  } catch {
    result = null;
  }
  bitmap.close();
  const ms = performance.now() - began;
  const hands = (result?.landmarks ?? []).map((points, k) => ({
    points: points.flatMap((p) => [p.x, p.y, p.z]),
    side: result?.handedness?.[k]?.[0]?.categoryName ?? ""
  }));
  self.postMessage({ type: "result", hands, ms, time });
};
