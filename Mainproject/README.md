# Biryani Center

A fruit-fly biryani restaurant. Flies take orders on a phone, then cook a Dum Biryani across
six kitchen stations — and the work is gated by a real *Drosophila* connectome running live in
the browser.

Two pages, one restaurant:

| Page | What happens |
|---|---|
| `orders.html` | A fly at a phone. You build an order; she smells it as a sparse Kenyon-cell code and has a feeling about it. Placing it dispatches that code to the kitchen. |
| `kitchen.html` | Six flies work the pipeline: marination → parboiled rice → saffron & ghee → layering the handi → dum sealing → packing. Under it, the brain runs live. |

```bash
python3 serve.py        # then open http://localhost:8080/
node verify.mjs         # 29 checks, no test framework
```

No build step, no bundler, no `node_modules`, no backend. Three.js comes from a CDN import map;
everything else is local, so it runs with the wifi off after first load.

---

## What is real, and what is not

**Real.** The connectome is MaleCNS v1.0 (FlyEM/HHMI Janelia + Google Research, CC BY 4.0):
**150 neurons and 2,224 synaptic connections** with measured contact counts, across four traced
sensory→motor routes. Not a random graph, not a stand-in.

| Route | From | To | Measured end-to-end |
|---|---|---|---|
| sugar | LB3b_R + LB3c_R (labellar taste) | **MN9_L** — the proboscis extends | 27 ms |
| smell | ORN_DM1_R (a fruit-odour glomerulus) | DNb05_R | 66 ms |
| water | LB3a_R | DNg67_R | 19 ms |
| looming | LC4_R | DNp01 — the giant fibre, escape | 27 ms |

**The brain is on the control path, not beside it.** A fly does not work a station because a
timer said so. Arriving at the rice boiler drives that fly's real LB3a water cells; about 25 ms
of simulated time later DNg67 fires, and *that firing* is what commits a tick of work. Silence
the sensory cells and the flies still fly to their stations and then stand there. `verify.mjs`
asserts exactly this, and the **Lesion** button in the kitchen does it live.

**Not real, and labelled as such:**

- **No inhibition.** The pathway export carries no neurotransmitter field, so every neuron is
  treated as excitatory. This is the single biggest limitation. It gives the network a sharp
  all-or-nothing threshold — at drive 0.25 every route is silent, at 1.0 every route saturates —
  and it is why the looming readout sits at 286 Hz, above any biological ceiling. That number is
  left uncapped and labelled rather than quietly clamped. A neuPrint extract with `predictedNt`
  fixes it and is the highest-value upgrade to this codebase.
- **The mushroom body is a stand-in.** The learning *rule* is real — sparse KC code, APL global
  inhibition, dopamine-gated depression at KC→MBON, which is where *Drosophila* associative
  learning actually happens. The *wiring* is a deterministic sparse circuit sized after MaleCNS
  MB populations, because the traced pathways contain no mushroom body. It lives in `src/mb.js`,
  separately from the real graph in `src/circuit.js`, so the two are never confused.
- **An order has no smell.** Turning menu options into a PN activation pattern is a hash, not
  olfaction. It is deterministic, so the same order always smells the same, but it is an
  invented sensory adapter.
- **Navigation is steering, not neural.** These are reflex arcs, not a central-complex heading
  system, so there is no ring attractor here to steer with. The brain decides *whether* work
  happens; ordinary steering decides *how* a fly gets there.
- **In the pathway traces, timing is measured and travel is drawn.** Each cell lights at the
  millisecond it actually first fired. The run *along* the branch is interpolation — the model's
  neurons are points with no internal geometry. The panel says so on screen.
- **66 of the 150 neurons have no soma in the point cloud.** A labellar taste cell or an
  olfactory receptor neuron keeps its cell body out in the labellum or antenna, outside the
  brain volume, and sends only its axon in. They appear in the pathway traces and are absent
  from the cloud. That is anatomy, not a loading failure, and the UI says which.

## The two pages

They work whether you keep both open side by side or navigate between them in one tab.

Orders are written to `localStorage` first and only then announced on a `BroadcastChannel`.
The channel is a nudge, not the delivery — so an order placed while the kitchen is closed waits
for it, and the kitchen drains the queue on load. Outcomes come back the same way, which is why
the desk fly still learns from a ticket that finished while her page was shut.

Keeping both open is nicer to watch, because a backgrounded tab has its animation loop throttled
by the browser and genuinely stops simulating. The header says which state it is in rather than
calling both of them "offline".

## It is a flow, not a game

No score, no combos, no win state, no player-controlled fly. The restaurant runs itself; you
watch, inspect and teach. Progress is gated **physically, never by a timeout** — a fly has
arrived when its position *and* speed agree, and rice left unattended on a live flame spoils
because nobody came to take it off, not because a counter expired.

## The controls are shipped, not scripted

Reachable from the running kitchen:

- **Lesion sensory cells** — the flies fly to their stations and stand there. Nothing reaches a
  motor neuron.
- **Scramble wiring** — a degree-preserving shuffle. Every neuron keeps its out-degree and its
  weights; only the partners change. What survives that is not structure.
- **Pathway trace** — watch one route light up cell by cell at its measured latencies.
- **Forget everything** (order desk) — restores the naive circuit exactly.

## Layout

```
orders.html      the order desk
kitchen.html     the kitchen floor and the live brain
verify.mjs       22 checks in plain node, no framework
serve.py         static server

src/lif.js       leaky integrate-and-fire; Topology (shared) + State (per fly)
src/circuit.js   merges the four traced pathways into one real graph
src/mb.js        mushroom body — real rule, stand-in wiring
src/crew.js      the kitchen flies; where the brain gates the work
src/recipe.js    the Dum Biryani pipeline and its physical gating
src/brainview.js the 3D brain: ROI cage, 124,314 somas, pathway traces
src/fly.js       the fly body, at two levels of detail
src/bus.js       BroadcastChannel nudges between the two pages
src/store.js     localStorage: the durable order queue, outcomes and learning
src/ui.css       house palette

data/            MaleCNS v1.0 geometry and traced pathways (CC BY 4.0)
assets/fly/      NeuroMechFly body, Apache-2.0 (see NOTICE)
```

## Two levels of fly

`createFly` builds the full rig: ~70 meshes, every joint independent, so on the order desk she
tips her head at the phone, grooms her forelegs every few seconds and breathes.

`createSimpleFly` bakes the rest pose into one merged geometry and keeps only the wings
separate, so it draws in three calls instead of seventy. The kitchen floor uses it for all ten
flies, because a fly there is about thirty pixels tall and leg articulation is smaller than a
pixel — wingbeat, bank, pitch and bob are the only things that read at that size.

Ten rigged flies came to **664 draw calls and 23 fps**. The same scene with baked flies and
shared materials is **65 draw calls at 60 fps**. Materials are shared across every fly either
way; building a fresh `MeshStandardMaterial` per segment meant ~390 unique materials and a
shader state change on effectively every draw.

## Credits

- Connectome data and traced pathways: **MaleCNS v1.0**, FlyEM/HHMI Janelia + Google Research,
  CC BY 4.0. Packed for the browser by `nueral-visulazation/build_pathway.py`.
- Fly body: **NeuroMechFly / NeLy-EPFL**, Apache-2.0. Source morphology is a female micro-CT,
  used as an illustrative body. Wing and leg motion is illustrative kinematics, not biomechanics.
- Technique carried over from the reference projects in `../References/`: the point-cloud shader
  and pathway trace from `nueral-visulazation`, the LIF engine shape from `Flymap`, the UI
  pattern and palette from `flinge-main`, the APL settling loop and physical phase gating from
  `kitchen`.
