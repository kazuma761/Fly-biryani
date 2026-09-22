# Project 1 — Flymap ("Nona")

**Path:** `References/Flymap/`
**One line:** A browser game/simulation where a fly flies over a 3D Bangalore, and her sense of direction and her learning are both computed live by a real *Drosophila* connectome subgraph pulled from Janelia's MaleCNS v1.0 dataset.

---

## 1. Tech stack

| Layer | What they used |
|---|---|
| Runtime | **Plain browser ES modules. No build step, no bundler, no framework.** `python -m http.server 8080` is the whole dev server (`serve.py` also present) |
| 3D | **Three.js 0.169** loaded from jsDelivr through an `<script type="importmap">` in `index.html`; addons used: `OrbitControls`, `RoomEnvironment`, `EffectComposer`, `RenderPass`, `UnrealBloomPass` |
| Simulation | **Hand-written leaky integrate-and-fire (LIF) engine in pure JS** over typed arrays (`Float32Array`, `Int32Array`) with a **CSR sparse-matrix** layout for synapses |
| 2D HUD | Raw Canvas 2D (`src/hud.js`, `src/map.js`) |
| Voice/NLP | **Web Speech API** (`webkitSpeechRecognition`) + a ~100-line keyword parser. **No LLM, no API key, works offline** |
| Audio | WebAudio oscillators generated inline (chimes, buzz, key clicks) |
| Data pipeline | **Python + `neuprint-python` + pandas + `python-dotenv`** (`extract_*.py`) hitting `neuprint.janelia.org`, dataset `male-cns:v1.0`. Output cached as committed JSON so the demo runs with wifi off |
| Tests | **Node scripts, no test framework** — `node verify.mjs`, `node mbtest.mjs` print PASS/FAIL lines |
| Package.json | Literally `{"type":"module"}` — **zero npm dependencies** |

**Source size:** ~9,300 lines across 11 JS modules + a 1,812-line `index.html`.

---

## 2. Architecture / module map

```
index.html            page + importmap + all CSS (single file, 1.8k lines)
src/lif.js       198  generic LIF spiking-network engine (CSR, adaptation, NT signs)
src/compass.js   266  ring attractor — heading sense (central complex)
src/mushroom.js  208  Kenyon cells / MBONs / dopamine plasticity — learning
src/world.js    1184  Three.js Bangalore city, landmarks, flight dynamics
src/brain3d.js   368  3D neuron morphology render (merged tubes, PBR, bloom)
src/hud.js       177  2D ring + mushroom-body raster (Canvas)
src/map.js      1374  tactical minimap / radar
src/room.js      459  3D workstation room inside the "home" building
src/desk.js     1324  "NonaOS 98" retro desktop + training IDE overlay
src/listen.js    103  speech input + deliberately tiny intent parser
src/main.js     1806  the integration loop that joins everything
data/*.json           cached connectome (compass, mushroom, skeletons, compass_plus)
```

Data volumes they cite: compass = 166 neurons / 10,402 connections; mushroom body = 4,063 Kenyon cells, 97 MBONs, 332 DANs, 51,085 plastic synapses; 3D view = 472 neurons, 15,327 branches, ~597k vertices.

---

## 3. How the flow actually works

### 3.1 Boot
`boot()` in `main.js` does a retry-wrapped `fetch` of the four JSON datasets in parallel → constructs `Compass`, `MushroomBody`, `World`, `Room`, `Hud`, `Brain3D`, `Desk` → computes ER/PFL3 preferred angles from the edge list → seeds a bump at heading 0 → dismisses a boot veil → starts `requestAnimationFrame(frame)`. Everything is exposed on `globalThis.nona` for console debugging.

### 3.2 The neural engine (`lif.js`)
Generic and circuit-agnostic — both the compass and the mushroom body run on it.

- Constants are standard *Drosophila* values (Shiu et al.): `V_REST -52mV`, `V_THRESH -45mV`, `TAU_M 20ms`, `W_SYN 0.275mV`, refractory 2.2ms, plus spike-frequency adaptation.
- Neurotransmitter → sign map: acetylcholine `+1`, glutamate/GABA `-1`, modulators `+0.3`.
- Edges are built into **CSR** (`outPtr`/`outIdx`/`outW`) from the node/edge JSON; edges whose endpoints are outside the subgraph are dropped.
- **Per-neuron input normalisation** — each neuron's incoming weights are divided by its own total input × 100. They document this openly: the subgraph is ~63 edges/neuron, and raw sums saturate every cell. Relative pattern (the part that encodes heading) is untouched.
- `step(dt)`: leak toward rest + filtered synaptic current + external drive − adaptation; threshold crossing → reset + refractory + adaptation bump; then spikes are scattered to downstream partners through CSR; finally a ~50 ms low-passed `rate[]` is kept for display.
- Two built-in **controls**: `setAlive()` (lesion) and `scramble()` (degree-preserving random rewire — keeps every neuron's out-degree and weights, randomises the partner).

### 3.3 The compass (`compass.js`) — heading as an attractor
This is the clever part of the project.

- Each neuron's `instance` string (e.g. `EPG(PB08)_L3`) encodes which **protocerebral-bridge glomerulus** it belongs to. Since the PB tiles azimuth, that suffix **is** the neuron's preferred heading. `parseGlomeruli()` + `ringAngle()` read an anatomical coordinate out of the dataset instead of inventing a layout.
- Crucial discovery documented in the README: the **left PB hemisphere must be mirrored** (`L9…L1 | R1…R9`). Without it both PEN populations project the same way and the bump can't rotate; with it they come out at L +55.6° / R −55.9°, and EPG→EPG local weight rises 51% → 89%.
- Populations are picked by type: EPG, Delta7, PEG, PEN_a/PEN_b (split L/R by soma side).
- Each population gets its own tonic drive held *just below* threshold (EPG 0.39, PEN 0.14, Delta7 0.42) so the **recurrent wiring**, not the background, decides who fires. Gains (`excGain 0.14`, `inhGain 7.0`) were found by headless sweep (`scan.mjs`, `tune.mjs`, `final.mjs`).
- `setCue(theta)` = landmark pins the bump with a cosine drive onto EPG; `setLandmark()` optionally routes it through the **real ER ring-neuron population** (282 neurons, ~124k synapses) with a centre-surround step to sharpen broad ring input.
- `setTurn(omega)` drives PEN-L vs PEN-R asymmetrically — the mechanism that would walk the bump around the ring.
- `heading()` = **population vector over EPG firing rates**, with a `MIN_RATE = 2 Hz` floor so a near-silent ring can't fake a perfect heading.

### 3.4 The mushroom body (`mushroom.js`) — learning
- A word is hashed (FNV-1a → mulberry32 PRNG) into a **deterministic sparse 5% Kenyon-cell code**. Same word always lights the same KCs.
- KC→MBON edges are again stored as CSR, with a parallel `plast[]` multiplier array starting at 1.
- **Compartment identity is derived from the data**, not assigned: an MBON's `mbonSign` = `(ppl1Weight − pamWeight) / total`, i.e. which dopaminergic population actually innervates it in the connectome.
- `teach(word, sign)` depresses only the synapses that were active for that word **and** in the compartment matching the dopamine sign: `plast[p] *= 1 − 0.16 * |mbonSign|`. That's the real dopamine-gated depression rule.
- `valence(word)` = push-pull MBON readout measured against that word's own naive baseline, then `tanh(x*5)` so learning saturates instead of running away. An untaught word reads exactly 0.
- `changedSynapses()` and `forget()` back the UI's "1,409 of 51,085 depressed" / reset claims.

### 3.5 Language → dopamine (`listen.js`)
Deliberately tiny and local. It maps text to exactly two things: a **stimulus word** and a **dopamine sign**. Praise/scold word lists, a `SYNONYMS` table (`lab`→`home`, `park`→`cubbon`, `horns`→`traffic`), and three regexes (`this is X`, `go to X`, bare landmark). **It never sets the heading** — that constraint is what keeps the project's claim honest. Speech uses `SpeechRecognition` with `lang: 'en-IN'`, text box as fallback.

### 3.6 The frame loop (`main.js`)
Each animation frame:
1. If inside the "home computer" → step the brain 8 ms, render the room + desk, return early.
2. `chooseGoal()` — explicit user goal wins; otherwise pick the **landmark with the highest learned valence** above 0.12; otherwise, if the current cue has valence < −0.12, treat it as an *avoid* goal; otherwise null (wander).
3. Compute bearing to the goal, slew a `cueAngle` toward it (orbit offset +0.42π when within 52 m of a non-home landmark, +π when avoiding), and push it into `compass.setCue()`. No goal → random cue every ~3–6 s.
4. In manual mode, WASD turn input is fed into `compass.setTurn()` (PEN drive).
5. **Run 8 × 1 ms of neural time per rendered frame.**
6. Read `compass.heading()`, low-pass it into `smoothHeading` to remove spike jitter, and derive `autoSpeed` from bump strength × arrival falloff.
7. `world.update(dt, heading, autoSpeed, goal)` → flight; `world.render()`.
8. Push EPG/Delta7 rates, MBON activity, KC set, and valence into the 2D HUD; push a per-neuron rate buffer (core 166 + ER + PFL3, the latter two synthesised from the landmark bearing and heading) into `brain3d.setActivity()`.
9. Telemetry DOM updates, Cubbon Park "nectar stunt" trigger, auto-dock when within 55 m of home.

So: **learned valence chooses the goal → goal becomes a landmark cue → cue pins the ring attractor → the ring attractor's population vector *is* the flight heading.** The brain sits on the actual control path, not beside it.

### 3.7 The computer inside home (`desk.js`, `room.js`)
Approaching 2586Labs triggers `enterHome()` → world freezes, a camera tween dives into the building, and a **DOM/CSS "NonaOS 98" overlay** is drawn over a zoomed 3D monitor (explicitly copying henryheffernan.com's trick — sharp text, cheap, can call straight into the sim). The IDE's commands (`teach home`, `reward`, `avoid traffic`, `go home`, `forget`) go through **the same `runCommand` path as the chat box** → `parse()` → `mb.teach()` / `compass.setCue()`. There is no second brain. Exit is a CRT power-down → camera swoop → takeoff sequence.

`runCommand` itself is a ~200-line mini-shell: `help`, `clear`, `status`/`top` (full telemetry dump), `scan`/`radar` (range+bearing+valence per landmark), `fly <dest>`, `teach`, `reward`/`punish`, `lesion delta7`, `scramble`, `forget`, `mode`, `theme`, `dock` — with history and tab completion.

### 3.8 3D brain rendering (`brain3d.js`)
Real traced morphology from neuPrint skeletons (xyz + radius). Skeletons are pruned (terminal spine stubs dropped) and simplified with **Ramer-Douglas-Peucker** (142k → 32k points), then extruded into **merged tube geometry** (8 sides, radius capped at 1.05). One draw call per cell type; per-neuron brightness comes from a **per-vertex `aNeuron` attribute indexing a 166-texel activity texture rewritten every frame**. `MeshPhysicalMaterial` + `RoomEnvironment` + `UnrealBloomPass`, with activity driving vertex displacement in the shader. Deliberately no `transmission` (too costly at 256k verts).

---

## 4. Verification approach (worth stealing)
Two plain Node scripts assert every claim the README makes, and both must be green before the claim is repeated:

- `verify.mjs` — bump forms (strength 0.41 @ 69 Hz); tracks landmark (mean error 22°); **holds heading 3 s with no input** (drift 60°, strength 0.33 = working memory); lesion Delta7 collapses the bump (0.41 → 0.03); **scrambled wiring cannot sustain** (0.38 vs 0.06).
- `mbtest.mjs` — reward builds approach valence (0 → 0.37 → 0.66 → 0.83 → 0.96); punishment → −0.91; **learning is specific to the word** (home 0.96, worst other 0.000); 1,409 of 51,085 synapses depressed; `forget` restores naive.
- Supporting measurement scripts that *shaped* the model rather than testing it: `diag.mjs` (pathway peak offsets), `mirror.mjs` (the hemisphere-mirror proof), `roundtrip.mjs` (PEN offsets L +5.9° / R −5.9°), `ertrack.mjs`/`diag_er.mjs` (why ER is shown but not put in control).

---

## 5. Observations — what to take from this project

**Strengths**
1. **The honesty section is the product.** The README leads with "what is real / what is NOT claimed", including an outright admission that *angular-velocity integration does not work* (the bump jumps between discrete states under sustained turn, so heading is set by visual landmark instead). That credibility is far more persuasive than a bigger feature list.
2. **Controls are built into the engine.** Lesion + degree-preserving scramble are first-class functions, so "the structure does the work" is a measurable claim, not rhetoric.
3. **Anatomy read out of the data, not assigned.** Heading from the glomerulus suffix; MBON reward/punishment compartment from which DAN population innervates it. Both remove the biggest "you just hardcoded it" objection.
4. **Zero-dependency, zero-build front end.** `python -m http.server` and it runs with the wifi off. For a hackathon/demo context this eliminates an entire class of failure.
5. **Data cached as committed JSON** with Python re-pull scripts behind a token — fast demo, reproducible provenance.
6. **One command path.** Chat box and in-game IDE both call `runCommand`, so there's no divergent second implementation to keep honest.
7. **Performance discipline:** typed arrays + CSR, 8 ms of neural time per frame, merged tube geometry, one activity texture, RDP simplification.

**Weaknesses / risks**
1. `main.js` at 1,806 lines and `index.html` at 1,812 lines are monoliths — DOM wiring, mascot easter eggs, audio, telemetry and the sim loop all live together.
2. Cache-busting is done by hand (`./compass.js?v=5` on every import) — easy to get wrong.
3. No automated test runner, no CI, no lint; verification is two scripts someone must remember to run.
4. Hand-tuned gains (`excGain`, `inhGain`, tonics) found by sweep are a real modelling liberty — documented, but they are the load-bearing free parameters.
5. The mushroom-body sensory encoding (word → hashed sparse KC code) is *not* biological; it's a hash. Legitimately flagged, but it means the "learning" is association over an invented code.
6. ER/PFL3 are rendered and lit by real signals but are **not in the control loop** — routing the landmark through real ER makes pointing worse (30–60° vs 22°). Shown rather than hidden, but the loop is not closed.
