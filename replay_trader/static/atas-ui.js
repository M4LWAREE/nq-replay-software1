/* atas-ui.js — ATAS X chrome layered on top of the working replay engine.
   This file adds NEW UI only and never owns market data: it reuses the panes
   built by app.js (window.PANES) and the same no-lookahead /api endpoints.

   Provides:
     · top-toolbar TF buttons + Configure/Apply dropdown (drive the main pane)
     · zoom-adaptive candle <-> footprint auto-switch on the main pane
     · right-edge DOM / volume ladder (resting volume by price)
     · bottom panes: DOM Strength + Volume / Delta / Session Delta
     · instrument tab bar + decorative toolbar icons

   app.js exposes window.PANES = [pane0, pane1]; pane0 is the main chart. Each
   pane exposes .chart (Lightweight Charts), .candle (series), .tf, .tfSec(),
   .lastBarTime, .setStudy(key,on), .studies, .visible(). We lean on those. */
"use strict";

(function () {
  const $ = (s) => document.querySelector(s);
  const main = () => (window.PANES && window.PANES[0]) || null;

  // tiny JSON fetch that tolerates Python's Infinity/NaN tokens (same as app.js)
  async function api(path) {
    const r = await fetch(path);
    const t = await r.text();
    return JSON.parse(t.replace(/-?\bInfinity\b/g, "null").replace(/\bNaN\b/g, "null"));
  }

  const COL = {
    green: "#1eb87f", red: "#e24556",
    greenA: "rgba(30,184,127,.55)", redA: "rgba(226,69,86,.55)",
    greenDim: "rgba(30,184,127,.32)", redDim: "rgba(226,69,86,.32)",
    vol: "rgba(86,110,150,.6)", volStrong: "rgba(120,150,200,.85)",
    text: "#c7cedb", muted: "#69727f", magenta: "#d6418f",
  };
  const MONO = "ui-monospace,Menlo,Consolas,monospace";
  const curPrice = () => {
    const v = parseFloat(($("#price") && $("#price").textContent) || "");
    return isFinite(v) ? v : null;
  };

  // ── canvas DPR helper ───────────────────────────────────────────────────────
  function fitCanvas(cv) {
    const w = cv.clientWidth, h = cv.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 1. Instrument tab bar (visual — second tab mirrors the contract selector)
  // ════════════════════════════════════════════════════════════════════════════
  document.querySelectorAll(".itab").forEach((tab) => {
    tab.addEventListener("click", (e) => {
      if (e.target.classList.contains("itab-x")) return;
      document.querySelectorAll(".itab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
    });
  });
  const tabAdd = $("#tabAdd");
  if (tabAdd) tabAdd.onclick = () => $("#btnNew") && $("#btnNew").click();

  // ════════════════════════════════════════════════════════════════════════════
  // 2. Top-toolbar TF buttons — reuse each pane's own TF handler by clicking the
  //    matching per-pane .tf button inside pane0 (keeps all of app.js's logic).
  // ════════════════════════════════════════════════════════════════════════════
  function paneTfButton(tf) {
    const host = $("#pane0");
    return host ? host.querySelector(`.tf[data-tf="${tf}"]`) : null;
  }
  function applyTf(tf) {
    const b = paneTfButton(tf);
    if (b) b.click();          // app.js rebuilds bars/studies for the new TF
    syncTfActive();
  }
  function syncTfActive() {
    const p = main(); if (!p) return;
    document.querySelectorAll("#atasTf .tfbtn[data-tf]").forEach((b) =>
      b.classList.toggle("active", b.dataset.tf === p.tf));
    document.querySelectorAll("#tfConfig .tfc[data-tf]").forEach((b) =>
      b.classList.toggle("active", b.dataset.tf === p.tf));
  }
  document.querySelectorAll("#atasTf .tfbtn[data-tf]").forEach((b) =>
    b.onclick = () => applyTf(b.dataset.tf));

  // ── 2b. Timeframe Configure/Apply dropdown ──────────────────────────────────
  const tfCfg = $("#tfConfig");
  let pendingTf = null;
  function openTfCfg() { syncTfActive(); pendingTf = null; tfCfg.classList.remove("hidden"); }
  function closeTfCfg() { tfCfg.classList.add("hidden"); }
  $("#tfConfigBtn").onclick = (e) => {
    e.stopPropagation();
    tfCfg.classList.contains("hidden") ? openTfCfg() : closeTfCfg();
  };
  document.querySelectorAll("#tfConfig .tfc[data-tf]").forEach((b) =>
    b.onclick = () => {
      pendingTf = b.dataset.tf;
      document.querySelectorAll("#tfConfig .tfc[data-tf]").forEach((x) =>
        x.classList.toggle("active", x === b));
    });
  $("#tfConfigApply").onclick = () => { if (pendingTf) applyTf(pendingTf); closeTfCfg(); };
  $("#tfConfigClose").onclick = () => closeTfCfg();
  document.addEventListener("click", (e) => {
    if (tfCfg.classList.contains("hidden")) return;
    if (!tfCfg.contains(e.target) && e.target.id !== "tfConfigBtn") closeTfCfg();
  });

  // ── 2c. fold the main pane's Studies menu into the top "Indicators" button.
  //    The per-pane mini-toolbar is hidden (display:none), so we relocate pane0's
  //    .studies-menu to <body> and pop it under the Indicators button. The menu's
  //    buttons keep the handlers app.js bound to them; a click-capture stops the
  //    menu from closing on each toggle so multiple studies can be flipped.
  const tbIndicators = $("#tbIndicators");
  let studiesMenu = null;
  function setupIndicatorsMenu() {
    if (studiesMenu || !tbIndicators) return !!studiesMenu;
    const menu = document.querySelector("#pane0 .studies-menu");
    if (!menu) return false;
    document.body.appendChild(menu);
    menu.classList.add("hidden", "floating-menu");
    menu.style.position = "fixed";
    menu.style.right = "auto";       // override the .studies-menu right:0 anchor
    menu.style.zIndex = "60";
    menu.addEventListener("click", (e) => e.stopPropagation());  // keep open on toggle
    studiesMenu = menu;
    tbIndicators.onclick = (e) => {
      e.stopPropagation();
      const show = menu.classList.contains("hidden");
      if (show) {
        const r = tbIndicators.getBoundingClientRect();
        menu.style.top = (r.bottom + 6) + "px";
        menu.style.left = Math.min(r.left, window.innerWidth - 200) + "px";
        menu.classList.remove("hidden");
        tbIndicators.classList.add("active");
      } else {
        menu.classList.add("hidden");
        tbIndicators.classList.remove("active");
      }
    };
    document.addEventListener("click", (e) => {
      if (menu.classList.contains("hidden")) return;
      if (!menu.contains(e.target) && e.target !== tbIndicators && !tbIndicators.contains(e.target)) {
        menu.classList.add("hidden"); tbIndicators.classList.remove("active");
      }
    });
    return true;
  }

  const tbEth = $("#tbEth");
  if (tbEth) tbEth.onclick = () => tbEth.classList.toggle("active");

  // ── 2d. drawing rail — decorative single-select highlight ───────────────────
  document.querySelectorAll("#rail .railbtn").forEach((b) => b.onclick = () => {
    document.querySelectorAll("#rail .railbtn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 3. Zoom-adaptive candle <-> footprint on the main pane.
  //    Zoomed in  (wide bars) -> footprint clusters; zoomed out -> plain candles.
  //    Hysteresis avoids flapping at the boundary. A manual toggle (▦ tbCandles)
  //    pins the mode and disables auto until re-enabled.
  // ════════════════════════════════════════════════════════════════════════════
  const FP_ON = 15;     // barSpacing px: turn footprint ON at/above this (zoomed in)
  const FP_OFF = 11;    // turn footprint OFF below this (zoomed out)
  let autoFp = true;
  const tbCandles = $("#tbCandles");
  function setFpIndicator() {
    const p = main(); if (!p || !tbCandles) return;
    tbCandles.classList.toggle("active", !!(p.studies && p.studies.fp));
    tbCandles.title = autoFp
      ? "Zoom-adaptive: candles when zoomed out, footprint when zoomed in (click to pin manually)"
      : "Manual mode — click to toggle footprint, dbl-click to re-enable zoom-adaptive";
  }
  function autoFpTick() {
    const p = main(); if (!p || !autoFp || !p.visible()) return;
    let bs;
    try { bs = p.chart.timeScale().options().barSpacing; } catch (_) { return; }
    if (!isFinite(bs)) return;
    const on = !!(p.studies && p.studies.fp);
    if (!on && bs >= FP_ON) { p.setStudy("fp", true); setFpIndicator(); }
    else if (on && bs < FP_OFF) { p.setStudy("fp", false); setFpIndicator(); }
  }
  if (tbCandles) {
    tbCandles.onclick = () => {
      const p = main(); if (!p) return;
      autoFp = false;                                    // pin manual
      p.setStudy("fp", !(p.studies && p.studies.fp));
      setFpIndicator();
    };
    tbCandles.ondblclick = () => { autoFp = true; setFpIndicator(); autoFpTick(); };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 4. DOM / volume ladder — overlaid on pane0's RIGHT PRICE AXIS (ATAS-style).
  //    Resting volume by price over the visible window (footprint cells summed),
  //    drawn as horizontal bars anchored to the axis and extending left into the
  //    chart: red above the current price (offers), green below (bids). The live
  //    price gets a highlighted tag on the axis. Not a separate column — the
  //    canvas is an overlay inside the chart wrap, like the footprint/VP layers.
  // ════════════════════════════════════════════════════════════════════════════
  let _domCv = null;
  function domCanvas() {
    if (_domCv && _domCv.isConnected) return _domCv;
    const host = document.querySelector("#pane0 .chartwrap");
    if (!host) return null;
    _domCv = document.createElement("canvas");
    _domCv.className = "overlay dom-overlay";
    host.appendChild(_domCv);
    return _domCv;
  }
  let domData = null, domFetching = false;

  async function domFetch() {
    const p = main();
    if (!p || domFetching || !p.visible()) return;
    let vr; try { vr = p.chart.timeScale().getVisibleRange(); } catch (_) { return; }
    if (!vr) return;
    domFetching = true;
    try {
      const from = Math.floor(vr.from) - p.tfSec() * 2;
      const to = Math.ceil(vr.to) + p.tfSec() * 2;
      const r = await api(`/api/footprint?tf=${p.tf}&from=${from}&to=${to}`);
      if (r && r.ok) {
        const agg = new Map();
        for (const bar of (r.fp || [])) for (const c of (bar.cells || [])) {
          const pt = Math.round(c.p / 0.25);
          let e = agg.get(pt); if (!e) { e = { p: c.p, b: 0, s: 0 }; agg.set(pt, e); }
          e.b += c.b; e.s += c.s;
        }
        domData = Array.from(agg.values());
        domDraw();
      }
    } catch (_) { /* transient */ }
    domFetching = false;
  }

  function axisWidth(p) {
    try { const aw = p.chart.priceScale("right").width(); if (aw > 0) return aw; } catch (_) {}
    return 58;
  }

  function domDraw() {
    const p = main();
    const cv = domCanvas();
    if (!p || !cv) return;
    const { ctx, w, h } = fitCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    if (!domData || !domData.length) return;
    const cur = curPrice();
    const axisW = axisWidth(p);
    const plotRight = Math.max(40, w - axisW);          // right edge of the plot area
    const barMax = Math.min(96, plotRight * 0.42);      // ladder bar reach (px)
    // adaptive bucketing so rows stay ~constant height (reuse the chart's y map)
    let ppt = 0;
    for (let i = 0; i < domData.length; i++) {
      const y0 = p.candle.priceToCoordinate(domData[i].p);
      const y1 = p.candle.priceToCoordinate(domData[i].p + 0.25);
      if (y0 != null && y1 != null && Math.abs(y0 - y1) > 0) { ppt = Math.abs(y0 - y1); break; }
    }
    if (ppt <= 0) ppt = 1;
    const binTicks = Math.max(1, Math.ceil(9 / ppt));
    const rowPx = Math.max(2, binTicks * ppt);
    const bins = new Map();
    for (const d of domData) {
      const k = Math.floor(Math.round(d.p / 0.25) / binTicks);
      let e = bins.get(k); if (!e) { e = { k, v: 0 }; bins.set(k, e); }
      e.v += d.b + d.s;
    }
    let maxV = 1;
    for (const e of bins.values()) if (e.v > maxV) maxV = e.v;
    const drawNums = rowPx >= 9;
    ctx.font = `9px ${MONO}`;
    ctx.textBaseline = "middle";
    for (const e of bins.values()) {
      const centerPt = e.k * binTicks + (binTicks - 1) / 2;
      const price = centerPt * 0.25;
      const y = p.candle.priceToCoordinate(price);
      if (y == null) continue;
      const len = (e.v / maxV) * barMax;
      const above = cur != null && price >= cur;
      ctx.fillStyle = above ? COL.redDim : COL.greenDim;
      ctx.fillRect(plotRight - len, y - rowPx / 2 + 0.5, len, Math.max(1, rowPx - 1));
      if (drawNums) {                                   // value at the bar's left end
        ctx.fillStyle = above ? "#f3b6bd" : "#a7e9d1";
        ctx.textAlign = "left";
        const txt = e.v >= 10000 ? (e.v / 1000).toFixed(1) + "k" : String(e.v);
        ctx.fillText(txt, plotRight - len + 2, y);
      }
    }
    // live price tag on the axis
    if (cur != null) {
      const y = p.candle.priceToCoordinate(cur);
      if (y != null) {
        ctx.fillStyle = COL.magenta;
        ctx.fillRect(plotRight, y - 8, w - plotRight, 16);
        ctx.fillStyle = "#fff"; ctx.textAlign = "center";
        ctx.font = `bold 10px ${MONO}`;
        ctx.fillText(cur.toFixed(2), plotRight + (w - plotRight) / 2, y);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 5. Bottom panes — Volume / Delta / Session Delta + DOM Strength.
  //    Read the SAME bars as the main chart (no-lookahead) and align each bar's
  //    x to the chart's time axis via timeToCoordinate, so the columns sit under
  //    the candles like ATAS. Session Delta = cumulative delta (area).
  // ════════════════════════════════════════════════════════════════════════════
  const bp = {
    domstr: $("#bpDomStr"), volume: $("#bpVolume"),
    delta: $("#bpDelta"), sess: $("#bpSessDelta"),
  };
  let bpBars = [], bpFetching = false;

  async function bpFetch() {
    const p = main();
    if (!p || bpFetching || !p.visible()) return;
    let vr; try { vr = p.chart.timeScale().getVisibleRange(); } catch (_) { return; }
    bpFetching = true;
    try {
      const from = vr ? Math.floor(vr.from) - p.tfSec() * 4 : "";
      const r = await api(`/api/bars?tf=${p.tf}&since=${from}`);
      if (r && r.ok) { bpBars = r.bars || []; bpDraw(); }
    } catch (_) { /* transient */ }
    bpFetching = false;
  }

  // width of a column in px (median bar gap from the chart)
  function colWidth(p, xs) {
    const gaps = [];
    for (let i = 1; i < xs.length; i++)
      if (xs[i] != null && xs[i - 1] != null) gaps.push(Math.abs(xs[i] - xs[i - 1]));
    gaps.sort((a, b) => a - b);
    let cw = gaps.length ? gaps[gaps.length >> 1] : 0;
    if (!isFinite(cw) || cw <= 0) { try { cw = p.chart.timeScale().options().barSpacing || 6; } catch (_) { cw = 6; } }
    return Math.max(1, cw);
  }

  function drawHistRow(cv, getVal, colorFn, opts) {
    const p = main();
    if (!p || !cv) return;
    const { ctx, w, h } = fitCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    if (!bpBars.length) return;
    const ts = p.chart.timeScale();
    const xs = bpBars.map((b) => ts.timeToCoordinate(b.time));
    const cw = colWidth(p, xs);
    const bw = Math.max(1, cw * 0.66);
    let maxAbs = 1;
    for (const b of bpBars) { const v = Math.abs(getVal(b) || 0); if (v > maxAbs) maxAbs = v; }
    const signed = !!opts.signed;
    const mid = signed ? h / 2 : h - 1;
    const usable = signed ? (h / 2 - 2) : (h - 3);
    for (let i = 0; i < bpBars.length; i++) {
      const x = xs[i]; if (x == null) continue;
      const v = getVal(bpBars[i]) || 0;
      const len = (Math.abs(v) / maxAbs) * usable;
      ctx.fillStyle = colorFn(bpBars[i], v);
      if (signed) {
        if (v >= 0) ctx.fillRect(x - bw / 2, mid - len, bw, len);
        else ctx.fillRect(x - bw / 2, mid, bw, len);
      } else {
        ctx.fillRect(x - bw / 2, mid - len, bw, len);
      }
    }
    if (signed) { // zero line
      ctx.strokeStyle = "rgba(120,130,150,.25)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, mid + 0.5); ctx.lineTo(w, mid + 0.5); ctx.stroke();
    }
    // per-bar numeric labels when columns are wide (ATAS prints them)
    if (cw >= 30 && opts.labels) {
      ctx.font = `9px ${MONO}`; ctx.textAlign = "center"; ctx.textBaseline = signed ? "middle" : "bottom";
      ctx.fillStyle = COL.text;
      for (let i = 0; i < bpBars.length; i++) {
        const x = xs[i]; if (x == null) continue;
        const v = Math.round(getVal(bpBars[i]) || 0);
        ctx.fillStyle = opts.labelColor ? opts.labelColor(bpBars[i], v) : COL.muted;
        ctx.fillText(String(v), x, signed ? h / 2 : h - 2);
      }
    }
  }

  // abbreviate big magnitudes so columns never overflow (signed-safe)
  function abbr(v) {
    const a = Math.abs(v), s = v < 0 ? "-" : "";
    if (a >= 100000) return s + (a / 1000).toFixed(0) + "k";
    if (a >= 10000) return s + (a / 1000).toFixed(1) + "k";
    return String(Math.round(v));
  }

  // Per-bar NUMBER row (ATAS footprint-bottom style): one value per chart column,
  // x-aligned to the candle above, color by getColor(value). Columns are thinned
  // out (every Nth) and the font shrinks when they get tight, so the row never
  // crowds; numbers under the left label are skipped. getVal(bar, index).
  const LABEL_GUTTER = 62;   // px reserved on the left for the row label
  function drawNumberRow(cv, getVal, getColor, fmt) {
    const p = main();
    if (!p || !cv) return;
    const { ctx, w, h } = fitCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    if (!bpBars.length) return;
    const ts = p.chart.timeScale();
    const xs = bpBars.map((b) => ts.timeToCoordinate(b.time));
    const cw = colWidth(p, xs);
    // need ~26px of clear width per number; thin to every Nth column otherwise
    const step = Math.max(1, Math.ceil(26 / cw));
    const fs = Math.min(11, Math.max(8, Math.round(cw * 0.46)));
    ctx.font = `${fs}px ${MONO}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const cy = h / 2;
    for (let i = 0; i < bpBars.length; i += step) {
      const x = xs[i];
      if (x == null || x < LABEL_GUTTER || x > w - 2) continue;
      const v = getVal(bpBars[i], i);
      ctx.fillStyle = getColor(v);
      ctx.fillText(fmt(v), x, cy);
    }
  }

  function bpDraw() {
    // Volume — neutral numbers (non-negative)
    drawNumberRow(bp.volume, (b) => b.volume || 0, () => "#9aa6b6", (v) => abbr(v));
    // Delta — signed numbers, red/green by sign (ATAS coloring)
    drawNumberRow(bp.delta, (b) => (b.delta == null ? 0 : b.delta),
      (v) => (v >= 0 ? "#5fcf9f" : "#ef8a93"), (v) => (v > 0 ? "+" : "") + abbr(v));
    // Session Delta — cumulative running sum, signed numbers, red/green by sign
    {
      let cum = 0; const cums = bpBars.map((b) => (cum += (b.delta || 0)));
      drawNumberRow(bp.sess, (b, i) => cums[i],
        (v) => (v >= 0 ? "#5fcf9f" : "#ef8a93"), (v) => (v > 0 ? "+" : "") + abbr(v));
    }
    // DOM Strength (proxy) — signed bar from delta×volume; replay has no live
    // depth feed, so this is a flow-imbalance proxy, labeled as such in the UI.
    drawHistRow(bp.domstr, (b) => {
      const d = b.delta == null ? 0 : b.delta;
      return Math.sign(d) * Math.sqrt(Math.abs(d) * Math.max(1, b.volume || 0));
    }, (b, v) => (v >= 0 ? "rgba(30,184,127,.7)" : "rgba(226,69,86,.7)"),
      { signed: true, labels: false });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // wiring: redraw new chrome whenever the main pane scrolls/zooms/resizes, and
  // poll for fresh data on a light interval. All reads are best-effort.
  // ════════════════════════════════════════════════════════════════════════════
  function redrawAll() { try { domDraw(); bpDraw(); } catch (_) {} }
  function refetchAll() { try { domFetch(); bpFetch(); } catch (_) {} }

  function wireMainPane() {
    const p = main(); if (!p || p._atasWired) return false;
    p._atasWired = true;
    try {
      p.chart.timeScale().subscribeVisibleTimeRangeChange(() => { autoFpTick(); redrawAll(); refetchAll(); });
      p.chart.timeScale().subscribeVisibleLogicalRangeChange(() => { autoFpTick(); redrawAll(); });
    } catch (_) {}
    new ResizeObserver(redrawAll).observe($("#center"));
    setupIndicatorsMenu();
    syncTfActive(); setFpIndicator();
    return true;
  }

  // boot: PANES exists synchronously after app.js, but retry a few frames in case
  let tries = 0;
  (function bootWire() {
    if (!wireMainPane() && tries++ < 50) return void setTimeout(bootWire, 100);
  })();

  // light polling loops (cheap; guarded by visibility + in-flight flags)
  setInterval(() => { if (main()) { autoFpTick(); refetchAll(); } }, 450);
  setInterval(() => { syncTfActive(); }, 1000);   // keep TF highlight in sync with pane TF changes
  // redraw faster so ladder/bottom track the live tape smoothly
  setInterval(redrawAll, 220);
})();
