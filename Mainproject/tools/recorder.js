/**
 * Dev-only screen recorder. Not part of the app.
 *
 * Composites one or two of the page's live WebGL canvases into an offscreen
 * 1280x720 canvas, draws a caption bar over it, and records that with
 * MediaRecorder. Recording the canvases directly rather than the desktop means
 * no screen-recording permission, nothing else on the machine is captured, and
 * the output is exactly 720p regardless of window size.
 *
 *   await __rec.start({ name:'kitchen.webm', layout:'split', captions:[...] })
 *   await __rec.stop()            // POSTs to tools/record.py
 */
(() => {
  const W = 1280, H = 720;
  const BAR = 104;                       // caption bar height

  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const g = out.getContext('2d');

  let rec = null, chunks = [], raf = 0, t0 = 0, cfg = null, frames = 0;

  /**
   * Draw src into the rect.
   *
   * 'cover' fills the rect and crops the overflow, which is right when the
   * source and target aspects are close. When they are not it is actively
   * harmful: a 1152x1366 portrait canvas cover-cropped into 16:9 throws away
   * 53% of the height and can cut the subject out of frame entirely. 'contain'
   * fits the whole frame instead and pads with the page background.
   */
  function cover(src, x, y, w, h, fit) {
    if (!src || !src.width || !src.height) return;
    const srcAspect = src.width / src.height, dstAspect = w / h;
    // Auto: fall back to contain when the mismatch is bad enough to crop badly.
    const mode = fit || (Math.max(srcAspect / dstAspect, dstAspect / srcAspect) > 1.35
                          ? 'contain' : 'cover');
    const s = mode === 'contain'
      ? Math.min(w / src.width, h / src.height)
      : Math.max(w / src.width, h / src.height);
    const dw = src.width * s, dh = src.height * s;
    g.save();
    g.beginPath(); g.rect(x, y, w, h); g.clip();
    g.drawImage(src, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    g.restore();
  }

  function roundRect(x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function caption(text, sub, fade) {
    const grad = g.createLinearGradient(0, H - BAR - 60, 0, H);
    grad.addColorStop(0, 'rgba(20,17,14,0)');
    grad.addColorStop(0.45, 'rgba(20,17,14,0.92)');
    grad.addColorStop(1, 'rgba(20,17,14,0.98)');
    g.fillStyle = grad;
    g.fillRect(0, H - BAR - 60, W, BAR + 60);

    g.globalAlpha = fade;
    g.fillStyle = '#d4a35a';
    g.font = '600 34px "DM Sans", -apple-system, system-ui, sans-serif';
    g.fillText(text, 48, H - 58);
    if (sub) {
      g.fillStyle = '#b5a694';
      g.font = '400 22px "DM Sans", -apple-system, system-ui, sans-serif';
      g.fillText(sub, 48, H - 24);
    }
    g.globalAlpha = 1;
  }

  function brand() {
    g.fillStyle = 'rgba(243,235,224,0.9)';
    g.font = '600 26px Fraunces, Georgia, serif';
    g.fillText('Biryani Center', 48, 56);
    g.fillStyle = 'rgba(181,166,148,0.75)';
    g.font = '400 17px "DM Sans", -apple-system, system-ui, sans-serif';
    g.fillText('a fly brain running a restaurant', 48, 82);
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    const t = (performance.now() - t0) / 1000;
    frames++;

    g.fillStyle = '#14110e';
    g.fillRect(0, 0, W, H);

    const a = cfg.a && document.querySelector(cfg.a);
    const b = cfg.b && document.querySelector(cfg.b);

    if (cfg.layout === 'split' && b) {
      const gap = 14, lw = Math.round(W * 0.615);
      cover(a, 0, 0, lw, H, cfg.fit);
      cover(b, lw + gap, 0, W - lw - gap, H, cfg.fit);
      g.fillStyle = '#14110e';
      g.fillRect(lw, 0, gap, H);
    } else {
      cover(a, 0, 0, W, H, cfg.fit);
    }

    // current caption, with a short fade in and out
    let cur = null, idx = -1;
    for (let i = 0; i < cfg.captions.length; i++) if (cfg.captions[i].at <= t) { cur = cfg.captions[i]; idx = i; }
    if (cur) {
      const next = cfg.captions[idx + 1];
      const since = t - cur.at;
      const until = next ? next.at - t : 99;
      const fade = Math.min(1, since / 0.35, Math.max(0, until / 0.35));
      if (fade > 0.01) caption(cur.title, cur.sub, fade);
    }
    brand();

    if (cfg.seconds && t >= cfg.seconds) api.stop();
  }

  const api = {
    async start(opts) {
      cfg = Object.assign({ a: 'canvas', b: null, layout: 'single', captions: [], seconds: 0, fit: null, force: false }, opts);

      // Fail loudly rather than recording nothing.
      //
      // Measure whether the animation loop is actually running instead of
      // trusting document.hidden, which reports `true` in some embedded panes
      // that are compositing at a full 60 fps. A throttled loop draws no frames
      // into the composite canvas, so captureStream yields a 0-byte file and
      // the failure only shows up long after the take.
      // Bounded: a fully throttled page fires no rAF at all, so an unbounded
      // probe never settles and the caller just hangs. A wall-clock timer
      // always resolves, and a rate of ~0 is exactly the signal we want.
      const rate = await new Promise((res) => {
        let n = 0, done = false;
        const finish = (v) => { if (!done) { done = true; res(v); } };
        const t = performance.now();
        const f = () => { n++; if (performance.now() - t < 320) requestAnimationFrame(f); else finish(n / 0.32); };
        requestAnimationFrame(f);
        setTimeout(() => finish(n / 0.9), 900);
      });
      // Advisory, not fatal. An idle embedded pane can sit at a few frames a
      // second and then jump to 60 as soon as anything touches it, so a probe
      // taken before the take does not predict the take. `force` skips the
      // complaint; either way stop() reports the real frame count and measured
      // fps, which is the only trustworthy check.
      if (rate < 20 && !cfg.force) {
        throw new Error(`requestAnimationFrame is running at ${rate.toFixed(0)}/s — the page looks `
          + 'throttled. Show the pane and keep it active during the take, or pass force:true '
          + 'and check the frame count that stop() reports.');
      }
      for (const sel of [cfg.a, cfg.b].filter(Boolean)) {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`no canvas matches ${sel}`);
        if (el.width < 200 || el.height < 150) {
          throw new Error(`${sel} is ${el.width}x${el.height} — the layout has collapsed. `
            + 'Show the pane and let it lay out before recording.');
        }
      }
      chunks = [];
      const stream = out.captureStream(60);
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
        .find((m) => MediaRecorder.isTypeSupported(m));
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      t0 = performance.now();
      frames = 0;
      rec.start();
      frame();
      return { mime, recording: true };
    },
    stop() {
      if (!rec || rec.state === 'inactive') return Promise.resolve('not recording');
      cancelAnimationFrame(raf);
      return new Promise((resolve) => {
        rec.onstop = async () => {
          const blob = new Blob(chunks, { type: 'video/webm' });
          const r = await fetch(`/record?name=${encodeURIComponent(cfg.name || 'clip.webm')}`,
                                { method: 'POST', body: blob });
          const secs = (performance.now() - t0) / 1000;
          resolve(`${cfg.name}: ${(blob.size / 1e6).toFixed(1)} MB, ${frames} frames over `
            + `${secs.toFixed(1)}s (${(frames / secs).toFixed(0)} fps), upload ${r.ok ? 'ok' : 'FAILED'}`);
        };
        rec.stop();
      });
    },
    /**
     * One composited frame as a PNG, POSTed like a clip.
     *
     * Separate from start()/stop() because a still only needs the page to
     * paint once, which an idle pane will do even when it is too throttled to
     * sustain 60 fps for a recording.
     */
    async snap(opts) {
      const o = Object.assign({ a: 'canvas', b: null, layout: 'single', fit: null,
                                bare: true, name: 'shot.png' }, opts);
      // Wait for a real paint so the WebGL buffer has something in it: drawing
      // a WebGL canvas outside its own frame gives an empty image.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      g.fillStyle = '#14110e';
      g.fillRect(0, 0, W, H);
      const a = document.querySelector(o.a);
      const b = o.b && document.querySelector(o.b);
      if (o.layout === 'split' && b) {
        const gap = 14, lw = Math.round(W * 0.615);
        cover(a, 0, 0, lw, H, o.fit);
        cover(b, lw + gap, 0, W - lw - gap, H, o.fit);
        g.fillStyle = '#14110e';
        g.fillRect(lw, 0, gap, H);
      } else {
        cover(a, 0, 0, W, H, o.fit);
      }
      if (!o.bare) brand();
      const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
      const res = await fetch(`/record?name=${encodeURIComponent(o.name)}`,
                              { method: 'POST', body: blob });
      return `${o.name}: ${(blob.size / 1e3).toFixed(0)} KB, ${res.ok ? 'ok' : 'FAILED'}`;
    },

    get state() { return rec ? rec.state : 'idle'; },
    get frames() { return frames; },
  };

  globalThis.__rec = api;
  console.log('recorder ready');
})();
