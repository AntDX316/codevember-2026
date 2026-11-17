# Day 14: Tension

<img src="../videos/14-tension.gif" alt="Tension" width="384">

[Try it live](https://adamwebsite.com/codevember/14-tension/)

An orb web strung between twigs, beaded with dew, in four weathers. Pluck it and the spider comes running.

## How to play

Pull a thread and let it go. Pull too far and it snaps.

Run it locally with `npm run dev` from the repo root, then open <http://localhost:3000/14-tension/>.

## Technical overview

### The web

- Spun like a garden spider's: frame threads, spokes, a hub mesh, then the sticky spiral, wider below the hub.
- Position-based dynamics on the CPU, two substeps a frame, pulls threads back to length; pull too far and one snaps.

### Silk and dew

- Threads are camera-facing strips at least a pixel wide, faded as they widen, with a sheen and a rainbow glint.
- Instanced dew beads are ball lenses showing the garden upside down; their weight sags the web.

### The spider

- Six-segment legs are solved every frame, so the foot comes down steeply to grip and ride a thread.
- She walks in an alternating tetrapod, sits head down at the hub and runs along the silk to where you pluck.

### Tree and weather

- Twigs grow through the frame's anchors, with CC0 Poly Haven bark and shader-drawn leaves that glow when backlit.
- Four weathers glide into each other, lit by a blurred garden dome, with GPU particles, depth of field and bloom.

Everyone whose work Codevember builds on is listed in [CREDITS.md](../CREDITS.md).
