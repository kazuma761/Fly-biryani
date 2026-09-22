# Fly Biryani

A fruit-fly biryani restaurant, run by a real *Drosophila* connectome in your browser.

Flies take orders on a phone, then cook a Dum Biryani across six kitchen stations — and every
tick of work is gated by an actual fly brain, simulated live from Janelia's MaleCNS v1.0
connectome.

```bash
cd Mainproject && python3 serve.py
```

Then open **http://localhost:8080/orders.html**, build an order, and click **Kitchen** to watch
it get cooked.

```bash
cd Mainproject && node verify.mjs      # 29 checks, no test framework
```

No build step, no bundler, no `node_modules`, no backend. Three.js comes from a CDN import map;
everything else is local, so after the first load it runs with the wifi off.

---

## Two pages, one restaurant

| Page | What happens |
|---|---|
| **Order desk** | A fly at a phone. You build an order; she smells it as a sparse Kenyon-cell code and has a feeling about it. Placing it dispatches that code to the kitchen. |
| **Kitchen** | Six flies work the pipeline — marination → parboiled rice → sweets → layering the handi → dum sealing → packing — with the brain running live underneath. |

The order **is** the Kenyon-cell code. A menu choice becomes a sparse pattern of ~24 active
cells out of 400, and that pattern is what gets dispatched, so the kitchen flies smell the order
rather than parse JSON.

## What is real

The connectome is **MaleCNS v1.0** (FlyEM/HHMI Janelia + Google Research, CC BY 4.0):
**150 neurons and 2,224 synaptic connections** with measured contact counts, across four traced
sensory→motor routes.

| Route | From | To | Measured |
|---|---|---|---|
| sugar | LB3b_R + LB3c_R (labellar taste) | **MN9_L** — the proboscis extends | 27 ms |
| smell | ORN_DM1_R (a fruit-odour glomerulus) | DNb05_R | 66 ms |
| water | LB3a_R | DNg67_R | 19 ms |
| looming | LC4_R | DNp01 — the giant fibre, escape | 27 ms |

**The brain is on the control path, not beside it.** A fly does not work a station because a
timer said so. Arriving at the rice boiler drives that fly's real LB3a water cells; about 25 ms
of simulated time later DNg67 fires, and *that firing* is what commits a tick of work.

Silence the sensory cells and the flies still fly to their stations and then stand there. The
intact kitchen serves a ticket in 930 frames; the lesioned one never leaves the first station
and fires zero spikes. Both are assertions in `verify.mjs`, and **Lesion sensory cells** is a
button in the running app.

Calibrated by sweep: sugar reaches MN9 at **26 ms simulated against 27 ms measured**.

## What is not real, and is labelled as such

- **No inhibition.** The pathway export carries no neurotransmitter field, so every neuron is
  treated as excitatory. This is the biggest limitation. It gives the network a sharp
  all-or-nothing threshold — below drive 0.25 nothing conducts, above 1.0 everything saturates —
  and it is why the looming readout sits at 286 Hz, above any biological ceiling. That number is
  left uncapped and labelled rather than quietly clamped.
- **The mushroom body is a stand-in.** The learning *rule* is real — sparse KC code, APL global
  inhibition, dopamine-gated depression at KC→MBON, which is where *Drosophila* associative
  learning actually happens. The *wiring* is a deterministic sparse circuit sized after MaleCNS
  MB populations, because the traced pathways contain no mushroom body.
- **An order has no smell.** Turning menu options into a PN activation pattern is a hash, not
  olfaction. Deterministic, so the same order always smells the same, but invented.
- **Navigation is steering, not neural.** These are reflex arcs, not a central-complex heading
  system, so there is no ring attractor here to steer with. The brain decides *whether* work
  happens; ordinary steering decides *how* a fly gets there.
- **In the pathway traces, timing is measured and travel is drawn.** Each cell lights at the
  millisecond it actually first fired. The run *along* the branch is interpolation — the model's
  neurons are points with no internal geometry. The panel says so on screen.
- **66 of the 150 neurons have no soma in the point cloud.** A labellar taste cell or an
  olfactory receptor neuron keeps its cell body out in the labellum or antenna, outside the
  brain volume, and sends only its axon in. That is anatomy, not a loading failure, and the UI
  says which.

## It is a flow, not a game

No score, no combos, no win state, no player-controlled fly. The restaurant runs itself; you
watch, inspect and teach.

Progress is gated **physically, never by a timeout** — a fly has arrived when its position *and*
speed agree, and rice left unattended on a live flame spoils because nobody came to take it off,
not because a counter expired.

## The controls are shipped, not scripted

- **Lesion sensory cells** — the flies fly to their stations and stand there.
- **Scramble wiring** — a degree-preserving shuffle. Every neuron keeps its out-degree and its
  weights; only the partners change. What survives that is not structure.
- **Pathway trace** — watch one route light up cell by cell at its measured latencies.
- **Forget everything** — restores the naive circuit exactly.

## Layout

```
Mainproject/
  orders.html      the order desk
  kitchen.html     the kitchen floor and the live brain
  verify.mjs       29 checks in plain node
  serve.py         static server

  src/lif.js       leaky integrate-and-fire; Topology (shared) + State (per fly)
  src/circuit.js   merges the four traced pathways into one real graph
  src/mb.js        mushroom body — real rule, stand-in wiring
  src/crew.js      the kitchen flies; where the brain gates the work
  src/recipe.js    the Dum Biryani pipeline and its physical gating
  src/brainview.js the 3D brain: ROI cage, 124,314 somas, pathway traces
  src/fly.js       the fly body, at two levels of detail
  src/store.js     localStorage: durable order queue, outcomes and learning
  src/bus.js       BroadcastChannel nudges between the two pages

  data/            MaleCNS v1.0 geometry and traced pathways (CC BY 4.0)
  assets/fly/      NeuroMechFly body, Apache-2.0 (see NOTICE)

  reference-analysis/   teardowns of the projects this borrows technique from
CLAUDE.md          full build context, decisions and the bugs worth not repeating
```

## Credits

- Connectome data and traced pathways: **MaleCNS v1.0**, FlyEM/HHMI Janelia + Google Research,
  CC BY 4.0.
- Fly body: **NeuroMechFly / NeLy-EPFL**, Apache-2.0. Source morphology is a female micro-CT,
  used as an illustrative body. Wing and leg motion is illustrative kinematics, not biomechanics.
- Technique is borrowed from several open *Drosophila* connectome projects — the point-cloud
  shader and pathway trace, the LIF engine shape, the UI pattern and palette, the APL settling
  loop and physical phase gating. Those codebases are not redistributed here; the teardowns in
  `Mainproject/reference-analysis/` record what was taken from each.
