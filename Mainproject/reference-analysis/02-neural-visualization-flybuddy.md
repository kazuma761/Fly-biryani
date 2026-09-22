# Project Report 2 — `nueral-visulazation` (Fly Brain viewer + FlyBuddy)

**Location:** `References/nueral-visulazation/`
**One line:** One fruit fly living in three bodies at once — a live MLX-accelerated connectome simulation in the browser, a music-recognition "ears" service, and an ESP32-S3 desk toy that pulls a face — all wired through a single in-process event bus so one moment reaches all three.

---

## 1. What the project actually is

Three packages and a firmware, deliberately runnable as **one process**:

| Folder | Tech | Job |
|---|---|---|
| `visualization/` | Python + **MLX** (Apple GPU), `websockets`, Three.js 0.169 in a single 1,376-line `index.html` | Steps the MaleCNS connectome live, streams spikes to a browser point cloud of 124,314 somas, serves the page, owns the board link |
| `learning/` | Pure-stdlib Python (no numpy!) + ffmpeg + RapidAPI Shazam | Listens to the room, fingerprints audio, recognises songs from memory, asks Shazam at most once per song ever |
| `flybuddy/` | C++ / Arduino, ESP32-S3, JD9853 240×296 LCD, LIS2DH12 accelerometer | The physical fly: analytic vector rendering at 30 fps, accelerometer-driven behaviour, WiFi uplink, speaker |
| `design/` | PNG reference sheets | The mood/behaviour design sheet the firmware implements |

The thesis, stated in the viewer README: *"One page, one process, one fly… all three are the same fly, so a thing that happens to one happens to all of them."* Starting them separately was explicitly identified as the thing that made it feel like three demos instead of one animal.

---

## 2. Tech stack, precisely

**Simulation**
- **MLX** (Apple's array framework) with fused Metal kernels — `lif.engine_metal.propagate` and `lif.engine_fused._state_kernel`, imported from a sibling research repo (`research/drosophila-brain-mlx`), *not vendored here*
- MaleCNS v1 pack: 166,700 neurons, ~24.5M synapses, LIF dynamics, 0.1 ms ticks
- NumPy for indexing/packing only; the heavy math is on the GPU

**Viewer**
- Zero build step. One HTML file, ESM import map pulling `three@0.169.0` from jsDelivr, plus `OrbitControls`
- Custom `ShaderMaterial` point cloud: per-point `shown` and `active` float attributes, so lighting a firing neuron is one float write, not a rebuilt buffer. Additive blending, round point sprites discarded outside radius, size scales with activity.
- Geometry is **quantised uint16** and dequantised in JS against a stored span — `brain.bin`/`somas.bin`/`pathway_*.bin` are custom binary formats with a JSON sidecar index

**Learning**
- `fingerprint.py` is a **pure-stdlib Shazam-style constellation fingerprinter**, FFT included (`cmath`, no numpy, no build toolchain). 8 kHz / 1024-sample frames / 256 hop.
- `audio.py` shells out to ffmpeg for capture and resampling
- HTTP on `FLY_PORT` (8020) via `ThreadingHTTPServer`; raw TCP on 8021 speaking the deskbuddy's binary song protocol

**Firmware**
- Arduino-ESP32, FreeRTOS tasks, dual-core: render on one core, SPI push on the other
- No framebuffer — two 15 KB bands (a 240×296 canvas would be 142 KB), dirty-rect blits
- Analytic shapes: a rotated ellipse solves its own conic per row, edges antialiased from true distance to the curve. No sprites, so rotation is free.
- Measured: 30.0 fps, 27.0 ms draw, 0.8 ms waiting on the panel, 83.4 KB static RAM (26%), 976 KB flash (76% — 49 points of that added by the WiFi/lwIP stack alone)

---

## 3. The flow, end to end

### 3.1 The hub (`visualization/sim_server.py`, 449 lines)
One `asyncio.run(main())` brings up **four things**:
1. `Simulation` — wraps `LiveBrain`, loads the pack, maps model neurons onto soma point indices
2. `start_learning(fly)` — imports the `learning` package *in this process*, starts its HTTP + TCP servers on threads. Every failure here is survivable and printed: no ffmpeg, no API key, no mic, port busy → the brain still runs.
3. `DeviceLink` — the board's TCP server plus a UDP beacon
4. A `ThreadingHTTPServer` serving `index.html` and `data/` so page and socket come from one origin

**Threading model, and why:** MLX calls block, so the simulation runs on a worker thread. It hands finished chunks to the asyncio loop with `loop.call_soon_threadsafe` into an `asyncio.Queue(maxsize=1)` — if the browser falls behind, **frames are dropped, not queued**, so the screen always shows the newest brain state. Control messages get a separate depth-64 queue that drops the *oldest*, because each one is a thing that happened and is worth keeping.

### 3.2 The wire format
Control messages are JSON both ways. Spike frames are binary little-endian, because a busy chunk names several thousand neurons and JSON would spend most of the bandwidth on commas:

```
float32  t_bio      biological seconds since reset
float32  wall_ms    what the chunk cost to compute
float32  bio_ms     how much brain time it covered
uint32   n_firing   neurons that fired, of those drawn
uint32   n_spikes   total spikes including undrawn neurons
uint32   n_readouts
float32  readouts[] in the order given in the hello message
uint32   point[n_firing]   index into the soma point cloud
uint8    count[n_firing]   spikes this chunk, saturating at 255
```

Each chunk is `CHUNK_TICKS = 100` × 0.1 ms = **10 ms of biological time**, costing ~8 ms wall clock. Default playback speed is 0.25 (4× slow motion) because the spread is too quick to read at 1.0; a physical feed button drops it to 0.05 (20×).

**A real bug they guarded against, documented inline:** the firing mask uses `(per_neuron > 0) & drawn`, not `per_neuron & drawn` — a bitwise AND against a boolean mask would keep only the low bit, so a neuron that fired exactly twice in a chunk would silently vanish.

**Index-identity check:** spike frames address the browser's point cloud *by index*. If the server loaded a different `somas.bin`, every index would still be in range and would light the wrong neuron, silently. So the count is sent in the `hello` and the page refuses to run on a mismatch, with the rebuild command in the error.

### 3.3 The live brain (`live_engine.py`)
Wraps the same two Metal kernels as the benchmarked offline lane, in the same order, so the arithmetic is identical — what differs is *who owns the state*. The offline `engine_fused.run` materialises the whole stimulus up front and builds fresh state inside the call, which makes it parity-testable but impossible to pause and resume. The live panel needs the opposite.

Two deliberate divergences, both documented as consequences of a drive that can toggle mid-run:
- `rfc_reload` is rebuilt whenever the driven set changes, so a neuron is refractory-exempt only *while* it is actually being driven, and returns to the normal 2.2 ms refractory period when its stimulus stops
- Poisson draws come from a per-chunk numpy Generator rather than one pre-materialised bit pattern

Every neuron any button can drive gets a **permanent column** in the draw matrix, so the kernel's `target_slot` map is built once; an off stimulus just draws zeros.

### 3.4 Stimuli, and the honesty rule
Six stimuli in `STIMULI`, each naming real cell types:

| Key | Cells | Provenance |
|---|---|---|
| `sugar` | `LB3b_R`, `LB3c_R` | verified against this pack |
| `water` | `LB3a_R` | verified |
| `smell` | `ORN_DM1_R` | verified |
| `looming` | `LC4_R` | verified |
| `sound` | `JO-B_R` → `JO-B` → `JO-A_R` → `AMMC-A1_R` … | **from the literature**, candidate list |
| `bitter` | `LB1e_R`/`LB2e_R` → `Gr66a_R` … | from the literature, expected to drop |

A selector may be a list of alternatives tried in order, and **a stimulus that resolves to nothing is dropped, not fatal** — the panel and the page both say which buttons are missing and tell you to run `find_types.py` to see how the pack spells them. This is the cleanest idea in the project: the graph is allowed to not have something, and the UI reports that rather than faking it.

### 3.5 The reaction table (`reactions.py`)
The join between "the fly heard something" and "the brain, the board and the page do things" is a **frozen dataclass table**, on purpose, because "a claim in a table can be read, argued with and corrected — the same decision spread across three if-statements in a socket handler could not be."

| What happens | Brain drives | Board does |
|---|---|---|
| Ears armed | — | curious |
| Music starts | `sound` | curious |
| Knows the song from memory | `sound` | dancing (excited if heard < 3 times) |
| Shazam just named it | `sound` | excited |
| Nobody could name it | `sound` | curious |
| **You agree — sweet** | **`sugar`** | **eating + a crumb drops** |
| You disagree — bitter | — | angry |
| Music stops | — | back to choosing its own face |

Two rules keep cells empty deliberately:
- **The brain column is anatomy.** A row drives a stimulus only where a real fly has a sense organ. There is no "recognition" or "happiness" input in a connectome, so those rows drive nothing rather than something vaguely related.
- **The bitter row is empty on purpose** because this pack's labellar bitter cells are not identified, and naming a cell type on a hunch would put a false claim on screen.

A thumbs-up therefore drives 17 real sugar receptor neurons of the right labellum, through 24.5M synapses, to MN9 (the proboscis-extension motor neuron), with nothing scripted in between — and you watch the MN9 readout meter move.

### 3.6 The event bus (`learning/events.py`)
62 lines. A publisher hands over a dict; subscribers are called **inline on the publisher's own thread**. No sockets, no polling, no HTTP round trip between the three halves. The contract is stated: a subscriber must be quick and non-blocking (the simulator's only drops a trigger into a queue), and an exception in one subscriber is printed and swallowed because "a broken face is not a reason to stop the fly from hearing."

`flystate.bridge()` is deliberately the **only** place an event becomes actions — one event in, three places updated — so adding a fourth consumer is a line in a function rather than a fourth subscriber racing the others.

### 3.7 Music recognition (`learning/`)
The decision order is the design:
```
4 s of sound → memory (free, instant) → hit? answer
                     ↓ miss
               Shazam, exactly once → named? answer + write down
                     ↓ nameless
               remembered anyway under a placeholder key
```
A song is paid for once in its life. Two separate things improve: *being told the name* happens once; *recognising it* improves every hearing, because each hearing's landmarks are folded into the song's record shifted by the matched offset, so all hearings share one timeline — a song first met through its chorus is eventually known by its intro too.

Matching is an offset histogram: coincidence scatters, a real match stacks at one offset, score = tallest bar. Measured across 64 clips of four real sources: right source scored 14–277, best *wrong* source ever scored 3, pure noise scored 0, 64 decisions right and 0 wrong. `MIN_SCORE = 8` and twice the runner-up sits in that gap. Fingerprinting 4 s takes 0.09 s in pure Python.

The energy gate was also measured through the Mac's own mic (quiet room 2% loud blocks, music 78%, voiceover 74–94%) and the conclusion is honest: **it cannot tell music from continuous speech, and nothing cheap can** — so the gate only paces the asking, and a physical button decides what the fly is being asked to do.

### 3.8 The board link (`device.py` + `flybuddy/uplink.cpp`)
The board is **never given an address**. `sim_server.py` UDP-broadcasts `flybuddy <port>` to 255.255.255.255 twice a second; the board listens, takes the sender's address, and dials back one TCP socket. A new DHCP lease, a different network, a restarted router → it finds the laptop again in seconds, no reflash. The tradeoff is stated: guest WiFi with client isolation passes neither broadcast nor peer-to-peer traffic and will never connect, and `status()` reports "wifi" and "looking" separately precisely so you can tell which one you are stuck on.

Line protocol, host → board:
```
MOOD <NAME> <seconds>   AUTO   FEED   SAY <text>   SUB <text>   PING
```
Board → host: `HELLO <name>`, `PONG`, and `FEED` when the physical `+` button is pressed. Moods are validated against the firmware's `fly.h` enum on the *host* side rather than sent and silently ignored. Sends never block the caller — a sleeping board must not stall the simulation thread ("the fly's face is not worth a frame of the brain"); a failed write drops that board. `PING_EVERY = 6 s` against the board's 20 s silence timeout.

A physical feed press triggers `sugar` on *every* connected browser, forces the trace on regardless of the checkbox, and drops the brain to 20× slow motion — because a button on the desk is a presentation, not a control tweak.

### 3.9 Pathway tracing (`build_pathway.py`)
The nicest piece of methodology in the repo. The stimulus→motor pathway is **not read off the connectivity graph**, because a graph walk finds plenty of routes the model never uses (the two cells that look like the sugar gate by synapse count reach MN9 through a single synapse, one of them inhibitory). Instead it:
1. runs the simulation and records each neuron's **first-spike time**
2. walks backwards from the readout, keeping only presynaptic partners that both connect strongly *and* fired earlier
3. fetches MaleCNS skeleton morphology (CC BY 4.0, FlyEM/HHMI Janelia) and packs quantised vertices + per-vertex distance-from-root

The page then runs a **light along the branch** at the millisecond each neuron actually first fired — 27 ms of biological time from labellum to MN9 — over the still-running point cloud. The spikes and the route are the same event seen two ways.

Also handled: a sugar neuron's soma sits out in the labellum and is not in the point cloud at all, but its axon is 100% inside the brain — so as a *skeleton* the input becomes visible.

### 3.10 The firmware behaviour
Nothing is special-cased per orientation. Where the floor is, which way is up, and how big the fly can be are all derived from the gravity vector — which is why 180° and a full 360° need no code of their own. SIT / FLY / LAND state machine: past ~35°, or a spin, or a shake → takeoff (wings blur, legs tuck, body banks); hold still → lands on whichever edge is now the floor, squashes on impact, springs upright with overshoot, grins wider for a second. Idle life: breathing, head turns, antennae trailing with a spring, flicks, and grooming every 7–14 s.

The voice is `song.cpp` — synthesised *D. melanogaster* courtship song, pulse trains at 215 Hz with realistic IPI jitter and a 145 Hz sine component, pitched up 3× because a 4 Ω toy speaker cannot do 145 Hz. Nothing is ever spoken in English: the song name is *shown* in a bubble under the face, "the way a comic panel puts words on an animal that has never spoken in its life."

---

## 4. Observations — what is worth stealing

1. **One process, one animal.** The architectural decision that carries the whole project: the brain, the ears, the page and the board are not four services with an API between them. They share an in-process notice board, so no round trip was added and a song still costs at most one lookup.
2. **The reaction table as a testable artifact.** `reactions.py`, `flystate.py` and `device.py` import *nothing* that needs MLX, the 1.5 GB pack or an Apple GPU — which is exactly why the rules worth testing live there, and `test_wiring.py` exercises them against a fake simulator and a fake board. The untestable part is confined to `sim_server.py`.
3. **Graceful degradation is the default everywhere.** No ffmpeg → brain runs. No API key → guesses only. No board → page and brain don't know or care. Missing cell type → that one button is absent and labelled. Port busy → printed, survivable.
4. **Measured claims, with the negative result included.** Firmware fps and RAM, fingerprint scores against wrong sources, energy-gate percentages — all measured and tabulated. And the README's last section states plainly what is *unverified*: no commercially released music was on the machine, so a positive Shazam identification has never been seen end to end.
5. **Zero-build frontend that still does real GPU work.** 1,376 lines of HTML, an import map, and a custom shader — no bundler, no node_modules, no install step for the viewer.
6. **Binary-with-JSON-sidecar data format.** Quantised uint16 geometry + a JSON index gives small files and a trivial JS reader, and the count check makes the two halves refuse to run out of sync.
7. **Discovery by broadcast beats configuration.** The board has no host, no port, no hostname in its config — and therefore no reflash on a network change.

## 5. Weak points / risks noted

- **Hard external dependency that isn't in the repo**: `lif` / `research/drosophila-brain-mlx/data/pack/male_cns_v1` is referenced by path and is required for anything real to run. `sim_server.py` cannot even be *imported* without it.
- Apple-only: MLX + Metal means no Linux/Windows/CUDA path at all.
- Folder name is misspelled (`nueral-visulazation`), and `__pycache__` and the whole `flybuddy/build/` output tree are committed.
- `context/circuits.md` and `context/touchscreen.md` are referenced repeatedly by the READMEs but are **not present** in this copy — a reader cannot check the cell-type provenance claims.
- The mic loop is not closed: the board has an ES7210 but `flybuddy/` is playback-only, so today's ear is the laptop's. The README lists exactly what is missing (`mic.cpp`, a `music_id.cpp` pointed at port 8021, `doublePressedPlus()`).
