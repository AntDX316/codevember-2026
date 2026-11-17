# Day 15: Mirage

<img src="../videos/15-mirage.gif" alt="Mirage" width="384">

[Try it live](https://adamwebsite.com/codevember/15-mirage/)

A little desert whose sand turns to water under your hand. Where the water lingers, grass and palms grow, until the desert is an oasis.

## How to play

Drag across the dunes to turn the sand to water. Keep going and an oasis grows. Drag the sky, hold the middle button or swipe two fingers on a trackpad to look round.

Run it locally with `npm run dev` from the repo root, then open <http://localhost:3000/15-mirage/>.

## Technical overview

### Sand and water

- A heightfield of sand, water and wetness runs in WebGPU compute; the hand turns sand to water that flows by the pipe method.
- Water is lit per pixel with ripples, traced reflections, a depth-darkened bed and caustics.

### Instancing

- Hundreds of thousands of grains are culled each frame by a compute pass with an atomic counter, and drawn from that list.
- Moisture greens the desert: up to 900,000 grass blades in eight clump kinds, grown and culled in compute.

### Palms and animals

- Seven kinds of palm sprout, turn woody and leaf out, with fronds built leaflet by leaflet.
- Flamingos and camels are single skins of blended rods meshed by surface nets, skinned on the GPU.

### Sky and the mirage

- A ray-marched wall round the patch bends the far dunes into Fata Morgana towers; light shafts march against depth.
- Depth of field focuses like an eye, reading the depth of whatever sits at the centre of the frame.

Everyone whose work Codevember builds on is listed in [CREDITS.md](../CREDITS.md).
