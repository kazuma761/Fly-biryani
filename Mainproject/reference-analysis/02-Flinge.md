# Project 2 — Flinge

**Path:** `References/flinge-main/`
**One line:** A fruit fly on a Hinge-style dating app — a mushroom-body dopamine learner (Python/NumPy) served over FastAPI, driving a React + Three.js UI with a live "paint the brain" point-cloud HUD, plus a second seven-stage heartbreak-recovery curriculum.

---

## 1. Tech stack

| Layer | What they used |
|---|---|
| Backend | **Python 3.11**, packaged (`pyproject.toml`, `pip install -e '.[test]'`), importable as `python -m flinge` |
| Numerics | **NumPy only** — no PyTorch/JAX. The whole brain is dense/sparse matrix multiplies |
| API | **FastAPI + Uvicorn + Pydantic v2**, CORS open, singleton engines created on `startup` |
| Sensory input | **Pillow (PIL)** renders a 320×180 RGB "profile card", which is then projected into PN channels |
| LLM (optional) | OpenAI (`gpt-4o-mini`) for rizz lines and NPC replies, behind `OPEN_AI_KEY`; **scripted fallback always available** |
| Frontend | **React 19 + Vite 6 + react-router-dom 7 + Three.js 0.170** |
| 3D assets | Per-body-part **STL meshes** of a fly (`public/fly/meshes/*.stl`, Apache-2.0 + MIT credited) and a **brain point cloud** as a raw `positions.f32` binary |
| Orchestration | A root **Makefile** — `make start/stop/status`, PIDs and logs in `.run/`, ports overridable |
| Dev proxy | Vite proxies `/api` → `http://127.0.0.1:8765` |
| Tests | pytest (`flinge/tests/test_core.py`) + a `validate` CLI that does a frozen-vs-trained A/B |

**Source size:** ~2,073 lines of Python across 17 modules + ~1,790 lines of JSX/JS.

---

## 2. Architecture / module map

```
flinge/flinge/
  config.py       Settings dataclass (run dir, data dir, deadband, seed, model, port)
  prepare.py      builds the synthetic MB circuit .npz + manifest + default profiles
  brain.py        MushroomBody (PN→KC→MBON, DAN dopamine, depression) + rgb_to_pn
  render.py       PIL profile-card renderer (danger cards get a dark/red palette)
  profiles.py     Profile dataclass + the deck (traits, vibes, prompts, danger flag)
  girls.py        scripted NPC replies, fit_score, outcome → dopamine delta
  actions.py      valence → pass | like | comment | rizz  + rizz strategy buckets
  dopamine.py     DopamineState meter (0–100, anchor, deadband) + OUTCOME_DELTA table
  train.py        FlingeEngine — the observe → act → reinforce loop
  heartbreak.py   second MB curriculum, seven grief stages (443 lines)
  llm.py          OpenAI rizz/reply generation
  serve.py        FastAPI app, /api/* routes for both engines
  state.py        SessionState dataclass persisted as JSON
  validate.py     frozen vs trained mechanism check in a temp dir
  cli.py          prepare | train | step | status | serve | validate

flinge-ui/src/
  App.jsx                  Discover / Matches / Chat tabs + auto-step driver
  pages/HeartbreakPage.jsx the /heartbreak curriculum UI
  components/BrainCloud.jsx  Three.js point cloud, colours by action focus
  components/BrainPanel.jsx  region activity bars
  components/FlySimulator.jsx STL fly rig holding a phone
  lib/{api,flyModel,phoneTextures}.js
```

---

## 3. How the flow actually works

### 3.1 Setup path
`python -m flinge prepare` → `build_circuit(seed=20260920)` generates **four deterministic sparse matrices** sized after the MaleCNS MB extract: PN 128, KC 400, MBON 48, DAN 96 (80 PAM + 16 PPL1). Densities: PN→KC 4%, KC→MBON 8%, DAN→MBON 12%, MBON→MBON 5%. Saved as `mb_circuit.npz` + a `mb_manifest.json` that says in plain text: *"Deterministic sparse circuit sized after MaleCNS MB populations. Not the released synapse graph."*

### 3.2 The brain (`brain.py`)
- All weight blocks are **column-normalised** on load.
- `pn_drive` = `W_pn_kc.T @ pn`.
- `kenyon_from_drive` = **k-winners-take-all** at 6% sparsity (`np.partition` for the cut), then normalised by the max → a sparse KC code.
- `mbon = (W_kc_mbon * gain).T @ kc`, then **lateral MBON-MBON mixing** at 0.2.
- Dopamine: `dan[punish_mask] = punish`, `dan[~mask] = reward`, then `da = W_dan_mbon.T @ dan`.
- **Learning rule:** `gain -= lr * outer(kc, da)` with `lr = 0.35` — the classic dopamine-gated **depression** of exactly the KC→MBON synapses that were active when dopamine arrived. Plus a slow homeostatic `gain += 0.008 * (1 - gain)` and a `clip(0.05, 1.0)` floor.
- Readout: `valence = mbon @ mbon_valence`, plus separate `approach` (positive-valence MBON sum) and `avoid` sums.
- `depression` property = `1 − mean(gain over real synapses)` — the single number the UI shows as "how much has she learned".
- `frozen=True` disables all weight updates — this is the A/B control.

### 3.3 Sensory adapter (`rgb_to_pn`) — honestly labelled as invented
A card image is tiled **8×8**; each tile contributes 5 stats (grey mean, grey std, R/G/B means) → a 320-dim feature vector → projected through a **fixed seeded random mixing matrix** into `n_pn`, clipped at 0 and max-normalised. The docs call it "the same spirit as stonkfly's chart→retina path, not validated photoreceptors."

### 3.4 The dating loop (`FlingeEngine.step`)
1. `current_profile()` = deck cycled by `deck_index`.
2. **First pass, sensory only:** render card → `rgb_to_pn` → `brain.present(pn, learn=False)`.
3. `decode_action(obs, danger_bias)` — a **fixed engineered interface**, explicitly not "discovered dating neurons": `score = approach − avoid + 0.25*valence − danger_bias`, thresholded into `pass` (< −0.15) / `like` (< 0.25) / `comment` (< 0.55) / `rizz`. A **rizz strategy bucket** is chosen by `argmax(kc) % 5`. `guard_action()` enforces state legality (can't rizz before matching, can't like inside a chat).
4. Text: OpenAI if a key is present and the profile isn't a danger card, else a template from `TEMPLATE_RIZZ`.
5. **The NPC responds deterministically** (`girls.py`): a per-profile seeded RNG + `fit_score(profile, bucket, action)` derived from her trait vector and openness → an outcome label (`match`/`engaged`/`warm`/`cold`/`ghost`/`reject`/`danger`) → a meter delta from `OUTCOME_DELTA`.
6. **Dopamine meter** (`dopamine.py`): level clamped 0–100, compared against a moving `anchor` with a **deadband of 1.5**. Above → `reward`; below → `aversive`; inside → no DAN pulse at all. This is the stonkfly "equity curve" analogue and it's what makes reinforcement *sparse* rather than every-step.
7. **Second pass with learning:** re-render the card including the reply text → `brain.present(pn, punish, reward, learn=True)` → the gains move.
8. Session state (dopamine, likes, matches, threads, history, region bars) is persisted to `runs/flinge/session.json`, gains to `gains.npz`.

`region_bars()` maps MB readout numbers onto eight named brain regions (optic lobes, mushroom bodies, central complex, descending neurons, leg neuropils, antennal lobes, wing motor, halteres) for the HUD — and the code comments it as **"illustrative"**, i.e. a visualisation, not a simulation of those regions.

### 3.5 The heartbreak curriculum (`heartbreak.py`)
A second, independent `MushroomBody` instance with its own run dir and its own seven-stage state machine: Ambivalence → Shock and Denial → Anger → Bargaining → Depression → Acceptance → Growth. Healing actions (`rest`/`accept`/`grow`) advance stage progress; rumination/reach-out/bargaining set it back. Same present→dopamine→depress mechanics, different action vocabulary and reward table. Exposed under `/api/heartbreak/*` on the same server.

### 3.6 API surface (`serve.py`)
Module-level singletons `_engine` / `_heartbreak` created at startup.
`GET /api/health`, `GET /api/snapshot`, `GET /api/status`, `POST /api/step` (optional forced action + `use_llm`), `POST /api/train?n=` (capped 1–100), `POST /api/reset` (deletes `session.json`, `gains.npz`, `last.json` only — heartbreak runs survive), and the mirrored `/api/heartbreak/{snapshot,status,step,train,reset}`.

### 3.7 Frontend flow (`App.jsx`)
- `getSnapshot()` on mount and every **5 s** as a poll.
- An **auto-play loop at 2.8 s** calls `/api/step`; an `inFlight` ref prevents overlap.
- `applyStepResult` maps the response to a UI action state (`danger`/`match`/`rizz`/…) that drives the 3D scene, and auto-switches to the Matches tab on a match.
- `BrainCloud.jsx` loads `/brain/positions.f32` (falling back to `context.json`), reorients to the connectome axes (`x, -z, y`), strides down to ≤28k points, normalises, and colours between REST / STIM / FIRE per an `ACTION_FOCUS` table keyed by the current action. This is the **"paint the brain"** effect.
- `FlySimulator.jsx` assembles the STL body parts into a rig holding a phone whose screen texture is generated in `phoneTextures.js`; a `scrollPulse` counter kicks the tarsus animation the instant a request starts, before the response arrives.
- API errors surface as a literal instruction: *"API offline — run `python -m flinge serve` in flinge/"*.

### 3.8 Validation (`validate.py`)
Builds a **throwaway temp directory**, prepares a fresh circuit, then runs the same N steps twice — once `frozen=True`, once learning — and reports matches / likes / danger hits / depression / dopamine for each. The `notes` field states the limit outright: *"Mechanism check only… match-rate lift vs frozen is suggestive, not proof of romantic intelligence."*

---

## 4. Observations — what to take from this project

**Strengths**
1. **Clean separation of concerns.** Brain (numerics) / sensory adapter / action decoder / environment (NPCs) / meter / persistence are each one small file. You can swap the environment without touching the brain — which is exactly what the heartbreak module does, reusing `brain.py`, `dopamine.py`, `render.py` and `region_bars` wholesale.
2. **The dopamine meter with a deadband** is a genuinely good design: it converts a continuous outcome signal into sparse reward/aversive pulses and keeps the learner from being reinforced on every single step.
3. **Two-pass present (sense → act → re-sense with dopamine)** keeps the decision uncontaminated by the outcome, which is the right causal ordering.
4. **Frozen-vs-trained as a built-in CLI command.** The control is a product feature, not a notebook someone ran once.
5. **Honest labelling everywhere** — the manifest, the module docstrings, the README's "Honesty" paragraph, the `validate` notes, and the `region_bars` comment all say which parts are engineered. `actions.py` even says "not a discovery of 'like neurons'".
6. **LLM is strictly optional and never on the critical path.** No key → templates. Danger profiles never call the LLM at all (cost + safety).
7. **Determinism by construction:** fixed circuit seed, per-profile seeded RNGs (`sha256(profile_id:salt)`), seeded PN projection. Runs reproduce.
8. **Good operational ergonomics:** one Makefile for both processes, PID/log files, port overrides, Vite proxy so there's no CORS work in dev.

**Weaknesses / risks**
1. **The connectome is synthetic.** Population *sizes* are MaleCNS-inspired but the connectivity is `rng.uniform` sparse noise. Compared with Flymap (which uses the real graph), this is the weakest scientific claim in the three projects — and to their credit they say so in three separate places.
2. **The sensory adapter is a random projection of tile statistics.** It means "what she sees" has no real structure; a profile card is effectively a colour histogram.
3. **Module-level singleton engines** in `serve.py` — no per-session isolation, so one global fly is shared by every browser that connects. `/api/reset` mutates global state for everyone.
4. `CORSMiddleware(allow_origins=["*"])` plus an OpenAI key in the environment — fine locally, wrong the moment it's exposed.
5. `heartbreak.py` at 443 lines duplicates a fair amount of `train.py`'s loop shape; the two engines share primitives but not the loop skeleton.
6. Re-rendering the PIL card twice per step (before and after the reply) is the throughput bottleneck; at 2.8 s auto-steps nobody notices, but batch `train --steps N` pays for it.
7. Thin test coverage — one `test_core.py` for ~2k lines of Python.
