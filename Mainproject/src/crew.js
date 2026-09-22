/**
 * The kitchen flies.
 *
 * Each fly owns a State over the SHARED connectome topology, so eight flies
 * cost one copy of the graph and eight sets of voltages.
 *
 * HOW THE BRAIN IS ON THE CONTROL PATH, not beside it:
 *
 * A fly does not work a station because a timer said so. It works because its
 * own simulated brain responded to that station. Arriving at the rice boiler
 * drives that fly's real LB3a water cells; ~25 ms of simulated time later
 * DNg67 fires, and THAT firing is what commits a tick of work. If the readout
 * stays quiet, no work happens. Lesion the sensory cells for a station and its
 * flies stand there doing nothing -- which is the control, and it is reachable
 * from the running page.
 *
 * Navigation is steering, not neural. Said plainly rather than implied: the
 * pathways in this export are sensory->motor reflex arcs, not a central-complex
 * heading system, so there is no ring attractor here to steer with. The brain
 * decides WHETHER work happens; simple steering decides HOW the fly gets there.
 */

import { STATION } from './recipe.js';
import { DRIVE } from './circuit.js';

const ARRIVE_DIST = 0.55;   // metres
const ARRIVE_SPEED = 0.9;   // m/s -- must be slow, not just close
const MAX_SPEED = 3.4;
const ACCEL = 7.0;

/** Simulated ms of brain time per rendered frame, per fly. */
const NEURAL_MS_PER_FRAME = 4;

export class Fly {
  constructor(id, connectome, home) {
    this.id = id;
    this.co = connectome;
    this.brain = connectome.newState();
    this.pos = { x: home[0], z: home[1] };
    this.vel = { x: 0, z: 0 };
    this.home = { x: home[0], z: home[1] };
    this.target = null;        // station id
    this.ticket = null;        // ticket id
    this.heading = 0;
    this.airborne = 0;
    this.wander = { x: home[0], z: home[1] };
    this.wanderAt = 0;
    this.arc = (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.7);
    this.stim = null;          // which stimulus its station drives
    this.readoutHz = 0;
    this.spiked = [];          // rows that fired this frame, for the brain view
    this.worked = 0;           // ticks this fly has committed
  }

  get station() { return this.target ? STATION[this.target] : null; }

  /** Physically in place: close enough AND slow enough. No timeout involved. */
  get arrived() {
    const s = this.station;
    if (!s) return false;
    const dx = s.pos[0] - this.pos.x, dz = s.pos[1] - this.pos.z;
    const d = Math.hypot(dx, dz);
    const v = Math.hypot(this.vel.x, this.vel.z);
    return d < ARRIVE_DIST && v < ARRIVE_SPEED;
  }

  /** True when this fly's own readout neuron is firing hard enough to work. */
  get willing() { return this.readoutHz > 4; }

  assign(stationId, ticketId) {
    // A fresh arc each assignment, so two flies sent to the same station take
    // visibly different routes instead of overlapping.
    if (stationId !== this.target) this.arc = (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.7);
    this.target = stationId;
    this.ticket = ticketId;
    const st = stationId ? STATION[stationId] : null;
    this.stim = st ? st.stim : null;
  }

  release() {
    this.target = null; this.ticket = null; this.stim = null;
    this.brain.drive(this.co.drivenRows[this.stim] || [], 0);
  }

  /** Pick somewhere new to drift to. Idle flies should not stand still. */
  _repick(now) {
    const a = Math.random() * Math.PI * 2;
    const r = 2.2 + Math.random() * 3.4;
    this.wander = { x: Math.cos(a) * r, z: Math.sin(a) * r };
    this.wanderAt = now + 3.5 + Math.random() * 4.5;
  }

  /** Steering + brain. dt in seconds. */
  step(dt, lesioned, now = 0) {
    // ---- body: head for the station, or patrol while there is nothing to do
    let goal;
    if (this.station) {
      goal = { x: this.station.pos[0], z: this.station.pos[1] };
    } else {
      if (now > this.wanderAt) this._repick(now);
      goal = this.wander;
    }
    const dx = goal.x - this.pos.x, dz = goal.z - this.pos.z;
    const d = Math.hypot(dx, dz) || 1e-6;
    const cruise = this.station ? MAX_SPEED : MAX_SPEED * 0.38;
    const want = Math.min(cruise, d * 2.6);
    let tx = (dx / d) * want, tz = (dz / d) * want;

    // Curve the approach instead of beelining: a sideways component that fades
    // out over the last couple of units, so she still arrives cleanly.
    const swing = this.arc * Math.min(1, Math.max(0, (d - 1.0) / 3.0));
    tx += (-dz / d) * want * swing * 0.55;
    tz += ( dx / d) * want * swing * 0.55;
    this.vel.x += (tx - this.vel.x) * Math.min(1, ACCEL * dt);
    this.vel.z += (tz - this.vel.z) * Math.min(1, ACCEL * dt);
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.airborne += (Math.min(1, speed / 1.4) - this.airborne) * Math.min(1, dt * 6);
    if (speed > 0.06) this.heading = Math.atan2(this.vel.x, this.vel.z);

    // ---- brain: the station's stimulus drives this fly's real sensory cells,
    // but only once it is actually standing there.
    const rows = this.stim ? this.co.drivenRows[this.stim] : null;
    if (rows) {
      const on = this.arrived && !lesioned;
      this.brain.drive(rows, on ? DRIVE : 0);
    }

    this.spiked.length = 0;
    const steps = Math.max(1, Math.round(NEURAL_MS_PER_FRAME / 0.1));
    for (let i = 0; i < steps; i++) {
      this.brain.step(0.1);
      for (let r = 0; r < this.brain.n; r++) if (this.brain.spiked[r]) this.spiked.push(r);
    }

    const st = this.station;
    if (st) {
      const name = this.co.stimuli[st.stim].readout;
      const row = this.co.readoutRow[name];
      this.readoutHz = row !== undefined ? this.brain.rate[row] : 0;
      this.readoutName = name;
    } else {
      this.readoutHz = 0;
      this.readoutName = null;
    }
  }
}

export class Crew {
  constructor(connectome, size = 6) {
    this.co = connectome;
    this.lesioned = false;
    const ring = 5.6;
    this.flies = Array.from({ length: size }, (_, i) => {
      const a = (i / size) * Math.PI * 2 + 0.4;
      return new Fly(`F${i + 1}`, connectome, [Math.cos(a) * ring, Math.sin(a) * ring - 1.2]);
    });
  }

  get idle() { return this.flies.filter((f) => !f.ticket); }
  byId(id) { return this.flies.find((f) => f.id === id); }

  /**
   * Hand idle flies to the tickets that need crew, nearest first.
   * A ticket whose step needs two flies gets two before any third ticket is fed.
   */
  dispatch(tickets, recipeFor) {
    // release flies whose ticket moved on or finished
    for (const f of this.flies) {
      if (!f.ticket) continue;
      const t = tickets.find((x) => x.id === f.ticket);
      if (!t || t.done || !t.crew.includes(f.id)) f.release();
    }
    for (const t of tickets) {
      if (t.done) continue;
      const step = recipeFor(t);
      if (!step) continue;
      const need = step.crew - t.crew.length;
      if (need <= 0) continue;
      const st = STATION[step.station];
      const free = this.idle.sort((a, b) =>
        Math.hypot(a.pos.x - st.pos[0], a.pos.z - st.pos[1])
        - Math.hypot(b.pos.x - st.pos[0], b.pos.z - st.pos[1]));
      for (let i = 0; i < need && i < free.length; i++) {
        const f = free[i];
        f.assign(step.station, t.id);
        t.crew.push(f.id);
      }
    }
  }

  step(dt, now = 0) {
    for (const f of this.flies) f.step(dt, this.lesioned, now);
  }

  /**
   * Is this fly in place AND is its brain firing? The pipeline calls this, so
   * a quiet readout stalls the work even when the body has arrived.
   */
  ready(flyId, stationId) {
    const f = this.byId(flyId);
    return !!f && f.target === stationId && f.arrived && f.willing;
  }

  get totalSpikes() {
    return this.flies.reduce((a, f) => a + f.brain.spikeCount, 0);
  }
}
