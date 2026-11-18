import * as THREE from "three/webgpu";
import { days, daySlug } from "@/shared/days";
import { POSTERS } from "../posters";

// The average colour of a picture, made a little richer: the colour its portal lights the floor with.
export function tintOf(image: CanvasImageSource) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 6;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return new THREE.Color("#ffb48a");
  ctx.drawImage(image, 0, 0, 6, 6);
  const data = ctx.getImageData(0, 0, 6, 6).data;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  const colour = new THREE.Color().setRGB(r / 36 / 255, g / 36 / 255, b / 36 / 255, THREE.SRGBColorSpace);
  const hsl = { h: 0, s: 0, l: 0 };
  colour.getHSL(hsl);
  return colour.setHSL(hsl.h, Math.min(1, hsl.s * 1.6 + 0.1), Math.min(0.62, Math.max(0.42, hsl.l * 1.4)));
}

// A poster cropped to cover a card w by h CSS pixels and drawn by the browser at the card's own pixels: what the page shows
// of it, the same pixels whether the GPU draws it or the page as HTML shows it (spaces/mirror.ts).
export function coverPicture(image: HTMLImageElement, w: number, h: number) {
  const scale = Math.min(globalThis.devicePixelRatio || 1, 2);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.imageSmoothingQuality = "high";
    const fit = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const [dw, dh] = [image.naturalWidth * fit, image.naturalHeight * fit];
    ctx.drawImage(image, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

// Every live day's poster and the colour it casts, shared by the calendar and the spaces and loaded once for all of them.
// A poster that fails to load leaves its card plain, as a day without one, rather than taking the hub down.
export async function loadPosters() {
  const loader = new THREE.TextureLoader();
  const results = await Promise.allSettled(
    days
      .filter((day) => day.live)
      .map(async (day) => {
        const slug = daySlug(day);
        // The hub's own, sharp one; the calendar's until one has been taken.
        const poster = await loader.loadAsync(`${POSTERS}/${slug}.jpg`).catch(() => loader.loadAsync(`/${slug}.jpg`));
        poster.colorSpace = THREE.SRGBColorSpace;
        poster.anisotropy = 8;
        return [slug, { poster, tint: tintOf(poster.image as CanvasImageSource) }] as const;
      })
  );
  return new Map<string, { poster: THREE.Texture; tint: THREE.Color }>(results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])));
}
