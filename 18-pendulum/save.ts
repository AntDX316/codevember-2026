import * as THREE from "three/webgpu";
import { snapshot } from "./canvas";
import { CANVAS } from "./pendulum";

// The painting as an image to keep: the canvas drawn straight down from overhead, square to it and filling the picture,
// with the can, rope and stream hidden for the moment, signed small in a corner, and downloaded as a PNG.
//
// None of it may freeze the studio. The render's pipelines are built at load (prepareSave, behind the loader), not on
// the first press; the pixels come back from the graphics card without waiting on it; turning them from linear light to
// sRGB is a table lookup a value, done a slice of rows at a time between frames; and the PNG is encoded off the main
// thread by the browser. progress hears how far it has got, 0 to 1.

const SIZE = 2048;
const camera = new THREE.OrthographicCamera(-CANVAS / 2, CANVAS / 2, CANVAS / 2, -CANVAS / 2, 0.1, 6);
camera.position.set(0, 3, 0);
camera.up.set(0, 0, -1);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();
const targetFor = (size: number) => new THREE.RenderTarget(size, size, { type: THREE.HalfFloatType });

// The whole save run once behind the loader, at full size and read back, without the picture: every pipeline, buffer
// and table it needs is made now, so the first press costs no more than any other.
export function prepareSave(renderer: THREE.WebGPURenderer, scene: THREE.Scene) {
  halfToSrgb();
  const target = targetFor(SIZE);
  const before = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(before);
  renderer
    .readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE)
    .catch(() => undefined)
    .finally(() => target.dispose());
}

// Each half float's bits straight to an sRGB byte, worked out once.
let table: Uint8Array | null = null;
function halfToSrgb() {
  if (table) return table;
  table = new Uint8Array(65536);
  for (let h = 0; h < 65536; h++) {
    const c = Math.min(1, Math.max(0, fromHalf(h) || 0));
    table[h] = Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
  }
  return table;
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

// upright: the canvas on its turntable, squared up for the picture while it is taken.
export async function savePainting(renderer: THREE.WebGPURenderer, scene: THREE.Scene, hide: THREE.Object3D[], upright: THREE.Object3D | null = null, progress: (done: number) => void = () => undefined) {
  progress(0.02);
  await nextFrame();
  const target = targetFor(SIZE);
  snapshot.value = 1;
  const turned = upright?.rotation.y ?? 0;
  if (upright) upright.rotation.y = 0;
  const shown = hide.map((o) => o.visible);
  hide.forEach((o) => (o.visible = false));
  const before = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(before);
  hide.forEach((o, k) => (o.visible = shown[k]));
  if (upright) upright.rotation.y = turned;
  snapshot.value = 0;
  progress(0.1);
  const pixels = (await renderer.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE)) as Uint16Array | Float32Array | Uint8Array;
  target.dispose();
  progress(0.2);

  // Into a picture, from the render's linear light to sRGB, a slice of rows a frame.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const g = canvas.getContext("2d")!;
  const image = g.createImageData(SIZE, SIZE);
  const lut = halfToSrgb();
  const out = image.data;
  const ROWS = 128;
  for (let row = 0; row < SIZE; row += ROWS) {
    const end = Math.min(SIZE, row + ROWS) * SIZE * 4;
    for (let i = row * SIZE * 4; i < end; i += 4) {
      if (pixels instanceof Uint16Array) {
        out[i] = lut[pixels[i]];
        out[i + 1] = lut[pixels[i + 1]];
        out[i + 2] = lut[pixels[i + 2]];
      } else {
        const scale = pixels instanceof Uint8Array ? 1 / 255 : 1;
        for (let c = 0; c < 3; c++) {
          const v = Math.min(1, Math.max(0, pixels[i + c] * scale));
          out[i + c] = Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255);
        }
      }
      out[i + 3] = 255;
    }
    progress(0.2 + 0.55 * (Math.min(SIZE, row + ROWS) / SIZE));
    await nextFrame();
  }
  g.putImageData(image, 0, 0);
  g.font = `500 ${SIZE / 70}px system-ui, sans-serif`;
  g.fillStyle = "rgba(255, 255, 255, 0.55)";
  g.textAlign = "right";
  g.fillText(`Codevember · Pendulum · ${new Date().toLocaleDateString()}`, SIZE - SIZE / 40, SIZE - SIZE / 40);
  progress(0.8);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The painting could not be encoded");
  progress(0.97);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `pendulum-painting-${Date.now()}.png`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  progress(1);
}

// A half float's bits to a number.
function fromHalf(h: number) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}
