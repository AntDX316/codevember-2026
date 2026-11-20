"use client";

import type { Variant } from "../kit";
import { COLOURS, ROOM, Studio, Swaddle } from "./scene";

function Scene() {
  return (
    <>
      <Studio />
      <Swaddle />
    </>
  );
}

const label = (name: string) => name[0].toUpperCase() + name.slice(1);

const swaddle: Variant = {
  Scene,
  settings: {
    swaddleFabric: {
      type: "choice",
      label: "Fabric",
      value: "satin",
      options: [
        { value: "satin", label: "Satin" },
        { value: "velvet", label: "Velvet" },
        { value: "linen", label: "Linen" },
        { value: "chiffon", label: "Chiffon" }
      ]
    },
    swaddleColour: {
      type: "choice",
      label: "Colour",
      value: "blush",
      options: Object.entries(COLOURS).map(([value, swatch]) => ({ value, label: label(value), swatch: [swatch] }))
    },
    swaddleBreathing: { type: "toggle", label: "Breathing", value: true },
    swaddleWrap: { type: "action", label: "Unwrap / rewrap" }
  },
  view: { position: [1.1, 1.75, 5.9], target: [0, -0.1, 0], fov: 34 },
  look: { background: ROOM.horizon, exposure: 1.05, bloom: 0.18, bloomThreshold: 1.2, ao: 0.9, aoRadius: 0.25, vignette: 0.42, grain: 0.014 },
  hint: "Grab the cloth anywhere and pull. Let go and it swaddles itself again.",
  notes: "A sheet of fine cloth wound round a soft, unseen body that breathes inside it, with a warm light at its heart. Pull it and it stretches, slides and folds; let go and it cinches back.",
  overview: [
    {
      title: "Cloth",
      points: [
        "A grid of up to 5,000 particles stepped on the CPU with Verlet integration and position-based distance constraints: along the weave, across the diagonals and two apart for bending.",
        "The sheet is wound once and a fifth round an egg, with spare cloth at the gathered ends and in soft bands down it, so it buckles into folds rather than lying smooth.",
        "A gentle pull to its place on the body, firm onto the surface and loose along it, lets it slide where it is pushed and cinch back when let go."
      ]
    },
    {
      title: "Fabrics",
      points: [
        "Satin uses anisotropic highlights along its threads, velvet a strong sheen lobe for its pile, linen a slubbed weave and a dry lustre, chiffon is sheer.",
        "Each also moves as itself: satin slips over the body, velvet grips and hangs heavy, linen holds crisp folds, chiffon floats down slowly.",
        "Light from the body's heart comes through each in proportion to how open it is, and a small lamp inside lights the cloth's inner face."
      ]
    }
  ]
};

export default swaddle;
