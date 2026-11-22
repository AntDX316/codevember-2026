import * as THREE from "three/webgpu";
import { days, daySlug } from "@/shared/days";
import { lightHub } from "../budget";
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
export function coverPicture(image: HTMLImageElement | HTMLCanvasElement, w: number, h: number) {
  const scale = Math.min(globalThis.devicePixelRatio || 1, 2);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.imageSmoothingQuality = "high";
    const [iw, ih] = image instanceof HTMLImageElement ? [image.naturalWidth, image.naturalHeight] : [image.width, image.height];
    const fit = Math.max(canvas.width / iw, canvas.height / ih);
    const [dw, dh] = [iw * fit, ih * fit];
    ctx.drawImage(image, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

// On a light hub (budget.ts) each poster is kept at no more than this, rather than its own 1200 by 1500: 2.6 MB of GPU memory
// each with its smaller copies, rather than 9.6. A tile on a phone shows a poster a few dozen pixels across, a card on the
// page a few hundred, and only the moment of arriving back at a portal, fading in under the day's last frame, shows one
// larger, a little soft.
const LIGHT_POSTER = { w: 640, h: 800 };

async function lighten(texture: THREE.Texture) {
  const image = texture.image as HTMLImageElement;
  const scale = Math.min(LIGHT_POSTER.w / image.naturalWidth, LIGHT_POSTER.h / image.naturalHeight);
  if (!(scale < 1)) return;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  // Kept as a small JPEG rather than as the canvas: the browser may drop a picture's decoded pixels while it is not being
  // drawn, and decode it again when it is, where a canvas holds its 2 MB for good. It is uploaded again from this after the
  // posters have been let go (below). The full-size picture is let go.
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  canvas.width = canvas.height = 0;
  if (!blob) return;
  const small = new Image();
  small.src = URL.createObjectURL(blob);
  await small.decode();
  texture.image = small;
  texture.needsUpdate = true;
}

// Every live day's poster and the colour it casts, shared by the calendar and the spaces and loaded once for all of them.
// A poster that fails to load leaves its card plain, as a day without one, rather than taking the hub down.
export async function loadPosters() {
  const loader = new THREE.TextureLoader();
  const light = lightHub();
  const results = await Promise.allSettled(
    days
      .filter((day) => day.live)
      .map(async (day) => {
        const slug = daySlug(day);
        // The hub's own, sharp one; the calendar's until one has been taken.
        const poster = await loader.loadAsync(`${POSTERS}/${slug}.jpg`).catch(() => loader.loadAsync(`/${slug}.jpg`));
        poster.colorSpace = THREE.SRGBColorSpace;
        poster.anisotropy = 8;
        if (light) await lighten(poster).catch(() => {});
        return [slug, { poster, tint: tintOf(poster.image as CanvasImageSource) }] as const;
      })
  );
  return new Map<string, { poster: THREE.Texture; tint: THREE.Color }>(results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])));
}

// The posters stay loaded for the whole visit, so that coming back to the hub is quick, but their GPU copies (about 190 MB
// with twenty days out, at full size) are let go while a day is open, which needs the memory more: the calendar calls this
// as it goes, and they are uploaded again from the pictures kept here when it comes back, behind the frame held over it.
export function releasePosters(posters: Map<string, { poster: THREE.Texture }>) {
  for (const { poster } of posters.values()) poster.dispose();
}
