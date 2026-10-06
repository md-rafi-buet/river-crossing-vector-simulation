# River Crossing: Vector Addition & Relative Velocity

An interactive 3D website that explains **vector addition** and **relative velocity** through the classic
"boat crossing a flowing river" problem.

```
V_bg = V_bw + V_wg
(boat w.r.t. ground) = (boat w.r.t. water) + (water w.r.t. ground)
```

## Running it

Open `index.html` in a modern browser (Chrome, Edge, Firefox or Safari). Three.js and KaTeX load from a
CDN, so you need an internet connection. No build step is needed, and the page also works when opened
straight from disk.

To serve it locally instead:

```bash
python -m http.server 8765
```

Then visit http://localhost:8765.

## Project structure

| File | Responsibility |
| --- | --- |
| `index.html` | Page layout: 3D viewport, HUD, control panel, math panel |
| `style.css` | Visual design and responsive layout (desktop, laptop, tablet) |
| `script.js` | App entry point: state, animation loop, wiring between modules |
| `js/physics.js` | **Pure physics** with no rendering: vector maths, special cases, time integration |
| `js/geometry.js` | Reusable Three.js pieces: 3D arrows, thick ribbon lines, angle arcs, HTML labels |
| `js/scene.js` | The 3D world: river, banks, boat, markers, rulers, water particles, camera views |
| `js/vectors.js` | Vector visualisation: V_bw / V_wg / V_bg arrows, triangle, components, paths |
| `js/ui.js` | Controls, heading dial, "Live Vector Mathematics" panel, HUD, cards |
| `js/learning.js` | Learning Mode, the "Explain Vector Addition" demo, Prediction Mode |

## Conventions

* **+x** is downstream (the direction of the current). **+y** points straight across, from the start bank (y = 0) to the opposite bank (y = W).
* Heading **θ** is measured from +x: 0° points downstream, 90° straight across, 180° upstream.
* The boat's **nose** points along V_bw. Its **motion** follows V_bg.

## Physics accuracy

* Each frame advances the boat with `r ← r + V_bg·Δt`, where Δt is the real elapsed time × playback speed. The physics never depends on the frame rate.
* If the far bank is reached inside a frame, the step is shortened to the exact moment of arrival. The simulated crossing time and landing point therefore match `t = W / V_y` and `x = V_x·t` exactly.
* Changing velocities during a crossing bends the path, and the simulation records it piece by piece.
* The playback speed (0.25× to 4×) changes only how fast the result is shown, never the result itself.

## Keyboard shortcuts

`Space` play/pause · `R` reset · `T` top view · `V` 3D view · `Esc` close a mode
