import { logFreqs, formatFreq } from './eq.js';

const F_LO = 20;
const F_HI = 20000;
const GRID_F = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

export class EqGraph {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.opts = { minDb: -15, maxDb: 15, ...opts };
    this.freqs = logFreqs(300);
    this.selected = -1;
    this.hover = -1;
    this.drag = null;
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('dblclick', (e) => this.onDbl(e));
  }

  destroy() { this.ro.disconnect(); }

  get w() { return this.canvas.clientWidth; }
  get h() { return this.canvas.clientHeight; }
  pad() { return { l: 40, r: 12, t: 12, b: 24 }; }

  xOf(f) {
    const p = this.pad();
    return p.l + (Math.log(f / F_LO) / Math.log(F_HI / F_LO)) * (this.w - p.l - p.r);
  }
  fOf(x) {
    const p = this.pad();
    const t = Math.min(Math.max((x - p.l) / (this.w - p.l - p.r), 0), 1);
    return F_LO * Math.pow(F_HI / F_LO, t);
  }
  yOf(db) {
    const p = this.pad();
    const { minDb, maxDb } = this.opts;
    return p.t + ((maxDb - db) / (maxDb - minDb)) * (this.h - p.t - p.b);
  }
  dbOf(y) {
    const p = this.pad();
    const { minDb, maxDb } = this.opts;
    return maxDb - ((y - p.t) / (this.h - p.t - p.b)) * (maxDb - minDb);
  }

  points() { return this.opts.getPoints(); }

  hit(x, y) {
    const pts = this.points();
    let best = -1, bestD = 14;
    pts.forEach((pt, i) => {
      const d = Math.hypot(this.xOf(pt.freq) - x, this.yOf(pt.dot ?? pt.gain) - y);
      if (d < bestD) { best = i; bestD = d; }
    });
    return best;
  }

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onDown(e) {
    const { x, y } = this.local(e);
    const i = this.hit(x, y);
    if (i < 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { i, id: e.pointerId };
    this.selected = i;
    this.opts.onSelect?.(i);
    this.draw();
  }

  onMove(e) {
    const { x, y } = this.local(e);
    if (this.drag && this.drag.id === e.pointerId) {
      const { minDb, maxDb } = this.opts;
      const pt = this.points()[this.drag.i];
      const freq = this.fOf(x);
      const gain = pt.fixedGain ? pt.gain : Math.min(Math.max(this.dbOf(y), minDb), maxDb);
      this.opts.onDrag?.(this.drag.i, { freq, gain }, e);
      this.draw();
      return;
    }
    const h = this.hit(x, y);
    if (h !== this.hover) {
      this.hover = h;
      this.canvas.style.cursor = h >= 0 ? 'grab' : 'crosshair';
      this.draw();
    }
  }

  onUp(e) {
    if (this.drag && this.drag.id === e.pointerId) {
      this.opts.onDragEnd?.(this.drag.i);
      this.drag = null;
    }
  }

  onWheel(e) {
    if (!this.opts.onQ) return;
    const { x, y } = this.local(e);
    let i = this.hit(x, y);
    if (i < 0) i = this.selected;
    if (i < 0) return;
    e.preventDefault();
    const pt = this.points()[i];
    const q = Math.min(Math.max(pt.q * Math.pow(1.1, e.deltaY < 0 ? 1 : -1), 0.1), 20);
    this.opts.onQ(i, q);
    this.draw();
  }

  onDbl(e) {
    if (!this.opts.onAdd) return;
    const { x, y } = this.local(e);
    if (this.hit(x, y) >= 0) return;
    this.opts.onAdd(this.fOf(x), Math.round(this.dbOf(y) * 10) / 10);
  }

  /** The live spectrum on its own canvas behind the graph, so it can move ~20 times a second
   *  without redrawing the EQ. sp = { freqs, db, label }; own scale from −96 to −12 dB. */
  drawSpectrum(c, sp, lo = -96, hi = -12) {
    const dpr = window.devicePixelRatio || 1;
    const W = this.w, H = this.h;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!sp?.db?.length || Math.max(...sp.db) <= lo) return;
    const p = this.pad();
    const bottom = H - p.b;
    const yS = (db) => p.t + (1 - Math.min(Math.max((db - lo) / (hi - lo), 0), 1)) * (bottom - p.t);
    g.beginPath();
    g.moveTo(this.xOf(sp.freqs[0]), bottom);
    sp.db.forEach((db, k) => g.lineTo(this.xOf(sp.freqs[k]), yS(db)));
    g.lineTo(this.xOf(sp.freqs[sp.freqs.length - 1]), bottom);
    g.closePath();
    const fill = g.createLinearGradient(0, p.t, 0, bottom);
    fill.addColorStop(0, 'rgba(168,85,247,.32)');
    fill.addColorStop(1, 'rgba(34,211,238,.06)');
    g.fillStyle = fill;
    g.fill();
    g.strokeStyle = 'rgba(168,85,247,.55)';
    g.lineWidth = 1;
    g.stroke();
    if (sp.label) {
      g.font = '11px system-ui, sans-serif';
      g.fillStyle = 'rgba(200,180,255,.8)';
      g.textAlign = 'right';
      g.fillText(sp.label, W - p.r - 6, p.t + 14);
    }
  }

  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const W = this.w, H = this.h;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const p = this.pad();
    const { minDb, maxDb } = this.opts;

    g.font = '11px system-ui, sans-serif';
    g.lineWidth = 1;
    for (const f of GRID_F) {
      const x = Math.round(this.xOf(f)) + 0.5;
      g.strokeStyle = '#1a2335';
      g.beginPath(); g.moveTo(x, p.t); g.lineTo(x, H - p.b); g.stroke();
      g.fillStyle = '#5d6a85';
      g.textAlign = 'center';
      g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x, H - 7);
    }
    const step = maxDb - minDb > 24 ? 6 : 3;
    for (let db = Math.ceil(minDb / step) * step; db <= maxDb; db += step) {
      const y = Math.round(this.yOf(db)) + 0.5;
      g.strokeStyle = db === 0 ? '#33415f' : '#1a2335';
      g.beginPath(); g.moveTo(p.l, y); g.lineTo(W - p.r, y); g.stroke();
      g.fillStyle = '#5d6a85';
      g.textAlign = 'right';
      g.fillText(`${db > 0 ? '+' : ''}${db}`, p.l - 6, y + 4);
    }

    const pts = this.points();
    if (this.opts.bandCurve) {
      pts.forEach((pt, i) => {
        if (pt.enabled === false) return;
        const r = this.opts.bandCurve(i, this.freqs);
        if (!r) return;
        g.beginPath();
        r.forEach((db, k) => {
          const x = this.xOf(this.freqs[k]), y = this.yOf(Math.min(Math.max(db, minDb - 5), maxDb + 5));
          k ? g.lineTo(x, y) : g.moveTo(x, y);
        });
        g.lineTo(this.xOf(F_HI), this.yOf(0));
        g.lineTo(this.xOf(F_LO), this.yOf(0));
        g.closePath();
        g.fillStyle = hexA(pt.color, i === this.selected ? 0.18 : 0.08);
        g.fill();
      });
    }

    const total = this.opts.curve(this.freqs);
    const grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#22d3ee');
    grad.addColorStop(1, '#a855f7');
    g.beginPath();
    total.forEach((db, k) => {
      const x = this.xOf(this.freqs[k]), y = this.yOf(Math.min(Math.max(db, minDb - 5), maxDb + 5));
      k ? g.lineTo(x, y) : g.moveTo(x, y);
    });
    g.strokeStyle = grad;
    g.lineWidth = 2.5;
    g.shadowColor = 'rgba(34,211,238,.5)';
    g.shadowBlur = 10;
    g.stroke();
    g.shadowBlur = 0;

    // The whole chain as played (Loudness, Crossfeed, klip-beskyttelse), dashed.
    const chain = this.opts.chainCurve?.(this.freqs);
    if (chain) {
      g.beginPath();
      chain.forEach((db, k) => {
        const x = this.xOf(this.freqs[k]), y = this.yOf(Math.min(Math.max(db, minDb - 5), maxDb + 5));
        k ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.setLineDash([5, 4]);
      g.strokeStyle = 'rgba(230,235,245,.7)';
      g.lineWidth = 1.5;
      g.stroke();
      g.setLineDash([]);
    }

    pts.forEach((pt, i) => {
      const x = this.xOf(pt.freq), y = this.yOf(pt.dot ?? pt.gain);
      const active = i === this.selected || i === this.hover;
      g.beginPath();
      g.arc(x, y, active ? 8 : 6.5, 0, Math.PI * 2);
      g.fillStyle = pt.enabled === false ? '#3a4560' : pt.color;
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = active ? '#fff' : '#0a0e16';
      g.stroke();
      if (pt.label) {
        g.fillStyle = '#0a0e16';
        g.font = 'bold 9px system-ui';
        g.textAlign = 'center';
        g.fillText(pt.label, x, y + 3);
      }
    });

    const show = this.drag ? this.drag.i : this.hover;
    if (show >= 0 && pts[show]) {
      const pt = pts[show];
      const txt = `${formatFreq(pt.freq)}  ${pt.gain > 0 ? '+' : ''}${pt.gain.toFixed(1)} dB${pt.q != null && this.opts.onQ ? `  Q ${pt.q.toFixed(2)}` : ''}`;
      g.font = '12px system-ui';
      const tw = g.measureText(txt).width + 16;
      let tx = this.xOf(pt.freq) - tw / 2;
      tx = Math.min(Math.max(tx, p.l), W - p.r - tw);
      let ty = this.yOf(pt.dot ?? pt.gain) - 34;
      if (ty < 2) ty += 52;
      g.fillStyle = 'rgba(18,24,38,.95)';
      g.strokeStyle = '#2b3754';
      g.lineWidth = 1;
      roundRect(g, tx, ty, tw, 22, 6);
      g.fill(); g.stroke();
      g.fillStyle = '#e6ebf5';
      g.textAlign = 'left';
      g.fillText(txt, tx + 8, ty + 15);
    }
  }
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export const BAND_COLORS = ['#22d3ee', '#38bdf8', '#818cf8', '#a855f7', '#e879f9', '#f472b6', '#fb7185', '#fbbf24', '#a3e635', '#34d399', '#2dd4bf', '#60a5fa'];
