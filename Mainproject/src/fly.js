/**
 * The fly's body.
 *
 * Anatomical assets: NeuroMechFly / NeLy-EPFL, Apache-2.0 (see assets/fly/NOTICE).
 * Source morphology is a female micro-CT, used as an illustrative body. The
 * wing and leg motion here is illustrative kinematics -- not physics, and not a
 * biomechanical result.
 *
 * Loader shape follows flinge-main/flinge-ui/src/lib/flyModel.js: model.json
 * carries the rig (segments, joints, rest poses, dofs) and each segment gets one
 * STL. Right-side segments reuse the left mesh with scale.y = -1.
 */

import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

const cache = new Map();
const rad = Math.PI / 180;
const turn = new THREE.Quaternion();

/**
 * Materials are shared across every fly.
 *
 * Each fly is 39 separate meshes, one per rig segment. Building a fresh
 * MeshStandardMaterial for each of them meant ten flies on the kitchen floor
 * carried ~390 unique materials, and the renderer had to change shader state
 * for effectively every draw. Measured: that alone was most of the frame.
 *
 * The segments only ever come in a few flavours, so they are cached by flavour.
 * Geometry is already shared through `cache`; this does the same for materials.
 */
const materials = new Map();

function segmentMaterial(name, tint) {
  const wing = name.endsWith('_wing');
  const eye = name.includes('eye');
  const key = wing ? 'wing' : eye ? 'eye'
            : tint ? `tint:${tint}`
            : name.includes('abdomen6') ? 'abdomen6' : 'body';
  let mat = materials.get(key);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({
      color: wing ? new THREE.Color('#c5d4c8')
           : eye ? new THREE.Color('#c43c2e')
           : tint ? new THREE.Color(tint)
           : key === 'abdomen6' ? new THREE.Color('#3a3228')
           : new THREE.Color('#8a7358'),
      roughness: wing ? 0.35 : 0.55,
      metalness: wing ? 0.08 : 0,
      transparent: wing, opacity: wing ? 0.4 : 1,
      depthWrite: !wing,
      side: wing ? THREE.DoubleSide : THREE.FrontSide,
    });
    materials.set(key, mat);
  }
  return mat;
}

async function loadAssets(base) {
  if (!cache.has(base)) {
    cache.set(base, (async () => {
      const r = await fetch(`${base}/model.json`);
      if (!r.ok) throw new Error(`fly model.json: HTTP ${r.status}`);
      const model = await r.json();
      const loader = new STLLoader();
      const files = [...new Set(Object.values(model.meshes).map((x) => x.file))];
      const geometries = Object.fromEntries(await Promise.all(files.map(async (file) => {
        const g = await loader.loadAsync(`${base}/meshes/${file}`);
        g.scale(model.meshScale, model.meshScale, model.meshScale);
        g.computeVertexNormals();
        return [file, g];
      })));
      return { model, geometries };
    })());
  }
  return cache.get(base);
}

function pose(state, changes = {}) {
  for (const [name, node] of Object.entries(state.nodes)) {
    node.quaternion.copy(state.rest[name]);
    for (const dof of state.dofs[name] || []) {
      const deg = (state.model.neutralDeg[dof.name] || 0) + (changes[dof.name] || 0);
      node.quaternion.multiply(turn.setFromAxisAngle(dof.vector, deg * rad));
    }
  }
}

/** Build one fly. Returns a THREE.Group; rig state is on group.userData.fly. */
export async function createFly(base = 'assets/fly', tint = null) {
  const { model, geometries } = await loadAssets(base.replace(/\/$/, ''));
  const group = new THREE.Group();
  group.name = 'fly';
  const body = new THREE.Group();
  const state = { model, nodes: {}, rest: {}, dofs: {}, body };

  for (const name of model.segments) {
    const node = new THREE.Group();
    node.name = name;
    const conf = model.rest[name];
    node.position.fromArray(conf.pos);
    const [w, x, y, z] = conf.quat;
    state.rest[name] = new THREE.Quaternion(x, y, z, w).normalize();

    const spec = model.meshes[name];
    const mesh = new THREE.Mesh(geometries[spec.file], segmentMaterial(name, tint));
    if (spec.mirror) mesh.scale.y = -1;
    node.add(mesh);
    state.nodes[name] = node;
  }

  for (const d of model.dofs) {
    (state.dofs[d.child] ||= []).push({
      ...d,
      vector: new THREE.Vector3().fromArray(
        Array.isArray(d.axis) ? d.axis : model.axisVector[d.axis]),
    });
  }
  body.add(state.nodes[model.root]);
  for (const [parent, child] of model.joints) state.nodes[parent].add(state.nodes[child]);
  pose(state);
  body.updateMatrixWorld(true);
  body.rotation.x = -Math.PI / 2;      // asset is Z-up; scene is Y-up
  group.add(body);
  // YXZ so the caller can own rotation.y as heading while the animation owns
  // x (pitch) and z (bank) without the three fighting each other.
  group.rotation.order = 'YXZ';
  group.userData.fly = state;
  group.userData.seed = Math.random() * 100;
  return group;
}

const LEGS = ['lf', 'lm', 'lh', 'rf', 'rm', 'rh'];

/**
 * Illustrative idle/flight animation.
 *
 * Real wings beat near 200 Hz, which at 60 fps would only ever strobe. This
 * drives them at 22 Hz instead: fast enough to read as flight, slow enough to
 * see. Like everything else here it is illustrative kinematics, not biomechanics.
 *
 * @param {number} t        seconds
 * @param {number} airborne 0..1 -- wings open and beat, legs tuck up
 * @param {{bank?:number, pitch?:number, head?:number, groom?:boolean}} opts
 *        bank  degrees of roll into a turn
 *        pitch degrees of nose-down (positive = nose down)
 *        head  degrees the head tilts down, for looking at something
 */
export function animateFly(group, t, airborne = 0, opts = {}) {
  const state = group.userData.fly;
  if (!state) return;
  const tt = t + (group.userData.seed || 0);
  const c = {};
  const air = Math.max(0, Math.min(1, airborne));

  // ---- wings. Folded back over the abdomen at rest, swept out and beating in
  // flight. The two sides mirror, so one sign flip covers the right wing.
  const beat = Math.sin(tt * 22 * Math.PI * 2);
  // No flutter at rest -- a settled fly holds its wings still. The 22 Hz
  // beat only exists while she is actually airborne.
  const amp = 54 * air;
  c['c_thorax-l_wing-pitch'] = beat * amp;
  c['c_thorax-r_wing-pitch'] = -beat * amp;
  c['c_thorax-l_wing-yaw'] = -20 * air + beat * 7 * air;
  c['c_thorax-r_wing-yaw'] = 20 * air - beat * 7 * air;
  c['c_thorax-l_wing-roll'] = beat * 12 * air;
  c['c_thorax-r_wing-roll'] = -beat * 12 * air;

  // halteres beat too, antiphase to the wings, which is what they really do
  c['c_thorax-l_haltere-pitch'] = -beat * 20 * air;
  c['c_thorax-r_haltere-pitch'] = -beat * 20 * air;

  // ---- legs. Tucked under the body in flight; in a slow idle they shift.
  // Grooming: every ~9 s a fly rubs its forelegs together.
  const groomPhase = (tt % 9) / 9;
  const grooming = opts.groom !== false && air < 0.15 && groomPhase > 0.78;
  const groomWave = grooming ? Math.sin((groomPhase - 0.78) / 0.22 * Math.PI * 6) : 0;

  for (const leg of LEGS) {
    const front = leg[1] === 'f', hind = leg[1] === 'h';
    const reach = front ? 1 : hind ? 0.62 : 0.8;
    const idle = Math.sin(tt * 1.3 + (leg.charCodeAt(0) + leg.charCodeAt(1))) * 1.6 * (1 - air);
    const g = front ? groomWave * 26 : 0;
    c[`c_thorax-${leg}_coxa-pitch`] = -30 * air * reach + idle + g;
    c[`${leg}_coxa-${leg}_trochanterfemur-pitch`] = -34 * air * reach + idle - g * 0.6;
    c[`${leg}_trochanterfemur-${leg}_tibia-pitch`] = 46 * air * reach + g * 0.8;
    c[`${leg}_tibia-${leg}_tarsus1-pitch`] = 30 * air * reach + g * 0.5;
  }

  // ---- body. Breathing at rest, a slight curl of the abdomen in flight.
  const breathe = Math.sin(tt * 1.7) * 1.5 * (1 - air);
  c['c_thorax-c_abdomen12-pitch'] = breathe + 9 * air;
  c['c_abdomen12-c_abdomen3-pitch'] = breathe * 0.6 + 4 * air;
  c['c_abdomen3-c_abdomen4-pitch'] = breathe * 0.4 + 3 * air;

  // ---- head. Small idle turns, plus whatever the caller asks for.
  const look = Math.sin(tt * 0.6) * 4 * (1 - air);
  c['c_thorax-c_head-pitch'] = (opts.head || 0) + breathe * 0.5;
  c['c_thorax-c_head-yaw'] = look;

  // ---- antennae trail behind the motion, with a little spring.
  const trail = Math.sin(tt * 3.1) * 3 + air * 10;
  c['c_head-l_pedicel-pitch'] = trail;
  c['c_head-r_pedicel-pitch'] = trail;
  c['l_pedicel-l_funiculus-pitch'] = trail * 0.7;
  c['r_pedicel-r_funiculus-pitch'] = trail * 0.7;

  pose(state, c);

  // Bank and pitch are attitude, not anatomy, so they go on the outer group.
  // rotation.y is left alone -- that is the caller's heading.
  group.rotation.z = THREE.MathUtils.degToRad(opts.bank || 0);
  group.rotation.x = THREE.MathUtils.degToRad(opts.pitch || 0);
}

/**
 * The cheap fly. One level of detail down from the rigged one.
 *
 * A rigged fly is about 70 meshes, so every joint can move on its own. That is
 * worth paying for on the order desk, where one fly fills the frame and you can
 * watch her groom and tip her head. It is not worth paying for on the kitchen
 * floor, where a fly is roughly thirty pixels tall and leg articulation is
 * smaller than a pixel: ten rigged flies came to 664 draw calls and held 23 fps.
 *
 * So this bakes the rest pose -- every body segment transformed into place and
 * merged into ONE geometry -- and leaves the two wings separate so they can
 * still beat. Three draw calls instead of seventy. Wingbeat, bank, pitch and
 * bob all still read, and those are the only things visible at that size.
 */
export async function createSimpleFly(base = 'assets/fly', tint = null) {
  const { model, geometries } = await loadAssets(base.replace(/\/$/, ''));

  // Walk the rig once at rest to get each segment's world transform.
  const nodes = {};
  for (const name of model.segments) {
    const n = new THREE.Group();
    const conf = model.rest[name];
    n.position.fromArray(conf.pos);
    const [w, x, y, z] = conf.quat;
    n.quaternion.set(x, y, z, w).normalize();
    nodes[name] = n;
  }
  for (const [parent, child] of model.joints) nodes[parent].add(nodes[child]);
  const root = nodes[model.root];
  root.updateMatrixWorld(true);

  const bodyParts = [];
  const wings = [];
  for (const name of model.segments) {
    const spec = model.meshes[name];
    const g = geometries[spec.file].clone();
    if (spec.mirror) g.scale(1, -1, 1);
    g.applyMatrix4(nodes[name].matrixWorld);
    if (name.endsWith('_wing')) wings.push({ name, geometry: g });
    else bodyParts.push(g);
  }

  const group = new THREE.Group();
  const body = new THREE.Group();
  const merged = BufferGeometryUtils.mergeGeometries(bodyParts, false);
  merged.computeVertexNormals();
  body.add(new THREE.Mesh(merged, segmentMaterial('body', tint)));

  // Wings stay separate, each pivoting about the thorax so they can beat.
  const wingPivots = [];
  for (const w of wings) {
    const pivot = new THREE.Group();
    pivot.add(new THREE.Mesh(w.geometry, segmentMaterial('l_wing', null)));
    body.add(pivot);
    wingPivots.push({ pivot, side: w.name.startsWith('r') ? -1 : 1 });
  }

  body.rotation.x = -Math.PI / 2;
  group.add(body);
  group.rotation.order = 'YXZ';
  group.userData.simple = { wingPivots };
  group.userData.seed = Math.random() * 100;
  return group;
}

/** Wingbeat and attitude for a baked scenery fly. */
export function animateSimpleFly(group, t, opts = {}) {
  const a = group.userData.simple;
  if (!a) return;
  const beat = Math.sin((t + (group.userData.seed || 0)) * 22 * Math.PI * 2);
  for (const { pivot, side } of a.wingPivots) pivot.rotation.x = beat * 0.62 * side;
  group.rotation.z = THREE.MathUtils.degToRad(opts.bank || 0);
  group.rotation.x = THREE.MathUtils.degToRad(opts.pitch || 0);
}
