/* replay_trader frontend — live tick-replay chart + trading + scoreboard.
   No-lookahead: all market data comes from /api/bars which only returns
   ticks[start:cursor). We never compute anything from future data client-side. */
"use strict";

const $ = (s) => document.querySelector(s);
const fmt = (v, d = 2) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));
const money = (v) => (v === null || v === undefined ? "—"
  : (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2));

// ── chart setup ───────────────────────────────────────────────────────────────
const utcHMS = (t) => {
  const d = new Date(t * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds());
};

const chart = LightweightCharts.createChart($("#chart"), {
  layout: { background: { color: "#0d1117" }, textColor: "#c9d1d9", fontSize: 11 },
  grid: { vertLines: { color: "#1b2230" }, horzLines: { color: "#1b2230" } },
  rightPriceScale: { borderColor: "#2a3340", scaleMargins: { top: 0.06, bottom: 0.26 } },
  timeScale: {
    borderColor: "#2a3340", timeVisible: true, secondsVisible: true, rightOffset: 6,
    tickMarkFormatter: (t) => utcHMS(t),
  },
  localization: { timeFormatter: (t) => utcHMS(t) },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
});
const candle = chart.addCandlestickSeries({
  upColor: "#26a69a", downColor: "#ef5350", wickUpColor: "#26a69a",
  wickDownColor: "#ef5350", borderVisible: false,
});
const vol = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "" });
vol.priceScale().applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });

// price line markers for live position (stop / target / entry)
let posPriceLines = [];
function clearPosLines() { posPriceLines.forEach((l) => candle.removePriceLine(l)); posPriceLines = []; }

// ── client state ────────────────────────────────────────────────────────────
let TF = "5s";
let tfSec = 5;
let lastBarTime = null;      // synth time of most-recent applied bar
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

// ── rendering ─────────────────────────────────────────────────────────────────
function applyBars(bars, replace) {
  if (replace) {
    const cd = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
    candle.setData(cd);
    vol.setData(bars.map((b) => ({
      time: b.time, value: b.volume,
      color: b.close >= b.open ? "rgba(38,166,154,.5)" : "rgba(239,83,80,.5)",
    })));
    if (bars.length) lastBarTime = bars[bars.length - 1].time;
  } else {
    for (const b of bars) {
      candle.update({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close });
      vol.update({ time: b.time, value: b.volume,
        color: b.close >= b.open ? "rgba(38,166,154,.5)" : "rgba(239,83,80,.5)" });
    }
    if (bars.length) lastBarTime = Math.max(lastBarTime || 0, bars[bars.length - 1].time);
  }
}

function renderState(s) {
  if (!s || !s.ok && !s.session_id) return;
  $("#clock").textContent = s.et_clock || "--:--:--";
  $("#price").textContent = fmt(s.cur_price);
  $("#prog").textContent = (s.progress_pct ?? 0) + "%";
  $("#btnPlay").textContent = s.paused ? "▶ Play" : "⏸ Pause";
  $("#paused-badge").classList.toggle("hidden", !s.paused || ended);
  // position
  const pb = $("#posbody");
  clearPosLines();
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
              ? `<span style="color:#ff9f40">armed @ ${p.trail_tk} tk · ${fmt(p.trail_stop)}</span>`
              : `<span class="muted">waiting (+${p.arm_tk || 0})</span>`}</span>`
          : "")
      + `<span>MFE / MAE</span><span>+${fmt(p.mfe, 1)} / ${fmt(p.mae, 1)} tk</span>`
      + `</div>`;
    posPriceLines.push(candle.createPriceLine({ price: p.entry, color: "#9aa4b2",
      lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "entry" }));
    if (p.stop !== null) posPriceLines.push(candle.createPriceLine({ price: p.stop,
      color: "#ef5350", lineStyle: 0, lineWidth: 1, axisLabelVisible: true, title: "stop" }));
    if (p.target !== null) posPriceLines.push(candle.createPriceLine({ price: p.target,
      color: "#26a69a", lineStyle: 0, lineWidth: 1, axisLabelVisible: true, title: "target" }));
    if (p.trail_armed && p.trail_stop !== null && p.trail_stop !== undefined)
      posPriceLines.push(candle.createPriceLine({ price: p.trail_stop,
        color: "#ff9f40", lineStyle: 2, lineWidth: 2, axisLabelVisible: true, title: "trail" }));
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
  // day_baseline/selection_skill are null on legacy sessions (pre-feature) or
  // before any trade carries a random_time_ev_net — fall back to the old edge.
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
  renderTrades(s);
}

let lastTradeN = -1;
function renderTrades(s) { /* filled by full fetch */ }

async function refreshTrades() {
  // trades come from the session json; pull via state's stats only has counts,
  // so fetch the persisted list lazily through /api/bars payload's stats is enough
}

// ── poll loop ─────────────────────────────────────────────────────────────────
let polling = false;
async function poll() {
  if (!haveSession || polling) return;
  polling = true;
  try {
    // Inclusive server filter (time >= since): request from the current last bar
    // so it refreshes the still-forming bucket in place and appends newer ones.
    // Subtracting tfSec would return an OLDER bucket and make candle.update() throw
    // "Cannot update oldest data", silently killing the live refresh.
    const since = lastBarTime === null ? "" : lastBarTime;
    const r = await api(`/api/bars?tf=${TF}&since=${since}`);
    if (r.ok) {
      applyBars(r.bars || [], lastBarTime === null);
      renderState(r);
      if (fpOn) fetchFootprint();
      if (r.ended && !ended) onEnded();
    }
  } catch (e) { /* transient */ }
  polling = false;
}

// trades table: maintained from each closed trade via a dedicated fetch of state
async function fetchTradesTable() {
  try {
    const r = await api("/api/state");
    if (!r.ok) return;
    renderState(r);
  } catch (e) {}
}

// ── full reload (new session / tf switch) ─────────────────────────────────────
async function fullReload() {
  lastBarTime = null;
  const r = await api(`/api/bars?tf=${TF}&since=`);
  if (r.ok) {
    applyBars(r.bars || [], true);
    renderState(r);
    chart.timeScale().scrollToPosition(6, false);
  }
}

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

document.querySelectorAll(".tf").forEach((b) => b.onclick = async () => {
  document.querySelectorAll(".tf").forEach((x) => x.classList.remove("active"));
  b.classList.add("active");
  TF = b.dataset.tf; tfSec = TF === "5s" ? 5 : 60;
  fpData = []; if (fpOn && fpCtx) fpCtx.clearRect(0, 0, fpW, fpH);
  await fullReload();
  if (fpOn) fetchFootprint();
});

// ── bracket tick persistence ───────────────────────────────────────────────────
// Stop/Target are TICK offsets from fill. Remember the last-used values so the
// trader can set them once (e.g. Stop 40 / Target 5) and just hit B/S after.
const BR_KEY = "replay_trader.brackets";
function saveBrackets() {
  try {
    localStorage.setItem(BR_KEY, JSON.stringify({
      stop: $("#stop").value, target: $("#target").value,
      trail: $("#trail").value, arm: $("#arm").value,
    }));
  } catch (_) { /* ignore quota / private-mode errors */ }
}
function loadBrackets() {
  try {
    const v = JSON.parse(localStorage.getItem(BR_KEY) || "null");
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
  $("#target").value = b.dataset.target;
  saveBrackets();
});
loadBrackets();

async function doOrder(side) {
  const size = Math.max(1, +$("#lots").value || 1);
  const stop_tk = $("#stop").value === "" ? null : +$("#stop").value;
  const target_tk = $("#target").value === "" ? null : +$("#target").value;
  const trail_tk = $("#trail").value === "" ? null : +$("#trail").value;
  const arm_tk = $("#arm").value === "" ? null : +$("#arm").value;
  saveBrackets();
  const r = await post("/api/order", { side, size, stop_tk, target_tk, trail_tk, arm_tk });
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
  const r = await post("/api/new_session", { mode, slip_tk: 1 });
  haveSession = true; ended = false; lastBarTime = null;
  await fullReload();
  renderState(r);
}

// ── hotkeys ───────────────────────────────────────────────────────────────────
window.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return;
  if (e.code === "Space") { e.preventDefault(); $("#btnPlay").click(); }
  else if (e.key === "b" || e.key === "B") doOrder("buy");
  else if (e.key === "s" || e.key === "S") doOrder("sell");
  else if (e.key === "f" || e.key === "F") $("#btnFlat").click();
  else if (e.key === "9") { e.preventDefault(); $("#btnClose").click(); }
});

// ── footprint overlay ─────────────────────────────────────────────────────────
// Per-bar buy×sell volume by price level, drawn on a canvas aligned to the
// lightweight-charts bars. Default OFF (persisted). Zero overhead when off:
// no fetch, no draw, canvas hidden. Cells render only when zoomed in enough to
// be readable; otherwise just the per-bar delta + a POC marker show.
const FP_KEY = "replay_trader.footprint";
let fpOn = false;
let fpData = [];            // last fetched array of {time, poc, delta, cells:[{p,b,s}]}
let fpFetching = false;
const fpcv = $("#fpcanvas");
let fpCtx = null, fpW = 0, fpH = 0;

function fpResize() {
  const wrap = $("#chartwrap");
  const w = wrap.clientWidth, h = wrap.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  fpcv.width = Math.round(w * dpr); fpcv.height = Math.round(h * dpr);
  fpcv.style.width = w + "px"; fpcv.style.height = h + "px";
  fpCtx = fpcv.getContext("2d");
  fpCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fpW = w; fpH = h;
}

async function fetchFootprint() {
  if (!fpOn || !haveSession || fpFetching) return;
  const vr = chart.timeScale().getVisibleRange();
  if (!vr) return;
  fpFetching = true;
  try {
    const from = Math.floor(vr.from) - tfSec * 2;
    const to = Math.ceil(vr.to) + tfSec * 2;
    const r = await api(`/api/footprint?tf=${TF}&from=${from}&to=${to}`);
    if (r.ok) { fpData = r.fp || []; drawFootprint(); }
  } catch (e) { /* transient */ }
  fpFetching = false;
}

function _median(a) {
  const v = a.filter((x) => isFinite(x)).sort((x, y) => x - y);
  return v.length ? v[v.length >> 1] : NaN;
}

function drawFootprint() {
  if (!fpOn || !fpCtx) return;
  fpCtx.clearRect(0, 0, fpW, fpH);
  if (!fpData.length) return;
  const ts = chart.timeScale();
  const xs = fpData.map((b) => ts.timeToCoordinate(b.time));
  // bar pixel width from consecutive on-screen bar centers (fallback barSpacing)
  const gaps = [];
  for (let i = 1; i < xs.length; i++)
    if (xs[i] != null && xs[i - 1] != null) gaps.push(xs[i] - xs[i - 1]);
  let cellW = _median(gaps);
  if (!isFinite(cellW) || cellW <= 0) cellW = (ts.options().barSpacing || 8);
  // pixels per 0.25-tick price level (probe off the first bar's POC/first cell)
  let ppt = 0;
  const probe = fpData.find((b) => b.cells && b.cells.length);
  if (probe) {
    const pp = probe.cells[0].p;
    const y0 = candle.priceToCoordinate(pp), y1 = candle.priceToCoordinate(pp + 0.25);
    if (y0 != null && y1 != null) ppt = Math.abs(y0 - y1);
  }
  const drawCells = cellW >= 30 && ppt >= 8;
  const fs = Math.max(8, Math.min(11, Math.floor(ppt) - 2));
  fpCtx.font = `${fs}px ui-monospace,Menlo,Consolas,monospace`;
  const half = cellW / 2;

  for (const b of fpData) {
    const x = ts.timeToCoordinate(b.time);
    if (x == null) continue;
    if (drawCells && b.cells && b.cells.length) {
      const m = {};
      for (const c of b.cells) m[c.p.toFixed(2)] = c;
      for (const c of b.cells) {
        const y = candle.priceToCoordinate(c.p);
        if (y == null) continue;
        const top = y - ppt / 2;
        // POC row highlight
        if (b.poc != null && Math.abs(c.p - b.poc) < 1e-6) {
          fpCtx.fillStyle = "rgba(255,255,255,.10)";
          fpCtx.fillRect(x - half, top, cellW, ppt);
        }
        // diagonal imbalance (>=3:1): buy[p] vs sell[p+tick]; sell[p] vs buy[p-tick]
        const above = m[(c.p + 0.25).toFixed(2)];
        const below = m[(c.p - 0.25).toFixed(2)];
        if (c.b > 0 && above && above.s > 0 && c.b >= 3 * above.s) {
          fpCtx.fillStyle = "rgba(38,166,154,.22)";
          fpCtx.fillRect(x, top, half, ppt);
        }
        if (c.s > 0 && below && below.b > 0 && c.s >= 3 * below.b) {
          fpCtx.fillStyle = "rgba(239,83,80,.22)";
          fpCtx.fillRect(x - half, top, half, ppt);
        }
        fpCtx.textBaseline = "middle";
        fpCtx.textAlign = "right"; fpCtx.fillStyle = "#ef5350";
        fpCtx.fillText(c.s, x - 3, y);
        fpCtx.textAlign = "left"; fpCtx.fillStyle = "#26a69a";
        fpCtx.fillText(c.b, x + 3, y);
      }
    } else if (b.poc != null) {
      // not zoomed enough for cells — just mark the POC level
      const y = candle.priceToCoordinate(b.poc);
      if (y != null) {
        fpCtx.fillStyle = "rgba(227,209,75,.75)";
        fpCtx.fillRect(x - Math.max(2, half * 0.6), y - 1, Math.max(4, cellW * 0.6), 2);
      }
    }
    // per-bar delta under the bar (always, cheap)
    fpCtx.textAlign = "center"; fpCtx.textBaseline = "bottom";
    fpCtx.fillStyle = b.delta >= 0 ? "#26a69a" : "#ef5350";
    fpCtx.fillText((b.delta > 0 ? "+" : "") + b.delta, x, fpH - 3);
  }
}

function setFootprint(on) {
  fpOn = on;
  $("#btnFoot").classList.toggle("active", on);
  fpcv.classList.toggle("hidden", !on);
  try { localStorage.setItem(FP_KEY, on ? "1" : "0"); } catch (_) {}
  if (on) { fpResize(); fetchFootprint(); }
  else { fpData = []; if (fpCtx) fpCtx.clearRect(0, 0, fpW, fpH); }
}
$("#btnFoot").onclick = () => setFootprint(!fpOn);
try { if (localStorage.getItem(FP_KEY) === "1") setFootprint(true); } catch (_) {}

// redraw/refetch on pan & zoom so cells stay aligned and cover newly-shown bars
let fpSched = null;
function fpScheduleFetch() {
  if (!fpOn) return;
  if (fpSched) clearTimeout(fpSched);
  fpSched = setTimeout(fetchFootprint, 70);
}
chart.timeScale().subscribeVisibleTimeRangeChange(() => { if (fpOn) drawFootprint(); fpScheduleFetch(); });
chart.timeScale().subscribeVisibleLogicalRangeChange(() => { if (fpOn) drawFootprint(); fpScheduleFetch(); });

// resize
new ResizeObserver(() => { chart.applyOptions({}); if (fpOn) { fpResize(); drawFootprint(); } }).observe($("#chart"));

// ── main loop: poll the tape continuously ─────────────────────────────────────
setInterval(poll, 140);
document.querySelector('.spd[data-spd="1"]').classList.add("active");

// auto-start a session on load
newSession();

// ── fixed-range volume profile overlay ──────────────────────────────────────
// Volume traded at each price across a chosen range (visible window or whole
// session). Server side reuses the same no-lookahead footprint aggregation.
// Default OFF and zero-overhead when off: no fetch, no draw, canvas hidden.
const VP_KEY = "replay_trader.volprofile";
const VPCFG_KEY = "replay_trader.volprofile.cfg";
let vpOn = false;
let vpData = null;
let vpFetching = false;
const vpcv = $("#vpcanvas");
let vpCtx = null, vpW = 0, vpH = 0;

const vpCfg = { mode: "visible", rows: 48, va: 70, width: 30, opacity: 80,
                side: "right", band: true, split: true, poc: true };

function vpLoadCfg() {
  try { Object.assign(vpCfg, JSON.parse(localStorage.getItem(VPCFG_KEY) || "{}")); } catch (_) {}
  $("#vpMode").value = vpCfg.mode; $("#vpRows").value = vpCfg.rows;
  $("#vpVA").value = vpCfg.va; $("#vpWidth").value = vpCfg.width;
  $("#vpOpacity").value = vpCfg.opacity; $("#vpSide").value = vpCfg.side;
  $("#vpVAband").checked = vpCfg.band; $("#vpSplit").checked = vpCfg.split;
  $("#vpShowPoc").checked = vpCfg.poc;
}
function vpSaveCfg() {
  vpCfg.mode = $("#vpMode").value;
  vpCfg.rows = Math.max(0, +$("#vpRows").value || 0);
  vpCfg.va = Math.min(100, Math.max(0, +$("#vpVA").value || 70));
  vpCfg.width = Math.min(60, Math.max(5, +$("#vpWidth").value || 30));
  vpCfg.opacity = Math.min(100, Math.max(10, +$("#vpOpacity").value || 80));
  vpCfg.side = $("#vpSide").value;
  vpCfg.band = $("#vpVAband").checked;
  vpCfg.split = $("#vpSplit").checked;
  vpCfg.poc = $("#vpShowPoc").checked;
  try { localStorage.setItem(VPCFG_KEY, JSON.stringify(vpCfg)); } catch (_) {}
}

function vpResize() {
  const wrap = $("#chartwrap");
  const w = wrap.clientWidth, h = wrap.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  vpcv.width = Math.round(w * dpr); vpcv.height = Math.round(h * dpr);
  vpcv.style.width = w + "px"; vpcv.style.height = h + "px";
  vpCtx = vpcv.getContext("2d");
  vpCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  vpW = w; vpH = h;
}

async function vpFetch() {
  if (!vpOn || !haveSession || vpFetching) return;
  vpFetching = true;
  try {
    let from = "", to = "";
    if (vpCfg.mode === "visible") {
      const vr = chart.timeScale().getVisibleRange();
      if (vr) { from = Math.floor(vr.from); to = Math.ceil(vr.to); }
    }
    const r = await api(`/api/volprofile?tf=${TF}&from=${from}&to=${to}&rows=${vpCfg.rows}&va=${vpCfg.va}`);
    if (r.ok) { vpData = r; vpDraw(); }
  } catch (e) { /* transient */ }
  vpFetching = false;
}

function vpDraw() {
  if (!vpOn || !vpCtx) return;
  vpCtx.clearRect(0, 0, vpW, vpH);
  if (!vpData || !vpData.levels || !vpData.levels.length) return;
  const L = vpData.levels;
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
  if (vpCfg.band && vpData.vah != null && vpData.val != null) {
    const yT = candle.priceToCoordinate(vpData.vah);
    const yB = candle.priceToCoordinate(vpData.val);
    if (yT != null && yB != null) {
      vpCtx.fillStyle = `rgba(77,159,255,${0.07 * op})`;
      vpCtx.fillRect(0, Math.min(yT, yB) - barH / 2, vpW, Math.abs(yB - yT) + barH);
    }
  }
  for (const lv of L) {
    const y = candle.priceToCoordinate(lv.p);
    if (y == null) continue;
    const len = (lv.v / maxV) * maxLen;
    const top = y - barH / 2;
    const inVA = vpData.vah != null && lv.p <= vpData.vah + 1e-6 && lv.p >= vpData.val - 1e-6;
    const a = (inVA ? 1 : 0.55) * op;
    if (vpCfg.split && lv.v > 0) {
      const buyLen = len * (lv.b / lv.v), sellLen = len - buyLen;
      if (anchorRight) {
        let x = xEdge;
        vpCtx.fillStyle = `rgba(38,166,154,${a})`; vpCtx.fillRect(x - buyLen, top, buyLen, barH); x -= buyLen;
        vpCtx.fillStyle = `rgba(239,83,80,${a})`; vpCtx.fillRect(x - sellLen, top, sellLen, barH);
      } else {
        let x = xEdge;
        vpCtx.fillStyle = `rgba(38,166,154,${a})`; vpCtx.fillRect(x, top, buyLen, barH); x += buyLen;
        vpCtx.fillStyle = `rgba(239,83,80,${a})`; vpCtx.fillRect(x, top, sellLen, barH);
      }
    } else {
      vpCtx.fillStyle = `rgba(77,159,255,${a})`;
      vpCtx.fillRect(anchorRight ? xEdge - len : xEdge, top, len, barH);
    }
  }
  if (vpCfg.poc && vpData.poc != null) {
    const y = candle.priceToCoordinate(vpData.poc);
    if (y != null) {
      vpCtx.strokeStyle = `rgba(227,209,75,${Math.min(1, op + 0.1)})`;
      vpCtx.lineWidth = 1.5;
      vpCtx.beginPath(); vpCtx.moveTo(0, y); vpCtx.lineTo(vpW, y); vpCtx.stroke();
    }
  }
}

function setVP(on) {
  vpOn = on;
  $("#btnVP").classList.toggle("active", on);
  vpcv.classList.toggle("hidden", !on);
  try { localStorage.setItem(VP_KEY, on ? "1" : "0"); } catch (_) {}
  if (on) { vpResize(); vpFetch(); }
  else { vpData = null; if (vpCtx) vpCtx.clearRect(0, 0, vpW, vpH); }
}
$("#btnVP").onclick = () => setVP(!vpOn);
$("#btnVPcfg").onclick = () => $("#vpcfg").classList.toggle("hidden");

["vpMode", "vpRows", "vpVA", "vpWidth", "vpOpacity", "vpSide", "vpVAband", "vpSplit", "vpShowPoc"]
  .forEach((id) => {
    const el = $("#" + id); if (!el) return;
    el.addEventListener("change", () => {
      vpSaveCfg();
      if (["vpRows", "vpVA", "vpMode"].includes(id)) vpFetch(); else vpDraw();
    });
  });

let vpSched = null;
function vpScheduleFetch() {
  if (!vpOn || vpCfg.mode !== "visible") return;
  if (vpSched) clearTimeout(vpSched);
  vpSched = setTimeout(vpFetch, 90);
}
chart.timeScale().subscribeVisibleTimeRangeChange(() => { if (vpOn) { vpDraw(); vpScheduleFetch(); } });
chart.timeScale().subscribeVisibleLogicalRangeChange(() => { if (vpOn) { vpDraw(); vpScheduleFetch(); } });
new ResizeObserver(() => { if (vpOn) { vpResize(); vpDraw(); } }).observe($("#chart"));

// throttled live refresh — the profile grows as new ticks print (zero work when off)
setInterval(() => { if (vpOn && haveSession) vpFetch(); }, 600);

vpLoadCfg();
try { if (localStorage.getItem(VP_KEY) === "1") setVP(true); } catch (_) {}

// ── studies waffle menu ─────────────────────────────────────────────────────
$("#btnStudies").onclick = (e) => { e.stopPropagation(); $("#studiesMenu").classList.toggle("hidden"); };
document.addEventListener("click", (e) => {
  const w = document.querySelector(".studies-wrap");
  if (w && !w.contains(e.target)) $("#studiesMenu").classList.add("hidden");
});

// ── contract selector: Mini (NQ) ↔ Micro (MNQ) ─────────────────────────────
// Pure math switch — micro = 1/10 the $/tick & commission of a mini (10 micros
// = 1 mini). Lets you hold wider/longer for the same dollar risk. No new data.
const INSTR_KEY = "replay_trader.instrument";
const instrEl = $("#instrument");
async function instrApply() {
  try { await post("/api/control", { action: "instrument", instrument: instrEl.value }); } catch (_) {}
}
if (instrEl) {
  try { const v = localStorage.getItem(INSTR_KEY); if (v) instrEl.value = v; } catch (_) {}
  instrEl.addEventListener("change", () => {
    try { localStorage.setItem(INSTR_KEY, instrEl.value); } catch (_) {}
    instrApply();
  });
  setTimeout(instrApply, 800);                 // re-apply after the auto new_session on load
  $("#btnNew").addEventListener("click", () => setTimeout(instrApply, 500));
  $("#modalNew").addEventListener("click", () => setTimeout(instrApply, 500));
}

// ── bid / ask per-candle overlay ────────────────────────────────────────────
// When ON: the chart's normal (fat) candles are hidden and we draw THIN custom
// candles on the overlay, then flank each one with its volume traded at the bid
// (aggressive sells, LEFT) and at the ask (aggressive buys, RIGHT). Numbers sit
// OUTSIDE the thin body so nothing merges, and their height is clamped to the
// candle's own high–low span. Reuses /api/bars (OHLC) + /api/footprint (b/a).
// Default OFF, zero overhead when off (normal candles restored).
const BA_KEY = "replay_trader.bidask";
const BA_CANDLE_ON = { upColor: "#26a69a", downColor: "#ef5350",
  wickUpColor: "#26a69a", wickDownColor: "#ef5350", borderVisible: false };
const BA_CANDLE_HIDDEN = { upColor: "rgba(0,0,0,0)", downColor: "rgba(0,0,0,0)",
  wickUpColor: "rgba(0,0,0,0)", wickDownColor: "rgba(0,0,0,0)", borderVisible: false };
let baOn = false, baBars = [], baFetching = false;
const bacv = $("#bacanvas");
let baCtx = null, baW = 0, baH = 0;
const baFmt = (n) => (n >= 100000 ? (n / 1000).toFixed(0) + "k"
  : n >= 10000 ? (n / 1000).toFixed(1) + "k" : String(n));

function baResize() {
  const wrap = $("#chartwrap");
  const w = wrap.clientWidth, h = wrap.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  bacv.width = Math.round(w * dpr); bacv.height = Math.round(h * dpr);
  bacv.style.width = w + "px"; bacv.style.height = h + "px";
  baCtx = bacv.getContext("2d");
  baCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  baW = w; baH = h;
}

async function baFetch() {
  if (!baOn || !haveSession || baFetching) return;
  const vr = chart.timeScale().getVisibleRange();
  if (!vr) { return; }
  baFetching = true;
  try {
    const from = Math.floor(vr.from) - tfSec * 2;
    const to = Math.ceil(vr.to) + tfSec * 2;
    const [rb, rf] = await Promise.all([
      api(`/api/bars?tf=${TF}&since=${from}`),
      api(`/api/footprint?tf=${TF}&from=${from}&to=${to}`),
    ]);
    const fp = {};
    if (rf && rf.ok) for (const b of (rf.fp || [])) {
      let bid = 0, ask = 0;
      for (const c of (b.cells || [])) { bid += c.s; ask += c.b; }
      fp[b.time] = { cells: b.cells || [], poc: b.poc, bid, ask };
    }
    if (rb && rb.ok) {
      baBars = (rb.bars || [])
        .filter((b) => b.time >= from - 1 && b.time <= to + 1)
        .map((b) => Object.assign({}, b, fp[b.time] || { cells: [], poc: null, bid: 0, ask: 0 }));
      baDraw();
    }
  } catch (e) { /* transient */ }
  baFetching = false;
}

function baDraw() {
  if (!baOn || !baCtx) return;
  baCtx.clearRect(0, 0, baW, baH);
  if (!baBars.length) return;
  const ts = chart.timeScale();
  const xs = baBars.map((b) => ts.timeToCoordinate(b.time));
  const gaps = [];
  for (let i = 1; i < xs.length; i++)
    if (xs[i] != null && xs[i - 1] != null) gaps.push(xs[i] - xs[i - 1]);
  gaps.sort((a, b) => a - b);
  let cellW = gaps.length ? gaps[gaps.length >> 1] : (ts.options().barSpacing || 8);
  if (!isFinite(cellW) || cellW <= 0) cellW = 8;
  const tw = Math.max(2, Math.min(7, Math.round(cellW * 0.18)));   // thin body width
  // pixels per 0.25-tick price level (probe off the first bar that has cells)
  let ppt = 0;
  const probe = baBars.find((b) => b.cells && b.cells.length);
  if (probe) {
    const p0 = probe.cells[0].p;
    const y0 = candle.priceToCoordinate(p0), y1 = candle.priceToCoordinate(p0 + 0.25);
    if (y0 != null && y1 != null) ppt = Math.abs(y0 - y1);
  }
  const avail = cellW / 2 - tw / 2 - 3;                  // px outside the body, each side
  const perLevel = cellW >= 18 && ppt >= 8 && avail >= 8; // enough room for a price ladder
  for (const b of baBars) {
    const x = ts.timeToCoordinate(b.time);
    if (x == null) continue;
    const yO = candle.priceToCoordinate(b.open), yC = candle.priceToCoordinate(b.close);
    const yH = candle.priceToCoordinate(b.high), yL = candle.priceToCoordinate(b.low);
    if (yO == null || yC == null || yH == null || yL == null) continue;
    const up = b.close >= b.open;
    const col = up ? "#26a69a" : "#ef5350";
    // wick
    baCtx.strokeStyle = col; baCtx.lineWidth = 1;
    baCtx.beginPath(); baCtx.moveTo(x + 0.5, yH); baCtx.lineTo(x + 0.5, yL); baCtx.stroke();
    // thin body
    const bodyTop = Math.min(yO, yC), bodyH = Math.max(1, Math.abs(yC - yO));
    baCtx.fillStyle = col; baCtx.fillRect(Math.round(x - tw / 2), bodyTop, tw, bodyH);

    if (perLevel && b.cells && b.cells.length) {
      // PER-LEVEL ladder: bid (sells, red, LEFT) / ask (buys, green, RIGHT) at each price,
      // flanking the thin body so nothing merges. Row font <= row height (no vertical overlap).
      const fs = Math.max(6, Math.min(11, Math.floor(ppt) - 1));
      baCtx.font = `${fs}px ui-monospace,Menlo,Consolas,monospace`;
      baCtx.textBaseline = "middle";
      for (const c of b.cells) {
        const y = candle.priceToCoordinate(c.p);
        if (y == null) continue;
        if (b.poc != null && Math.abs(c.p - b.poc) < 1e-6) {   // POC row highlight
          baCtx.fillStyle = "rgba(227,209,75,.12)";
          baCtx.fillRect(x - cellW / 2, y - ppt / 2, cellW, Math.max(1, ppt));
        }
        if (c.s) { baCtx.fillStyle = "#ef5350"; baCtx.textAlign = "right"; baCtx.fillText(baFmt(c.s), x - tw / 2 - 2, y); }
        if (c.b) { baCtx.fillStyle = "#26a69a"; baCtx.textAlign = "left"; baCtx.fillText(baFmt(c.b), x + tw / 2 + 2, y); }
      }
    } else {
      // zoomed out for a ladder — show per-candle totals at the candle mid (auto-fit / skip)
      const cMid = (yH + yL) / 2;
      const cH = Math.max(2, Math.abs(yL - yH));
      const bidT = baFmt(b.bid || 0), askT = baFmt(b.ask || 0);
      let fs = Math.max(6, Math.min(11, Math.floor(cH)));
      baCtx.font = `${fs}px ui-monospace,Menlo,Consolas,monospace`;
      let wNeed = Math.max(baCtx.measureText(bidT).width, baCtx.measureText(askT).width);
      while (fs > 6 && wNeed > avail) {
        fs -= 1;
        baCtx.font = `${fs}px ui-monospace,Menlo,Consolas,monospace`;
        wNeed = Math.max(baCtx.measureText(bidT).width, baCtx.measureText(askT).width);
      }
      if (wNeed > avail) continue;
      baCtx.textBaseline = "middle";
      const bidW = baCtx.measureText(bidT).width, askW = baCtx.measureText(askT).width;
      const bh = Math.min(cH, fs + 2);
      baCtx.fillStyle = "rgba(13,17,23,.55)";
      baCtx.fillRect(x - tw / 2 - 2 - bidW, cMid - bh / 2, bidW + 2, bh);
      baCtx.fillRect(x + tw / 2, cMid - bh / 2, askW + 2, bh);
      baCtx.fillStyle = "#ef5350"; baCtx.textAlign = "right"; baCtx.fillText(bidT, x - tw / 2 - 2, cMid);
      baCtx.fillStyle = "#26a69a"; baCtx.textAlign = "left"; baCtx.fillText(askT, x + tw / 2 + 2, cMid);
    }
  }
}

function setBA(on) {
  baOn = on;
  $("#btnBA").classList.toggle("active", on);
  bacv.classList.toggle("hidden", !on);
  candle.applyOptions(on ? BA_CANDLE_HIDDEN : BA_CANDLE_ON);  // thin custom candles when on
  try { localStorage.setItem(BA_KEY, on ? "1" : "0"); } catch (_) {}
  if (on) { baResize(); baFetch(); }
  else { baBars = []; if (baCtx) baCtx.clearRect(0, 0, baW, baH); }
}
$("#btnBA").onclick = () => setBA(!baOn);

let baSched = null;
function baScheduleFetch() {
  if (!baOn) return;
  if (baSched) clearTimeout(baSched);
  baSched = setTimeout(baFetch, 70);
}
chart.timeScale().subscribeVisibleTimeRangeChange(() => { if (baOn) { baDraw(); baScheduleFetch(); } });
chart.timeScale().subscribeVisibleLogicalRangeChange(() => { if (baOn) { baDraw(); baScheduleFetch(); } });
new ResizeObserver(() => { if (baOn) { baResize(); baDraw(); } }).observe($("#chart"));
setInterval(() => { if (baOn && haveSession) baFetch(); }, 300);  // keeps thin candles + b/a live
try { if (localStorage.getItem(BA_KEY) === "1") setBA(true); } catch (_) {}
