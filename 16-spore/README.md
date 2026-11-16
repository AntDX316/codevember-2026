# Day 16: Spore

<img src="../videos/16-spore.gif" alt="Spore" width="384">

[Try it live](https://adamwebsite.com/codevember/16-spore/)

A forest floor at night. Spores drift down where you touch it, and where they land a bioluminescent bloom grows and spreads.

## How to play

Tap the forest floor to let spores go. Where they land, glowing mushrooms grow, and threads of light spread between them under the leaves. Hold, then drag, to scatter a trail. Drag to look round.

Run it locally with `npm run dev` from the repo root, then open <http://localhost:3000/16-spore/>.

## Technical overview

### Mushrooms

- Every mushroom is one instanced draw built from numbers rather than a shape: each vertex knows only whether it is stem, cap or gills, how far along and how far round, and the shader makes the mushroom from that, its own size and lean, and how far it has grown. So a cluster costs the processor nothing once it is written: births, growth and glow are all worked out from the clock.
- Six kinds grow, from crowded troops of little bells on thread-thin stems and rice-sized bonnets to stout dipped caps, tall parasols, inkcaps and upturned funnels, with now and then a giant cluster twice the size of the rest. Each grows like a spring let go, the stem overshooting and settling before the cap pops open from a closed bud with a flash. Some glow brilliantly, some barely at all and some in slow waves rolling across their cluster; brush one and it leans, springs back and lights up.
- Before it shoots its spores a mushroom scrunches down with a shiver, then springs up as they go. The spores rise in a swirl, drift on wavering arcs and land, and those that land on floor or wood grow new clusters, so the bloom spreads by itself. Seven kinds of spore cloud are worked out in the shader from where and when each spore began and ends.

### Mycelium and light

- From each cluster threads of mycelium wander out through the litter, turning in lazy curves and forking, with a thicker strand reaching to the nearest other cluster. They are strips turned to the eye, growing at a living thread's pace, their tips brightest and pulses of light running out along them; each tap sends a ring of light through them and rocks the mushrooms it reaches.
- The blooms light everything round them through a coarse grid over the floor, filled on the processor each frame with the mushrooms' and threads' own light, so the litter, logs, ferns and grass take the colour of whatever glows nearby. Giant neon mushrooms stand in two rings out among the trees, their light worked out per vertex since it changes only over metres, with soft haloes hanging in the damp air.

### The forest floor

- The floor is a scan of decaying leaf litter (Poly Haven, CC0) pushed up by its own heights, with rainwater standing in its hollows: the puddles are real reflections, a second camera drawing only what glows and the woods behind from under the floor. Over it lie thousands of curled, folded leaves each wearing a patch of the scan, twigs, scanned stones and deadwood, moss cushions, sorrel, patches of grass in darker shades, and procedural ferns whose toothed leaflets are cut in the shader.
- Dew beads the litter and the logs, each drop a tiny ball lens as in Tension: the night bent upside down inside it, its rim mirroring the sky, the moon gathered to a burning point. Two big fallen trees lie across the floor, one built as a kinked, split tube with sloughed bark and bracket fungi, the other a scan, with smaller logs about; mushrooms grow along them too.
- Each kind of litter is split into wedges and rings round the middle, each with its own bounds, so whatever is behind the eye is skipped whole; the quality tier is judged behind the loader and sets how much litter is drawn.

### The night

- Tall trunks with shelf fungi stand all round under a starry sky and the Milky Way, mist lying low among them and far blooms glowing out of focus. Deer wander in the dark, seen only as black shapes against the mist and the giants' glow, walking a real deer's four-beat walk with each hoof planted, stopping to graze and look about. Fireflies blink and dust catches the moon.
- The view orbits close in among the mushrooms, its pivot kept near the floor, and depth of field focuses on whatever is in the middle of the frame. Three glows, Foxfire, Ghost and Aurora, change only the colours.
- Sound: crickets, a low hum of the woods, an owl and falling drops; a bubble as a mushroom is brushed, a breath and sparkle as spores go, and a soft pentatonic chime as each new cluster shows, all synthesised in Web Audio, over a music track.

Everyone whose work Codevember builds on is listed in [CREDITS.md](../CREDITS.md).
