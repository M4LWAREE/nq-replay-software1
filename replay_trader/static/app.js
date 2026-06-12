/* replay_trader frontend — live tick-replay chart + trading + scoreboard.
   DeepCharts (Volumetrica) theme + dual-pane layout.

   No-lookahead: all market data comes from /api/bars which only returns
   ticks[start:cursor). We never compute anything from future data client-side.

   ARCHITECTURE: everything chart-shaped lives in a PANE built by makePane()
   (chart + candle/vol/vwap/delta series + footprint/vol-profile/bid-ask canvas
   overlays + per-pane TF & Studies toolbar). pane0 = main/right chart,
   pane1 = left context chart (hidden in single layout). Both panes poll the
   SAME server session — the bar/footprint caches are keyed per-TF server-side,
   so two timeframes replay the same tape with zero extra state. Trading,
   scoreboard, pills and session controls stay global. */
"use strict";

const $ = (s) => document.querySelector(s);
const fmt = (v, d = 2) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));
const money = (v) => (v === null || v === undefined ? "—"
  : (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2));

// ── DeepCharts palette (sampled from reference/deepcharts_ui_reference.png) ──
const COL = {
  bg: "#121212", axis: "#0a0a0a", grid: "#1e1e1e", border: "#2e2e2e",
  text: "#c8c8c8",
  green: "#00d301", red: "#ff001a",
  purple: "#8e3ae3", purpleDeep: "#612499",
  blue: "#2c7fff", blueLight: "#99d9ea",
  gold: "#f1b100", magenta: "#e9077e", orange: "#cb9603",
  fpGreen: "#21d501",
};

const utcHMS = (t) => {
  const d = new Date(t * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds());
};

// ── client state ────────────────────────────────────────────────────────────
// TF label -> bucket seconds. Mirrors the server's TF_SECONDS (one source of
// truth per side). Adding a TF = one entry here + one button in the template.
const TF_SECONDS = { "5s": 5, "30s": 30, "1m": 60, "5m": 300, "15m": 900 };
let haveSession = false;
let ended = false;

// ── API helpers ───────────────────────────────────────────────────────────────
async function api(path, opts) {
  const r = await fetch(path, opts);
  const t = await r.text();
  // Python's json serializes non-finite floats as the bare tokens Infinity /
  // -Infinity / NaN, which are NOT valid JSON — r.json()/JSON.parse throw on
  // them. A throw here used to freeze the whole tape (every poll died before
  // rendering). Sanitize to null so a stray non-finite stat degrades to "—"
  // instead of killing the poll loop.
  return JSON.parse(t.replace(/-?\bInfinity\b/g, "null").replace(/\bNaN\b/g, "null"));
}
const post = (path, body) => api(path, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body || {}),
});

const store = {
  get(k, fb) { try { const v = localStorage.getItem(k); return v === null ? fb : v; } catch (_) { return fb; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* quota/private */ } },
  json(k, fb) { try { return Object.assign({}, fb, JSON.parse(localStorage.getItem(k) || "{}")); } catch (_) { return Object.assign({}, fb); } },
};

// ── pane template ─────────────────────────────────────────────────────────────
const TF_LIST = ["5s", "30s", "1m", "5m", "15m"];
const PANE_TPL = `
<div class="pane-toolbar">
  <span class="instr-chip"><span class="sym">/MNQ</span>·<span class="tf-label">5s</span></span>
  ${TF_LIST.map((t) => `<button class="tf ctl" data-tf="${t}">${t}</button>`).join("")}
  <span class="seps"></span>
  <div class="studies-wrap">
    <button class="ctl studies-btn" title="Chart studies for this pane">▦ Studies</button>
    <div class="studies-menu hidden">
      <button class="ctl menuitem st-foot" title="Footprint: per-bar buy×sell heat cells by price, magenta POC, gold imbalance numbers (zoom in for cells)">Footprint</button>
      <div class="menurow">
        <button class="ctl menuitem st-vp" title="Volume Profile (left-edge, Volumetrica style): volume traded at each price; gold POC">Vol Profile</button>
        <button class="ctl gear st-vpcfg" title="Volume Profile settings">⚙</button>
      </div>
      <button class="ctl menuitem st-ba" title="Bid/Ask ladder per candle (bid left, ask right)">Bid / Ask</button>
      <button class="ctl menuitem st-vwap" title="Session VWAP from the 09:30 RTH open + dotted ±1σ/±2σ bands, drawn live. When off, the server skips the calc.">VWAP + bands</button>
      <button class="ctl menuitem st-dc" title="Delta-colored candles: green = positive bar delta, purple = negative (DeepCharts style)">Delta candles</button>
      <button class="ctl menuitem st-d1" title="1-minute volume delta histogram panel at the bottom of the chart">Delta 1m</button>
    </div>
  </div>
</div>
<div class="chartwrap">
  <div class="chart"></div>
  <canvas class="overlay fpcanvas hidden"></canvas>
  <canvas class="overlay vpcanvas hidden"></canvas>
  <canvas class="overlay bacanvas hidden"></canvas>
  <div class="vpcfg hidden">
    <div class="vpcfg-h">Volume Profile</div>
    <label>Range
      <select class="vpMode">
        <option value="visible">Visible range</option>
        <option value="rolling">Rolling (min)</option>
        <option value="session">Whole session</option>
      </select>
    </label>
    <label>Roll min <input class="vpRollMin" type="number" min="1" max="390" step="5" value="30"/></label>
    <label>Rows <input class="vpRows" type="number" min="0" max="200" step="1" value="48"/></label>
    <label>Value area % <input class="vpVA" type="number" min="0" max="100" step="1" value="70"/></label>
    <label>Width % <input class="vpWidth" type="number" min="5" max="60" step="1" value="30"/></label>
    <label>Opacity % <input class="vpOpacity" type="number" min="10" max="100" step="5" value="80"/></label>
    <label>Side
      <select class="vpSide"><option value="left">Left</option><option value="right">Right</option></select>
    </label>
    <label class="vpck"><input class="vpVAband" type="checkbox"/> Value-area shading</label>
    <label class="vpck"><input class="vpSplit" type="checkbox"/> Buy / sell split</label>
    <label class="vpck"><input class="vpShowPoc" type="checkbox" checked/> POC line</label>
  </div>
</div>`;

// ── pane factory ──────────────────────────────────────────────────────────────
function makePane(idx, host, defaults) {
  host.innerHTML = PANE_TPL;
  const q = (sel) => host.querySelector(sel);
  const KEY = (k) => `replay_trader.p${idx}.${k}`;

  const p = {
    idx, el: host,
    tf: store.get(KEY("tf"), defaults.tf),
    studies: store.json(KEY("studies"), defaults.studies),
    lastBarTime: null,
    vwapLastT: null,
    d1LastT: null,
    posLines: [],
    fpData: [], fpFetching: false,
    vpData: null, vpFetching: false,
    baBars: [], baFetching: false,
  };
  if (!(p.tf in TF_SECONDS)) p.tf = defaults.tf;
  p.tfSec = () => TF_SECONDS[p.tf] || 5;
  p.visible = () => !host.classList.contains("hidden");

  // ---- chart + series ----
  const chart = LightweightCharts.createChart(q(".chart"), {
    autoSize: true,
    layout: { background: { color: COL.bg }, textColor: COL.text, fontSize: 11 },
    grid: { vertLines: { color: COL.grid }, horzLines: { color: COL.grid } },
    rightPriceScale: { borderColor: COL.border, scaleMargins: { top: 0.06, bottom: 0.26 } },
    timeScale: {
      borderColor: COL.border, timeVisible: true, secondsVisible: true, rightOffset: 6,
      tickMarkFormatter: (t) => utcHMS(t),
    },
    localization: { timeFormatter: (t) => utcHMS(t) },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  });
  const CANDLE_ON = { upColor: COL.green, downColor: COL.red,
    wickUpColor: COL.green, wickDownColor: COL.red, borderVisible: false };
  const CANDLE_HIDDEN = { upColor: "rgba(0,0,0,0)", downColor: "rgba(0,0,0,0)",
    wickUpColor: "rgba(0,0,0,0)", wickDownColor: "rgba(0,0,0,0)", borderVisible: false };
  const candle = chart.addCandlestickSeries(CANDLE_ON);
  const vol = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
  // 1-min volume delta panel (DeepCharts bottom panel). Empty when the study is off.
  const d1m = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "d1m" });

  // session VWAP + dotted σ bands (server-computed, no-lookahead; gated &vwap=1).
  const Dotted = LightweightCharts.LineStyle.Dotted;
  const mkLine = (color, width, style) => chart.addLineSeries({
    color, lineWidth: width, lineStyle: style,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  });
  const vwapLine = mkLine(COL.orange, 2, LightweightCharts.LineStyle.Solid);
  const vwapB = [
    mkLine("rgba(153,217,234,.85)", 1, Dotted),   // +1σ
    mkLine("rgba(153,217,234,.85)", 1, Dotted),   // −1σ
    mkLine("rgba(153,217,234,.45)", 1, Dotted),   // +2σ
    mkLine("rgba(153,217,234,.45)", 1, Dotted),   // −2σ
  ];

  function updateScaleMargins() {
    const d1on = !!p.studies.d1;
    vol.priceScale().applyOptions({ scaleMargins: d1on
      ? { top: 0.68, bottom: 0.18 } : { top: 0.86, bottom: 0 } });
    d1m.priceScale().applyOptions({ scaleMargins: { top: 0.86, bottom: 0.02 } });
  }
  updateScaleMargins();

  p.chart = chart; p.candle = candle;

  // ---- bar rendering (delta-colored candles are per-bar color overrides) ----
  const dcCols = (b) => (b.delta == null || b.delta >= 0)
    ? { color: COL.green, wickColor: COL.green, borderColor: COL.green }
    : { color: COL.purpleDeep, wickColor: COL.purple, borderColor: COL.purple };
  const volCol = (b) => {
    if (p.studies.dc) return (b.delta == null || b.delta >= 0)
      ? "rgba(0,211,1,.45)" : "rgba(142,58,227,.45)";
    return b.close >= b.open ? "rgba(0,211,1,.45)" : "rgba(255,0,26,.45)";
  };
  // footprint & bid/ask replace the fat candles with thin canvas skeletons —
  // the series is hidden via transparent options. Per-bar delta colors would
  // OVERRIDE those options, so delta coloring is suppressed while either is on.
  const skeletonOn = () => !!(p.studies.fp || p.studies.ba);
  const candleBar = (b) => {
    const base = { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close };
    return (p.studies.dc && !skeletonOn()) ? Object.assign(base, dcCols(b)) : base;
  };
  function syncCandleSkin() {
    candle.applyOptions(skeletonOn() ? CANDLE_HIDDEN : CANDLE_ON);
    if (p.studies.dc) p.fullReload();   // rebuild per-bar colors for the new skin
  }

  p.applyBars = (bars, replace) => {
    if (replace) {
      candle.setData(bars.map(candleBar));
      vol.setData(bars.map((b) => ({ time: b.time, value: b.volume, color: volCol(b) })));
      if (bars.length) p.lastBarTime = bars[bars.length - 1].time;
    } else {
      for (const b of bars) {
        candle.update(candleBar(b));
        vol.update({ time: b.time, value: b.volume, color: volCol(b) });
      }
      if (bars.length) p.lastBarTime = Math.max(p.lastBarTime || 0, bars[bars.length - 1].time);
    }
  };

  // ---- poll (one tick of this pane's tape) ----
  p.polling = false;
  p.poll = async (isMain) => {
    if (!haveSession || p.polling) return;
    p.polling = true;
    try {
      // Inclusive server filter (time >= since): request from the current last bar
      // so it refreshes the still-forming bucket in place and appends newer ones.
      const wasEmpty = p.lastBarTime === null;
      const since = wasEmpty ? "" : p.lastBarTime;
      const extra = (isMain && flowOn ? "&flow=1" : "") + (isMain && heatOn ? "&heat=1" : "")
        + (p.studies.vwap ? "&vwap=1" : "");
      const r = await api(`/api/bars?tf=${p.tf}&since=${since}${extra}`);
      if (r.ok) {
        p.applyBars(r.bars || [], wasEmpty);
        if (wasEmpty) chart.timeScale().scrollToPosition(6, false);
        if (p.studies.vwap) p.renderVwap(r);
        if (isMain) renderState(r);
        if (p.studies.fp) p.fetchFootprint();
        if (p.studies.d1) p.pollDelta();
        if (r.ended && !ended) onEnded();
      }
    } catch (e) { /* transient */ }
    p.polling = false;
  };

  // Drop all pane data without fetching — used when a NEW SESSION starts while
  // this pane is hidden, so a stale lastBarTime can never poison candle.update()
  // ("Cannot update oldest data") when the pane is shown again.
  p.reset = () => {
    p.lastBarTime = null;
    p.vwapClear();
    p.d1LastT = null; d1m.setData([]);
    candle.setData([]); vol.setData([]);
    p.fpData = []; if (fpCtx) fpCtx.clearRect(0, 0, fpW, fpH);
    p.vpData = null; if (vpCtx) vpCtx.clearRect(0, 0, vpW, vpH);
    p.baBars = []; if (baCtx) baCtx.clearRect(0, 0, baW, baH);
  };

  p.fullReload = async () => {
    p.reset();
    const r = await api(`/api/bars?tf=${p.tf}&since=` + (p.studies.vwap ? "&vwap=1" : ""));
    if (r.ok) {
      p.applyBars(r.bars || [], true);
      if (p.studies.vwap) p.renderVwap(r);
      chart.timeScale().scrollToPosition(6, false);
    }
  };

  // ---- VWAP + bands (built LIVE: each poll appends the current value) ----
  p.renderVwap = (s) => {
    const v = s ? s.vwap : undefined;
    if (v === null || v === undefined || p.lastBarTime === null) return;
    if (p.vwapLastT !== null && p.lastBarTime < p.vwapLastT) return;  // never go back in time
    vwapLine.update({ time: p.lastBarTime, value: v });
    const sd = s.vwap_sd;
    if (sd !== null && sd !== undefined) {
      vwapB[0].update({ time: p.lastBarTime, value: v + sd });
      vwapB[1].update({ time: p.lastBarTime, value: v - sd });
      vwapB[2].update({ time: p.lastBarTime, value: v + 2 * sd });
      vwapB[3].update({ time: p.lastBarTime, value: v - 2 * sd });
    }
    p.vwapLastT = p.lastBarTime;
  };
  p.vwapClear = () => {
    vwapLine.setData([]);
    vwapB.forEach((b) => b.setData([]));
    p.vwapLastT = null;
  };

  // ---- 1-min volume delta panel ----
  p.deltaFetching = false;
  p.pollDelta = async () => {
    if (!p.studies.d1 || !haveSession || p.deltaFetching) return;
    p.deltaFetching = true;
    try {
      const since = p.d1LastT === null ? "" : p.d1LastT;
      const r = await api(`/api/bars?tf=1m&since=${since}`);
      if (r.ok) {
        for (const b of (r.bars || [])) {
          d1m.update({ time: b.time, value: b.delta == null ? 0 : b.delta,
            color: (b.delta == null || b.delta >= 0) ? "rgba(0,211,1,.8)" : "rgba(255,0,26,.8)" });
          p.d1LastT = Math.max(p.d1LastT || 0, b.time);
        }
      }
    } catch (e) { /* transient */ }
    p.deltaFetching = false;
  };

  // ---- canvas helpers ----
  function sizeCanvas(cv) {
    const wrap = q(".chartwrap");
    const w = wrap.clientWidth, h = wrap.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = w + "px"; cv.style.height = h + "px";
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }
  const _median = (a) => {
    const v = a.filter((x) => isFinite(x)).sort((x, y) => x - y);
    return v.length ? v[v.length >> 1] : NaN;
  };

  // ── shared per-bar level renderer (footprint heat + bid/ask ladder) ────────
  // ZOOM-ADAPTIVE BUCKETING: adjacent price levels merge into coarser buckets so
  // each rendered row keeps ~ROW_TARGET_PX height — native 0.25-tick rows fully
  // zoomed in, then 0.5 → 1pt → 2.5pt → 5pt… steps zoomed out. Displayed numbers
  // are the TRUE SUMS of the merged levels (binCells conserves volume exactly:
  // every native cell maps to exactly one bucket). Bars and numbers always come
  // from the SAME buckets, and the 3:1 diagonal imbalance is evaluated on the
  // bucketed sums. Numbers sit at the bar ends: bid (sell) LEFT of the red bar,
  // ask (buy) RIGHT of the green bar, abbreviated (1.2k) with an 8px font floor.
  const ROW_TARGET_PX = 12;
  const BIN_SNAPS = [1, 2, 4, 10, 20, 40, 100, 200, 400];   // ticks: .25→.5→1pt→2.5→5→10→25→50→100pt
  function snapBin(t) {
    for (const s of BIN_SNAPS) if (t <= s) return s;
    return BIN_SNAPS[BIN_SNAPS.length - 1];
  }
  // Bucket key = floor(priceTicks / binTicks) on the absolute tick grid, so
  // buckets align across bars and across zoom levels.
  function binCells(cells, binTicks) {
    const bins = new Map();
    for (const c of cells) {
      const pt = Math.round(c.p / 0.25);                 // display price -> integer ticks
      const k = Math.floor(pt / binTicks);
      let e = bins.get(k);
      if (!e) { e = { k, b: 0, s: 0 }; bins.set(k, e); }
      e.b += c.b; e.s += c.s;
    }
    return bins;
  }
  const fmtVol = (n) => (n >= 100000 ? (n / 1000).toFixed(0) + "k"
    : n >= 10000 ? (n / 1000).toFixed(1) + "k" : String(n));
  const MONO = "ui-monospace,Menlo,Consolas,monospace";

  function drawLevelRows(ctx, x, cells, opts) {
    const { cellW, ppt, drawNums } = opts;
    const binTicks = snapBin(Math.max(1, Math.ceil(ROW_TARGET_PX / ppt)));
    const rowPx = Math.max(1, binTicks * ppt);
    const bins = binCells(cells, binTicks);
    let pocK = null, maxTot = 1;
    for (const e of bins.values()) {
      const t = e.b + e.s;
      if (t > maxTot) { maxTot = t; pocK = e.k; }
    }
    const half = cellW / 2;
    // reserve a number column at each side so bar-end numbers never spill into
    // the neighboring bar's columns
    const numW = drawNums ? Math.max(20, Math.min(34, half * 0.35)) : 0;
    const bandW = Math.max(2, half * 0.92 - numW);
    const fs = Math.max(8, Math.min(11, Math.round(rowPx) - 2));
    ctx.font = `${fs}px ${MONO}`;
    ctx.textBaseline = "middle";
    for (const e of bins.values()) {
      const centerPt = e.k * binTicks + (binTicks - 1) / 2;   // bucket center, ticks
      const y = candle.priceToCoordinate(centerPt * 0.25);
      if (y == null) continue;                                // off-screen row culled
      const top = y - rowPx / 2;
      const rh = Math.max(1, rowPx - (rowPx > 3 ? 1 : 0));
      const sellW = (e.s / maxTot) * bandW;
      const buyW = (e.b / maxTot) * bandW;
      ctx.fillStyle = "rgba(255,0,26,.55)";
      ctx.fillRect(x - sellW, top + 0.5, sellW, rh);
      ctx.fillStyle = "rgba(33,213,1,.50)";
      ctx.fillRect(x, top + 0.5, buyW, rh);
      if (e.k === pocK) {   // magenta POC row (max bucketed total volume)
        ctx.fillStyle = "rgba(233,7,126,.30)";
        ctx.fillRect(x - half, top, cellW, rowPx);
        ctx.strokeStyle = COL.magenta; ctx.lineWidth = 1;
        ctx.strokeRect(x - half + 0.5, top + 0.5, cellW - 1, Math.max(1, rowPx - 1));
      }
      if (!drawNums) continue;
      // diagonal imbalance (>=3:1) on the ACTIVE bucket resolution:
      // ask(buy)[k] vs bid(sell) one bucket up; bid(sell)[k] vs ask(buy) one down
      const above = bins.get(e.k + 1);
      const below = bins.get(e.k - 1);
      const askImb = e.b > 0 && above && above.s > 0 && e.b >= 3 * above.s;
      const bidImb = e.s > 0 && below && below.b > 0 && e.s >= 3 * below.b;
      ctx.textAlign = "right";
      ctx.fillStyle = bidImb ? COL.gold : "#e8e8e8";
      if (bidImb) ctx.font = `bold ${fs}px ${MONO}`;
      ctx.fillText(fmtVol(e.s), x - sellW - 3, y);
      if (bidImb) ctx.font = `${fs}px ${MONO}`;
      ctx.textAlign = "left";
      ctx.fillStyle = askImb ? COL.gold : "#e8e8e8";
      if (askImb) ctx.font = `bold ${fs}px ${MONO}`;
      ctx.fillText(fmtVol(e.b), x + buyW + 3, y);
      if (askImb) ctx.font = `${fs}px ${MONO}`;
    }
  }

  // ── footprint overlay — Volumetrica heat cells ─────────────────────────────
  // Per-bar buy×sell volume by price level: red sell-heat bars left of the bar
  // center, green buy-heat right, magenta POC row, gold imbalance numbers.
  // Zoomed out -> thick magenta POC dash per bar (like the 15m reference pane).
  const fpcv = q(".fpcanvas");
  let fpCtx = null, fpW = 0, fpH = 0;
  function fpResize() { const s = sizeCanvas(fpcv); fpCtx = s.ctx; fpW = s.w; fpH = s.h; }

  p.fetchFootprint = async () => {
    if (!p.studies.fp || !haveSession || p.fpFetching) return;
    const vr = chart.timeScale().getVisibleRange();
    if (!vr) return;
    p.fpFetching = true;
    try {
      const from = Math.floor(vr.from) - p.tfSec() * 2;
      const to = Math.ceil(vr.to) + p.tfSec() * 2;
      const [r, rb] = await Promise.all([
        api(`/api/footprint?tf=${p.tf}&from=${from}&to=${to}`),
        api(`/api/bars?tf=${p.tf}&since=${from}`),
      ]);
      if (r.ok) {
        const fp = r.fp || [];
        if (rb && rb.ok) {
          const ohlc = {};
          for (const bar of (rb.bars || [])) ohlc[bar.time] = bar;
          for (const b of fp) {
            const o = ohlc[b.time];
            if (o) { b.open = o.open; b.high = o.high; b.low = o.low; b.close = o.close; }
          }
        }
        p.fpData = fp;
        drawFootprint();
      }
    } catch (e) { /* transient */ }
    p.fpFetching = false;
  };

  function drawFootprint() {
    if (!p.studies.fp || !fpCtx) return;
    fpCtx.clearRect(0, 0, fpW, fpH);
    if (!p.fpData.length) return;
    const ts = chart.timeScale();
    const xs = p.fpData.map((b) => ts.timeToCoordinate(b.time));
    const gaps = [];
    for (let i = 1; i < xs.length; i++)
      if (xs[i] != null && xs[i - 1] != null) gaps.push(xs[i] - xs[i - 1]);
    let cellW = _median(gaps);
    if (!isFinite(cellW) || cellW <= 0) cellW = (ts.options().barSpacing || 8);
    // pixels per 0.25-tick price level (probe off the first bar's first cell)
    let ppt = 0;
    const probe = p.fpData.find((b) => b.cells && b.cells.length);
    if (probe) {
      const pp = probe.cells[0].p;
      const y0 = candle.priceToCoordinate(pp), y1 = candle.priceToCoordinate(pp + 0.25);
      if (y0 != null && y1 != null) ppt = Math.abs(y0 - y1);
    }
    // three zoom regimes (matches the Volumetrica reference):
    //   numbers+heat (zoom-adaptive buckets) when the column is wide enough ·
    //   heat-only bucketed bars when narrow (the 15m-pane look: continuous
    //   red/green heat + magenta POC) · bare magenta POC dash when bars are
    //   too narrow for anything. Vertical resolution always comes from
    //   drawLevelRows' adaptive bucketing — numbers are true bucket sums.
    const drawNums = cellW >= 56 && ppt >= 0.4;
    const drawCells = cellW >= 8 && ppt >= 0.4;
    const half = cellW / 2;

    for (const b of p.fpData) {
      const x = ts.timeToCoordinate(b.time);
      if (x == null) continue;
      // thin candle skeleton — the real series is transparent while footprint
      // is on, so price action stays readable under the heat (Volumetrica look)
      if (b.open != null && b.high != null) {
        const yO = candle.priceToCoordinate(b.open), yC = candle.priceToCoordinate(b.close);
        const yH = candle.priceToCoordinate(b.high), yL = candle.priceToCoordinate(b.low);
        if (yO != null && yC != null && yH != null && yL != null) {
          const col = p.studies.dc ? (b.delta >= 0 ? COL.green : COL.purple)
            : (b.close >= b.open ? COL.green : COL.red);
          const tw = Math.max(2, Math.min(6, Math.round(cellW * 0.10)));
          fpCtx.strokeStyle = col; fpCtx.lineWidth = 1;
          fpCtx.beginPath(); fpCtx.moveTo(x + 0.5, yH); fpCtx.lineTo(x + 0.5, yL); fpCtx.stroke();
          fpCtx.fillStyle = col;
          fpCtx.fillRect(Math.round(x - tw / 2), Math.min(yO, yC), tw, Math.max(1, Math.abs(yC - yO)));
        }
      }
      if (drawCells && b.cells && b.cells.length) {
        drawLevelRows(fpCtx, x, b.cells, { cellW, ppt, drawNums });
      } else if (b.poc != null) {
        // not zoomed enough for cells — thick magenta POC dash (reference look)
        const y = candle.priceToCoordinate(b.poc);
        if (y != null) {
          fpCtx.fillStyle = COL.magenta;
          fpCtx.fillRect(x - Math.max(3, half * 0.7), y - 1.5, Math.max(6, cellW * 0.7), 3);
        }
      }
      // per-bar delta: above the candle's high if bullish, below the low if
      // bearish — only when columns are wide enough to stay readable
      if (cellW < 28) continue;
      fpCtx.font = `10px ${MONO}`;
      fpCtx.textAlign = "center";
      fpCtx.fillStyle = b.delta >= 0 ? COL.fpGreen : COL.red;
      const dTxt = (b.delta > 0 ? "+" : "") + b.delta;
      if (b.open != null && b.close != null) {
        const yH = candle.priceToCoordinate(b.high);
        const yL = candle.priceToCoordinate(b.low);
        if (b.close >= b.open && yH != null) {        // bullish -> top of candle
          fpCtx.textBaseline = "bottom"; fpCtx.fillText(dTxt, x, yH - 4);
        } else if (b.close < b.open && yL != null) {  // bearish -> bottom of candle
          fpCtx.textBaseline = "top"; fpCtx.fillText(dTxt, x, yL + 4);
        } else {
          fpCtx.textBaseline = "bottom"; fpCtx.fillText(dTxt, x, fpH - 3);
        }
      } else {
        fpCtx.textBaseline = "bottom"; fpCtx.fillText(dTxt, x, fpH - 3);
      }
    }
  }

  let fpSched = null;
  function fpScheduleFetch() {
    if (!p.studies.fp) return;
    if (fpSched) clearTimeout(fpSched);
    fpSched = setTimeout(p.fetchFootprint, 70);
  }

  // ── volume profile overlay — Volumetrica left-edge profile ─────────────────
  // Blue (#2c7fff) rows anchored to the chart's left edge by default, gold POC
  // line, optional buy/sell split + VA shading. Server side reuses the same
  // no-lookahead footprint aggregation.
  const vpcv = q(".vpcanvas");
  let vpCtx = null, vpW = 0, vpH = 0;
  function vpResize() { const s = sizeCanvas(vpcv); vpCtx = s.ctx; vpW = s.w; vpH = s.h; }

  const vpCfg = store.json(KEY("vpcfg"), { mode: "rolling", rollMin: 30, rows: 48,
    va: 70, width: 24, opacity: 80, side: "left", band: false, split: false, poc: true });
  function vpLoadCfg() {
    q(".vpMode").value = vpCfg.mode; q(".vpRollMin").value = vpCfg.rollMin;
    q(".vpRows").value = vpCfg.rows; q(".vpVA").value = vpCfg.va;
    q(".vpWidth").value = vpCfg.width; q(".vpOpacity").value = vpCfg.opacity;
    q(".vpSide").value = vpCfg.side;
    q(".vpVAband").checked = vpCfg.band; q(".vpSplit").checked = vpCfg.split;
    q(".vpShowPoc").checked = vpCfg.poc;
  }
  function vpSaveCfg() {
    vpCfg.mode = q(".vpMode").value;
    vpCfg.rollMin = Math.max(1, +q(".vpRollMin").value || 30);
    vpCfg.rows = Math.max(0, +q(".vpRows").value || 0);
    vpCfg.va = Math.min(100, Math.max(0, +q(".vpVA").value || 70));
    vpCfg.width = Math.min(60, Math.max(5, +q(".vpWidth").value || 24));
    vpCfg.opacity = Math.min(100, Math.max(10, +q(".vpOpacity").value || 80));
    vpCfg.side = q(".vpSide").value;
    vpCfg.band = q(".vpVAband").checked;
    vpCfg.split = q(".vpSplit").checked;
    vpCfg.poc = q(".vpShowPoc").checked;
    store.set(KEY("vpcfg"), JSON.stringify(vpCfg));
  }

  p.vpFetch = async () => {
    if (!p.studies.vp || !haveSession || p.vpFetching) return;
    p.vpFetching = true;
    try {
      let from = "", to = "";
      if (vpCfg.mode === "visible") {
        const vr = chart.timeScale().getVisibleRange();
        if (vr) { from = Math.floor(vr.from); to = Math.ceil(vr.to); }
      } else if (vpCfg.mode === "rolling") {
        if (p.lastBarTime != null) { to = Math.ceil(p.lastBarTime); from = to - vpCfg.rollMin * 60; }
      }
      const r = await api(`/api/volprofile?tf=${p.tf}&from=${from}&to=${to}&rows=${vpCfg.rows}&va=${vpCfg.va}`);
      if (r.ok) { p.vpData = r; vpDraw(); }
    } catch (e) { /* transient */ }
    p.vpFetching = false;
  };

  function vpDraw() {
    if (!p.studies.vp || !vpCtx) return;
    vpCtx.clearRect(0, 0, vpW, vpH);
    if (!p.vpData || !p.vpData.levels || !p.vpData.levels.length) return;
    const L = p.vpData.levels;
    const maxV = L.reduce((m, x) => (x.v > m ? x.v : m), 0) || 1;
    const ys = L.map((x) => candle.priceToCoordinate(x.p));
    const gaps = [];
    for (let i = 1; i < ys.length; i++)
      if (ys[i] != null && ys[i - 1] != null) gaps.push(Math.abs(ys[i] - ys[i - 1]));
    gaps.sort((a, b) => a - b);
    let rowH = gaps.length ? gaps[gaps.length >> 1] : 4;
    if (!isFinite(rowH) || rowH <= 0) rowH = 4;
    const barH = Math.max(1, rowH * 0.86);
    const axisPad = 58;
    const plotW = Math.max(40, vpW - axisPad);
    const maxLen = plotW * (vpCfg.width / 100);
    const op = vpCfg.opacity / 100;
    const anchorRight = vpCfg.side === "right";
    const xEdge = anchorRight ? (vpW - axisPad) : 2;
    if (vpCfg.band && p.vpData.vah != null && p.vpData.val != null) {
      const yT = candle.priceToCoordinate(p.vpData.vah);
      const yB = candle.priceToCoordinate(p.vpData.val);
      if (yT != null && yB != null) {
        vpCtx.fillStyle = `rgba(44,127,255,${0.07 * op})`;
        vpCtx.fillRect(0, Math.min(yT, yB) - barH / 2, vpW, Math.abs(yB - yT) + barH);
      }
    }
    for (const lv of L) {
      const y = candle.priceToCoordinate(lv.p);
      if (y == null) continue;
      const len = (lv.v / maxV) * maxLen;
      const top = y - barH / 2;
      const inVA = p.vpData.vah != null && lv.p <= p.vpData.vah + 1e-6 && lv.p >= p.vpData.val - 1e-6;
      const a = (inVA ? 1 : 0.55) * op;
      if (vpCfg.split && lv.v > 0) {
        const buyLen = len * (lv.b / lv.v), sellLen = len - buyLen;
        if (anchorRight) {
          let x = xEdge;
          vpCtx.fillStyle = `rgba(0,211,1,${a})`; vpCtx.fillRect(x - buyLen, top, buyLen, barH); x -= buyLen;
          vpCtx.fillStyle = `rgba(255,0,26,${a})`; vpCtx.fillRect(x - sellLen, top, sellLen, barH);
        } else {
          let x = xEdge;
          vpCtx.fillStyle = `rgba(0,211,1,${a})`; vpCtx.fillRect(x, top, buyLen, barH); x += buyLen;
          vpCtx.fillStyle = `rgba(255,0,26,${a})`; vpCtx.fillRect(x, top, sellLen, barH);
        }
      } else {
        vpCtx.fillStyle = `rgba(44,127,255,${a})`;
        vpCtx.fillRect(anchorRight ? xEdge - len : xEdge, top, len, barH);
      }
    }
    if (vpCfg.poc && p.vpData.poc != null) {
      const y = candle.priceToCoordinate(p.vpData.poc);
      if (y != null) {
        vpCtx.strokeStyle = `rgba(241,177,0,${Math.min(1, op + 0.1)})`;   // gold POC
        vpCtx.lineWidth = 1.5;
        vpCtx.beginPath(); vpCtx.moveTo(0, y); vpCtx.lineTo(vpW, y); vpCtx.stroke();
      }
    }
  }

  let vpSched = null;
  function vpScheduleFetch() {
    if (!p.studies.vp || vpCfg.mode !== "visible") return;
    if (vpSched) clearTimeout(vpSched);
    vpSched = setTimeout(p.vpFetch, 90);
  }

  // ── bid / ask per-candle ladder ─────────────────────────────────────────────
  // Thin custom candles + per-level bid (left, red) / ask (right) volume numbers,
  // magenta POC band. Adaptive level binning keeps row height ~constant.
  const bacv = q(".bacanvas");
  let baCtx = null, baW = 0, baH = 0;
  function baResize() { const s = sizeCanvas(bacv); baCtx = s.ctx; baW = s.w; baH = s.h; }

  p.baFetch = async () => {
    if (!p.studies.ba || !haveSession || p.baFetching) return;
    const vr = chart.timeScale().getVisibleRange();
    // No mappable range — keep drawing what we have and bail WITHOUT setting the
    // in-flight guard, so the next zoom/interval retries cleanly.
    if (!vr) { baDraw(); return; }
    p.baFetching = true;
    try {
      const from = Math.floor(vr.from) - p.tfSec() * 2;
      const to = Math.ceil(vr.to) + p.tfSec() * 2;
      const [rb, rf] = await Promise.all([
        api(`/api/bars?tf=${p.tf}&since=${from}`),
        api(`/api/footprint?tf=${p.tf}&from=${from}&to=${to}`),
      ]);
      const fp = {};
      if (rf && rf.ok) for (const b of (rf.fp || [])) {
        fp[b.time] = { cells: b.cells || [], poc: b.poc };
      }
      if (rb && rb.ok) {
        p.baBars = (rb.bars || [])
          .filter((b) => b.time >= from - 1 && b.time <= to + 1)
          .map((b) => Object.assign({}, b, fp[b.time] || { cells: [], poc: null }));
      }
      baDraw();
    } catch (e) { /* transient */ }
    finally { p.baFetching = false; }   // ALWAYS release the guard
  };

  function baDraw() {
    if (!p.studies.ba || !baCtx) return;
    try {
      baCtx.clearRect(0, 0, baW, baH);
      if (!p.baBars.length) return;
      const ts = chart.timeScale();
      const xs = p.baBars.map((b) => ts.timeToCoordinate(b.time));
      const gaps = [];
      for (let i = 1; i < xs.length; i++)
        if (xs[i] != null && xs[i - 1] != null) gaps.push(xs[i] - xs[i - 1]);
      gaps.sort((a, b) => a - b);
      let cellW = gaps.length ? gaps[gaps.length >> 1] : (ts.options().barSpacing || 8);
      if (!isFinite(cellW) || cellW <= 0) cellW = 8;
      const tw = Math.max(2, Math.min(7, Math.round(cellW * 0.18)));   // thin body width
      let ppt = 0;
      for (const b of p.baBars) {
        const y0 = candle.priceToCoordinate(b.close), y1 = candle.priceToCoordinate(b.close + 0.25);
        if (y0 != null && y1 != null && Math.abs(y0 - y1) > 0) { ppt = Math.abs(y0 - y1); break; }
      }
      if (ppt <= 0) ppt = 1;
      const drawNums = cellW >= 56;
      for (let bi = 0; bi < p.baBars.length; bi++) {
        const b = p.baBars[bi];
        const x = ts.timeToCoordinate(b.time);
        if (x == null) continue;
        const yO = candle.priceToCoordinate(b.open), yC = candle.priceToCoordinate(b.close);
        const yH = candle.priceToCoordinate(b.high), yL = candle.priceToCoordinate(b.low);
        if (yO == null || yC == null || yH == null || yL == null) continue;
        const up = b.close >= b.open;
        const col = up ? COL.green : COL.red;
        baCtx.strokeStyle = col; baCtx.lineWidth = 1;
        baCtx.beginPath(); baCtx.moveTo(x + 0.5, yH); baCtx.lineTo(x + 0.5, yL); baCtx.stroke();
        const bodyTop = Math.min(yO, yC), bodyH = Math.max(1, Math.abs(yC - yO));
        baCtx.fillStyle = col; baCtx.fillRect(Math.round(x - tw / 2), bodyTop, tw, bodyH);

        if (!b.cells || !b.cells.length) continue;
        // shared zoom-adaptive renderer: bucketed bid/ask bars + true-sum
        // numbers at the bar ends + 3:1 imbalance on the active resolution
        drawLevelRows(baCtx, x, b.cells, { cellW, ppt, drawNums });
      }
    } catch (e) { /* never let a draw error kill the study */ }
  }

  let baSched = null;
  function baScheduleFetch() {
    if (!p.studies.ba) return;
    if (baSched) clearTimeout(baSched);
    baSched = setTimeout(p.baFetch, 70);
  }

  // ---- studies toggles ----
  const stBtns = {
    fp: q(".st-foot"), vp: q(".st-vp"), ba: q(".st-ba"),
    vwap: q(".st-vwap"), dc: q(".st-dc"), d1: q(".st-d1"),
  };
  function saveStudies() { store.set(KEY("studies"), JSON.stringify(p.studies)); }
  function refreshStudyBtns() {
    for (const [k, b] of Object.entries(stBtns)) b.classList.toggle("active", !!p.studies[k]);
  }

  p.setStudy = (k, on) => {
    p.studies[k] = !!on;
    refreshStudyBtns(); saveStudies();
    if (k === "fp") {
      fpcv.classList.toggle("hidden", !on);
      syncCandleSkin();
      if (on) { fpResize(); p.fetchFootprint(); }
      else { p.fpData = []; if (fpCtx) fpCtx.clearRect(0, 0, fpW, fpH); }
    } else if (k === "vp") {
      vpcv.classList.toggle("hidden", !on);
      if (on) { vpResize(); p.vpFetch(); }
      else { p.vpData = null; if (vpCtx) vpCtx.clearRect(0, 0, vpW, vpH); }
    } else if (k === "ba") {
      bacv.classList.toggle("hidden", !on);
      syncCandleSkin();
      if (on) { baResize(); p.baFetch(); }
      else { p.baBars = []; if (baCtx) baCtx.clearRect(0, 0, baW, baH); }
    } else if (k === "vwap") {
      if (!on) p.vwapClear();      // poll drops &vwap=1 -> server skips calc
    } else if (k === "dc") {
      p.fullReload();              // re-set data with/without per-bar colors
    } else if (k === "d1") {
      updateScaleMargins();
      if (on) { p.d1LastT = null; p.pollDelta(); }
      else { d1m.setData([]); p.d1LastT = null; }
    }
  };
  for (const [k, b] of Object.entries(stBtns)) b.onclick = () => p.setStudy(k, !p.studies[k]);

  // studies dropdown open/close
  const stMenu = q(".studies-menu");
  q(".studies-btn").onclick = (e) => { e.stopPropagation(); stMenu.classList.toggle("hidden"); };
  document.addEventListener("click", (e) => {
    if (!host.querySelector(".studies-wrap").contains(e.target)) stMenu.classList.add("hidden");
  });

  // vp config popup
  q(".st-vpcfg").onclick = (e) => { e.stopPropagation(); q(".vpcfg").classList.toggle("hidden"); };
  ["vpMode", "vpRollMin", "vpRows", "vpVA", "vpWidth", "vpOpacity", "vpSide",
   "vpVAband", "vpSplit", "vpShowPoc"].forEach((cls) => {
    const el = q("." + cls); if (!el) return;
    el.addEventListener("change", () => {
      vpSaveCfg();
      if (["vpRows", "vpVA", "vpMode", "vpRollMin"].includes(cls)) p.vpFetch(); else vpDraw();
    });
  });
  vpLoadCfg();

  // ---- TF buttons ----
  const tfLabel = q(".tf-label");
  function refreshTfBtns() {
    host.querySelectorAll(".tf").forEach((b) =>
      b.classList.toggle("active", b.dataset.tf === p.tf));
    tfLabel.textContent = p.tf;
  }
  host.querySelectorAll(".tf").forEach((b) => b.onclick = async () => {
    p.tf = b.dataset.tf;
    store.set(KEY("tf"), p.tf);
    refreshTfBtns();
    p.fpData = []; if (p.studies.fp && fpCtx) fpCtx.clearRect(0, 0, fpW, fpH);
    p.baBars = []; if (p.studies.ba && baCtx) baCtx.clearRect(0, 0, baW, baH);
    await p.fullReload();
    if (p.studies.fp) p.fetchFootprint();
    if (p.studies.vp) p.vpFetch();
    if (p.studies.ba) p.baFetch();
  });
  refreshTfBtns();

  p.setInstrLabel = (instr) => {
    q(".instr-chip .sym").textContent = instr === "micro" ? "/MNQ" : "/NQ";
  };

  // ---- position price lines ----
  p.clearPosLines = () => { p.posLines.forEach((l) => candle.removePriceLine(l)); p.posLines = []; };
  p.drawPosLines = (pos) => {
    p.clearPosLines();
    if (!pos) return;
    p.posLines.push(candle.createPriceLine({ price: pos.entry, color: "#9a9a9a",
      lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "entry" }));
    if (pos.stop !== null) p.posLines.push(candle.createPriceLine({ price: pos.stop,
      color: COL.red, lineStyle: 0, lineWidth: 1, axisLabelVisible: true, title: "stop" }));
    if (pos.target !== null) p.posLines.push(candle.createPriceLine({ price: pos.target,
      color: COL.green, lineStyle: 0, lineWidth: 1, axisLabelVisible: true, title: "target" }));
    if (pos.trail_armed && pos.trail_stop !== null && pos.trail_stop !== undefined)
      p.posLines.push(candle.createPriceLine({ price: pos.trail_stop,
        color: COL.gold, lineStyle: 2, lineWidth: 2, axisLabelVisible: true, title: "trail" }));
  };

  // ---- per-pane zoom persistence ----
  // The pane's barSpacing belongs to the USER: sync never rewrites it, and it
  // survives reloads. Saved debounced on any logical-range change (zoom/scroll).
  const savedZoom = parseFloat(store.get(KEY("zoom"), ""));
  if (isFinite(savedZoom) && savedZoom > 0) {
    try { chart.timeScale().applyOptions({ barSpacing: savedZoom }); } catch (_) {}
  }
  let zoomSaveT = null;
  function saveZoom() {
    if (zoomSaveT) clearTimeout(zoomSaveT);
    zoomSaveT = setTimeout(() => {
      const bs = chart.timeScale().options().barSpacing;
      if (isFinite(bs) && bs > 0) store.set(KEY("zoom"), String(bs));
    }, 300);
  }

  // ---- redraw / refetch subscriptions + live study refresh ----
  chart.timeScale().subscribeVisibleTimeRangeChange(() => {
    if (p.studies.fp) { drawFootprint(); fpScheduleFetch(); }
    if (p.studies.vp) { vpDraw(); vpScheduleFetch(); }
    if (p.studies.ba) { baDraw(); baScheduleFetch(); }
  });
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
    saveZoom();
    if (p.studies.fp) { drawFootprint(); fpScheduleFetch(); }
    if (p.studies.vp) { vpDraw(); vpScheduleFetch(); }
    if (p.studies.ba) { baDraw(); baScheduleFetch(); }
  });
  new ResizeObserver(() => {
    if (p.studies.fp) { fpResize(); drawFootprint(); }
    if (p.studies.vp) { vpResize(); vpDraw(); }
    if (p.studies.ba) { baResize(); baDraw(); }
  }).observe(q(".chartwrap"));
  // throttled live refresh — profiles/ladders grow as new ticks print
  setInterval(() => { if (p.visible() && haveSession) {
    if (p.studies.vp) p.vpFetch();
  } }, 600);
  setInterval(() => { if (p.visible() && haveSession) {
    if (p.studies.ba) p.baFetch();
  } }, 300);

  // ---- restore persisted study visuals ----
  refreshStudyBtns();
  if (p.studies.fp) { fpcv.classList.remove("hidden"); fpResize(); }
  if (p.studies.vp) { vpcv.classList.remove("hidden"); vpResize(); }
  if (p.studies.ba) { bacv.classList.remove("hidden"); baResize(); }
  if (skeletonOn()) candle.applyOptions(CANDLE_HIDDEN);
  updateScaleMargins();

  return p;
}

// ── panes + layout ───────────────────────────────────────────────────────────
// pane0 = main/right chart (default: 5s, delta candles + rolling-30m VP + VWAP —
// the DeepCharts 5m-pane look on the replay TF). pane1 = left context pane
// (default: 15m + footprint, like the left half of the reference screenshot).
const pane0 = makePane(0, $("#pane0"),
  { tf: "5s", studies: { fp: false, vp: true, ba: false, vwap: true, dc: true, d1: false } });
const pane1 = makePane(1, $("#pane1"),
  { tf: "15m", studies: { fp: true, vp: false, ba: false, vwap: false, dc: false, d1: false } });
const panes = [pane0, pane1];

const LAYOUT_KEY = "replay_trader.layout";
let layoutDual = false;
function setLayout(dual, persist = true) {
  layoutDual = !!dual;
  $("#pane1").classList.toggle("hidden", !layoutDual);
  $("#panes").classList.toggle("single", !layoutDual);
  $("#btnLayout").classList.toggle("active", layoutDual);
  $("#btnLayout").textContent = layoutDual ? "▯ Single" : "▯▯ Dual";
  if (persist) store.set(LAYOUT_KEY, layoutDual ? "dual" : "single");
  if (layoutDual && haveSession) {
    // bring the context pane up to date, then co-scroll it to the main pane's
    // moment — its own zoom (barSpacing) is left exactly as the user set it
    pane1.poll(false).then(() => {
      try { alignTime(pane1, rightEdgeTime(pane0)); } catch (_) {}
    });
  }
}
$("#btnLayout").onclick = () => setLayout(!layoutDual);

// ── pane sync: TIME-ONLY co-scroll. Each pane owns its zoom (barSpacing) —
//    sync NEVER rewrites it, it only scrolls the other pane so both look at
//    the same moment (matching right-edge time). Zoom is persisted per pane.
//    Crosshair mirrors to the same time/price (snapped to the other pane's TF).
//    NOTE: setVisibleRange() is applied as a short animation that any series
//    update() (the 140ms poll) cancels — it silently no-ops under a live tape.
//    scrollToPosition(…, false) applies immediately and survives data updates.
//    Programmatic syncs are stamped so the follower's own scroll echo doesn't
//    ping-pong back. ──
let crossBusy = false;
// right-edge TIME of a pane = last bar time + whitespace scroll, in seconds
function rightEdgeTime(p) {
  if (p.lastBarTime == null) return null;
  return p.lastBarTime + p.chart.timeScale().scrollPosition() * p.tfSec();
}
// scroll pane `o` (zoom untouched) so its right edge shows time `t`
function alignTime(o, t) {
  if (t == null || o.lastBarTime == null) return;
  const ts = o.chart.timeScale();
  const pos = (t - o.lastBarTime) / o.tfSec();
  // already aligned (sub-second) — don't echo endlessly between the panes
  if (Math.abs((ts.scrollPosition() - pos) * o.tfSec()) < 0.5) return;
  o._syncStamp = performance.now();
  ts.scrollToPosition(pos, false);
}
function wireSync(src) {
  src.chart.timeScale().subscribeVisibleTimeRangeChange((r) => {
    if (!layoutDual || !r) return;
    // echo of a recent programmatic sync onto this pane — don't propagate back
    if (performance.now() - (src._syncStamp || 0) < 250) return;
    const t = rightEdgeTime(src);
    for (const o of panes) {
      if (o === src || !o.visible()) continue;
      try { alignTime(o, t); } catch (_) { /* tolerate degenerate states */ }
    }
  });
  src.chart.subscribeCrosshairMove((param) => {
    if (!layoutDual || crossBusy) return;
    crossBusy = true;
    try {
      for (const o of panes) {
        if (o === src || !o.visible()) continue;
        if (!param || param.time == null || !param.point) { o.chart.clearCrosshairPosition(); continue; }
        const price = src.candle.coordinateToPrice(param.point.y);
        const t = Math.floor(param.time / o.tfSec()) * o.tfSec();
        if (price != null) o.chart.setCrosshairPosition(price, t, o.candle);
      }
    } catch (_) { /* tolerate off-grid times */ }
    crossBusy = false;
  });
}
panes.forEach(wireSync);

// ── global state rendering ────────────────────────────────────────────────────
function renderState(s) {
  if (!s || !s.ok && !s.session_id) return;
  $("#clock").textContent = s.et_clock || "--:--:--";
  $("#price").textContent = fmt(s.cur_price);
  $("#prog").textContent = (s.progress_pct ?? 0) + "%";
  $("#btnPlay").textContent = s.paused ? "▶ Play" : "⏸ Pause";
  $("#paused-badge").classList.toggle("hidden", !s.paused || ended);
  // position
  const pb = $("#posbody");
  for (const p of panes) p.drawPosLines(s.position && p.visible() ? s.position : null);
  if (s.position) {
    const p = s.position;
    const cls = p.side === "LONG" ? "pos-long" : "pos-short";
    const plcls = p.open_pnl >= 0 ? "pos" : "neg";
    pb.innerHTML =
      `<div class="pl ${plcls}">${money(p.open_pnl)} <span class="muted" style="font-size:12px">`
      + `(${p.open_pnl_ticks >= 0 ? "+" : ""}${fmt(p.open_pnl_ticks, 1)} tk)</span></div>`
      + `<div class="grid">`
      + `<span>Side</span><span class="${cls}">${p.side} ×${p.size}</span>`
      + `<span>Entry</span><span>${fmt(p.entry)}</span>`
      + `<span>Stop</span><span>${p.stop === null ? "—" : fmt(p.stop)}</span>`
      + `<span>Target</span><span>${p.target === null ? "—" : fmt(p.target)}</span>`
      + (p.trail_tk
          ? `<span>Trail</span><span>${p.trail_armed
              ? `<span style="color:#f1b100">armed @ ${p.trail_tk} tk · ${fmt(p.trail_stop)}</span>`
              : `<span class="muted">waiting (+${p.arm_tk || 0})</span>`}</span>`
          : "")
      + `<span>MFE / MAE</span><span>+${fmt(p.mfe, 1)} / ${fmt(p.mae, 1)} tk</span>`
      + `</div>`;
  } else {
    pb.innerHTML = s.pending ? `<span class="muted">order working…</span>` : `<span class="muted">— flat —</span>`;
  }
  // scoreboard
  const st = s.stats || {};
  const sign = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
  $("#stats").innerHTML = [
    ["Trades", st.n ?? 0, ""],
    ["Win rate", (st.wr ?? 0) + "%", ""],
    ["Net P&L", money(st.net), sign(st.net)],
    ["Expectancy/t", money(st.expectancy), sign(st.expectancy)],
    ["Profit factor", st.pf === null ? "—" : (st.pf === Infinity ? "∞" : fmt(st.pf)), ""],
    ["Avg win", money(st.avg_win), "pos"],
    ["Avg loss", money(st.avg_loss), "neg"],
    ["Max drawdown", money(st.max_dd), "neg"],
    ["Coin-flip net", money(st.coinflip_net), sign(st.coinflip_net)],
  ].map(([k, v, c]) => `<tr><td>${k}</td><td class="${c}">${v}</td></tr>`).join("");
  // 3-layer decomposition: expectancy = Day + Your timing + Your direction.
  const hasDecomp = st.day_baseline !== null && st.day_baseline !== undefined
                 && st.selection_skill !== null && st.selection_skill !== undefined;
  if (hasDecomp) {
    const exp = st.expectancy ?? 0;
    const drow = (k, v, hint) =>
      `<div class="drow"><span class="dk">${k}<span class="dh">${hint}</span></span>`
      + `<span class="dv ${sign(v)}">${money(v)}</span></div>`;
    $("#edgebox").innerHTML =
      `<div class="big-edge ${sign(exp)}">${money(exp)}</div>`
      + `<div class="cap">your expectancy / trade</div>`
      + `<div class="decomp">`
      + drow("Day", st.day_baseline, "coin-flip @ random times")
      + drow("Your timing", st.selection_skill, "vs random times")
      + drow("Your direction", st.direction_skill, "vs coin-flip")
      + `</div>`;
  } else {
    const edge = st.edge_vs_coin ?? 0;
    $("#edgebox").innerHTML =
      `<div class="big-edge ${sign(edge)}">${money(edge)}</div>`
      + `<div class="cap">edge / trade vs coin-flip&nbsp;·&nbsp;you ${money(st.expectancy)} − coin ${money(st.coinflip_exp)}</div>`;
  }
  renderFlow(s);
  renderHeat(s);
  renderInstr(s);
}

// ── poll loop ─────────────────────────────────────────────────────────────────
let polling = false;
async function poll() {
  if (!haveSession || polling) return;
  polling = true;
  try {
    await pane0.poll(true);             // main pane carries flow/heat + state render
    if (layoutDual) await pane1.poll(false);
  } catch (e) { /* transient */ }
  polling = false;
}
setInterval(poll, 140);

// ── controls wiring ───────────────────────────────────────────────────────────
$("#btnPlay").onclick = async () => {
  const r = await api("/api/state");
  await post("/api/control", { action: r.paused ? "play" : "pause" });
  poll();
};
document.querySelectorAll(".spd").forEach((b) => b.onclick = async () => {
  document.querySelectorAll(".spd").forEach((x) => x.classList.remove("active"));
  b.classList.add("active");
  await post("/api/control", { action: "speed", speed: +b.dataset.spd });
});
$("#btnJump").onclick = async () => { await post("/api/control", { action: "jump", seconds: 300 }); poll(); };
$("#btnClose").onclick = async () => { const r = await post("/api/control", { action: "to_close" }); renderState(r); poll(); };

// T.Panel show/hide (Volumetrica toolbar button)
const TP_KEY = "replay_trader.tpanel";
function setTPanel(on) {
  $("#side").classList.toggle("hidden", !on);
  $("#btnTPanel").classList.toggle("active", on);
  store.set(TP_KEY, on ? "1" : "0");
}
$("#btnTPanel").onclick = () => setTPanel($("#side").classList.contains("hidden"));
setTPanel(store.get(TP_KEY, "1") !== "0");

// session reads dropdown
$("#btnSessStudies").onclick = (e) => { e.stopPropagation(); $("#sessStudiesMenu").classList.toggle("hidden"); };
document.addEventListener("click", (e) => {
  const w = $("#btnSessStudies").parentElement;
  if (w && !w.contains(e.target)) $("#sessStudiesMenu").classList.add("hidden");
});

// ── bracket tick persistence ───────────────────────────────────────────────────
// Stop/Target are TICK offsets from fill. Remember the last-used values so the
// trader can set them once (e.g. Stop 20 / Trail 6 / Arm 25) and just hit B/S after.
const BR_KEY = "replay_trader.brackets";
function saveBrackets() {
  store.set(BR_KEY, JSON.stringify({
    stop: $("#stop").value, target: $("#target").value,
    trail: $("#trail").value, arm: $("#arm").value,
  }));
}
function loadBrackets() {
  try {
    const v = JSON.parse(store.get(BR_KEY, "null"));
    if (v) {
      if (v.stop !== undefined) $("#stop").value = v.stop;
      if (v.target !== undefined) $("#target").value = v.target;
      if (v.trail !== undefined) $("#trail").value = v.trail;
      if (v.arm !== undefined) $("#arm").value = v.arm;
    }
  } catch (_) { /* ignore */ }
}
$("#stop").addEventListener("change", saveBrackets);
$("#target").addEventListener("change", saveBrackets);
$("#trail").addEventListener("change", saveBrackets);
$("#arm").addEventListener("change", saveBrackets);
document.querySelectorAll(".preset").forEach((b) => b.onclick = () => {
  $("#stop").value = b.dataset.stop;
  $("#target").value = b.dataset.target ?? "";
  if (b.dataset.trail !== undefined) $("#trail").value = b.dataset.trail;
  if (b.dataset.arm !== undefined) $("#arm").value = b.dataset.arm;
  saveBrackets();
});
loadBrackets();

// qty stepper
$("#qtyMinus").onclick = () => { $("#lots").value = Math.max(1, (+$("#lots").value || 1) - 1); };
$("#qtyPlus").onclick = () => { $("#lots").value = Math.max(1, (+$("#lots").value || 1) + 1); };

async function doOrder(side) {
  const size = Math.max(1, +$("#lots").value || 1);
  const stop_tk = $("#stop").value === "" ? null : +$("#stop").value;
  const target_tk = $("#target").value === "" ? null : +$("#target").value;
  const trail_tk = $("#trail").value === "" ? null : +$("#trail").value;
  const arm_tk = $("#arm").value === "" ? null : +$("#arm").value;
  saveBrackets();
  const r = await post("/api/order", { side, size, stop_tk, target_tk, trail_tk, arm_tk });
  flowFlash();           // brief acknowledgment tint — never blocks the trade
  renderState(r); poll();
}
$("#btnBuy").onclick = () => doOrder("buy");
$("#btnSell").onclick = () => doOrder("sell");
$("#btnFlat").onclick = async () => { const r = await post("/api/flatten", {}); renderState(r); poll(); };
$("#btnApply").onclick = async () => {
  const stop_tk = $("#stop").value === "" ? "" : +$("#stop").value;
  const target_tk = $("#target").value === "" ? "" : +$("#target").value;
  const trail_tk = $("#trail").value === "" ? "" : +$("#trail").value;
  const arm_tk = $("#arm").value === "" ? "" : +$("#arm").value;
  saveBrackets();
  const r = await post("/api/modify", { stop_tk, target_tk, trail_tk, arm_tk });
  renderState(r);
};

$("#btnNew").onclick = () => newSession();
$("#modalNew").onclick = () => { $("#overlay").classList.add("hidden"); newSession(); };
$("#modalClose").onclick = () => $("#overlay").classList.add("hidden");

$("#btnEnd").onclick = async () => {
  const r = await post("/api/end_session", {});
  onEnded(r);
};

function onEnded(r) {
  ended = true;
  $("#paused-badge").classList.add("hidden");
  showSummary(r);
}
async function showSummary(r) {
  if (!r) r = await post("/api/end_session", {});
  const st = r.stats || {};
  const rv = r.reveal || {};
  const sign = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
  $("#modalbody").innerHTML =
    `<h2>Session summary</h2>`
    + `<table>`
    + `<tr><td>Hidden date (revealed)</td><td>${rv.date || "—"}</td></tr>`
    + `<tr><td>Price offset (ticks)</td><td>${rv.px_offset_ticks ?? "—"}</td></tr>`
    + `<tr><td>Trades</td><td>${st.n ?? 0}</td></tr>`
    + `<tr><td>Win rate</td><td>${st.wr ?? 0}%</td></tr>`
    + `<tr><td>Net P&L</td><td class="${sign(st.net)}">${money(st.net)}</td></tr>`
    + `<tr><td>Expectancy / trade</td><td class="${sign(st.expectancy)}">${money(st.expectancy)}</td></tr>`
    + `<tr><td>Profit factor</td><td>${st.pf === null ? "—" : (st.pf === Infinity ? "∞" : fmt(st.pf))}</td></tr>`
    + `<tr><td>Max drawdown</td><td class="neg">${money(st.max_dd)}</td></tr>`
    + `<tr><td>Coin-flip net</td><td class="${sign(st.coinflip_net)}">${money(st.coinflip_net)}</td></tr>`
    + `<tr><td><b>Edge / trade vs coin-flip</b></td><td class="${sign(st.edge_vs_coin)}"><b>${money(st.edge_vs_coin)}</b></td></tr>`
    + `</table>`
    + `<p class="muted" style="margin-top:10px">Logged to sessions/session_${r.session_id || ""}.csv / .json</p>`;
  $("#overlay").classList.remove("hidden");
}

async function newSession() {
  const mode = "rth";
  // Send the persisted instrument so the new session is created on the RIGHT
  // contract from the first tick (no micro->mini reset, no timing race).
  const r = await post("/api/new_session", { mode, slip_tk: 1, instrument: instrPref() });
  haveSession = true; ended = false;
  // hidden panes get a hard reset (no fetch) so stale bar times from the old
  // session can never poison the tape when the pane is shown again
  for (const p of panes) { if (p.visible()) await p.fullReload(); else p.reset(); }
  renderState(r);
}

// ── hotkeys ───────────────────────────────────────────────────────────────────
window.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  if (e.code === "Space") { e.preventDefault(); $("#btnPlay").click(); }
  else if (e.key === "b" || e.key === "B") doOrder("buy");
  else if (e.key === "s" || e.key === "S") doOrder("sell");
  else if (e.key === "f" || e.key === "F") $("#btnFlat").click();
  else if (e.key === "9") { e.preventDefault(); $("#btnClose").click(); }
});

// ── flow light ───────────────────────────────────────────────────────────────
// Always-visible toolbar pill = trailing-60s signed order-flow delta (Σ side×size
// over SEEN ticks, server-computed no-lookahead). A PERMISSION read, NOT a signal:
// it never blocks a trade. The server only computes the delta when flow is ON
// (poll appends &flow=1); the per-trade flow_delta_entry is logged server-side at
// fill time REGARDLESS of the toggle (it's the science record). Default ON,
// persisted. No-flicker: DOM touched only when state changes.
const FLOW_KEY = "replay_trader.flow";
let flowOn = true;
const flowEl = $("#flowpill");
let flowLastState = null;
let flowLastLabel = null;
let flowLastVal = null;

function renderFlow(s) {
  if (!flowEl) return;
  if (!flowOn) {
    if (flowLastState !== "off") {
      flowEl.className = "flowpill off";
      $("#flowlabel").textContent = "FLOW";
      $("#flowval").textContent = "off";
      flowLastState = "off"; flowLastLabel = "FLOW"; flowLastVal = "off";
    }
    return;
  }
  const d = s ? s.flow_delta_60s : undefined;
  const thr = (s && s.flow_thresh != null) ? s.flow_thresh : 50;
  let state, label;
  if (d === null || d === undefined) { state = "neutral"; label = "FLOW"; }
  else if (d >= thr)  { state = "long";    label = "LONG"; }
  else if (d <= -thr) { state = "short";   label = "SHORT"; }
  else                { state = "neutral"; label = "FLAT"; }
  if (state !== flowLastState) { flowEl.className = "flowpill " + state; flowLastState = state; }
  if (label !== flowLastLabel) { $("#flowlabel").textContent = label; flowLastLabel = label; }
  const vtxt = (d === null || d === undefined) ? "—" : (d > 0 ? "+" : "") + d;
  if (vtxt !== flowLastVal) { $("#flowval").textContent = vtxt; flowLastVal = vtxt; }
}

function flowFlash() {
  if (!flowEl) return;
  flowEl.classList.remove("flash");
  void flowEl.offsetWidth;           // force reflow so the animation restarts
  flowEl.classList.add("flash");
}

function setFlow(on) {
  flowOn = on;
  $("#btnFlow").classList.toggle("active", on);
  store.set(FLOW_KEY, on ? "1" : "0");
  renderFlow(on ? null : undefined);
}
$("#btnFlow").onclick = () => setFlow(!flowOn);
setFlow(store.get(FLOW_KEY, "1") !== "0");   // default ON

// ── open heat ──────────────────────────────────────────────────────────────────
// Always-visible toolbar pill = 5-min opening-range width in ticks (max−min of PX
// over 09:30:00–09:35:00 ET, server-computed no-lookahead). Live-accumulates until
// the replay clock passes 09:35, then FREEZES. green <250 quiet, amber 250–400,
// red >400 heat protocol. open5m_range is logged into the session JSON stats at
// trade close REGARDLESS of the toggle (the science record). Default ON, persisted.
const HEAT_KEY = "replay_trader.heat";
let heatOn = true;
const heatEl = $("#heatpill");
let heatLastState = null;
let heatLastVal = null;

function renderHeat(s) {
  if (!heatEl) return;
  if (!heatOn) {
    if (heatLastState !== "off") {
      heatEl.className = "heatpill off";
      $("#heatval").textContent = "off";
      heatLastState = "off"; heatLastVal = "off";
    }
    return;
  }
  const r = s ? s.open5m_range : undefined;
  const quiet = (s && s.open_heat_quiet != null) ? s.open_heat_quiet : 250;
  const hot   = (s && s.open_heat_hot   != null) ? s.open_heat_hot   : 400;
  let state;
  if (r === null || r === undefined) state = "neutral";
  else if (r < quiet) state = "quiet";
  else if (r > hot)   state = "hot";
  else                state = "warm";
  if (state !== heatLastState) { heatEl.className = "heatpill " + state; heatLastState = state; }
  const vtxt = (r === null || r === undefined) ? "—" : r + "tk";
  if (vtxt !== heatLastVal) { $("#heatval").textContent = vtxt; heatLastVal = vtxt; }
}

function setHeat(on) {
  heatOn = on;
  $("#btnHeat").classList.toggle("active", on);
  store.set(HEAT_KEY, on ? "1" : "0");
  renderHeat(on ? null : undefined);
}
$("#btnHeat").onclick = () => setHeat(!heatOn);
setHeat(store.get(HEAT_KEY, "1") !== "0");   // default ON

// ── contract selector: Micro (MNQ) ↔ Mini (NQ) ─────────────────────────────
// Pure math switch — micro = 1/10 the $/tick & ~1/3 commission of a mini (10
// micros = 1 mini). DEFAULT: MICRO — the qty selector reads in micros, matching
// the live DeepCharts panel. No new data.
const INSTR_KEY = "replay_trader.instrument";
const instrEl = $("#instrument");
function instrPref() { return store.get(INSTR_KEY, "micro"); }
async function instrApply() {
  store.set(INSTR_KEY, instrEl.value);
  try {
    const r = await post("/api/control", { action: "instrument", instrument: instrEl.value });
    renderState(r);
  } catch (_) {}
}
// SERVER IS THE SOURCE OF TRUTH for the label: the dropdown always mirrors the
// snapshot's instrument, so what the UI shows is exactly what the engine bills.
function renderInstr(s) {
  if (!instrEl || !s || !s.instrument) return;
  if (instrEl.value !== s.instrument) instrEl.value = s.instrument;
  store.set(INSTR_KEY, s.instrument);
  for (const p of panes) p.setInstrLabel(s.instrument);
}
if (instrEl) {
  try { instrEl.value = instrPref(); } catch (_) {}
  instrEl.addEventListener("change", instrApply);
}
panes.forEach((p) => p.setInstrLabel(instrPref()));

// ── boot ─────────────────────────────────────────────────────────────────────
document.querySelector('.spd[data-spd="1"]').classList.add("active");
setLayout(store.get(LAYOUT_KEY, "single") === "dual", false);
newSession();

// debug handle (console-only; nothing reads this)
window.PANES = panes;
