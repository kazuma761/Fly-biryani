# Reference project analysis

Detailed teardowns of the projects in `References/`, covering tech stack, architecture, how the flow actually works end to end, and observations.

| # | Project | Folder | Report |
|---|---|---|---|
| 1 | **Flymap / "Nona"** — connectome-navigated fly over 3D Bangalore | `References/Flymap/` | [01-Flymap-Nona.md](01-Flymap-Nona.md) |
| 2 | **Flinge** — fly on a dating app, mushroom-body dopamine learner | `References/flinge-main/` | [02-Flinge.md](02-Flinge.md) |
| 3 | **mario-cart / "Fly Racer"** — kart racer steered by a connectome over a WebSocket | `References/mario-cart/` | [03-Mario-Cart-Fly-Racer.md](03-Mario-Cart-Fly-Racer.md) |

Not covered (not a codebase): `References/kitchen/` contains a single PDF, *"Fruit Fly Fruit Ninja: game model.pdf"*. `References/nueral-visulazation/` is a fourth project, outside the requested first three — see `../last 2 project reports/` for it.

> Note: `../last 2 project reports/` also contains an earlier, shorter mario-cart report. Report 3 here is an independent, longer teardown of the same project; keep whichever you prefer.

---

## Side-by-side

| | Flymap | Flinge | Fly Racer |
|---|---|---|---|
| **Shape** | Single-page browser sim | Python service + React SPA | TS game + Python neural service |
| **Front end** | Vanilla ES modules, **no build** | React 19 + Vite 6 | TypeScript + Vite 7 |
| **3D** | Three.js 0.169 (importmap CDN) | Three.js 0.170 (STL + point cloud) | Three.js 0.180 + **Rapier** physics |
| **Brain runs in** | The browser, in JS | Python / NumPy | Python, external pinned **Fly64** model |
| **Connectome** | **Real** — MaleCNS v1.0 via neuPrint (166 + 4,492 neurons) | **Synthetic** stand-in, MaleCNS-sized (128/400/48/96) | **Real** — MaleCNS via a pinned external checkout |
| **Circuit** | Central complex ring attractor + mushroom body | Mushroom body only | Early visual + descending motor pools |
| **Learning** | Dopamine-gated KC→MBON depression, live in the browser | Same rule, NumPy, `gain -= lr·outer(kc, da)` | **None in the brain** — supervised decoder outside a frozen graph |
| **Brain → control** | Ring attractor population vector **is** the heading | Valence → `pass/like/comment/rizz` | Rates or decoder output → `VehicleInput` steering |
| **Input to brain** | Landmark bearing + hashed word codes | Random projection of profile-card pixels | **Real rendered 6-face 384×256 eye atlas** |
| **Controls/ablations** | Lesion Delta7, scramble wiring | Frozen vs trained | blank / frozen / shuffled / disconnected vision, `motorInputs=mean` |
| **Verification** | `verify.mjs`, `mbtest.mjs` (10 checks) | pytest + `validate` CLI | 34 TS tests, ~30 Python tests, physical race checks |
| **Deps** | **Zero npm packages** | NumPy, FastAPI, Pillow, React | Rapier, Three, websockets, NumPy, external Fly64 |
| **Setup cost** | `python -m http.server` | `make start` | venv + pinned checkout + MaleCNS cache + service |
| **Scale** | ~9.3k lines JS | ~2.1k Python + 1.8k JSX | ~6.5k Python + 4.5k TS |

---

## Patterns common to all three

1. **A prominent honesty section is treated as a deliverable.** Every project leads with what is real and what is not: Flymap's "The honest claim" (including "angular velocity integration does not work"), Flinge's "Honesty" paragraph and manifest note, Fly Racer's documented negative motor result. None of them let the demo imply more than the code does.
2. **Same learning rule everywhere it appears** — sparse Kenyon-cell code → KC→MBON synapses **depressed** where dopamine coincides with activity → push-pull MBON readout as valence. Flymap does it in JS over the real graph, Flinge in NumPy over a synthetic one.
3. **Controls are shipped, not described.** Lesion/scramble, frozen/trained, blank/shuffled/disconnected vision — in all three the null condition is reachable from the running product.
4. **A deliberately narrow interface between "brain" and "game".** Flymap: the parser only emits a stimulus and a dopamine sign, never a heading. Flinge: `decode_action` is a fixed threshold interface, explicitly "not discovered dating neurons". Fly Racer: one normalised `VehicleInput`. In each case the narrowness is what makes the claim defensible.
5. **Determinism by seeding** — fixed circuit seeds, hashed-word KC codes, per-profile RNGs, fixed neural seeds in the handshake.
6. **Data cached and hashed locally** so a demo never depends on the network: Flymap commits neuPrint JSON, Fly Racer hashes a dataset manifest and pins an upstream commit.
7. **Plain-node / plain-pytest verification, no heavy harness**, with the results pasted into the README as the claim itself.

## Where they differ most

- **Real vs synthetic connectome.** Flymap and Fly Racer use the real MaleCNS graph; Flinge simulates a same-sized random one. That single choice drives most of the difference in setup cost and in how strong a claim each can make.
- **Where the brain sits relative to control.** Flymap puts it *on* the control path (heading is the population vector). Flinge puts it on the path but behind an engineered decoder. Fly Racer runs the real graph and then, in its best-performing mode, steers from a *learned decoder over* it — with the honest conclusion that the motor circuit itself isn't contributing.
- **Setup friction vs rigour.** Flymap optimises for "it runs with the wifi off"; Fly Racer optimises for "you cannot accidentally run a different brain and believe you ran this one". Opposite ends, both deliberate.
