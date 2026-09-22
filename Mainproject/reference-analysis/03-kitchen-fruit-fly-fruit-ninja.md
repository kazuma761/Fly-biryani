# Project Report 3 — `kitchen` (Fruit Fly Fruit Ninja)

**Location (local):** `References/kitchen/` — contains only the design document `# Fruit Fly Fruit Ninja: game model.pdf`
**Live build:** https://fruit-fly-fruit-ninja.vercel.app/
**One line:** A 3D kitchen game where eight fly "chefs" learn fruit preferences through simulated plasticity on real MaleCNS mushroom-body wiring, then fly to a knife, grip it, and chop the salad — with the same 319-neuron anatomy reused as a fixed feature transform for their flight controller.

> **Note on sources.** The local folder has no code. I reconstructed the architecture from two places: the PDF design document, and the deployed site — which ships **unbundled ES modules**, so `src/*.js` and `data/circuit.json` are readable directly. Everything below with a filename or a line of code attached was read from the live build, not inferred.

---

## 1. The shipped source layout

No bundler, no framework, no build step. `index.html` loads one module:

```html
<script type="module" src="./src/salad-app.js">
```

Module graph (13 files, ~111 KB of hand-written ES modules, plus vendored Three.js):

| File | Size | Job |
|---|---|---|
| `src/salad-app.js` | 17.5 KB | App shell, UI wiring, localStorage, event→feedback |
| `src/scene3d.js` | 19.3 KB | Three.js kitchen scene, lighting, camera |
| `src/salad-scene.js` | 10.5 KB | Fruit halves, juice, bowl, plating animations |
| `src/salad-game.js` | 6.3 KB | **Game state machine, blade sweep, scoring** |
| `src/flight3d.js` | 9.5 KB | Rigid-body knife, waypoints, docking, teacher PD controller |
| `src/motor3d.js` | 6.8 KB | **Motor encoder, PN→KC transform, six-output readout** |
| `src/fruit-memory.js` | 5.9 KB | **The mushroom-body circuit and the learning rule** |
| `src/ridge.js` | 3.6 KB | Ridge regression via Cholesky with adaptive jitter |
| `src/motor3d-worker.js` | 412 B | Web Worker shim around `trainMotorSwarm` |
| `src/motor-ui.js` | 5.8 KB | Train / erase / restore, policy persistence + validation |
| `src/brain-panel.js` | 5.4 KB | The 3D circuit inspector |
| `src/physics.js`, `src/fruit-models.js`, `src/fullscreen.js` | | Contacts, procedural fruit geometry, layout |
| `vendor/three/` | | Three.js + OrbitControls, self-hosted (not CDN) |
| `data/circuit.json` | 166 KB | The connectome subset |

Hosting is Vercel static — no backend, no API key, nothing to run server-side. That is the single biggest structural difference from the other two projects.

---

## 2. The anatomical data (`data/circuit.json`)

I pulled and parsed it. It is a genuine MaleCNS v1.0 extraction, not a stand-in:

```
schema_version 1.0 · dataset "MaleCNS v1.0", side L, edge_measure raw_synaptic_contact_count
319 neurons · 2,117 directed edges
```

| Role | Count |
|---|---|
| `kenyon_cell` | 192 |
| `projection_neuron` | 124 |
| `output` (MBON11_L) | 1 |
| `feedback_inhibition` (APL) | 1 |
| `teaching` (PPL101) | 1 |

| Relation | Count |
|---|---|
| `pn_to_kc` | 1,362 |
| `apl_to_kc` | 192 |
| `kc_to_apl` | 192 |
| `kc_to_mbon` | 192 |
| `ppl1_to_kc` | 179 |

The `selection` block is unusually candid, and is the thing most projects would have omitted:

> *"top KCg-m_L cells by descending raw KC-to-MBON11_L contact count; all connected ALPN_L inputs retained"*
> **selection_bias:** *"Enriches KCs strongly connected to MBON11 and is not a random or complete KC population."*
> **pn_scope_note:** ALPN is a source-native anatomical class whose modality and transmitter sign "are not resolved by the two extracted source tables; it must not be read as a guarantee of purely olfactory" input.

So the file states its own sampling bias and the limits of what its labels mean. A neuron record is `{id, type: 'VA7m_lPN', instance: 'VA7m_lPN_L', side: 'L', role}`; an edge is `{pre, post, count, relation}`.

The 179 `ppl1_to_kc` edges are **shipped but deliberately unused** — PPL1 is the *aversive* teaching pathway, and the game's rule is appetitive (fruit + snack), so relabelling it as reward would have been a false claim. It stays in the data for provenance and stays inactive in the model.

---

## 3. Circuit 1 — smell, and the learning rule (`fruit-memory.js`)

### Building the circuit
At load, edges are bucketed by relation into per-KC input lists, and **PN→KC counts are normalized per Kenyon cell** (`row.forEach(e => e[1] /= sum)`), so raw synapse counts set relative weighting without letting a high-count KC dominate. The circuit refuses to start if any KC lacks inputs or a KC→MBON edge:

```js
if(initial.some(v=>!v)||inputs.some(v=>!v.length)) throw new Error('Incomplete mushroom body circuit');
```

### Odor → sparse KC code
Each of the four fruits gets a **deterministic synthetic PN pattern** from a seeded PRNG (`random(12001 + f*733)`) — ~22% of the 124 PNs active per odor. Then a **three-pass APL settling loop**:

```js
for(let pass=0; pass<3; pass++) {
  drive   = per-KC weighted PN sum − 0.3·apl·aplInputs[i]/aplMax   // APL inhibition
  winners = top 15 by drive                                        // sparsity rule
  kc      = winners normalized to the strongest
  apl     = Σ kc[i]·aplOutputs[i]/aplSum                           // KC→APL feedback
}
```

That is the real mushroom-body motif — sparse coding enforced by a single global inhibitory neuron — implemented in nine lines. A fixed odor produces an identical KC pattern in every fly; what differs between flies is only their learned weights.

### The plasticity rule
```js
after = clamp(before + 0.28·eligibility·(1.5·initial[k] − before),
              0.05·initial[k], 1.5·initial[k])
```
- `eligibility` = that KC's activity for this odor, so **only KCs active for the taught fruit change**
- Initial weight = `0.2 × anatomical count`; the ceiling is `1.5 × anatomical count` — the anatomy sets both the starting point and the bounds
- It is a bounded exponential approach to the ceiling, so repetition saturates rather than diverging
- `teach()` records every change as `{fly, kc, before, after}` and pushes a history entry — the learning is auditable, not just applied

### Recruitment
```js
response = Σ kc·weights / Σ kc·initial      // normalized by the anatomical reference
VOLUNTEER_THRESHOLD = 0.72
```
A chef volunteers when their normalized response to the current ingredient clears 0.72. At least two are needed to lift the knife. Starter histories (`[0,1,2,0,1,2,0,1]` × 6 repetitions) give Pip/Basil/Fig apple, Zest/Miso/Boba orange, Dot/Bean strawberry — and **kiwi is left untrained on purpose**, so the player can create a volunteer from nothing in about ten seconds and watch the causal chain.

### Live display state
`stepNeuralActivity` runs first-order filters toward the computed values (τ = 0.12 s sensory, 0.22 s KC, 0.16 s output) per fly. `sniff()` gives a 2.8 s cue that changes activity but **never touches weights** — the read-only inspection path is a separate function from the write path.

---

## 4. Circuit 2 — flight, same anatomy, different job (`motor3d.js`)

This is the clever structural move: **the same fixed PN→KC wiring is reused as a feature transform for motor control.**

```
13 engineered observations
   → fixed random encoder (per-PN, hash-derived) → tanh → 124 PN units
   → the immutable 1,362 normalized PN→KC contacts → tanh → 192 KC features
   → learned linear readout → 6 outputs: fx, fy, fz, tx, ty, tz
```

The 13 observations (`motorObservation`) are all **relative and mass-normalized**: target offset ÷6, velocity ÷4, quaternion error (sign-corrected for double-cover via `q.w<0?-1:1`), angular velocity ÷3, and load `m`. Normalizing by `mass/0.55/n` and inertia is what lets one lesson drive both a 0.12-mass free-flying fly and a 0.55-mass knife carried by a varying number of chefs — no retraining per configuration.

The encoder is deterministic from neuron ID: `Math.sin(hash(\`${id}:motor3d:${j}\`)*1e-6)*.12` — reproducible across sessions with nothing stored.

**No intercept, no bypass.** `readout` is pure `Σ w·kc` with no constant term, which is what makes the advertised ablation exact: clamp the KC features to zero and output is *identically* zero, not merely small. The code has three modes built in for exactly this — `'clamped'` (kc.fill(0)), `'scrambled'` (rows permuted by `(i+37)%n` without refitting), and `'untrained'` (readout output forced to 0).

Outputs are clamped as **vectors**, not per-component: `clampLength(0,8)` for force and `clampLength(0,0.9)` for torque, applied identically in every mode including autopilot — so controllers compete under the same actuator limits.

### Training
`trainMotorSwarm` generates 1,800 randomized worlds (`randomMotorWorld`: random crew size 2–8, random pose, velocity, attitude, target), records KC features, and takes the **unbounded** analytic PD teacher action as the label (`{bounded:false}` — fit to the ideal, saturate at runtime). Ridge fits 6 × 192 = 1,152 weights, two outputs at a time sharing one normal-equation factorization, λ = 1e-10. `ridge.js` does Cholesky with **adaptive jitter** so λ=0 still yields a finite least-norm-ish result.

Runs in a Web Worker (`motor3d-worker.js`), reporting progress per output pair, so the UI stays live. One lesson is copied to all eight flies — and `training.sharedReadout: true` is recorded in the metadata so the UI cannot claim eight independent flight histories.

### Persistence with identity checks
`deserializeMotorSwarm` refuses a saved policy unless **all** of these match: `version`, `encodingId` (`'xyz13-pn-kc-tanh-v1'`), `topologyHash` (FNV-1a over every sorted `pre:post:count` contact string), the exact ordered `pnIds` and `kcIds`, 8 readouts × 6 rows × KC-length, all finite.

```js
throw new Error('Motor policy does not match the fixed circuit/encoding');
```

So a weight file fitted against different anatomy cannot silently load. Same instinct as mario-cart's SHA pinning, expressed as a topology hash.

---

## 5. The game loop (`salad-game.js` + `flight3d.js`)

### Phases
`idle → recruit → lift → ready → cut → plate → return → (next ingredient | served)`, with `waiting` when fewer than two chefs volunteer.

Notable: transitions are **physical, never timed out**.
- `recruit → lift` requires `crewAttached()` — position, speed *and* attitude tolerances (`<.07` distance, `<.2` speed, `<.12` rad).
- `lift → ready` requires `knifeSettled()`. And if a ready knife stops being settled, it **drops back to `lift`** and `readyTime` resets — `if(!knifeSettled(g.world)){g.readyTime=0;phase(g,'lift');}`. Losing control disables chopping until it genuinely recovers.
- Switching flight mode mid-round forces a re-settle rather than keeping the ready state: that is `setMotorMode`'s only side effect.
- A missed cut clears the combo and returns to `lift`. There is no success timeout anywhere.

### Free flight
Each fly integrates its own body at 120 Hz (mass 0.12, inertia 0.008) with its own observation through its own readout. Waypoints are `[departure, arrival, end]` — up off the shelf, across, then down onto the grip — advancing at 0.48 distance, with yaw targeting the next leg's direction until the final docking leg, which targets the grip orientation.

### The cut (`bladeContact`)
The most rigorous piece of the game:

```js
if((after.y - before.y)/dt > -0.25) return false;          // must be moving DOWN
travel  = |Δposition| + 1.5·quaternionAngle(qa,qb);         // rotation counts as travel
samples = ceil(travel / 0.025);                             // adaptive subdivision
for each t: slerp orientation, lerp position,
            rebuild the world-space blade edge,
            point-to-segment distance to the fruit sphere ≤ radius
```

The blade edge is `local x ∈ [−0.75, 1.4], y = −0.16, z = 0` transformed by the knife pose — **the same geometry that is rendered**, so what you see is what collides. Rotation is folded into the travel estimate so a fast pivot still gets subdivided. A stationary overlap can't cut; a blade passing behind the fruit in Z can't cut. Timing only sets the point value (60/100/150 by `phaseTime` bucket), never whether geometry was hit.

Scoring: timing bucket + `min(5, combo−1)×10` streak bonus, +200 per completed bowl. Rush is 90 s of *simulated* time — hiding the tab pauses it, and frame catch-up is capped so slow rendering slows the sim rather than teleporting it.

### The wind gust
`gust()` adds a real velocity and angular-velocity impulse (`vx+=1.7, vz+=1.2, ωz+=1.3`) to flying chefs and the carried knife. It is not an animation — the learned controller has to actually recover from it, and you can watch the six motor outputs change while it does.

---

## 6. The Brain panel

Two views over the same 319 neurons at **schematic** (explicitly not measured) 3D positions:
- **Smell circuit** — live per-fly PN/KC/APL/MBON rate state, traveling dots, `ACTIVE KCs` counted above 0.08 activation (which is why transitions briefly show more than the steady-state 15), `MBON OUTPUT` = the selected fly's normalized weighted KC sum. Teaching a fruit visibly changes this number.
- **Flight circuit** — the same fly's actual motor PN/KC features mapped by neuron ID, magnitudes amplified 15× for visibility, `ACTIVE FEATURES` counted above 0.001 on the *raw* values. MBON/APL/PPL1 nodes go dark here, because the six motor outputs are not biological MBONs and the panel refuses to imply they are.

A companion **Motor outputs** instrument shows all six signed components with centered bars on ±8 force / ±0.9 torque, labelled by source (learned readout / autopilot reference / zero-thrust). Resting flies read zero.

The panel auto-follows a volunteer when a crew is recruited, keeping your manual selection if that fly happens to be on duty; manual selection lasts until the next ingredient.

The PDF credits the visual direction to [Aimbug's Brain panel](https://aimbug.domi.zip/) and states explicitly that no code, neuron positions or artwork were copied.

---

## 7. Observations — what is worth stealing

1. **One anatomy, two learning problems, honestly separated.** The same 1,362 PN→KC contacts serve as (a) the odor feature space for associative plasticity on KC→MBON, and (b) a frozen random-feature transform for motor imitation. Two kinds of learning, two kinds of weights, one fixed wiring — and the UI labels which is which in both views.
2. **Ablations are the product, not a test script.** Erase flight → outputs go to zero and the flies visibly cannot lift the knife. Clamp KC → exactly zero, guaranteed by having no intercept. Permute KC without refitting → it fails. Teach kiwi → previously uninterested chefs volunteer. Every claim the design doc makes has a button.
3. **No-intercept as a design commitment.** `intercept:false` is recorded in the training metadata *because* it is what makes "the anatomy is load-bearing" checkable rather than rhetorical.
4. **Mass/inertia-normalized observations for transfer.** One 1,800-sample lesson drives a 0.12-mass fly, a 0.55-mass knife, and every 2-through-8-chef grip configuration, with no per-case retraining. Cheap, and the reason 28/28 two-chef configurations pass.
5. **Physical gating everywhere, no timeouts.** Arrival requires position + speed + attitude; readiness requires settling and is revoked if lost. The doc's phrase — *"No artificial success timeout moves it into position"* — is enforced in `stepGame`.
6. **Rendered geometry is collision geometry.** `bladeEdge()` returns the same local coordinates the blade mesh is drawn from, so the cut cannot disagree with the picture.
7. **Self-documenting data.** `circuit.json` carries its own `selection_bias` and a warning that its PN class label doesn't guarantee modality. That is the strongest provenance move across all three projects — the caveat travels with the file, not just the README.
8. **The unused aversive pathway is shipped anyway.** 179 PPL1→KC edges kept for provenance and left inactive rather than quietly repurposed as "reward". Same instinct as nueral-visulazation leaving the bitter row empty.
9. **Zero infrastructure.** Static Vercel, vendored Three.js, no CDN, no backend, no key. The other two projects need a pinned Fly64 checkout or a 1.5 GB MLX pack and an Apple GPU; this one is a URL.

## 8. Weak points / risks noted

- **The local `kitchen/` folder is just the PDF.** No repo, no `evidence/`, no `DATA_PROVENANCE.md`, no `tools/extract_data.py` — all of which the document references. The deployed source is the only code available here.
- The odors are **synthetic**: seeded random PN patterns, not recorded odor responses. The doc says so, but it's the biggest gap between "real connectome" and "real biology" in the project.
- The learning rule is explicitly *engineered appetitive*, not physiological — no bidirectional learning, no extinction, no spiking, no receptor identities, no physiological units.
- 192 of 689 candidate KCs, chosen by descending MBON11 contact count — a strongly biased subsample, as the file itself states.
- The "permuted KC fails" result shows dependence on the *learned feature mapping*, not that real anatomy beats a refitted alternative. The doc makes this distinction; it would be easy for a reader to miss.
- Shared readout across eight flies means the flight differences you see between chefs are body state, not eight learned styles.
- Progress lives in `localStorage` only (`fruit-fly-best-v1`, `fruit-fly-motor3d-v1`); smell preferences reset on reload by design, flight lessons persist.
