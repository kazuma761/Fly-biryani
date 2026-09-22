/**
 * Leaky integrate-and-fire over a real connectome subgraph.
 *
 * Constants are the community-standard Drosophila values (Shiu et al.):
 * a neuron is a leaky bucket of voltage, one synapse moves it 0.275 mV, and
 * crossing threshold dumps charge into every downstream partner.
 *
 * Split into Topology (the wiring, built once and SHARED by every fly) and
 * State (voltages, one per fly). A kitchen with eight flies therefore holds
 * one copy of the graph and eight small state arrays, not eight graphs.
 */

export const V_REST = -52.0;   // mV
export const V_THRESH = -45.0; // mV
export const V_RESET = -55.0;  // mV
export const TAU_M = 20.0;     // ms, membrane time constant
export const T_REFRAC = 2.2;   // ms
export const W_SYN = 0.275;    // mV per synapse
export const TAU_SYN = 5.0;    // ms, synaptic current decay
export const TAU_ADAPT = 80.0; // ms, adaptation decay
export const B_ADAPT = 0.55;   // mV/ms per spike

// Drosophila: acetylcholine excites, glutamate and GABA inhibit.
// Modulators are treated as weak excitation.
const NT_SIGN = {
  acetylcholine: 1, glutamate: -1, gaba: -1,
  octopamine: 0.3, dopamine: 0.3, serotonin: 0.3, unknown: 1,
};

export function ntSign(nt) {
  if (!nt) return 1;
  return NT_SIGN[String(nt).toLowerCase()] ?? 1;
}

/**
 * The wiring. Built once, shared by every fly that runs this circuit.
 *
 * @param {{nodes: Array<{bodyId:number,type?:string,nt?:string}>,
 *          edges: Array<{source:number,target:number,weight:number}>}} graph
 */
export class Topology {
  constructor(graph, opts = {}) {
    const nodes = graph.nodes;
    const n = nodes.length;
    this.n = n;
    this.nodes = nodes;
    this.excGain = opts.excGain ?? 1.0;
    this.inhGain = opts.inhGain ?? 1.0;
    this.bAdapt = opts.bAdapt ?? B_ADAPT;

    this.index = new Map();
    this.sign = new Float32Array(n);
    this.type = new Array(n);
    for (let i = 0; i < n; i++) {
      this.index.set(nodes[i].bodyId, i);
      this.sign[i] = ntSign(nodes[i].nt);
      this.type[i] = nodes[i].type;
    }

    // CSR over outgoing edges. Edges with an endpoint outside the subgraph
    // are dropped rather than silently remapped.
    const deg = new Int32Array(n);
    const valid = [];
    let dropped = 0;
    for (const e of graph.edges) {
      const s = this.index.get(e.source);
      const t = this.index.get(e.target);
      if (s === undefined || t === undefined) { dropped++; continue; }
      deg[s]++;
      valid.push([s, t, e.weight]);
    }
    this.droppedEdges = dropped;

    this.outPtr = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) this.outPtr[i + 1] = this.outPtr[i] + deg[i];
    const m = valid.length;
    this.m = m;
    this.outIdx = new Int32Array(m);
    this.outW = new Float32Array(m);
    const cursor = this.outPtr.slice(0, n);
    for (const [s, t, w] of valid) {
      const p = cursor[s]++;
      this.outIdx[p] = t;
      this.outW[p] = w;
    }
    this._origIdx = this.outIdx.slice();

    // Per-neuron input normalisation. Raw summed synapse counts saturate every
    // cell in a densely connected subgraph; dividing each neuron's incoming
    // weights by its own total input leaves the RELATIVE pattern of who
    // connects to whom untouched. Documented modelling choice, not a fudge.
    if (opts.normalize !== false) {
      const inSum = new Float32Array(n);
      for (let i = 0; i < n; i++)
        for (let p = this.outPtr[i]; p < this.outPtr[i + 1]; p++)
          inSum[this.outIdx[p]] += this.outW[p];
      for (let i = 0; i < n; i++)
        for (let p = this.outPtr[i]; p < this.outPtr[i + 1]; p++) {
          const t = this.outIdx[p];
          if (inSum[t] > 0) this.outW[p] = (this.outW[p] / inSum[t]) * 100;
        }
    }
  }

  /**
   * Degree-preserving edge shuffle: every neuron keeps its out-degree and its
   * weights, but they land on random partners. The control that shows the
   * STRUCTURE is doing the work. Affects every fly sharing this topology.
   */
  scramble(on, rng = Math.random) {
    if (!on) { this.outIdx.set(this._origIdx); return; }
    for (let p = 0; p < this.m; p++) this.outIdx[p] = (rng() * this.n) | 0;
  }

  indicesOfType(pred) {
    const out = [];
    for (let i = 0; i < this.n; i++) if (pred(this.type[i], this.nodes[i])) out.push(i);
    return out;
  }

  /** Indices whose cell-type name matches, e.g. byName('MN9_L'). */
  byName(name) {
    return this.indicesOfType((t) => t === name);
  }
}

/** One fly's dynamic state over a shared Topology. */
export class State {
  constructor(topology) {
    const n = topology.n;
    this.topo = topology;
    this.n = n;
    this.V = new Float32Array(n).fill(V_REST);
    this.refrac = new Float32Array(n);
    this.spiked = new Uint8Array(n);
    this.rate = new Float32Array(n);   // low-passed, for display
    this.ext = new Float32Array(n);    // external drive, mV/ms
    this.syn = new Float32Array(n);    // synaptic current
    this.adapt = new Float32Array(n);
    this.alive = new Uint8Array(n).fill(1);
    this.t = 0;
    this.spikeCount = 0;
  }

  /** Silence neurons by index. The lesion control. */
  setAlive(indices, alive) {
    for (const i of indices) this.alive[i] = alive ? 1 : 0;
  }

  reset() {
    this.V.fill(V_REST);
    this.refrac.fill(0); this.spiked.fill(0); this.rate.fill(0);
    this.ext.fill(0); this.syn.fill(0); this.adapt.fill(0);
    this.t = 0; this.spikeCount = 0;
  }

  /** Drive a set of neurons at `amp` mV/ms. Pass 0 to stop. */
  drive(indices, amp) {
    for (const i of indices) this.ext[i] = amp;
  }

  /** Mean low-passed rate (Hz) over a set of neurons. */
  meanRate(indices) {
    if (!indices.length) return 0;
    let s = 0;
    for (const i of indices) s += this.rate[i];
    return s / indices.length;
  }

  /** One integration step. dt in ms. */
  step(dt) {
    const { V, refrac, spiked, ext, syn, adapt, alive, rate } = this;
    const topo = this.topo;
    const { sign, outPtr, outIdx, outW } = topo;
    const decay = dt / TAU_M;
    const synDecay = Math.exp(-dt / TAU_SYN);
    const adaptDecay = Math.exp(-dt / TAU_ADAPT);
    const n = this.n;

    for (let i = 0; i < n; i++) {
      spiked[i] = 0;
      if (!alive[i]) { V[i] = V_REST; syn[i] = 0; adapt[i] = 0; continue; }
      if (refrac[i] > 0) { refrac[i] -= dt; V[i] = V_RESET; continue; }
      V[i] += (V_REST - V[i]) * decay + (syn[i] + ext[i] - adapt[i]) * dt;
      if (V[i] > V_THRESH) {
        V[i] = V_RESET;
        refrac[i] = T_REFRAC;
        spiked[i] = 1;
        adapt[i] += topo.bAdapt;
        this.spikeCount++;
      }
    }

    for (let i = 0; i < n; i++) { syn[i] *= synDecay; adapt[i] *= adaptDecay; }

    for (let i = 0; i < n; i++) {
      if (!spiked[i]) continue;
      const s = sign[i];
      const amp = s * W_SYN * (s >= 0 ? topo.excGain : topo.inhGain);
      const end = outPtr[i + 1];
      for (let p = outPtr[i]; p < end; p++) syn[outIdx[p]] += outW[p] * amp;
    }

    const ra = dt / 50.0;   // ~50 ms low-pass for display
    for (let i = 0; i < n; i++) {
      rate[i] += ((spiked[i] ? 1000 / dt : 0) - rate[i]) * ra;
    }
    this.t += dt;
  }
}
