/**
 * Mushroom body: how an order becomes a smell, and how a fly learns to feel
 * about it.
 *
 * PN -> KC -> MBON with APL global inhibition enforcing sparse coding, and
 * dopamine-gated depression of exactly the KC->MBON synapses that were active
 * when dopamine arrived. That is the real mushroom-body motif and the real
 * learning rule.
 *
 * WHAT IS REAL AND WHAT IS NOT, because it matters:
 *  - The RULE is real: sparse KC code, APL feedback inhibition, dopamine-gated
 *    depression at KC->MBON. This is the same rule used across the reference
 *    projects and it is where Drosophila associative learning actually happens.
 *  - The WIRING is NOT the released synapse graph. The pathway export in
 *    circuit.js contains sensory->motor routes and no mushroom body, so this
 *    circuit is a deterministic sparse stand-in sized after MaleCNS MB
 *    populations. Swap in a neuPrint MB extract and nothing above this line
 *    changes.
 *  - The ORDER->PN encoding is a hash, not olfaction. A biryani order has no
 *    odour; turning its options into a PN pattern is an invented sensory
 *    adapter, exactly like the reference projects' word hashes and image
 *    projections. It is deterministic, so the same order always smells the same.
 */

const COUNTS = { pn: 128, kc: 400, mbon: 48, dan: 96 };
const SEED = 20260921;
const KC_SPARSITY = 0.06;   // fraction of KCs that win
const APL_STRENGTH = 0.3;
const APL_PASSES = 3;
const LEARN_RATE = 0.28;

export const MB_MANIFEST = {
  kind: 'synthetic_mb_stand_in',
  note: 'Deterministic sparse circuit sized after MaleCNS MB populations. '
      + 'NOT the released synapse graph. The learning rule is real; the wiring is a stand-in.',
  counts: COUNTS,
  seed: SEED,
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, so the same order string always lights the same cells. */
export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class MushroomBody {
  constructor(opts = {}) {
    const rng = mulberry32(opts.seed ?? SEED);
    const { pn, kc, mbon } = COUNTS;
    this.counts = COUNTS;
    this.nKc = kc;
    this.nWinners = Math.max(1, Math.round(kc * KC_SPARSITY));

    // PN -> KC: each KC samples a handful of PNs, as real KCs do (~6 claws).
    this.kcInputs = [];
    for (let k = 0; k < kc; k++) {
      const claws = 4 + ((rng() * 4) | 0);
      const row = [];
      let sum = 0;
      for (let c = 0; c < claws; c++) {
        const src = (rng() * pn) | 0;
        const w = 0.5 + rng();
        row.push([src, w]); sum += w;
      }
      for (const e of row) e[1] /= sum;     // normalise per KC
      this.kcInputs.push(row);
    }

    // KC -> MBON, half the MBONs positive-valence, half negative (push-pull).
    this.kcMbon = new Float32Array(kc * mbon);
    this.initial = new Float32Array(kc * mbon);
    for (let k = 0; k < kc; k++) {
      for (let m = 0; m < mbon; m++) {
        if (rng() < 0.08) {
          const w = 0.5 + rng() * 0.5;
          this.kcMbon[k * mbon + m] = w;
          this.initial[k * mbon + m] = w;
        }
      }
    }
    this.mbonValence = new Float32Array(mbon);
    for (let m = 0; m < mbon; m++) this.mbonValence[m] = m % 2 === 0 ? 1 : -1;

    // APL: one global inhibitory neuron, in and out of every KC.
    this.aplIn = new Float32Array(kc);
    this.aplOut = new Float32Array(kc);
    for (let k = 0; k < kc; k++) { this.aplIn[k] = 0.5 + rng(); this.aplOut[k] = 0.5 + rng(); }
    this.aplInMax = Math.max(...this.aplIn);
    this.aplOutSum = this.aplOut.reduce((a, b) => a + b, 0);

    this.history = [];
  }

  /** An order's option list -> a deterministic PN activation pattern. */
  pnFor(orderKey) {
    const rng = mulberry32(hashString(orderKey));
    const pn = new Float32Array(this.counts.pn);
    for (let i = 0; i < pn.length; i++) pn[i] = rng() < 0.22 ? 0.4 + rng() * 0.6 : 0;
    return pn;
  }

  /**
   * PN pattern -> sparse KC code, via three passes of APL settling.
   * Returns a Float32Array of KC activations, mostly zero.
   */
  kcFor(pn) {
    const kc = new Float32Array(this.nKc);
    const drive = new Float32Array(this.nKc);
    let apl = 0;
    for (let pass = 0; pass < APL_PASSES; pass++) {
      for (let k = 0; k < this.nKc; k++) {
        let d = 0;
        for (const [src, w] of this.kcInputs[k]) d += pn[src] * w;
        drive[k] = d - APL_STRENGTH * apl * (this.aplIn[k] / this.aplInMax);
      }
      // top-N winners take all
      const order = Array.from(drive.keys()).sort((a, b) => drive[b] - drive[a]);
      kc.fill(0);
      const top = drive[order[0]] || 1;
      for (let i = 0; i < this.nWinners; i++) {
        const k = order[i];
        if (drive[k] > 0) kc[k] = drive[k] / top;
      }
      apl = 0;
      for (let k = 0; k < this.nKc; k++) apl += kc[k] * this.aplOut[k] / this.aplOutSum;
    }
    return kc;
  }

  /** MBON readout -> a single valence in roughly [-1, 1]. */
  valence(kc) {
    const m = this.counts.mbon;
    let v = 0, ref = 0;
    for (let k = 0; k < this.nKc; k++) {
      if (!kc[k]) continue;
      for (let j = 0; j < m; j++) {
        const w = this.kcMbon[k * m + j];
        if (!w) continue;
        v += kc[k] * w * this.mbonValence[j];
        ref += kc[k] * this.initial[k * m + j];
      }
    }
    return ref > 0 ? Math.tanh((v / ref) * 2.5) : 0;
  }

  /**
   * Dopamine-gated depression. Only synapses from KCs that were ACTIVE for
   * this order move, and they move in the direction the dopamine sign says.
   * Bounded, so repetition saturates instead of running away.
   */
  teach(kc, sign, rate = LEARN_RATE) {
    const m = this.counts.mbon;
    let changed = 0;
    for (let k = 0; k < this.nKc; k++) {
      const act = kc[k];
      if (!act) continue;
      for (let j = 0; j < m; j++) {
        const base = this.initial[k * m + j];
        if (!base) continue;
        // Depress the synapses whose MBON disagrees with the dopamine sign.
        const want = this.mbonValence[j] === Math.sign(sign) ? 1.4 : 0.15;
        const target = base * want;
        const before = this.kcMbon[k * m + j];
        const after = before + rate * act * (target - before);
        this.kcMbon[k * m + j] = Math.min(Math.max(after, base * 0.05), base * 1.5);
        if (Math.abs(after - before) > 1e-6) changed++;
      }
    }
    this.history.push({ sign, changed, at: Date.now() });
    return changed;
  }

  /** How far the whole circuit has moved from naive. The UI's "learned" number. */
  get depression() {
    let sum = 0, n = 0;
    for (let i = 0; i < this.kcMbon.length; i++) {
      if (!this.initial[i]) continue;
      sum += this.kcMbon[i] / this.initial[i]; n++;
    }
    return n ? 1 - sum / n : 0;
  }

  forget() {
    this.kcMbon.set(this.initial);
    this.history.length = 0;
  }
}
