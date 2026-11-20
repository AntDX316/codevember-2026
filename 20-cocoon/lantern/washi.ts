import * as THREE from "three/webgpu";
import { lehmer } from "../../shared/engine/random";

// A sheet of washi, painted once on a canvas: cloudy where the pulp settled thick or thin, and laced with long kozo
// fibres. It tiles, so each panel can take its own piece of it. Grey is even paper; lighter is thicker.
export function paintWashi(size = 512) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  const random = lehmer(7741);
  ctx.fillStyle = "rgb(128,128,128)";
  ctx.fillRect(0, 0, size, size);

  // Every mark is drawn at each of the nine tile offsets that could show it, so the sheet wraps without a seam.
  const tiled = (draw: (dx: number, dy: number) => void) => {
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) draw(x * size, y * size);
  };

  // The cloud: soft blobs of thicker and thinner pulp at a few sizes.
  for (let i = 0; i < 260; i++) {
    const x = random() * size;
    const y = random() * size;
    const r = size * (0.03 + random() * random() * 0.22);
    const thick = random() < 0.5;
    const a = 0.05 + random() * 0.09;
    tiled((dx, dy) => {
      const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      g.addColorStop(0, thick ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`);
      g.addColorStop(1, "rgba(128,128,128,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
    });
  }

  // Fibres: many short fine ones, and fewer long ones that wander, mostly thicker than the sheet around them.
  const fibre = (long: boolean) => {
    const x = random() * size;
    const y = random() * size;
    const length = size * (long ? 0.18 + random() * 0.35 : 0.03 + random() * 0.1);
    const heading = random() * Math.PI * 2;
    const bend = (random() - 0.5) * 1.6;
    const steps = long ? 8 : 3;
    const width = long ? 0.6 + random() * 1.1 : 0.4 + random() * 0.8;
    const light = random() < 0.8;
    const a = long ? 0.18 + random() * 0.25 : 0.1 + random() * 0.2;
    const points: [number, number][] = [[x, y]];
    let h = heading;
    for (let s = 1; s <= steps; s++) {
      h += (bend / steps) * (0.5 + random());
      const [px, py] = points[s - 1];
      points.push([px + (Math.cos(h) * length) / steps, py + (Math.sin(h) * length) / steps]);
    }
    tiled((dx, dy) => {
      ctx.beginPath();
      ctx.moveTo(points[0][0] + dx, points[0][1] + dy);
      for (let s = 1; s < points.length; s++) {
        const [mx, my] = [(points[s - 1][0] + points[s][0]) / 2, (points[s - 1][1] + points[s][1]) / 2];
        ctx.quadraticCurveTo(points[s - 1][0] + dx, points[s - 1][1] + dy, mx + dx, my + dy);
      }
      ctx.lineTo(points[points.length - 1][0] + dx, points[points.length - 1][1] + dy);
      ctx.strokeStyle = light ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a * 0.7})`;
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.stroke();
    });
  };
  for (let i = 0; i < 700; i++) fibre(false);
  for (let i = 0; i < 90; i++) fibre(true);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}
