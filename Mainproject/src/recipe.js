/**
 * The Dum Biryani pipeline, and the kitchen's state.
 *
 * This is a FLOW, not a game. There is no score, no combo, no timer pressure
 * and no win state. Tickets arrive, flies work them, biryani gets made.
 *
 * Progress is gated PHYSICALLY, never by a timeout: a step advances when a fly
 * is actually at the station (position and speed both agree), and a step that
 * loses its fly goes back to waiting rather than completing itself.
 */

/**
 * Six stations on a hexagon of radius 4, centred on the origin, running
 * clockwise in recipe order so the pipeline reads as a loop.
 *
 * Centred matters: the first layout had its centroid at (-0.97, 0.97) and was
 * 10.6 units wide, so a camera aimed at the origin cropped Marination off the
 * left edge. A symmetric ring frames itself.
 */
export const STATIONS = [
  { id: 'marination', label: 'Marination',    pos: [-3.46,  2.00], stim: 'smell', colour: 0xc76b52 },
  { id: 'rice',       label: 'Rice Boiler',   pos: [ 0.00,  4.00], stim: 'water', colour: 0x6fa892 },
  { id: 'sweets',     label: 'Sweets & Dessert',pos: [ 3.46,  2.00], stim: 'smell', colour: 0xd4a35a },
  { id: 'handi',      label: 'Layering Handi',pos: [ 3.46, -2.00], stim: 'sugar', colour: 0xe0913f },
  { id: 'dum',        label: 'Dum Sealing',   pos: [ 0.00, -4.00], stim: 'sugar', colour: 0xb5643a },
  { id: 'packing',    label: 'Packing & QC',  pos: [-3.46, -2.00], stim: 'sugar', colour: 0x8fa9c0 },
];

export const STATION = Object.fromEntries(STATIONS.map((s) => [s.id, s]));

/**
 * Ordered steps. `ticks` is simulation ticks of work once a fly is in place.
 * `crew` is how many flies the step needs at once -- the handi is heavy.
 */
export const RECIPE = [
  { station: 'marination', ticks: 3, crew: 1, verb: 'marinating',   note: 'meat, yoghurt and spices resting' },
  // Rice reaches 70% and then sits on a live flame. If the next step has no
  // crew free to come and take it, it keeps cooking and breaks. That is why
  // holdsHeat belongs to THIS step but spoils during the NEXT one's wait.
  { station: 'rice',       ticks: 4, crew: 1, verb: 'parboiling',   note: 'basmati to 70%, whole spices in the water',
    holdsHeat: true, spoilAfter: 6, spoilNote: 'rice sat past 70% on the flame and broke' },
  { station: 'sweets',     ticks: 2, crew: 1, verb: 'plating',      note: 'double ka meetha to the side, birista and mint on top' },
  { station: 'handi',      ticks: 4, crew: 2, verb: 'layering',     note: 'marinade down, rice over, aromatics last',
    ordered: ['marination', 'rice', 'sweets'] },
  { station: 'dum',        ticks: 5, crew: 2, verb: 'on dum',       note: 'dough-sealed lid, low flame' },
  { station: 'packing',    ticks: 2, crew: 1, verb: 'packing',      note: 'handi to the counter, raita cup, ticket tagged' },
];

export const STAGES = RECIPE.map((r) => r.station);

let nextId = 1;

/** A ticket is one order moving through the pipeline. */
export function makeTicket(order, kc) {
  return {
    id: `T${String(nextId++).padStart(3, '0')}`,
    order,                  // {protein, style, spice, side, key, label}
    kc,                     // the Kenyon-cell code -- this IS the ticket
    step: 0,                // index into RECIPE
    worked: 0,              // ticks of work done at the current step
    idle: 0,                // ticks spent waiting for crew at the current step
    crew: [],               // fly ids currently on it
    spoiled: null,          // set to a reason string if a step went wrong
    done: false,
    placedAt: Date.now(),
    log: [],
  };
}

export function currentStep(ticket) {
  return ticket.done ? null : RECIPE[ticket.step];
}

export function stageLabel(ticket) {
  if (ticket.done) return 'served';
  if (ticket.spoiled) return 'remade';
  const r = RECIPE[ticket.step];
  return r ? r.verb : 'waiting';
}

/**
 * Advance one ticket by one tick.
 *
 * `atStation(flyId, stationId)` must report whether that fly is PHYSICALLY in
 * place -- close enough and slow enough. Nothing here advances on a timer.
 *
 * Returns an event string when something notable happened, else null.
 */
export function stepTicket(ticket, atStation) {
  if (ticket.done) return null;
  const r = RECIPE[ticket.step];
  const present = ticket.crew.filter((id) => atStation(id, r.station));

  if (present.length < r.crew) {
    ticket.idle++;
    // Waiting is normal and is not a failure -- unless the step just behind
    // this one left something on the heat, in which case the wait is what
    // spoils it. This is the only way a ticket can go wrong.
    const prev = ticket.step > 0 ? RECIPE[ticket.step - 1] : null;
    if (prev && prev.holdsHeat && ticket.idle > prev.spoilAfter) {
      ticket.spoiled = prev.spoilNote;
      ticket.log.push({ step: prev.station, event: 'spoiled', note: prev.spoilNote });
      ticket.step = RECIPE.indexOf(prev);   // that pot goes back on
      ticket.worked = 0;
      ticket.idle = 0;
      ticket.crew = [];
      ticket.remakes = (ticket.remakes || 0) + 1;
      return 'spoiled';
    }
    return null;
  }

  ticket.worked++;

  if (ticket.worked >= r.ticks) {
    ticket.log.push({ step: r.station, event: 'done', note: r.note });
    ticket.step++;
    ticket.worked = 0;
    ticket.idle = 0;
    ticket.crew = [];
    if (ticket.step >= RECIPE.length) {
      ticket.done = true;
      ticket.servedAt = Date.now();
      return 'served';
    }
    return 'advanced';
  }
  return null;
}

/** The order options a customer can pick. */
export const MENU = {
  protein: ['chicken', 'mutton', 'egg', 'veg'],
  style:   ['hyderabadi', 'lucknowi', 'kolkata'],
  spice:   ['mild', 'medium', 'spicy'],
  side:    ['raita', 'salan', 'none'],
};

export function orderKey(o) {
  return `${o.protein}|${o.style}|${o.spice}|${o.side}`;
}

export function orderLabel(o) {
  const side = o.side === 'none' ? 'no side' : o.side;
  return `${o.style} ${o.protein} biryani, ${o.spice}, ${side}`;
}
