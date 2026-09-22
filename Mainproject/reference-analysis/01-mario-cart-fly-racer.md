# Project Report 1 — `mario-cart` ("Fly Racer")

**Location:** `References/mario-cart/`
**One line:** A browser racing game where the opponent kart is driven by a real fruit-fly connectome (MaleCNS, 166,700 neurons) simulated on a local Python service, with the game feeding it rendered fly-eye images over a WebSocket at 10 Hz.

---

## 1. What the project actually is

It is two programs that talk over one WebSocket:

| Half | Tech | Job |
|---|---|---|
| **Browser game** (`src/`, TypeScript + Vite) | Three.js 0.180, Rapier3D (`@dimforge/rapier3d-compat`) | Renders the track, runs kart physics at fixed 60 Hz, renders a 6-face "fly eye" cube map, ships it to the brain, converts the returned neural rates into steering/throttle |
| **Brain service** (`brain/`, Python) | NumPy, SciPy, scikit-learn, `websockets`, an externally installed **Fly64** checkout + MaleCNS connectome data | Steps the spiking connectome at 50 Hz, reads out descending-neuron firing rates, optionally runs a trained decoder, returns JSON control signals |

The stated goal in the PRD (`Fly-vs-Human-Racing-Game-PRD.md`, dated 20 Sept 2026) is not a strong racing AI. It is an **inspectable loop**:

> track image → simulated fly vision → connectome activity → vehicle controls → changed track image

The README and docs are unusually disciplined about *not overclaiming* — repeatedly stating that a running motor circuit is not evidence of useful driving, that the scripted practice opponent must never be presented as neural driving, and that a decoder may legitimately assign zero weight to motor inputs.

---

## 2. Tech stack, precisely

**Frontend**
- TypeScript 5.9, Vite 7, ESM, no framework (deliberately *not* React Three Fiber — README says so)
- `three` 0.180 for rendering; GLB assets from Kenney (CC0) loaded via GLTFLoader
- `@dimforge/rapier3d-compat` 0.19 — WASM ray-cast vehicle physics
- Native test runner: `node --experimental-strip-types --test src/*.test.ts` (no Jest/Vitest)
- Web Audio for engine/countdown tones; Gamepad API + dual-rumble for DualSense
- A CoreAudio/IOHID helper in **C** (`scripts/controller-speaker.c`) to route countdown beeps to the DualSense speaker over USB on macOS

**Backend / research**
- Python 3.12+, `numpy 2.5.3`, `scipy 1.18.1`, `scikit-learn 1.9.1`, `pandas`, `pyarrow`, `websockets 16.1.1`, `threadpoolctl`
- **Fly64** (github.com/ornata/fly) — *not vendored*. `brain/backend.py` pins it by git SHA (`f2f4114e…`), refuses to load if the checkout's HEAD differs or has local modifications. Strong provenance discipline.
- MaleCNS v1.0 connectome data, prepared into a local cache with a `manifest.json` whose SHA-256 is reported in session metadata
- Playwright (headless Chrome) used as a *data collector* — it drives the game page to capture training frames

**Ops**
- `.env.example` only sets two WebSocket URLs (`VITE_FLY_BRAIN_URL`, `VITE_FLY_FAST_BRAIN_URL`)
- Distributed training across two Macs via **Tailscale SSH + rsync** (`scripts/train-distributed.py`)

---

## 3. The runtime flow, step by step

### 3.1 Frame capture (browser)
`src/fly-vision.ts` — the fly's eye:
- One `WebGLRenderTarget` of 128×128, a 90° FOV perspective camera
- Renders **6 faces** (forward, right, back, left, up, down) in the kart's local frame, packed into a **384×256 RGB8 atlas** (2 rows × 3 columns of 128px faces) — this layout matches Fly64's expected input
- Critical detail: the observed car is hidden (`hidden.visible = false`) and the shadow map is refreshed once with it hidden, so the sensor never sees a stale spectator shadow of its own car. Viewport/scissor/shadow state is saved and restored in a `finally` block.
- Capture is throttled to **one frame every 100 ms** (`fly-driver.ts`)

### 3.2 Transport (`src/fly-client.ts` ↔ `brain/server.py`)
A hand-rolled protocol, version-negotiated, that **fails closed** everywhere:

1. Client opens WS, sends `{type:'hello', protocol:1, seed, mode, readout, eyePreviews, neuronActivity, …}`
2. Server builds the `Brain`, replies `{type:'ready', …metadata}` including `backend` (`malecns` vs `synthetic-fixture`), `upstreamCommit`, `neurons`, `edges`, `datasetManifestSha256`, `readoutSha256`
3. Client **verifies the ready message against what it asked for** — mismatched readout, motorShare, seed, mode, neuralHz ≠ 50, or a fixture backend when not allowed → close + `error` status. It will not silently accept a different brain than the one requested.
4. Frames go up as binary: `uint32 little-endian frame ID || 294,912 bytes RGB`. IDs must strictly increase.
5. Activity comes back as JSON: `forwardHz`, `leftHz`, `rightHz`, `jumpHz`, `spikeCount`, `meanLuminance`, `temporalEnergy`, plus `steering` / `targetSpeed` / `motorEffect` when a decoder is loaded.
6. Optional side channels every 10th tick: `eyes` (base64 256×128 eye preview) and `neurons` (base64 per-neuron activity for the anatomy canvas)

**Freshness is enforced on both ends.** The client tracks capture timestamps per frame ID and discards any activity whose frame is ≥500 ms old; the server emits a `stale` message if the newest frame is ≥500 ms old and stops stepping. Only the *browser's own monotonic clock* is used — an explicit comment says never subtract clocks across two Macs. Backpressure: the client refuses to send if `bufferedAmount > 0` or if more than 32 frames are in flight.

### 3.3 The brain (`brain/backend.py`)
- `Brain.transform()` applies the **ablation mode**: `live`, `blank` (zeros), `frozen` (first frame held), `shuffled` (a seeded pixel permutation), `disconnected` (visual input detached from the graph). These are the scientific controls — the loop can be proven to depend on vision.
- `model.step(frame)` runs the LIF connectome; a rolling `history` window is averaged and split into four motor pools → forward / left / right / jump firing rates in Hz.
- If a trained readout is installed, features are extracted and a decoder predicts steering (and optionally a normalized target speed).

### 3.4 Decoding (`brain/readout.py`)
Four feature representations, all read **only** from simulated cells — never track coordinates:
- `activity-voltage` — 768 features: activity and membrane voltage pooled into a 384-bin retinotopic grid (topology preserved by binning on `visual_pixels`)
- `membrane-change` — reset-corrected voltage deltas plus an exponentially filtered history (the representation that actually worked)
- `motor-*` variants — the same, over the ordered `motor_nodes`
- `visual-motor-membrane-change` — 768 visual + 2×20 motor = 788 features

Decoders are either ridge-linear or a small MLP (768→128→64→1, or 788→…→2 with a speed head). Weights are loaded from `.npz` with heavy validation: neuron count must match, motor node ordering must match exactly, all weights finite, scale > 0, shapes exact. `without_motor()` masks motor features to their training means so the UI can display the *actual* causal contribution of motor inputs (`motorEffect`).

### 3.5 Control conversion (`src/fly-controller.ts`)
Five selectable readout modes, chosen by URL query parameter:

| `?readout=` | Steering source |
|---|---|
| `descending` (default) | `(rightHz − leftHz) × gain`, gain = 1100/(50×70) — raw biology, no learning |
| `trained` | learned visual decoder output |
| `hybrid` | `0.5 × learned visual + 0.5 × motor` (share negotiated in the handshake) |
| `plastic-motor` | graph with a frozen learned synapse patch; throttle also neural |
| `combined` | joint visual+motor decoder, with `motorInputs=live|mean` for the ablation |

Then: exponential smoothing (τ ≈ 20 ms/ln(0.78) by default, 50 ms for trained), a deadzone, clamping, and a fixed 0.5 throttle unless neural throttle is enabled. If no fresh sample within `staleMs` (250 ms), the controller **returns neutral input** rather than repeating the last command.

### 3.6 Game loop (`src/main.ts`)
- Fixed 60 Hz physics accumulator, separate render interpolation
- Split screen via `setScissor`/`setViewport`: fly/NPC left, human right
- `fly.step(dt, active, npc.speed)` produces the opponent's `VehicleInput`; `npc.npcInput()` (a scripted lookahead controller) is used when the fly is off
- Assists that are honestly labelled in the UI: an 8 m/s speed cap in trained mode, a stuck-recovery counter (`fly-recovery.ts`), and a deterministic speed servo in the 90 km/h mode
- Lap logic (`race.ts`) requires all 20 gates crossed in order and in the correct direction — no shortcut or reverse-crossing credit

---

## 4. The training pipeline (the most interesting part)

This is a full offline supervised-learning rig bolted onto a game:

1. **Collect** — `scripts/collect-training.mjs` launches headless Chrome via Playwright, imports the game's own `world.ts`/`track.ts`/`fly-vision.ts` modules inside the page, hides the karts, and captures sensor atlases at posed positions along the track. Labels come from a geometric teacher: look 12 m ahead down the centreline, take the heading error, `steering = clamp(-error × 1.9, ±1)`.
2. **Encode** — `brain/train_combined.py` / `train_speed.py` replay each frame through the *real* connectome (5 ticks per frame to let dynamics settle) and record the feature vector. This is the expensive step.
3. **Fit** — ridge or MLP against the teacher labels, with held-out contiguous segments (explicitly *not* unseen-track generalization — the docs say so).
4. **Validate** — always trains a motor-enabled and a **zero-motor** candidate and lets validation choose. Docs repeatedly note that the motor branch winning nothing is an acceptable, meaningful result.
5. **Evaluate** — `/evaluate90.html`, `/runs.html`, `/vision-parity.html` are standalone harness pages: independent seeds, ordered three-lap checkpoints, failure gates, trajectory overlays.

**Distributed variant** (`docs/distributed-f1-training.md`): two Macs, five F1 circuits (Monza, Interlagos, Silverstone, Spa, Red Bull Ring), 1800 images each. A coordinator waits for camera captures, rsyncs them to the Mac Studio over Tailscale SSH into a *batch-specific* directory (never touching the remote game checkout), runs encoders on both machines in parallel, then fits one joint readout from the combined features. Worker state is written as JSON that `/runs.html` polls.

---

## 5. Observations — what is worth stealing

1. **Provenance as a hard gate, not a comment.** The upstream commit SHA, the dataset manifest hash, and the readout file hash are all computed at load, sent in the handshake, and *verified by the client*. A session cannot silently degrade to a fixture brain or a different decoder.
2. **Ablation modes are first-class.** `blank` / `frozen` / `shuffled` / `disconnected` are built into the protocol, not scripts on the side. That is what makes the "vision actually matters" claim testable in one click.
3. **Fail closed, never fall back.** Every validation failure closes the socket and neutralizes controls. There is no path where the scripted NPC quietly substitutes for the fly — which is the single most tempting cheat in a project like this.
4. **The UI reports honest uncertainty.** `motorEffect` shows the measured change in steering when motor inputs are live; the tooltip literally says "A nonzero effect does not prove better driving."
5. **Parity auditing between training and runtime.** `docs/training-game-parity.md` found and fixed four real divergences (ground extents, interpolated vs rigid-body position, shadow-history contamination, missing warm-up) and then declared the older captured features *legacy evidence*. Very few hobby projects do this.
6. **A single physics factory** is shared by game, training and evaluation so they cannot drift apart again.
7. **Documentation-as-lab-notebook.** `docs/` contains 12 experiment write-ups that record failures (batch B leaving the road at u=0.63, the failed synapse patch, motor steering not showing opposing signs for mirrored stimuli) as prominently as successes.

## 6. Weak points / risks noted

- The README's "Current scope" section is **stale** — it says the vision pipeline and WebSocket bridge are future work, while `docs/` and `src/` show them shipped. Two sources of truth.
- Heavy reliance on query-parameter mode switching (`?opponent=fly&readout=combined&pace=90&motorInputs=mean`) — powerful for research, fragile as a product surface.
- The whole thing needs an out-of-band setup: a pinned Fly64 checkout, a prepared 1.5 GB MaleCNS cache, a Python venv, a second Mac for the fast brain. Nothing in the repo bootstraps that.
- Learned drivers have never been shown to reliably complete laps; the docs say so plainly, but it means the "game" half is still the scripted opponent for most users.
