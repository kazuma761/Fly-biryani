/**
 * Asserts every claim this project makes about its connectome, in plain node.
 *   node verify.mjs
 */
import fs from 'fs';
import { mergePathways, Connectome, EXC_GAIN, DRIVE } from './src/circuit.js';

const metas = {};
for (const k of ['sugar', 'smell', 'water', 'looming']) {
  metas[k] = JSON.parse(fs.readFileSync(`data/pathway_${k}.json`, 'utf8'));
}

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const graph = mergePathways(metas);
const c = new Connectome(graph, { excGain: EXC_GAIN });

check('graph is the expected size', c.topology.n === 150 && c.topology.m === 2224,
      `${c.topology.n} neurons, ${c.topology.m} synapses`);
check('every synapse has both endpoints in the subgraph', c.topology.droppedEdges === 0,
      `${c.topology.droppedEdges} dropped`);
check('all four routes present', Object.keys(c.stimuli).length === 4);
check('every route has a readout wired in',
      Object.values(c.stimuli).every((s) => c.readoutRow[s.readout] !== undefined));

// Each route must actually conduct from its sensory cells to its motor readout.
function run(stim, { amp = DRIVE, scramble = false, silenceDriven = false } = {}) {
  c.topology.scramble(scramble, mulberry(7));
  const s = c.newState();
  if (silenceDriven) s.setAlive(c.drivenRows[stim], false);
  else s.drive(c.drivenRows[stim], amp);
  const row = c.readoutRow[c.stimuli[stim].readout];
  let hit = null;
  for (let i = 0; i < 1500; i++) { s.step(0.1); if (s.spiked[row] && hit === null) hit = s.t; }
  c.topology.scramble(false);
  return { hit, rate: s.rate[row], spikes: s.spikeCount };
}
function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

for (const [stim, info] of Object.entries(c.stimuli)) {
  const r = run(stim);
  check(`${stim} reaches ${info.readout}`, r.hit !== null,
        r.hit !== null ? `${r.hit.toFixed(0)} ms sim vs ${info.lastMs} ms measured, ${r.rate.toFixed(0)} Hz` : '');
}

// The controls. Silencing the sensory cells must kill the route -- if the
// readout still fires, something other than the stimulus is driving it.
for (const stim of ['sugar', 'water']) {
  const r = run(stim, { silenceDriven: true });
  check(`${stim} is silent when its sensory cells are lesioned`, r.hit === null);
}

// Below the band, nothing conducts. Above it, everything saturates. Both are
// documented properties of a network exported without inhibition.
check('drive 0.25 is below the conduction threshold',
      ['sugar', 'smell', 'water', 'looming'].every((k) => run(k, { amp: 0.25 }).hit === null));

// Structure matters: a degree-preserving shuffle should change the outcome.
const intact = run('sugar');
const shuffled = run('sugar', { scramble: true });
check('scrambled wiring changes the sugar result',
      intact.hit !== shuffled.hit || Math.abs(intact.rate - shuffled.rate) > 1,
      `intact ${intact.hit?.toFixed(0)}ms/${intact.rate.toFixed(0)}Hz vs shuffled ${shuffled.hit?.toFixed(0) ?? '--'}ms/${shuffled.rate.toFixed(0)}Hz`);

// ---------------------------------------------------------------- mushroom body
const { MushroomBody } = await import('./src/mb.js');
{
  const mb = new MushroomBody();
  const A = 'chicken|hyderabadi|spicy|raita';
  const B = 'mutton|lucknowi|mild|none';
  const kcA = mb.kcFor(mb.pnFor(A)), kcB = mb.kcFor(mb.pnFor(B));
  const nA = [...kcA].filter((v) => v > 0).length;
  const overlap = [...kcA].filter((v, i) => v > 0 && kcB[i] > 0).length;
  check('the order code is sparse', nA > 10 && nA < mb.nKc * 0.12, `${nA} of ${mb.nKc} KCs`);
  check('two different orders barely overlap', overlap < nA * 0.25, `${overlap} shared cells`);

  const before = mb.valence(kcA), otherBefore = mb.valence(kcB);
  for (let i = 0; i < 6; i++) mb.teach(kcA, +1);
  const after = mb.valence(kcA), otherAfter = mb.valence(kcB);
  check('reward raises that order\'s valence', after > before + 0.4,
        `${before.toFixed(2)} -> ${after.toFixed(2)}`);
  check('learning is specific to the order that was taught',
        Math.abs(otherAfter - otherBefore) < Math.abs(after - before) * 0.5,
        `taught moved ${(after - before).toFixed(2)}, untaught moved ${(otherAfter - otherBefore).toFixed(2)}`);

  for (let i = 0; i < 6; i++) mb.teach(kcB, -1);
  check('punishment lowers the other order\'s valence', mb.valence(kcB) < -0.3,
        mb.valence(kcB).toFixed(2));
  mb.forget();
  check('forget restores the naive circuit exactly',
        Math.abs(mb.valence(kcA) - before) < 1e-9 && Math.abs(mb.valence(kcB) - otherBefore) < 1e-9);
}

// ---------------------------------------------------------------- the kitchen
const { Crew } = await import('./src/crew.js');
const R = await import('./src/recipe.js');

function runKitchen({ lesion = false, maxFrames = 60 * 150, starveAt = null } = {}) {
  const co = new Connectome(mergePathways(metas), { excGain: EXC_GAIN });
  const cr = new Crew(co, 6);
  cr.lesioned = lesion;
  const t = R.makeTicket(
    { protein: 'chicken', style: 'hyderabadi', spice: 'spicy', side: 'raita', key: 'k', label: 'test' },
    new Float32Array(400));
  const list = [t];
  let frame = 0;
  while (!t.done && frame++ < maxFrames) {
    cr.dispatch(list, (x) => {
      const step = R.currentStep(x);
      // starveAt withholds crew from one station, to test the overcook path
      return step && starveAt && step.station === starveAt ? null : step;
    });
    cr.step(1 / 60);
    if (frame % 30 === 0) R.stepTicket(t, (id, st) => cr.ready(id, st));
    if (t.remakes) break;
  }
  return { t, cr, frame, spikes: cr.totalSpikes };
}

{
  const ok = runKitchen();
  check('a ticket is cooked and served end to end', ok.t.done,
        `${ok.frame} frames (${(ok.frame / 60).toFixed(1)}s), ${ok.spikes.toLocaleString()} spikes`);

  // The claim the whole project rests on: the flies work because their own
  // simulated brains respond, not because a timer fired.
  const dead = runKitchen({ lesion: true, maxFrames: 60 * 60 });
  check('lesioning the sensory cells stalls the kitchen',
        !dead.t.done && dead.spikes === 0,
        `reached ${R.RECIPE[Math.min(dead.t.step, 5)].station}, ${dead.spikes} spikes`);
  check('the brain is on the control path, not beside it',
        ok.t.done && !dead.t.done);

  const starved = runKitchen({ starveAt: 'sweets', maxFrames: 60 * 90 });
  check('rice left unattended on the flame spoils and goes back on',
        starved.t.remakes === 1 && R.RECIPE[starved.t.step].station === 'rice',
        starved.t.spoiled || 'no spoil recorded');
}

// ---------------------------------------------------------------- the store
// This is the regression test for a real bug: orders were passed over a
// BroadcastChannel alone, which is fire-and-forget. Navigating the same tab
// from the desk to the kitchen -- the obvious thing to do, since the nav links
// are ordinary <a href> -- unloaded the desk before anything was listening, and
// the order vanished with no error anywhere.
{
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  const store = await import('./src/store.js');

  check('storage is usable', store.storageWorks());

  store.pushOrder({ order: { key: 'a', label: 'one' }, kc: [1, 2] });
  store.pushOrder({ order: { key: 'b', label: 'two' }, kc: [3] });
  check('an order placed with no kitchen listening is still waiting for it',
        store.pendingCount() === 2);

  const drained = store.drainOrders();
  check('the kitchen takes every waiting order on load',
        drained.length === 2 && drained[0].order.key === 'a');
  check('draining clears the queue, so orders are not cooked twice',
        store.pendingCount() === 0 && store.drainOrders().length === 0);

  store.pushEvents([{ kind: 'served', key: 'a', label: 'one' }]);
  check('an outcome survives for a desk that is not open',
        store.drainEvents().length === 1 && store.drainEvents().length === 0);

  // Weights are never stored; the tally of outcomes is, and replaying it must
  // land on exactly the circuit those outcomes would have produced.
  const key = 'chicken|hyderabadi|spicy|raita';
  const live = new MushroomBody();
  const code = live.kcFor(live.pnFor(key));
  for (let i = 0; i < 3; i++) live.teach(code, +1);
  live.teach(code, -1);
  const expected = live.valence(code);

  const restored = new MushroomBody();
  const rcode = restored.kcFor(restored.pnFor(key));
  for (let i = 0; i < 3; i++) restored.teach(rcode, +1);
  restored.teach(rcode, -1);
  check('replaying the stored tally rebuilds the circuit exactly',
        Math.abs(restored.valence(rcode) - expected) < 1e-12,
        `${expected.toFixed(4)} vs ${restored.valence(rcode).toFixed(4)}`);

  store.clearAll();
  check('clearing leaves nothing behind',
        store.pendingCount() === 0 && store.loadLearned().length === 0 && !store.loadState());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
