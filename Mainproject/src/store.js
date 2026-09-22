/**
 * Durable state shared by the two pages.
 *
 * WHY THIS EXISTS. The first version passed orders over a BroadcastChannel
 * alone. That is fire-and-forget: it reaches whoever is listening at that
 * instant and is never stored. But the nav links are ordinary <a href>, so the
 * usual thing to do is place an order and then navigate the SAME tab to the
 * kitchen -- at which point the desk page has already unloaded, nobody was
 * listening, and the order is simply gone. The kitchen would open to an empty
 * queue with no error anywhere.
 *
 * So localStorage is the source of truth and the channel is only a live nudge:
 *   - the desk appends an order to `pending` and broadcasts
 *   - the kitchen drains `pending` on load AND whenever it is nudged
 *   - the kitchen writes its ticket state back, so the desk's Queue tab is
 *     populated even when the kitchen is not open at all
 *
 * localStorage can throw (private windows, blocked site data) and can come back
 * empty, so every read and write is guarded and the pages render correctly with
 * none of it.
 */

const VERSION = 1;
const K = {
  pending: `biryani.v${VERSION}.pending`,   // orders the kitchen has not taken yet
  state:   `biryani.v${VERSION}.state`,     // the kitchen's latest published state
  events:  `biryani.v${VERSION}.events`,    // outcomes the desk has not learned from yet
  learned: `biryani.v${VERSION}.learned`,   // what the desk fly has been taught
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }   // private window, quota, blocked site data
}

/** True when storage is actually usable, so the UI can say so if it is not. */
export function storageWorks() {
  try {
    const probe = `${K.pending}.probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch { return false; }
}

// ---- orders waiting to be cooked -------------------------------------------

export function pushOrder(entry) {
  const q = read(K.pending, []);
  q.push({ ...entry, at: Date.now() });
  // A queue nobody drains should not grow without limit.
  write(K.pending, q.slice(-200));
}

/** Take everything waiting and clear it. */
export function drainOrders() {
  const q = read(K.pending, []);
  if (q.length) write(K.pending, []);
  return q;
}

export function pendingCount() { return read(K.pending, []).length; }

// ---- the kitchen's published state -----------------------------------------

export function saveState(state) { write(K.state, state); }
export function loadState() { return read(K.state, null); }

// ---- outcomes the desk still has to learn from ------------------------------

export function pushEvents(events) {
  if (!events || !events.length) return;
  const q = read(K.events, []);
  write(K.events, [...q, ...events].slice(-200));
}

export function drainEvents() {
  const q = read(K.events, []);
  if (q.length) write(K.events, []);
  return q;
}

// ---- what the desk fly has learned ------------------------------------------
//
// The synaptic weights themselves are not stored. The tally of outcomes is,
// and the desk replays it through the same teach() calls on load, so the
// restored circuit is exactly the circuit those outcomes would have produced.
// Storing counts rather than ~19k floats also keeps this well inside quota.

export function saveLearned(rows) { write(K.learned, rows); }
export function loadLearned() { return read(K.learned, []); }

export function clearAll() {
  for (const key of Object.values(K)) {
    try { localStorage.removeItem(key); } catch { /* nothing to do */ }
  }
}
