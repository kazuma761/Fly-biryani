/**
 * Dev-only: capture the README's stills and animations from the running app.
 *
 *   python3 serve.py 8081 &        # or tools/record.py
 *   node tools/shoot.mjs           # writes docs/media/*.png and *.gif
 *
 * Everything here drives the real pages in a real browser — no mock-ups, no
 * compositing of things the app does not draw. A frame is a screenshot of the
 * app at the moment named in the caption.
 *
 * Animations are screenshot sequences assembled by ffmpeg rather than
 * MediaRecorder output, because a screenshot catches the DOM panels too, and
 * the panels are half of what each figure is trying to show.
 *
 * Not part of the app. Nothing in orders.html or kitchen.html talks to this.
 */
import { launch } from './cdp.mjs';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'media');
const TMP = join(ROOT, '.shoot');
const BASE = process.env.SHOOT_URL || 'http://127.0.0.1:8081';
const only = process.argv.slice(2);

mkdirSync(OUT, { recursive: true });
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Screenshot sequence -> gif. fps is the playback rate, not the capture rate. */
function gif(name, dir, { fps = 12, width = 900 } = {}) {
  const pal = join(TMP, `${name}.png`);
  const filters = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps),
    '-i', join(dir, 'f%04d.png'), '-vf', `${filters},palettegen=stats_mode=diff`, pal]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps),
    '-i', join(dir, 'f%04d.png'), '-i', pal,
    '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
    join(OUT, `${name}.gif`)]);
  const size = execFileSync('du', ['-h', join(OUT, `${name}.gif`)]).toString().split('\t')[0];
  console.log(`  ${name}.gif  ${size}`);
}

/** Capture n frames as fast as the protocol allows, optionally driving the page. */
async function film(tab, name, { frames = 60, every = 0, clip = null, step = null }) {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < frames; i++) {
    if (step) await step(i);
    await tab.shot(join(dir, `f${String(i + 1).padStart(4, '0')}.png`), clip);
    if (every) await sleep(every);
  }
  return dir;
}

const scenes = {
  // ---- the order desk ------------------------------------------------------
  async desk(s) {
    const tab = await s.open(`${BASE}/orders.html`, { width: 1440, height: 900 });
    await tab.waitFor(`document.getElementById('deskhud').textContent.includes('fps')`,
      { label: 'the desk fly to finish loading' });
    await sleep(2500);
    await tab.shot(join(OUT, 'desk.png'));
    console.log('  desk.png');

    // The order changes -> the Kenyon-cell code changes with it. One frame per
    // click, held, so the sparse code is readable rather than a flicker.
    const panel = await tab.box('.layout > .panel');
    const picks = ['mutton', 'lucknowi', 'spicy', 'salan', 'egg', 'kolkata', 'mild', 'raita'];
    const dir = await film(tab, 'smell', {
      frames: picks.length * 6, every: 40,
      clip: { x: panel.x, y: panel.y + 60, width: panel.width, height: 620 },
      step: async (i) => {
        if (i % 6) return;
        await tab.eval(`[...document.querySelectorAll('.chips button')]
          .find(b => b.textContent.trim() === ${JSON.stringify(picks[i / 6])})?.click()`);
        await sleep(160);
      },
    });
    gif('smell', dir, { fps: 8, width: 760 });

    // Place three orders so the kitchen has something to cook.
    for (const combo of [['mutton', 'hyderabadi', 'spicy'], ['egg', 'kolkata', 'mild'], ['veg', 'lucknowi', 'medium']]) {
      for (const c of combo) {
        await tab.eval(`[...document.querySelectorAll('.chips button')]
          .find(b => b.textContent.trim() === ${JSON.stringify(c)})?.click()`);
      }
      await tab.eval(`document.getElementById('place').click()`);
      await sleep(400);
    }
    const placed = await tab.eval(`document.getElementById('s-placed').textContent`);
    if (Number(placed) < 3) throw new Error(`only ${placed} orders placed — the desk did not take them`);
    tab.close();
    return { placed };
  },

  // ---- the kitchen floor ---------------------------------------------------
  async kitchen(s) {
    const tab = await s.open(`${BASE}/kitchen.html`, { width: 1440, height: 1000 });
    await tab.waitFor(`document.getElementById('khud').textContent.includes('fps')`,
      { label: 'the kitchen to finish loading' });
    await tab.waitFor(`parseInt(document.getElementById('s-neurons').textContent.replace(/,/g,''),10) > 1000`,
      { label: 'the soma cloud' });
    await tab.waitFor(`+document.getElementById('s-work').textContent > 0`,
      { timeout: 60000, label: 'a fly to start working a station' });
    await sleep(1500);

    // The floor and its tickets: everything above the fold, as one screen.
    const top = await tab.box('.layout');
    const hero = { x: 0, y: 0, width: 1440, height: Math.ceil(top.y + top.height + 16) };
    await tab.shot(join(OUT, 'kitchen.png'), hero);
    console.log('  kitchen.png');

    const stage = await tab.box('.stage');
    gif('floor', await film(tab, 'floor', {
      frames: 90, clip: { x: stage.x, y: stage.y, width: stage.width, height: stage.height },
    }), { fps: 14, width: 860 });

    // The brain sits below the fold; scroll it fully into view before clipping,
    // because captureScreenshot only has pixels for what is on screen.
    await tab.eval(`document.querySelectorAll('.layout')[1].scrollIntoView({ block: 'end' })`);
    await sleep(800);
    const wide = await tab.box('.layout ~ .layout');
    await tab.shot(join(OUT, 'brain.png'),
      { x: wide.x, y: wide.y, width: wide.width, height: wide.height });
    console.log('  brain.png');

    await tab.eval(`document.querySelector('[data-tab="controls"]').click()`);
    await sleep(300);
    await tab.eval(`[...document.querySelectorAll('#paths button')]
      .find(b => b.textContent === 'sugar').click()`);
    const brain = await tab.box('.brain-stage');
    gif('pathway', await film(tab, 'pathway', {
      frames: 110, clip: { x: brain.x, y: brain.y, width: brain.width, height: brain.height },
    }), { fps: 14, width: 860 });
    const note = await tab.eval(`document.getElementById('pathnote').textContent.trim().replace(/\\s+/g,' ')`);
    console.log(`  (trace: ${note.slice(0, 90)}…)`);
    await tab.eval(`[...document.querySelectorAll('#paths button')].find(b=>b.textContent==='off').click()`);

    // The ablation, measured rather than asserted: count spikes over the same
    // window with the sensory cells intact and then silenced.
    const spikes = () => tab.eval(`parseInt(document.getElementById('s-spikes').textContent.replace(/,/g,''),10)`);
    const meters = () => tab.eval(`[...document.querySelectorAll('#meters .meter-val')].map(e=>e.textContent).join(' ')`);
    await tab.eval(`document.querySelector('[data-tab="tickets"]').click()`);
    await tab.eval(`window.scrollTo(0,0)`);
    await sleep(400);
    const s0 = await spikes(); await sleep(6000);
    const intact = { spikes: (await spikes()) - s0, readouts: await meters(),
                     work: await tab.eval(`+document.getElementById('s-work').textContent`) };
    await tab.eval(`document.querySelector('[data-tab="controls"]').click()`);
    await tab.eval(`document.getElementById('lesion').click()`);
    await tab.eval(`document.querySelector('[data-tab="tickets"]').click()`);
    await sleep(2000);
    const s1 = await spikes(); await sleep(6000);
    const lesioned = { spikes: (await spikes()) - s1, readouts: await meters(),
                       work: await tab.eval(`+document.getElementById('s-work').textContent`) };
    await tab.shot(join(OUT, 'lesion.png'), hero);
    console.log(`  lesion.png  intact ${intact.spikes} spikes/6s (${intact.readouts})`);
    console.log(`              lesioned ${lesioned.spikes} spikes/6s (${lesioned.readouts})`);
    tab.close();
    return { intact, lesioned, trace: note };
  },
};

const s = await launch({ headless: process.env.SHOOT_HEADED !== '1' });
const results = {};
try {
  for (const [name, fn] of Object.entries(scenes)) {
    if (only.length && !only.includes(name)) continue;
    console.log(`${name}:`);
    results[name] = await fn(s);
  }
} finally {
  s.close();
}
console.log(JSON.stringify(results));
if (!existsSync(join(OUT, 'desk.png'))) process.exitCode = 1;
process.exit(process.exitCode || 0);
