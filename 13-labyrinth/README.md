# Day 13: Labyrinth

<img src="../videos/13-labyrinth.gif" alt="Labyrinth" width="384">

[Try it live](https://adamwebsite.com/codevember/13-labyrinth/)

A hedge maze without end that never stops rebuilding itself.

## How to play

Drag to look around, WASD to fly. Walk takes you down into the maze, Space to jump over the hedges; on a phone, hold still to walk.

Run it locally with `npm run dev` from the repo root, then open <http://localhost:3000/13-labyrinth/>.

## Technical overview

### The maze

- A perfect maze on a 40 by 40 torus tiles the ground; the camera wraps back one copy as it travels, so it never ends.
- It rewrites one loop at a time: removing a wall makes one loop, and restoring another wall on it keeps it perfect.

### Hedges

- Each wall is one instanced box with a TSL leaf material from noise; near hedges get cards of ivy, bramble and grass.
- Meshy rabbit cut from 30,524 to 300 triangles, colours baked in (4 kB); Meshy leaf cut to 24 triangles in six variants.

### Bent worlds

- Lighting, shadows and mist run on flat ground; only the last vertex step bends each point into ring, fold or twist.
- The bend changes at random every thirteen seconds, and motion vectors bend too so temporal anti-aliasing holds.

### Light and play

- Shadow maps, screen-space bounce light and occlusion, volumetric mist, depth of field and bloom.
- Walking collides with the hedges as they stand that frame; game mode lays coins on every path and hedge top.

Everyone whose work Codevember builds on is listed in [CREDITS.md](../CREDITS.md).
