/**
 * The join between the order desk and the kitchen.
 *
 * Both pages are the same restaurant, so a thing that happens on one has to
 * show up on the other. A BroadcastChannel carries it -- same origin, no
 * server, no polling, and it works with the two pages in separate windows.
 *
 * The kitchen is the one that owns ticket state. The desk sends orders and
 * renders whatever the kitchen reports back; it never simulates a second
 * kitchen of its own. One source of truth, like the reference projects'
 * single command path.
 */

const NAME = 'biryani-fly';

export class Bus {
  constructor(role) {
    this.role = role;                       // 'desk' | 'kitchen'
    this.ch = new BroadcastChannel(NAME);
    this.handlers = new Map();
    this.ch.onmessage = (e) => {
      const { type, payload, from } = e.data || {};
      if (from === this.role) return;       // ignore our own echo
      const hs = this.handlers.get(type);
      if (hs) for (const h of hs) h(payload);
    };
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }

  send(type, payload) {
    this.ch.postMessage({ type, payload, from: this.role, at: Date.now() });
  }

  close() { this.ch.close(); }
}

/** Message types, named once so the two pages cannot drift. */
export const MSG = {
  ORDER: 'order',           // desk -> kitchen: {order, kc: number[], key}
  STATE: 'state',           // kitchen -> desk: {tickets, flies, stats}
  HELLO: 'hello',           // either -> either: announce presence
  TEACH: 'teach',           // desk -> kitchen: {key, sign}
  PAUSE: 'pause',           // desk -> kitchen: {paused}
};
