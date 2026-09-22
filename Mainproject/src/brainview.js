/**
 * The 3D brain.
 *
 * Technique carried over from References/nueral-visulazation/visualization.
 * Data is MaleCNS v1.0, FlyEM/HHMI Janelia + Google Research, CC BY 4.0.
 *
 * Three layers, back to front:
 *   1. 84 neuropil ROI meshes at very low alpha -- the architectural cage
 *   2. 124,314 soma points, one per cell body, lit live from the simulation
 *   3. a traced pathway's real skeletons, with a light running along the branch
 *
 * Two things worth keeping in mind while reading this:
 *
 * GLOW IS ADDITIVE BLENDING, NOT POST-PROCESSING. No EffectComposer, no
 * UnrealBloomPass. At 124k points a bloom pass costs real frame time, and
 * additive blending plus the shader's own radial falloff gets the same look for
 * free. This is the main reason it holds 60 fps.
 *
 * TIMING IS MEASURED, TRAVEL IS DRAWN. Each neuron on a pathway lights at the
 * millisecond it actually first fired (firstMs, measured by the exporter). The
 * run *along* the branch is interpolation, because the model's neurons are
 * points with no internal geometry. The caller is expected to say so on screen.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** Colour per functional group, warm where the food senses live. */
const SOMA_COLOR = {
  sensory: 0xd6e15e, motor: 0xff6b6b, descending: 0xffb347, ascending: 0xff8c6b,
  central: 0x7bd0e8, visual_projection: 0x49c9a0, optic: 0x4a7fb8,
  vnc: 0x9aa7c0, other: 0x6b7a95,
};
const ROI_COLOR = {
  sez: 0xff6b35, mb: 0x8f7cff, al: 0x3fd39b, optic: 0x2f6fb5, other: 0x46587a,
};

/** Light runs along one cell over this fraction of the whole play time. */
const TRAVEL = 0.28;

const PATH_VERT = `
  attribute float dist;
  uniform float uHead;
  varying float vGlow;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    float d = uHead - dist;                 // > 0 where the light has passed
    float band = exp(-d * d * 42.0);        // the bright head
    vGlow = uHead < 0.0 ? 0.0 : max(band, d > 0.0 ? 0.30 : 0.0);
  }`;
const PATH_FRAG = `
  uniform vec3 uColor; uniform vec3 uFire; uniform float uBase;
  varying float vGlow;
  void main() {
    vec3 c = mix(uColor, uFire, clamp(vGlow, 0.0, 1.0));
    gl_FragColor = vec4(c, uBase + vGlow * 0.85);
  }`;

export class BrainView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {string} base directory holding brain.bin / somas.bin / pathway_*
   */
  constructor(canvas, base = 'data') {
    this.canvas = canvas;
    this.base = base;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x05070d);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 100);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.addEventListener('start', () => { this._touched = true; });

    // orient flips the anatomy upright; spinner carries the slow turn; content
    // carries the centring offset and does NOT rotate -- put the offset on the
    // spinner and the brain would orbit its own axis instead of turning in place.
    this.orient = new THREE.Group();
    this.spinner = new THREE.Group();
    this.content = new THREE.Group();
    this.spinner.add(this.content);
    this.orient.add(this.spinner);
    this.scene.add(this.orient);
    this.orient.rotation.x = Math.PI;

    this.spin = true;
    this.pathCache = {};
    this.pathGroup = null;
    this.pathMeta = null;
    this.pathT = 0;
    this.pathSpan = 1;
    this.pathPlaying = false;
    this.onPathStep = null;
    this._lastStepIdx = -1;
  }

  async load() {
    const [brainMeta, brainBuf, somaMeta, somaBuf] = await Promise.all([
      this._json('brain.json'), this._bin('brain.bin'),
      this._json('somas.json'), this._bin('somas.bin'),
    ]);
    this.brainMeta = brainMeta;
    this.somaMeta = somaMeta;

    // Both files quantise against the same box, so one transform puts them in
    // register. Dequantised on the CPU into plain float32 rather than left as a
    // normalised uint16 attribute: it costs a few MB and it means the numbers in
    // the buffer are the numbers the camera is framed against, with no
    // normalisation convention in between to get wrong.
    const q = brainMeta.quantization;
    this.span = new THREE.Vector3(...q.span);
    this.UNIT = 1 / Math.max(this.span.x, this.span.y, this.span.z);

    this._buildROIs(brainMeta, brainBuf);
    this._buildSomas(somaMeta, somaBuf);
    await this._loadSomaIds();
    this._frameCamera();
    return this;
  }

  /**
   * bodyId -> point index, so a simulation can light the right cell.
   *
   * Not every neuron has a point here. A labellar taste cell or an olfactory
   * receptor neuron has its SOMA out in the labellum or the antenna, outside
   * the brain volume this cloud covers -- only its axon comes in. Those cells
   * are visible in the pathway skeletons and absent from the cloud, which is
   * anatomy, not a loading failure. `missingSomas` counts them so the UI can
   * say so instead of quietly showing fewer neurons than it claims.
   */
  async _loadSomaIds() {
    const buf = await this._bin('soma_body_ids.u32');
    const ids = new Uint32Array(buf);
    if (ids.length !== this.nSoma) {
      throw new Error(`soma_body_ids.u32 has ${ids.length} ids but somas.bin has `
        + `${this.nSoma} points. Rebuild them from the same export.`);
    }
    this.pointOf = new Map();
    for (let i = 0; i < ids.length; i++) this.pointOf.set(ids[i], i);
  }

  /**
   * Map a list of body ids to point indices, dropping the ones with no soma here.
   * @returns {{points: number[], missing: number}}
   */
  pointsForBodies(bodyIds) {
    const points = [];
    let missing = 0;
    for (const b of bodyIds) {
      const p = this.pointOf.get(b);
      if (p === undefined) missing++; else points.push(p);
    }
    return { points, missing };
  }

  async _json(f) {
    const r = await fetch(`${this.base}/${f}`);
    if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
    return r.json();
  }
  async _bin(f) {
    const r = await fetch(`${this.base}/${f}`);
    if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
    return r.arrayBuffer();
  }

  /** uint16 0..65535 -> centred model units, each axis on its own span. */
  _dequantize(qa, count) {
    const out = new Float32Array(count * 3);
    const sx = this.span.x * this.UNIT, sy = this.span.y * this.UNIT, sz = this.span.z * this.UNIT;
    for (let i = 0; i < count; i++) {
      out[i * 3]     = (qa[i * 3]     / 65535 - 0.5) * sx;
      out[i * 3 + 1] = (qa[i * 3 + 1] / 65535 - 0.5) * sy;
      out[i * 3 + 2] = (qa[i * 3 + 2] / 65535 - 0.5) * sz;
    }
    return out;
  }

  _buildROIs(meta, buf) {
    this.roiByGroup = {};
    for (const c of meta.compartments) {
      const qa = new Uint16Array(buf, c.vertexOffset, c.vertexCount * 3);
      const idx = c.indexBytes === 2
        ? new Uint16Array(buf, c.indexOffset, c.indexCount)
        : new Uint32Array(buf, c.indexOffset, c.indexCount);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(this._dequantize(qa, c.vertexCount), 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: ROI_COLOR[c.group] ?? ROI_COLOR.other,
        transparent: true, opacity: 0.07,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide, depthWrite: false,
      }));
      mesh.renderOrder = 1;
      this.content.add(mesh);
      (this.roiByGroup[c.group] ??= []).push(mesh);
    }
  }

  _buildSomas(meta, buf) {
    const n = meta.count;
    this.nSoma = n;
    const pos = new THREE.BufferAttribute(
      this._dequantize(new Uint16Array(buf, meta.positionOffset, n * 3), n), 3);
    const codes = new Uint8Array(buf, meta.groupOffset, n);
    this.somaGroupCode = codes;
    this.somaGroups = meta.groups;

    const colors = new Float32Array(n * 3);
    this.shown = new Float32Array(n).fill(1);
    this.active = new Float32Array(n);
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      col.setHex(SOMA_COLOR[meta.groups[codes[i]]] ?? SOMA_COLOR.other);
      colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', pos);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('shown', new THREE.BufferAttribute(this.shown, 1));
    // NOTE: the attribute is called aFire, not `active` -- `active` is a reserved
    // word in GLSL ES 3.00 and the shader will not compile with it.
    geo.setAttribute('aFire', new THREE.BufferAttribute(this.active, 1));
    this.somaGeo = geo;

    // Per-point `shown` and `active` floats: lighting a firing neuron is ONE
    // float write, not a rebuilt buffer. That is what makes 124k live cells cheap.
    this.somaMat = new THREE.ShaderMaterial({
      uniforms: {
        // Point size in device pixels is uSize * uScale / viewDistance, and
        // uScale tracks canvas height x dpr, so this constant fixes the apparent
        // size of a resting soma independent of panel size. Measured at this
        // panel: 0.014 gives a ~2 px resting dot and a ~7 px firing one.
        // It has to be this small. With 124,314 additively blended points,
        // even 7 px each saturates the whole volume to flat white long before
        // any structure is visible -- the value that looks right on a fullscreen
        // canvas is far too large here.
        uSize: { value: 0.014 }, uScale: { value: 1 },
        uFire: { value: new THREE.Color(0xfff0c0) },
      },
      vertexShader: `
        attribute vec3 color; attribute float shown; attribute float aFire;
        uniform float uSize; uniform float uScale; uniform vec3 uFire;
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          vColor = mix(color, uFire, aFire);
          vAlpha = shown * mix(0.5, 1.0, aFire);
          gl_PointSize = uSize * (1.0 + 2.2 * aFire) * uScale / max(-mv.z, 0.001);
          if (shown < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = dot(d, d);
          if (r > 0.25) discard;
          gl_FragColor = vec4(vColor, vAlpha * (1.0 - 4.0 * r));
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.somaMat);
    this.points.renderOrder = 2;
    this.content.add(this.points);
  }

  /**
   * Centre the content and record its half-extents. Framing itself is done by
   * fitCamera(), which needs the viewport aspect and so must re-run on resize.
   */
  _frameCamera() {
    const box = new THREE.Box3().setFromObject(this.content);
    const sph = box.getBoundingSphere(new THREE.Sphere());
    this.content.position.sub(sph.center);
    this.radius = sph.radius;
    box.translate(sph.center.clone().negate());
    this.half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    this.fitCamera();
  }

  /**
   * Fit the brain to the viewport from its measured box, not its bounding
   * sphere. The sphere's radius is set by the brain's WIDTH (the model is about
   * 1.0 x 0.56 x 0.47), so framing by radius in a wide, short panel pushes the
   * camera far enough back that the brain fills a quarter of the height and
   * looks lost. Fitting height and width separately and taking whichever needs
   * more distance puts it in the frame at any panel shape.
   *
   * The scene also spins on Y, so the horizontal extent swaps between x and z
   * as it turns; the larger of the two is used so it never clips mid-rotation.
   */
  fitCamera(margin = 1.1) {
    if (!this.half) return;
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const tan = Math.tan(vFov / 2);
    const horiz = Math.max(this.half.x, this.half.z);
    const dH = this.half.y / tan;
    const dW = horiz / (tan * Math.max(this.camera.aspect, 0.01));
    const dist = Math.max(dH, dW) * margin + horiz;
    this.camera.position.set(0, this.half.y * 0.18, dist);
    this.camera.near = Math.max(dist * 0.002, 0.001);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  /** Show only these soma group names (e.g. ['sensory','motor']). null = all. */
  showGroups(names) {
    const want = names ? new Set(names) : null;
    for (let i = 0; i < this.nSoma; i++) {
      this.shown[i] = !want || want.has(this.somaGroups[this.somaGroupCode[i]]) ? 1 : 0;
    }
    this.somaGeo.getAttribute('shown').needsUpdate = true;
  }

  /**
   * Light somas. `rows` are indices into THIS view's point cloud, so the caller
   * owns the mapping from its own simulation rows to point indices.
   */
  fire(pointIndices, amount = 1) {
    for (const p of pointIndices) {
      if (p >= 0 && p < this.nSoma) this.active[p] = Math.min(1, Math.max(this.active[p], amount));
    }
    this.somaGeo.getAttribute('aFire').needsUpdate = true;
  }

  // ---------------------------------------------------------------- pathway
  async loadPathway(key) {
    if (this.pathCache[key]) return this.pathCache[key];
    const [meta, buf] = await Promise.all([
      this._json(`pathway_${key}.json`), this._bin(`pathway_${key}.bin`),
    ]);
    const group = new THREE.Group();
    for (const c of meta.neurons) {
      const qa = new Uint16Array(buf, c.vertexOffset, c.vertexCount * 3);
      const dq = new Uint16Array(buf, c.distOffset, c.vertexCount);
      const e = new Uint32Array(buf, c.edgeOffset, c.edgeCount * 2);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(this._dequantize(qa, c.vertexCount), 3));
      g.setAttribute('dist', new THREE.BufferAttribute(Float32Array.from(dq, (v) => v / 65535), 1));
      g.setIndex(new THREE.BufferAttribute(e, 1));
      const colour = c.driven ? 0xff7a2f : c.readout ? 0x4ade80 : 0x6f7fd8;
      const line = new THREE.LineSegments(g, new THREE.ShaderMaterial({
        uniforms: {
          uHead: { value: -1 },
          uColor: { value: new THREE.Color(colour) },
          uFire: { value: new THREE.Color(0xfff4d0) },
          uBase: { value: c.readout ? 0.30 : 0.16 },
        },
        vertexShader: PATH_VERT, fragmentShader: PATH_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      line.userData = c;
      line.renderOrder = 3;
      group.add(line);
    }
    group.visible = false;
    this.content.add(group);

    // One narration step per millisecond at which something new fires.
    const byMs = new Map();
    for (const c of meta.neurons) {
      if (!byMs.has(c.firstMs)) byMs.set(c.firstMs, []);
      byMs.get(c.firstMs).push(c);
    }
    const steps = [...byMs.entries()].sort((a, b) => a[0] - b[0]).map(([ms, cells]) => {
      const driven = cells.filter((c) => c.driven).length;
      const readout = cells.find((c) => c.readout);
      if (readout) return { ms, cells, text: `${readout.name} fires`, kind: 'readout' };
      if (driven === cells.length) {
        return { ms, cells, kind: 'sensory',
          text: `${driven} ${meta.stimulusLabel.toLowerCase()} neuron${driven > 1 ? 's' : ''} firing` };
      }
      const relays = cells.filter((c) => !c.driven);
      return { ms, cells: relays, kind: 'relay', text: relays.map((c) => c.name).join(', ') };
    });

    const last = Math.max(...meta.neurons.map((c) => c.firstMs));
    this.pathCache[key] = { meta, group, steps, span: last * (1 + TRAVEL), last };
    return this.pathCache[key];
  }

  async playPathway(key) {
    const p = await this.loadPathway(key);
    for (const k in this.pathCache) this.pathCache[k].group.visible = false;
    this.pathGroup = p.group;
    this.pathMeta = p.meta;
    this.pathSteps = p.steps;
    this.pathSpan = p.span;
    this.pathLast = p.last;
    p.group.visible = true;
    this.pathT = 0;
    this._lastStepIdx = -1;
    this.pathPlaying = true;
    return p;
  }

  hidePathway() {
    if (this.pathGroup) this.pathGroup.visible = false;
    this.pathPlaying = false;
    this.pathGroup = null;
  }

  _tickPathway(dt, speed) {
    if (!this.pathGroup || !this.pathPlaying) return;
    this.pathT += dt * 1000 * speed;
    const head = this.pathT;
    for (const line of this.pathGroup.children) {
      const c = line.userData;
      const local = (head - c.firstMs) / (this.pathLast * TRAVEL);
      line.material.uniforms.uHead.value = local < 0 ? -1 : Math.min(local, 1.4);
    }
    // Report each narration step once, as it is reached.
    let idx = -1;
    for (let i = 0; i < this.pathSteps.length; i++) if (this.pathSteps[i].ms <= head) idx = i;
    if (idx !== this._lastStepIdx) {
      this._lastStepIdx = idx;
      if (idx >= 0 && this.onPathStep) this.onPathStep(this.pathSteps[idx], head);
    }
    if (head > this.pathSpan) { this.pathT = 0; this._lastStepIdx = -1; }
  }

  resize() {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.somaMat.uniforms.uScale.value = h * Math.min(devicePixelRatio, 2) * 0.55;
    // Re-fit for the new aspect, but not once someone has orbited -- re-framing
    // under their hands every resize would fight them.
    if (!this._touched) this.fitCamera();
  }

  /** Call once per frame. dt in seconds. */
  render(dt, { decay = 2.4, pathSpeed = 1 } = {}) {
    if (this.spin) this.spinner.rotation.y += dt * 0.22;
    // Spikes fade rather than latch, so the cloud shows recent activity.
    if (decay > 0) {
      const k = Math.exp(-dt * decay);
      let any = false;
      for (let i = 0; i < this.nSoma; i++) {
        if (this.active[i] > 0.002) { this.active[i] *= k; any = true; }
        else if (this.active[i]) this.active[i] = 0;
      }
      if (any) this.somaGeo.getAttribute('aFire').needsUpdate = true;
    }
    this._tickPathway(dt, pathSpeed);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
