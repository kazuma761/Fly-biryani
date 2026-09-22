# Shop-fly — Project Context

## What this repo is right now

A workspace with two halves:

- `Mainproject/` — where the thing we are building will live. Today it holds only
  `reference-analysis/`: eight markdown teardowns of the reference projects.
- `References/` — five borrowed codebases (`Flymap`, `flinge-main`, `mario-cart`,
  `nueral-visulazation`, `kitchen`). **Do not read these unless explicitly asked.**
  The analysis docs exist so the reference code does not have to be re-read; go to the
  source folder only when we are about to lift a specific mechanism out of it.

## The domain: *Drosophila* connectome-driven applications

Every reference is the same bet in a different costume: take a **real measured fruit-fly
connectome** (Janelia **MaleCNS v1.0**, ~166,700 neurons / ~24.5M synapses), run it
honestly as a spiking network, and wrap an interface around it that makes the loop
inspectable — while refusing, structurally, to fake the parts that do not work.

Two brain circuits recur across all five:

| Circuit | What it gives you | Used by |
|---|---|---|
| **Central complex ring attractor** (EPG / PEN / PEG / Delta7) | Heading sense; the population vector *is* a direction | Flymap |
| **Mushroom body** (PN → KC → MBON, DAN dopamine, APL inhibition) | Associative learning of preference/valence | Flymap, Flinge, kitchen |
| Early visual + descending motor pools | Vision → steering | mario-cart |

The mushroom-body learning rule is the same everywhere it appears: sparse KC code
(k-winners-take-all, ~5–6% sparsity) → **dopamine-gated depression** of exactly the
KC→MBON synapses active when dopamine arrived → push–pull MBON readout as valence.
kitchen inverts the sign (bounded appetitive potentiation toward a ceiling of
`1.5 × anatomical count`) because its reward is appetitive.

## The five references, one line each

| # | Project | Path | What it is | Brain is |
|---|---|---|---|---|
| 1 | **Flymap / "Nona"** | `References/Flymap/` | Fly flies over 3D Bangalore; voice commands teach her which landmarks to like. Zero-build browser ES modules, LIF engine in pure JS, no npm deps. | **Real** MaleCNS (166 compass + 4,492 MB neurons), runs in the browser |
| 2 | **Flinge** | `References/flinge-main/` | Fly on a Hinge-style dating app + a 7-stage heartbreak curriculum. FastAPI/NumPy backend, React 19 + Three.js UI. | **Synthetic** MaleCNS-sized random circuit (its weakest claim, stated 3× in the repo) |
| 3 | **mario-cart / "Fly Racer"** | `References/mario-cart/` | Split-screen Three.js + Rapier kart racer; the opponent is a connectome over a WebSocket. ~6.5k Py + 4.5k TS, distributed 2-Mac training. | **Real** MaleCNS via an external **Fly64** checkout pinned by git SHA |
| 4 | **nueral-visulazation / FlyBuddy** | `References/nueral-visulazation/` | One fly in three bodies: MLX/Metal connectome viewer (124,314 somas), a pure-stdlib Shazam-style "ears" service, and an ESP32-S3 desk toy — **one process**, one in-process event bus. | **Real** MaleCNS v1, fused Metal LIF kernels, 0.1 ms ticks |
| 5 | **kitchen / Fruit Fly Fruit Ninja** | `References/kitchen/` (PDF only; code is at the deployed Vercel site, unbundled ES modules) | 3D kitchen; 8 fly chefs learn fruit preferences, then fly to a knife and chop. Static hosting, no backend. | **Real** MaleCNS subset shipped as a 319-neuron `circuit.json` that documents its own sampling bias |

## Reusable pieces, indexed by need

When we need X, the reference to lift from is:

| Need | Go to |
|---|---|
| Spiking **LIF engine** in JS, CSR sparse synapses, typed arrays | Flymap `src/lif.js` (198 lines, circuit-agnostic) |
| **LIF on Apple GPU** (fused Metal kernels, pause/resume live state) | nueral-visulazation `visualization/live_engine.py` |
| **Heading from anatomy** (PB glomerulus suffix → preferred angle; left hemisphere must be mirrored) | Flymap `src/compass.js` |
| **Mushroom-body learning**, JS, real graph, MBON compartment derived from which DAN innervates it | Flymap `src/mushroom.js` |
| **Mushroom-body learning**, NumPy, clean and small | Flinge `brain.py` (`gain -= lr * outer(kc, da)`) |
| **APL global-inhibition sparsity loop** (3-pass settle, top-15 winners) | kitchen `src/fruit-memory.js` |
| **Dopamine meter with a deadband** → sparse reward/aversive pulses instead of per-step reinforcement | Flinge `dopamine.py` |
| **Rendering a fly eye**: 6 × 90° faces → 384×256 RGB atlas, self-body hidden, shadow pass isolated | mario-cart `src/fly-vision.ts` |
| **Retinotopy-preserving feature pooling** (384 spatial bins, 768 dims; `membrane-change` is the rep that worked) | mario-cart `brain/readout.py` |
| **Supervised readout over a frozen graph** (ridge / hand-rolled MLP, no PyTorch) | mario-cart `brain/train*.py`; kitchen `src/ridge.js` (Cholesky + adaptive jitter) |
| **Reusing one fixed anatomy as a frozen random-feature transform for motor control** | kitchen `src/motor3d.js` — the single cleverest structural move in any reference |
| **Mass/inertia-normalized observations** so one lesson transfers across bodies and crew sizes | kitchen `motorObservation` (13 dims) |
| **Game↔brain WebSocket protocol** (binary frames up, JSON rates down, two-sided handshake validation) | mario-cart `src/fly-client.ts` ↔ `brain/server.py` |
| **Binary spike-frame format** + drop-newest-wins queue of depth 1 | nueral-visulazation `sim_server.py` |
| **3D neuron morphology rendering** (RDP simplification, merged tubes, per-vertex neuron index → activity texture) | Flymap `src/brain3d.js` |
| **Point-cloud brain**, custom ShaderMaterial, per-point `shown`/`active` floats | nueral-visulazation `index.html`; Flinge `BrainCloud.jsx` |
| **Pathway tracing by first-spike time**, not by graph walk | nueral-visulazation `build_pathway.py` |
| **Rapier vehicle physics**, fixed 60 Hz accumulator, one normalized `VehicleInput` for keyboard/gamepad/script/fly | mario-cart `src/vehicle.ts`, `main.ts` |
| **Physical gating of game phases** (arrival = position + speed + attitude; readiness revocable; no success timeouts) | kitchen `src/salad-game.js` |
| **Collision = rendered geometry**, adaptive subdivision folding rotation into travel | kitchen `bladeContact` |
| **Local voice/NLP with no LLM** (Web Speech API + ~100-line keyword parser, works offline) | Flymap `src/listen.js` |
| **Optional LLM, never on the critical path** (template fallback always present) | Flinge `llm.py` |
| **Retro in-world OS/IDE overlay** (DOM/CSS over a zoomed 3D monitor) | Flymap `src/desk.js` ("NonaOS 98") |
| **In-process event bus** joining subsystems without sockets (62 lines) | nueral-visulazation `learning/events.py` |
| **Reaction table as a frozen dataclass** — one readable artifact instead of if-statements in a socket handler | nueral-visulazation `reactions.py` |
| **Device discovery by UDP broadcast** (board never configured with a host) | nueral-visulazation `device.py` + `flybuddy/uplink.cpp` |
| **Pure-stdlib audio fingerprinting** (Shazam-style constellation, FFT in `cmath`) | nueral-visulazation `learning/fingerprint.py` |
| **Makefile process orchestration** (`make start/stop/status`, PIDs + logs in `.run/`) | Flinge root Makefile |

## The shared discipline — treat this as our house style

All five encode the same principles **in code, not prose**. Carrying these over is the point:

1. **A prominent honesty section is a deliverable.** Every reference leads with what is real
   and what is not — Flymap admits outright that angular-velocity integration does not work;
   mario-cart's headline neural result is *negative* (validation selected zero motor weights,
   measured motor steering effect exactly zero) and says so; nueral-visulazation states a
   positive song identification has never been seen end to end.
2. **Ablations are shipped features, not test scripts.** Lesion Delta7 / scramble wiring
   (Flymap); frozen vs trained (Flinge); `blank`/`frozen`/`shuffled`/`disconnected` vision and
   `motorInputs=mean` as URL params (mario-cart); clamp-KC / scramble / erase buttons (kitchen).
   The null condition must be reachable from the running product.
3. **Fail closed, never substitute.** Provenance mismatch, missing weights, stale sample,
   out-of-range config → error or neutral input. No silent fallback; the scripted opponent
   never stands in for the fly.
4. **Provenance is verified, not asserted.** Pinned upstream git SHA + clean-worktree check +
   dataset manifest SHA-256 + readout hashes (mario-cart); topology hash over sorted
   `pre:post:count` (kitchen); soma count checked in the `hello` (nueral-visulazation).
5. **Anatomy read out of the data, never assigned.** Heading from the glomerulus suffix;
   MBON valence from which DAN population innervates it. This kills the "you hardcoded it"
   objection.
6. **The brain→control interface is deliberately narrow.** One stimulus + one dopamine sign;
   one `VehicleInput`; one valence scalar. The narrowness is what makes the claim defensible.
7. **Freshness over completeness.** Drop stale frames, go neutral rather than repeat the last
   command, queue depth 1 so the screen shows the newest state.
8. **Determinism by seeding**, and data cached/committed locally so a demo never needs wifi.
9. **A missing thing is named in the UI, not approximated.** A stimulus whose cells are absent
   is dropped and labelled; kitchen ships 179 unused aversive PPL1→KC edges for provenance
   rather than repurposing them as reward; the bitter row is left empty on purpose.
10. **Verification is plain `node --test` / pytest with results pasted into the README as the
    claim itself.** No heavy harness.
11. **Promotion gated on physical validation** — a model is good when it completes 60 ordered
    checkpoints with zero recoveries, not when MAE dropped. Candidates never auto-promote.

## Recurring weaknesses to avoid

- Monoliths (Flymap's 1,806-line `main.js` and 1,812-line `index.html`; mario-cart's inline-
  `innerHTML` HUD).
- Heavy out-of-band setup that nothing in the repo bootstraps (mario-cart's pinned Fly64
  checkout + 1.5 GB cache; nueral-visulazation's unvendored `lif` package and Apple-only MLX).
- Module-level singleton engines → one global shared fly for every connected browser, and a
  `/api/reset` that resets it for everyone (Flinge).
- `CORS allow_origins=["*"]` next to a live API key (Flinge).
- Synthetic sensory encodings (hashed words, random projections of tile statistics, seeded
  random PN patterns) — the widest gap between "real connectome" and "real biology" in all five.
- Query-parameter mode switching: great for research, fragile as a product surface.
- Manual cache-busting (`./compass.js?v=5`), stale READMEs contradicting `docs/`.

## Decisions taken (2026-09-21)

| # | Question | Decision |
|---|---|---|
| 1 | Connectome | **Real** — Janelia MaleCNS v1.0, extracted subgraph committed as JSON, runs wifi-off |
| 2 | Where the brain sits | **On the control path**, Flymap-style — the circuit's own output *is* the control signal, not an input to an engineered controller |
| 3 | Core circuit | **Both, Flymap's loop** (my call — see below) |
| 4 | Stack | **In-browser, zero-build** — plain ES modules, Three.js via importmap, `python -m http.server`, no bundler, no backend |
| 5 | Hardware | **Apple M1** — so no MLX/Metal-only path (rules out the nueral-visulazation engine); the LIF engine runs in JS over typed arrays |
| 6 | Physical hardware | **Out of scope** — no ESP32, no DualSense, no mic |

### On decision 3

Take Flymap's two-circuit split, because it is the only arrangement where the brain is
genuinely load-bearing *and* the product is interactive:

- **Mushroom body decides *what to go toward*** — dopamine-gated depression on real KC→MBON
  synapses, valence read push–pull. This is the part the user teaches, so it is the
  interaction.
- **Central-complex ring attractor decides *which way that is*** — the EPG population vector
  is the heading, with the left PB hemisphere mirrored (`L9…L1 | R1…R9`) or the bump cannot
  rotate.

Loop: learned valence picks the goal → goal becomes a landmark cue → cue pins the ring
attractor → the population vector *is* the flight heading.

Worth stealing from `kitchen` on top of this: reuse the **same fixed PN→KC anatomy as a frozen
feature transform** for a second, motor-ish task, with **no intercept** in the readout so
"clamp the KC features → output is *identically* zero" is an exact, demonstrable ablation
rather than an approximate one.

Known limits inherited from Flymap, to be stated up front rather than discovered later:
angular-velocity integration does not work (the bump jumps between discrete states under
sustained turn, so heading is pinned visually, not integrated); ER/PFL3 can be rendered and
lit by real signals but routing control through real ER makes pointing worse (30–60° vs 22°).

---

## THE PRODUCT — Biryani Center (decided 2026-09-21)

A 3D fruit-fly biryani restaurant. Flies take orders on a phone, then cook a Dum Biryani
across staged kitchen stations, with a live connectome visualisation of the brains doing it.

**Everything is 3D. Everything is in-browser. One continuous flow, not two demos.**

### Page 1 — Order Desk  (UI + mesh from `flinge-main`)
- Flinge's rigged fly (40 STL parts, `public/fly/meshes/`, Apache-2.0 NeLy-EPFL) holding a
  phone. `fly.js` loader/animator already exists — Y-up, faces +X, feet at Y=0, ~mm units,
  joints at `fly.userData.fly.nodes`.
- **Flinge's section/tab UI is the model for this page** — `.tabs` strip (discover /
  matches / chat → becomes queue / cooking / delivered), `.layout-top` grid at
  `1.45fr 1fr` (3D stage left, phone panel right), `.stat-pill` header stats.
- Flinge's palette is kept as the house palette — it is already a spice palette:
  `--bg0 #14110e`, `--gold #d4a35a` (saffron), `--rose #c76b52` (chilli),
  `--mint #6fa892` (raita/mint), Fraunces display + DM Sans body.
- Order card → PN channels → k-WTA + APL → sparse **Kenyon-cell code**. That code *is* the
  ticket dispatched to the kitchen, so kitchen flies smell the order rather than parse JSON.
- Desk fly learns from outcomes: dopamine depresses KC→MBON, so trouble orders get deprioritised.

### Page 2 — Kitchen  (feel + mechanics from `kitchen`)
Stations, per the flow: Marination → Rice Boiler → Saffron/Ghee → Layering Handi →
Dum Sealing → Packing → Delivery.

| Station | Fly task | State |
|---|---|---|
| 1 Meat & Marinade | pick meat → deposit → wait 3 ticks | marinated |
| 2 Parboiled Rice | activate stove → boil to 70% | `overcooked` past the timer → negative reward |
| 3 Handi Assembly | ordered drops: marinade → rice → birista/saffron/mint/ghee | layered |
| 4 Dum Sealing | pick dough rope → seal lid → low flame N steps | sealed, steaming |
| 5 Packing & QC | carry handi → add raita cup → tag ticket | complete |

- **Multiple flies**, each with own body state + own readout, sharing one topology. They work
  autonomously; nobody steers them.
- Navigation: MB valence picks the station → bearing → cue → ring attractor → heading.
- Body: mass/inertia-normalised 13-dim observation → fixed PN→KC → no-intercept readout
  → 6 outputs (fx,fy,fz,tx,ty,tz). Mass-normalisation is what lets one lesson drive a light
  fly and a heavy handi carried by a varying crew.
- **Cooperative carrying** — several flies lift the handi together. Phase gating is physical,
  never timed out: arrival needs position + speed + attitude; "ready" is revoked if the handi
  stops being settled. This is process realism, not a challenge for anyone to beat.

### The brain visualisation — from `nueral-visulazation`, NOT Flymap
This is the explicit direction. The assets are already local and real
(MaleCNS v1.0, FlyEM/HHMI Janelia + Google Research, CC BY 4.0):

| Asset | Size | What it gives |
|---|---|---|
| `somas.bin` + `somas.json` | 870 KB | 124,314 soma positions, uint16-quantised, 9 group codes (`sensory`, `motor`, `descending`, `central`, `optic`, …) |
| `brain.bin` + `brain.json` | 5.7 MB | 84 neuropil ROI meshes — the faint architectural cage |
| `pathway_sugar.{bin,json}` | 2.5 MB | labellum LB3b/LB3c_R → **MN9_L** (proboscis extends = *eating*) |
| `pathway_smell.{bin,json}` | 6.2 MB | **ORN_DM1_R** (fruit-odour glomerulus) → DNb05_R |
| `pathway_water`, `pathway_looming` | | LB3a_R → DNg67_R; LC4_R → DNp01 giant fibre (escape) |
| `skel/` (152), `ngmesh/` (84) | | further morphology |

Technique to carry over verbatim:
- **One shared quantisation box.** `brain.bin` and `somas.bin` quantise against the same
  origin/span, so one dequantise puts them in register. `UNIT = 1/max(span)` → longest axis
  becomes 1 model unit. Dequantise on the CPU into plain `Float32Array` — no normalised
  uint16 attribute convention to get wrong.
- **Point-cloud shader**: per-point `shown` and `active` float attributes, so lighting a
  firing neuron is *one float write*, not a rebuilt buffer.
  `vColor = mix(color, uFire, active)`, `gl_PointSize = uSize*(1+2.2*active)*uScale/-mv.z`,
  round sprites via `discard` outside `r > 0.25`.
- **Glow is additive blending, not post-processing.** `AdditiveBlending` +
  `depthWrite:false` on both the points and the pathway lines. No EffectComposer, no
  UnrealBloomPass — that is how it holds 60 fps at 124k points. (Flymap uses bloom; we do not.)
- **The travelling spark** (`PATH_VERT`/`PATH_FRAG`): per-vertex `dist` = normalised distance
  from root; a `uHead` uniform sweeps 0→1; `band = exp(-d*d*42.0)` is the bright head and
  everything already passed holds at `0.30`. Colour: driven `0xff7a2f`, readout `0x4ade80`,
  relay `0x6f7fd8`, fire `0xfff4d0`.
- **Timing is real, travel is drawn.** Each neuron lights at `firstMs` — the millisecond it
  actually first fired. The run *along* the branch is interpolation, because the model's
  neurons are points with no internal geometry. `TRAVEL = 0.28` of play time per cell.
  The panel says so on screen.
- **Narration steps** built by grouping neurons by `firstMs`; a readout step names what it
  commands (`MN9 → the proboscis extends`), anything unnamed is called a relay.
- Camera framed from the **measured** bounding sphere, so the brain cannot land off-screen.
- Spike decay + `sGeo.getAttribute('active').needsUpdate = true` once per frame.
- Frame-size self-check: `expect = 24 + nRead*4 + nFiring*5`, mismatch → one clear console
  error naming the drift, not a bare RangeError from inside the parse.

`pathway_sugar` (→ MN9, proboscis extension) and `pathway_smell` (ORN_DM1, a fruit-odour
glomerulus) are the two thematically right pathways for a food build, and both are on disk.

### NOT a game — this is a flow

The single hardest constraint, and the easiest one to drift away from. This is an
**autonomous process you observe**, not something you play.

**Absent by design:** score, combos, points, timers that pressure the viewer, win/lose,
levels, a player-controlled fly, difficulty, "try again". None of it.

**What it is instead:** the restaurant runs itself. Orders arrive, flies decide, biryani gets
made, tickets complete. The human **watches, inspects and teaches** — never drives.
The interaction model is Flinge's auto-loop (it steps on its own every few seconds and the fly
decides; you can pause, single-step, select a fly, open its brain, or teach it) — not
kitchen's playable blade.

**What we take from `kitchen` is the *motion and render quality*, not its game loop.**
Specifically: smooth Three.js easing, physical gating instead of timeouts (a fly arrives when
position + speed + attitude actually agree, not when a timer expires), rendered geometry ==
real geometry, and frame-rate-independent stepping. Its scoring, combo and blade-sweep code is
out of scope.

**Reads as:** a live operations view of a working kitchen, with a brain you can watch running
underneath it. Closer to a control room or a process dashboard than to a game.

The `overcooked` state and the reward numbers in the pipeline are **training signal**, not
player scoring — they shape the flies offline and are surfaced as diagnostics, never as points.

### Flow, not demos
nueral-visulazation's thesis applies: *"one page, one process, one fly — a thing that happens
to one happens to all of them."* Starting the halves separately is what made that project feel
like three demos instead of one animal. The order page and the kitchen page share one
simulation and one KC ticket code; a thing that happens at the desk shows up in the kitchen.

---

## BUILD STATUS — working, 2026-09-21

Built in `Mainproject/`. Runs with `python3 serve.py` → http://localhost:8080/.
`node verify.mjs` → **29 checks, 29 passing**, no test framework.

### What the connectome turned out to be
`References/Flymap/data/` is empty, but the pathway exports in
`nueral-visulazation/visualization/data/` carry a `connections` array nobody had noticed:
**150 real MaleCNS neurons, 2,224 real synaptic contacts** across four traced sensory→motor
routes. Everything is local; no neuPrint token and no network fetch were needed.

Calibrated `excGain 0.5 / drive 0.5` by sweep. Sugar reaches MN9 at **26 ms sim against 27 ms
measured**. Below drive 0.25 nothing conducts, above 1.0 everything saturates — a sharp band,
because the export has no neurotransmitter field and so no inhibition.

### The load-bearing claim, verified
A fly works a station because **its own simulated brain responded**, not because a timer fired.
Lesion the sensory cells → the kitchen stalls at the first station with 0 spikes, while the
intact kitchen serves in 930 frames. Both are assertions in `verify.mjs` and the Lesion button
does it live.

### Bugs found and fixed while building (worth not repeating)
1. **`active` is a reserved word in GLSL ES 3.00.** The reference used it as an attribute name;
   the shader will not compile. Renamed to `aFire`.
2. **Unbounded canvas growth.** `height:100%` on a canvas in an auto-height flex parent resolves
   against the canvas's own attribute height, which the renderer sets from `clientHeight` every
   resize — a feedback loop. Measured 198,000 px tall before the fix. Canvas must be
   `position:absolute; inset:0` inside the positioned stage.
3. **`[hidden]` loses to `display:flex`**, so all three tab bodies showed at once.
4. **Point size does not transfer between canvas sizes.** The reference's `uSize 1.6` is tuned
   for a fullscreen canvas; in a 329 px panel it produced 133 px points and 124k of them blended
   to flat white. Now 0.014, with `uScale` dpr-aware.
5. **Framing by bounding sphere under-fills a wide short panel** — the sphere's radius is set by
   the brain's width. Fit the box to the viewport aspect instead, and re-fit on resize until the
   user orbits.
6. **Overcooking cannot be driven by work time** — the step completes before any threshold. Real
   overcooking is rice left *unattended* on the heat, so it is driven by idle time during the
   *next* step's wait.
7. **Orders vanished when you navigated in one tab.** `BroadcastChannel` is fire-and-forget: it
   reaches whoever is listening at that instant and stores nothing. The nav links are ordinary
   `<a href>`, so the natural move — place an order, click Kitchen — unloaded the desk before
   anything was listening and lost the order silently. Fixed with `src/store.js`: localStorage is
   the source of truth, the channel is only a nudge. It only ever worked in testing because two
   tabs happened to be open. **Lesson: any cross-page message needs a durable backing store, and
   test the single-tab path, not just the happy one.**
8. **STLs must sit in `assets/fly/meshes/`**, not `assets/fly/` — `model.json` references them
   that way.


### Visual pass (2026-09-21, after first review)
- **Stations are a hexagon of radius 4 centred on the origin.** The first layout had its
  centroid at (-0.97, 0.97) and was 10.6 units wide, so a camera aimed at the origin cropped
  Marination off the left edge. A symmetric ring frames itself.
- Kitchen camera `(0, 7.5, 8.9)` at 46 deg FOV, floor radius 7.2, flies at scale 0.17.
- Order desk: the fly **faces +X** (see `assets/fly/NOTICE`), so the phone sits at +X of her,
  propped at ~58 deg — steep enough that she is looking at it, tipped enough toward the camera
  to read. Head held down via the `c_thorax-c_head-pitch` dof.
- `animateFly` now drives the real rig: 22 Hz wingbeat (200 Hz would only strobe at 60 fps),
  antiphase halteres, legs tucking on `{leg}_coxa/trochanterfemur/tibia` chains, abdomen
  breathing, antennae trailing, and a grooming cycle every ~9 s. Wings are **still at rest** —
  the beat only exists while airborne.
- Attitude (bank into turns, nose-down with speed) goes on the outer group with
  `rotation.order = 'YXZ'`, so it cannot fight the caller's heading on `rotation.y` or the
  asset's Z-up correction on the body.

### Known limits, stated in the README rather than hidden
No inhibition (looming readout sits at 286 Hz, above biological, left uncapped and labelled);
the mushroom body's rule is real but its wiring is a sized stand-in; order→PN is a hash, not
olfaction; navigation is steering, not neural; 66 of 150 cells have no soma in the point cloud
because sensory somas sit outside the brain volume — anatomy, and the UI says so.

---

## Working agreement

- Prefer this file and `Mainproject/reference-analysis/*.md` over re-reading reference code.
- When a reference folder is needed, open only the specific files named in the index above.
- Zero-build / zero-dependency front ends (Flymap, kitchen) are the cheapest to demo; a Python
  brain service behind a WebSocket (mario-cart, Flinge) buys real simulation at real setup cost.
  Which trade-off we take is the first architectural decision for whatever we build.

> **Status:** built and working in `Mainproject/`. See BUILD STATUS above.
