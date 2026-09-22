# Project 3 — mario-cart ("Fly Racer — Meadow Circuit")

**Path:** `References/mario-cart/`
**One line:** A split-screen Three.js + Rapier kart racer where the opponent can be driven by a real MaleCNS connectome simulation — the game renders a six-face fly-eye atlas, streams it over a WebSocket to a Python neural service, and steers the kart from what comes back.

By far the most engineering-heavy of the three: ~6,500 lines of Python, ~4,500 lines of TypeScript, 8 HTML entry points, a distributed two-machine training pipeline, and a documentation set that reads like a lab notebook.

---

## 1. Tech stack

| Layer | What they used |
|---|---|
| Game | **TypeScript + Vite 7 + Three.js 0.180** (direct Three.js — the PRD's React Three Fiber proposal was explicitly overridden) |
| Physics | **Rapier 3D** (`@dimforge/rapier3d-compat`) `DynamicRayCastVehicleController`, fixed **60 Hz** step with an accumulator, render interpolation separate from simulation |
| Neural service | **Python + NumPy + `websockets`** (asyncio), loopback-only, one session at a time |
| Neural model | An **external, independently installed "Fly64" checkout pinned to commit `f2f4114e…`**, plus a prepared MaleCNS dataset cache. No upstream code is bundled |
| Learned decoders | NumPy ridge regression and a hand-rolled **768-128-64-1 MLP** (no PyTorch) |
| Controller | Gamepad API (DualSense), Vibration/dual-rumble, plus an opt-in **macOS CoreAudio/IOHID C helper** compiled by a Vite plugin to play countdown tones through the controller speaker |
| Tests | `node --experimental-strip-types --test src/*.test.ts` (34 TS tests) + ~30 Python tests. No test framework dependency |
| Assets | Kenney karts/scenery GLB served locally, credits in `docs/ASSETS.md` |

---

## 2. Architecture / module map

```
Game (src/)
  main.ts          539  two scissored viewports, input routing, countdown, pause, results
  world.ts         368  scenery, materials, GLB loading, track visuals
  track.ts         184  continuous course sampling + 20 checkpoint gates
  physics.ts            shared ground + track boundary colliders
  vehicle.ts       332  Rapier suspension/engine/brakes, yaw assist, jump, recovery, chase cam
  race.ts               ordered crossing detection, lap splits, finish time, formatting
  gamepad.ts / rumble.ts / audio.ts / music.ts
  wheels.ts, surfaces.ts, circuits/{monza,spa,imola,silverstone,interlagos,red-bull-ring}.ts

Fly integration (src/)
  fly-vision.ts         renders the 6-face 384×256 RGB eye atlas off-screen
  fly-client.ts    193  WebSocket protocol, handshake validation, frame pacing
  fly-controller.ts133  neural rates/steering → VehicleInput, with smoothing + staleness
  fly-driver.ts    173  orchestrates vision→client→controller, builds the HUD panel
  fly-anatomy.ts        live neuron-position activity canvas
  fly-speed.ts, fly-recovery.ts, fly-controls.ts, fly.ts (fly avatar)

Training / evaluation (src/ + scripts/)
  training-world.ts, training-physics.ts, training-map.ts, training-teacher.ts
  meadow-training.ts, training90.ts, distributed-training.ts
  evaluate-all.ts, evaluate90.ts, vision-parity.ts, run-viewer.ts
  scripts/collect-training.mjs, label-camera-poses.mjs, check-trained-driving.mjs,
          analyze-driving.mjs, train-distributed.py, train-meadow-*.py

Brain service (brain/)
  server.py        loopback WebSocket, session negotiation, 50 Hz pacing
  backend.py       Fly64 adapter, visual interventions, readout wiring
  readout.py       NeuralFeatures (4 representations) + TrainedReadout (linear/MLP)
  train.py / train_mlp.py / train_combined.py / train_speed.py / train_motor_network.py
  motor_plasticity.py, recording.py, prepare_live.py, export_readout.py, export_speed.py
  models/  meadow-visual-readout.{npz,json}, meadow-combined-readout.*, meadow-speed90-*
  10 test_*.py

HTML entry points
  index.html (game), meadow-training.html, training90.html, distributed.html,
  evaluate-all.html, evaluate90.html, vision-parity.html, runs.html, public/pipeline.html
```

---

## 3. How the flow actually works

### 3.1 The game loop (no fly)
`main.ts` builds one renderer with `setScissorTest(true)` and draws **two viewports** — NPC left, human right. Physics runs on a fixed 60 Hz accumulator; the chase camera and render positions interpolate independently. Phases: `loading → ready → countdown → racing → finished`. A lap requires passing **all 20 gates in order** — `race.ts` rejects reverse crossings, repeated finish-line crossings, and gate skips. Results report placement, total time, best lap, each split, and recoveries.

Both karts use identical physics and collision geometry, and the scripted practice opponent feeds **the same normalised `VehicleInput` interface** as the keyboard adapter. That single interface is what makes the fly a drop-in third input source.

### 3.2 The fly vision path (`fly-vision.ts`)
The key trick: a **90° perspective camera rendered six times into a 128×128 render target**, packed into a **384×256 RGB atlas** (2 rows × 3 columns) matching Fly64's six-face layout. Local axes are right/up/forward derived from the kart's yaw. Notable care in the code:
- the observed car is hidden (`hidden.visible = false`) before capture, so the fly doesn't see its own body;
- `shadowMap.autoUpdate` is forced on for the first face then off, so the sensor gets its own shadow pass and **never inherits a stale spectator shadow**;
- every piece of renderer state (target, viewport, scissor, scissor test, shadow flags) is saved and restored in a `finally`.

### 3.3 The wire protocol (`fly-client.ts` ↔ `brain/server.py`)
- Client opens a WebSocket and sends `{type:'hello', protocol:1, seed, mode, eyePreviews, neuronActivity, readout, …}`.
- Server validates **everything** and fails closed: protocol must be 1, seed an int in `[0, 2³²)`, mode ∈ `live|blank|frozen|shuffled|disconnected`, readout ∈ `descending|trained|hybrid|plastic-motor|combined`, `eyePreviews` a strict boolean. A requested readout whose weights aren't installed is an error, never a silent fallback.
- **One experiment at a time:** a second connection is closed with code 1013.
- Frames go up as binary: `uint32 frame ID` + the 384×256×3 atlas. **Frame IDs must strictly increase within a session.**
- Activity comes back as JSON: `{type:'activity', sequence, frameId, simulationMs, computeMs, forwardHz, leftHz, rightHz, jumpHz, spikeCount, …}`, optionally `steering`, `targetSpeed`, `motorEffect`, `motorSteering`. Eye previews and base64 neuron-activity snapshots are sent every 10th tick.
- Pacing: `await asyncio.sleep(max(0, dt - elapsed))` with the comment *"Never drop neural steps or burst old controls to catch up."*
- The **client re-validates the server's `ready` message against its own config** — readout name, `neuralHz === 50`, backend, mode, seed, and (for combined/plastic modes) a 64-hex model hash — and hangs up on any mismatch.

### 3.4 The neural backend (`brain/backend.py`)
- `load_model_class()` shells out to `git rev-parse` on the Fly64 checkout, **refuses to run unless the revision equals the pinned commit**, and additionally refuses if `git status --porcelain` shows local changes — "cannot claim pinned provenance".
- Metadata attached to every session: upstream commit, neuron count, edge count, neural Hz, dataset manifest SHA-256, dataset sources and hashes.
- **Visual interventions** as first-class modes: `live`, `blank` (zeros), `frozen` (first frame held), `shuffled` (a fixed seeded pixel permutation), `disconnected` (`model.visual_connected = False`). These are the ablation controls.
- `step(frame)` runs the model, averages a spike history window, splits it at `model.motor_splits` into four descending pools → `forwardHz / leftHz / rightHz / jumpHz`.

### 3.5 The five control modes
| Mode | How steering is produced |
|---|---|
| `descending` | `(rightHz − leftHz) × gain` — raw descending-neuron rate difference. Throttle is a fixed assist |
| `trained` | A supervised decoder over **visual** features only (768 dims) |
| `hybrid` | `(1−share)·visual + share·motor`, default 50/50, motor side either raw rates or a trained motor decoder |
| `plastic-motor` | A frozen patch of *learned existing motor-input synapses* applied to the graph; requires neural throttle |
| `combined` | 788-dim decoder = frozen visual backbone + trainable motor-input rows |

### 3.6 Feature representations (`brain/readout.py`)
Four kinds, all computed from simulated cells only — **no track coordinates, waypoints, checkpoints or expert actions ever reach the runtime controller**:
- `activity-voltage` — activity + membrane voltage, pooled into **384 spatial bins that preserve retinal topology** (`bins = (px//4)*32 + py//2`), 768 dims total.
- `membrane-change` — reset-corrected voltage delta (`v + spikes − prev·e^(−dt/τ)`) plus an exponentially filtered history, same pooling. This is the representation that actually worked.
- `motor-*` — the same two, restricted to the model's ordered `motor_nodes`.
- `visual-motor-membrane-change` — concatenation, 768 + 2×20 = 788.

`TrainedReadout` refuses to load if the graph size differs, if the saved motor node ordering doesn't match, or if any weight is non-finite.

### 3.7 The controller (`fly-controller.ts`)
- **Every incoming sample is validated**: sequence and frame ID must strictly increase, rates must be finite and within `[0, 50]`, steering `|s| ≤ 1`, motor effect `|e| ≤ 2`. An invalid sample is rejected, not clamped.
- Uses only the browser's local monotonic clock — the comment says *"never subtract clocks on two Macs"*, because the service can be reached over an SSH tunnel from another machine.
- **Staleness is a hard cut:** older than 250 ms → neutral input, zero steering and throttle.
- Exponential smoothing (`smoothingSeconds = −0.02/ln(0.78)`), then a deadzone of `8/70`.
- Throttle is a **labelled assist**, not neural, in every mode but `plastic-motor` — fixed 0.5, and 0.3 with an 8 m/s cutoff for the trained modes. The HUD literally says "ASSISTED THROTTLE · 8 M/S LIMIT".
- Config validation throws `RangeError` on construction for any out-of-range parameter.

### 3.8 The training pipeline
1. **Collect:** `collect-training.mjs` / `training-world.ts` place a teacher at deterministic poses around the track; `label-camera-poses.mjs` renders the atlas at each pose. 1,800 camera poses is the standard dataset.
2. **Label:** `training-teacher.ts` — `correctionTeacher()` computes look-ahead steering and a curvature-derived target speed. Its docstring: *"Offline corrective labels only. Never called by the learned driving controller."*
3. **Encode:** `brain/train.py` replays each frame through the real neural model, runs `settle_ticks` first (random training poses jump much farther than successive driving frames, so the artificial visual transient is allowed to settle), then records **5 ticks per frame** → 9,000 observations.
4. **Fit:** ridge at α ∈ {1, 10, 100, 1000} (or the MLP in `train_mlp.py`), with **contiguous track-sector holdouts** — `sectors % 5 == 0` validation, `== 1` test — so neighbouring frames can't leak between splits.
5. **Validate & promote:** candidates land in an ignored `artifacts/` directory and **are never promoted automatically**. Promotion requires physical race checks: `check-trained-driving.mjs` runs real seeds through the real simulation and requires 60 ordered checkpoints, zero recoveries, zero browser errors.
6. **Live recording:** `recording.py` + `prepare_live.py` can capture neural features during real driving and join them to offline targets **by camera frame ID**, refusing the join on any provenance mismatch (readout hash, seed, dataset manifest, upstream commit, session).

### 3.9 Distributed training
`distributed.html` + `train-distributed.py` coordinate **two Macs over Tailscale SSH**: Monza and Interlagos locally, Silverstone/Spa/Red Bull Ring on the Studio. Each circuit contributes 60 three-second teacher episodes (1,800 images). Remote code is copied into a batch-specific directory so the other machine's checkout is untouched; only completed remote *features* come back for a joint fit. A batch completion marker is written only after all 1,800 images; existing captures are never overwritten; a stopped run resumes with `&from=<circuit>`.

---

## 4. The result they report (and how they report it)

This is the most striking thing in the repo. `docs/combined-control.md` documents an experiment that **did not work**, in detail:

- Validation steering MAE: visual backbone **0.36495**; the three fitted motor-input candidates scored 0.37965 / 0.37188 / 0.36575 — all worse.
- So validation **selected zero motor weights**, and the paper-trail says so: *"the full graph and motor feature extraction are active, but the selected decoder does not use the direct motor features to steer."*
- They still built the measurement instrument for it: `motorInputs=mean` replaces only the decoder's motor features with their training means, and the server computes live-vs-masked steering **from the same neural tick without advancing feature history twice**. The HUD shows it as "Motor steering effect", with a tooltip saying a nonzero effect *does not prove better driving*.
- Recorded motor steering effect across three validated race runs: **exactly zero**.

Similar candour throughout: the README says the left screen is *"a scripted practice opponent, **not a connected fly simulation**"*; `docs/trained-readout.md` opens with "Status: experimental, not yet reliable track following" and instructs *"Do not present the scripted practice controller as neural driving or silently fall back to it"*; `brain/models/README.md` says the learned decoder "is **not** steering generated by the fly's descending motor circuits".

---

## 5. Observations — what to take from this project

**Strengths**
1. **Provenance is enforced by code, not by convention.** Pinned upstream commit + clean-worktree check + dataset manifest SHA-256 + model weight hashes, re-verified on both ends of the handshake. You cannot accidentally run a different brain and believe you ran this one.
2. **Fail closed, everywhere.** Missing weights, mismatched modes, out-of-range config, stale samples, repeated frame IDs, provenance mismatches — every one is an error or a neutral input. There is no silent fallback anywhere in the fly path.
3. **The ablation controls are shipped features.** `blank`/`frozen`/`shuffled`/`disconnected` visual modes and `motorInputs=mean` are URL parameters, so the control condition is one query string away during a live demo.
4. **Sector-contiguous holdouts** instead of a random split — the correct choice for temporally correlated driving frames, and they also note the honest caveat that the pretrained visual backbone may already have seen those poses.
5. **Promotion gated on physical validation.** A model isn't "good" because MAE dropped; it's good when it completes 60 ordered checkpoints with zero recoveries. Candidates never auto-promote.
6. **One normalised input interface** (`VehicleInput`) for keyboard, gamepad, scripted opponent and fly — the reason a connectome can be dropped into a kart game at all.
7. **Careful real-time discipline:** never drop neural steps or burst stale controls; local monotonic clock only; 250 ms staleness cut; shadow-map correctness in the sensor render.
8. **Documentation as a lab notebook.** 15 docs recording what was tried, what the numbers were, what was selected, and what the result does *not* establish — including a note that one batch's capture was overwritten and therefore "must not be used as original meadow evidence".

**Weaknesses / risks**
1. **Heavy external setup.** Requires a separately installed Fly64 checkout at an exact commit, a prepared MaleCNS cache, a Python venv, and a running WebSocket service before the fly mode does anything. Nothing like Flymap's "run a static server and it works".
2. **Eight HTML entry points and a large `artifacts/`-shaped workflow** — the repo is a research bench as much as a game, and the boundary between the two is only in the docs.
3. **Style density.** `training-teacher.ts` and parts of `fly-driver.ts` are compressed to near-unreadability (multi-statement lines, no spacing); a large HUD is built as one inline `innerHTML` string in a constructor.
4. **The headline neural result is negative** — the motor circuit runs but contributes nothing to steering; the working driver is a supervised decoder over simulated early-visual features. They say this plainly, which is the right call, but it is what the project currently demonstrates.
5. **Single-session service** (`busy` flag) — fine for an experiment, not shareable.
6. **The DualSense speaker path compiles C at dev-server start** via a Vite plugin with a hardcoded macOS SDK path. Guarded and opt-in, but unusual.
