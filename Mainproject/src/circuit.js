/**
 * The connectome the flies actually run.
 *
 * Source: MaleCNS v1.0 traced pathways, FlyEM/HHMI Janelia + Google Research,
 * CC BY 4.0, as exported by nueral-visulazation's build_pathway.py. Each
 * pathway file carries real neurons (body id, cell-type name, measured
 * first-spike time) and real synaptic `connections` with contact counts.
 *
 * Four pathways are merged into one graph keyed by body id, so a neuron that
 * appears on two routes is ONE neuron with both sets of partners, not two.
 *
 * HONEST LIMITS, because they change what the model can claim:
 *  - The pathway export carries no neurotransmitter field, so every neuron is
 *    treated as excitatory (ntSign's default). Real inhibition is therefore
 *    absent. Swapping in a neuPrint extract with `predictedNt` fixes this and
 *    is the single highest-value upgrade to this file.
 *  - These are traced sensory->motor routes, not a whole brain. There is no
 *    mushroom body here, so associative learning lives in mb.js, separately
 *    and separately labelled.
 *  - build_pathway.py selected these neurons by walking back from the readout
 *    keeping partners that both connect strongly AND fired earlier. It is a
 *    measured route, not a complete or unbiased subgraph.
 */

import { Topology, State } from './lif.js';

export const PATHWAYS = ['sugar', 'smell', 'water', 'looming'];

/**
 * Calibrated by sweep (see verify.mjs). With no inhibition in the export the
 * network has a sharp all-or-nothing threshold: at DRIVE 0.25 every route is
 * silent, at 1.0 every route saturates. 0.5 is the usable band, and it puts
 * three of four readouts within a few ms of their MEASURED end-to-end latency:
 *
 *   sugar   26 ms sim vs 27 ms measured,  35 Hz
 *   smell   26 ms sim vs 66 ms measured,  39 Hz
 *   water   25 ms sim vs 19 ms measured,  12 Hz
 *   looming 25 ms sim vs 27 ms measured, 286 Hz  <- see note
 *
 * The looming readout is DNp01, the giant fibre. A real giant fibre does fire
 * hard on a looming stimulus, but 286 Hz is above the biological ceiling and is
 * an artefact of the missing inhibition, not a result. It is left uncapped and
 * labelled rather than quietly clamped.
 */
export const EXC_GAIN = 0.5;
export const DRIVE = 0.5;

/** What each route's readout neuron actually commands, for the narration. */
export const MEANS = {
  'MN9_L': 'the proboscis extends', 'MN9_R': 'the proboscis extends',
  'DNp01(GF)_R': 'the escape jump fires', 'DNp01(GF)_L': 'the escape jump fires',
  'DNb05_R': 'a descending command leaves the brain',
  'DNg67_R': 'a descending command leaves the brain',
};

/**
 * Merge loaded pathway metadata into one graph.
 * @param {Object<string, object>} metas  key -> parsed pathway_<key>.json
 */
export function mergePathways(metas) {
  const byBody = new Map();       // bodyId -> node
  const edgeKey = new Map();      // "from>to" -> edge
  const stimuli = {};             // key -> {label, types, driven: bodyIds}
  const readouts = {};            // name -> bodyId

  for (const [key, meta] of Object.entries(metas)) {
    if (!meta) continue;
    const driven = [];
    for (const c of meta.neurons) {
      let node = byBody.get(c.body);
      if (!node) {
        node = {
          bodyId: c.body,
          type: c.name,
          nt: null,               // not in this export; see header
          firstMs: {},            // per-pathway measured first spike
          driven: false,
          readout: false,
        };
        byBody.set(c.body, node);
      }
      node.firstMs[key] = c.firstMs;
      if (c.driven) { node.driven = true; driven.push(c.body); }
      if (c.readout) { node.readout = true; readouts[c.name] = c.body; }
    }
    // Real synaptic contacts. Duplicates across pathways keep the larger count
    // rather than summing -- the same synapse counted twice is still one synapse.
    for (const e of meta.connections || []) {
      const k = `${e.from}>${e.to}`;
      const prev = edgeKey.get(k);
      if (!prev || e.syn > prev.weight) {
        edgeKey.set(k, { source: e.from, target: e.to, weight: e.syn });
      }
    }
    stimuli[key] = {
      key,
      label: meta.stimulusLabel,
      types: meta.stimulusTypes,
      readout: meta.readout,
      driven,
      lastMs: Math.max(...meta.neurons.map((c) => c.firstMs)),
    };
  }

  const nodes = [...byBody.values()];
  const edges = [...edgeKey.values()];
  return { nodes, edges, stimuli, readouts };
}

/**
 * Build the shared topology plus an index of the things the kitchen drives
 * and reads. One of these per page; every fly gets its own State over it.
 */
export class Connectome {
  constructor(graph, opts = {}) {
    this.graph = graph;
    this.topology = new Topology(graph, opts);
    this.stimuli = graph.stimuli;
    this.readouts = graph.readouts;

    // bodyId -> row index, so pathway files and the engine agree on who is who.
    this.rowOf = this.topology.index;

    // Precompute the driven rows per stimulus and the row of each readout.
    this.drivenRows = {};
    for (const [key, s] of Object.entries(this.stimuli)) {
      this.drivenRows[key] = s.driven
        .map((b) => this.rowOf.get(b))
        .filter((i) => i !== undefined);
    }
    this.readoutRow = {};
    for (const [name, body] of Object.entries(this.readouts)) {
      const i = this.rowOf.get(body);
      if (i !== undefined) this.readoutRow[name] = i;
    }
  }

  newState() { return new State(this.topology); }

  get summary() {
    return {
      neurons: this.topology.n,
      synapses: this.topology.m,
      stimuli: Object.keys(this.stimuli).length,
      readouts: Object.keys(this.readoutRow).length,
    };
  }
}

/** Fetch and build. `base` is the directory holding pathway_*.json. */
export async function loadConnectome(base = 'data', keys = PATHWAYS, opts = {}) {
  opts = { excGain: EXC_GAIN, ...opts };
  const metas = {};
  await Promise.all(keys.map(async (k) => {
    const r = await fetch(`${base}/pathway_${k}.json`);
    if (!r.ok) throw new Error(`pathway_${k}.json: HTTP ${r.status}`);
    metas[k] = await r.json();
  }));
  return new Connectome(mergePathways(metas), opts);
}
