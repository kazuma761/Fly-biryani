# Last 2 Project Reports

Deep-dive reports on the final two reference projects in `References/`.

> The `References/` folder holds five entries: `Flymap`, `flinge-main`, `kitchen`, `mario-cart`, `nueral-visulazation`. `kitchen` contains only a PDF (*Fruit Fly Fruit Ninja: game model*), not a codebase — so the last two **projects** are `mario-cart` and `nueral-visulazation`.

| # | Report | Project | Core idea |
|---|---|---|---|
| 1 | [`01-mario-cart-fly-racer.md`](01-mario-cart-fly-racer.md) | `mario-cart` / "Fly Racer" | Three.js + Rapier racing game whose opponent is driven by a live MaleCNS connectome over a WebSocket |
| 2 | [`02-neural-visualization-flybuddy.md`](02-neural-visualization-flybuddy.md) | `nueral-visulazation` | MLX connectome viewer + music-recognition ears + an ESP32-S3 desk fly, all one process |

## Stack at a glance

| | mario-cart | nueral-visulazation |
|---|---|---|
| **Frontend** | TypeScript, Vite, Three.js 0.180, Rapier3D WASM | Single 1,376-line `index.html`, Three.js 0.169 via import map, zero build |
| **Backend** | Python + NumPy/SciPy/scikit-learn, `websockets` | Python + **MLX** (Apple Metal), `websockets`, stdlib-only audio |
| **Simulation** | Fly64 (pinned by git SHA), MaleCNS, 50 Hz | Fused Metal LIF kernels, MaleCNS, 0.1 ms ticks in 10 ms chunks |
| **Transport** | WS: binary RGB atlas up, JSON rates down | WS: JSON control, custom binary spike frames down |
| **Hardware** | DualSense (gamepad, rumble, USB speaker via a C helper) | ESP32-S3 + LCD + accelerometer over TCP, found by UDP broadcast |
| **ML** | Supervised ridge/MLP readouts, distributed training over 2 Macs | None — no learned decoder; a pure-stdlib Shazam-style fingerprinter instead |
| **Tests** | `node --test` on `.ts`, 55+ tests | `unittest`, confined to the MLX-free modules |

## The pattern shared by both

Both are the same underlying bet, approached from opposite ends:

**Take a real measured connectome, run it honestly, and build an interface that makes the loop inspectable — while refusing, structurally, to fake the parts that don't work yet.**

- mario-cart proves it by **closing the loop**: vision → neurons → steering → new vision, with ablation modes (`blank`/`frozen`/`shuffled`/`disconnected`) built into the wire protocol so "vision matters" is one click from being tested.
- nueral-visulazation proves it by **opening the box**: the same connectome, but you see each of 124,314 somas fire, and the sugar→MN9 route draws itself at the millisecond each cell actually first fired.

And both encode the same discipline in code rather than prose:

| Principle | mario-cart | nueral-visulazation |
|---|---|---|
| Provenance is verified, not asserted | upstream SHA + dataset + readout hashes checked in the handshake | point-cloud count checked in the `hello`, page refuses on mismatch |
| Fail closed, never substitute | any mismatch → close socket, neutral controls; scripted NPC never stands in for the fly | a stimulus whose cells are missing is dropped and *named in the UI*, never approximated |
| Freshness over completeness | frames ≥500 ms old discarded; `stale` message; controls go neutral | spike frames dropped under load (queue depth 1) so the screen is always the newest state |
| Honest uncertainty in the UI | `motorEffect` tooltip: "A nonzero effect does not prove better driving" | "the panel says which it got"; bitter row left empty rather than guessed |
| Negative results documented | 12 `docs/` write-ups including failed synapse patches and off-track runs | "a positive identification has not been seen end to end" in the README |
