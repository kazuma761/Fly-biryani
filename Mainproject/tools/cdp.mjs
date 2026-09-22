/**
 * Dev-only: a minimal Chrome DevTools Protocol driver, no npm dependencies.
 *
 * Node 21+ ships a global WebSocket, and Chrome is already on the machine, so
 * driving a real browser costs one file instead of a 300 MB install. Used by
 * tools/shoot.mjs to capture the README media against the real app.
 *
 * Not part of the app. Nothing in orders.html or kitchen.html talks to this.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function launch({ width = 1440, height = 900, port = 9222, headless = true } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'biryani-shoot-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    // A backgrounded or occluded window has its rAF loop throttled to a crawl,
    // which is indistinguishable from a broken scene in a still.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required',
    '--hide-scrollbars',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');

  const proc = spawn(CHROME, args, { stdio: 'ignore' });
  const ws = await waitFor(port);
  return new Session(proc, ws, profile);
}

async function waitFor(port, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      return (await r.json()).webSocketDebuggerUrl;
    } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error(`Chrome never opened a debugger on ${port}`);
}

class Session {
  constructor(proc, browserWs, profile) {
    this.proc = proc; this.browserWs = browserWs; this.profile = profile;
  }

  async open(url, { width = 1440, height = 900 } = {}) {
    const bws = await connect(this.browserWs);
    const { targetId } = await bws.send('Target.createTarget', { url: 'about:blank', width, height, newWindow: true });
    bws.close();
    const page = await connect(`ws://127.0.0.1:${new URL(this.browserWs).port}/devtools/page/${targetId}`);
    const tab = new Tab(page);
    await tab.send('Page.enable');
    await tab.send('Runtime.enable');
    await tab.send('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 2, mobile: false });
    await tab.goto(url);
    return tab;
  }

  close() { this.proc.kill(); }
}

class Tab {
  constructor(ws) { this.ws = ws; }
  send(method, params) { return this.ws.send(method, params); }

  async goto(url) {
    const loaded = this.ws.once('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await loaded;
  }

  /** Evaluate in the page; throws with the page's own error text. */
  async eval(expr, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression: typeof expr === 'function' ? `(${expr})()` : expr,
      awaitPromise, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      const e = r.exceptionDetails;
      throw new Error(e.exception?.description || e.text);
    }
    return r.result.value;
  }

  /** Poll a predicate in the page. Reports what it was still waiting for. */
  async waitFor(expr, { timeout = 30000, label = String(expr) } = {}) {
    const t0 = Date.now();
    for (;;) {
      if (await this.eval(`!!(${expr})`)) return;
      if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  async shot(path, clip) {
    const args = { format: 'png', captureBeyondViewport: false };
    if (clip) args.clip = { ...clip, scale: 2 };
    const { data } = await this.send('Page.captureScreenshot', args);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, Buffer.from(data, 'base64'));
    return path;
  }

  /** Bounding box of a selector, in CSS pixels, for clipped screenshots. */
  box(sel) {
    return this.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
      if (!e) throw new Error('no element ' + ${JSON.stringify(sel)});
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  }

  close() { this.ws.close(); }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const listeners = new Map();

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (!p) return;
        msg.error ? p.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`))
                  : p.resolve(msg.result);
      } else {
        const l = listeners.get(msg.method);
        if (l) { listeners.delete(msg.method); l(msg.params); }
      }
    };
    ws.onerror = () => reject(new Error(`websocket failed: ${url}`));
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const i = ++id;
          pending.set(i, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id: i, method, params }));
        });
      },
      once(method) { return new Promise((res) => listeners.set(method, res)); },
      close() { ws.close(); },
    });
  });
}
