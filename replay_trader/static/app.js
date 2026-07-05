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
  rightPriceScale: { borderColor: "#2a3340", minimumWidth: 64, scaleMargins: { top: 0.08, bottom: 0.12 } },
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
vol.priceScale().applyOptions({ scaleMargins: { top: 0.88, bottom: 0 } });   // volume in the bottom 12% (abuts the candle margin)

// session VWAP line (Σpx·sz / Σsz from the 09:30 RTH open; server-computed,
// no-lookahead). Empty data when the study is off (hidden). Default off.
const vwapSeries = chart.addLineSeries({
  color: "#e3d14b", lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
  crosshairMarkerVisible: false, lineStyle: LightweightCharts.LineStyle.Solid,
});

// Bollinger Bands — basis (SMA) + upper/lower (±mult·stdev) line series on the price
// chart. Empty data when the study is off. Computed client-side from allBars closes.
const _bbLineOpt = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
const bbUpper = chart.addLineSeries({ color: "#4d9fff", lineWidth: 1, ..._bbLineOpt });
const bbLower = chart.addLineSeries({ color: "#4d9fff", lineWidth: 1, ..._bbLineOpt });
const bbBasis = chart.addLineSeries({ color: "#ff9f40", lineWidth: 1,
  lineStyle: LightweightCharts.LineStyle.Dashed, ..._bbLineOpt });

// price line markers for live position (stop / target / entry)
let posPriceLines = [];
function clearPosLines() { posPriceLines.forEach((l) => candle.removePriceLine(l)); posPriceLines = []; }

// ── client state ────────────────────────────────────────────────────────────
// TF label -> bucket seconds. Mirrors the server's TF_SECONDS (one source of
// truth per side). Adding a TF = one entry here + one button in index.html.
const TF_SECONDS = { "5s": 5, "30s": 30, "1m": 60, "15m": 900 };
// The visible range is auto-FRAMED exactly ONCE, on a fresh session (NEW_SESSION_BARS
// candles ending at the open). EVERY other action — +time jump, →:59, touch/setup nav,
// play — only SCROLLS to follow the new data at the user's CURRENT zoom (never resets
// the visible range / zoom). This kills the jarring full-recenter on every jump.
const NEW_SESSION_BARS = 350;          // ~200-500 bars framed on a fresh session
let TF = "5s";
let tfSec = TF_SECONDS[TF];
let lastBarTime = null;      // synth time of most-recent applied bar
let haveSession = false;
let ended = false;
let lastSnap = null;         // most recent /api state (SL/TP anchor + setup-only state)

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
  updateBarsArray(bars, replace);     // keep the RSI source closes in sync
  if (rsiOn) { if (replace) rsiRebuild(); else rsiStep(); }
  if (bbOn) { if (replace) bbRebuild(); else bbStep(); }
}

function renderState(s) {
  if (!s || !s.ok && !s.session_id) return;
  lastSnap = s;
  trackTradeBoxes(s);     // open/close transitions -> grow/freeze the SL/TP trade box
  $("#clock").textContent = s.et_clock || "--:--:--";
  $("#price").textContent = fmt(s.cur_price);
  $("#prog").textContent = (s.progress_pct ?? 0) + "%";
  // date reveal (news trading): only shown when the server exposes session_date;
  // otherwise the badge stays hidden so blinding is intact.
  const sd = $("#session-date");
  if (sd) {
    if (s.session_date) { sd.textContent = "📅 " + s.session_date; sd.classList.remove("hidden"); }
    else { sd.textContent = ""; sd.classList.add("hidden"); }
  }
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
  renderFlow(s);
  renderHeat(s);
  renderVwap(s);
  renderTape(s);
  renderInstr(s);
  renderIctState(s);     // setup-only toggle reflect + SL/TP anchor redraw
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
    const r = await api(`/api/bars?tf=${TF}&since=${since}${flowOn ? "&flow=1" : ""}${heatOn ? "&heat=1" : ""}${vwapOn ? "&vwap=1" : ""}${tapeOn ? "&tape=1" : ""}`);
    if (r.ok) {
      applyBars(r.bars || [], lastBarTime === null);
      renderState(r);
      if (fpOn) fetchFootprint();
      if (ictOn) fetchStructures();
      if (liqOn) fetchLevels();
      if (zzOn) fetchZigzag();
      if (ppOn) fetchPP();
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

// Frame ~NEW_SESSION_BARS candles across the chart (zoom set once) — used ONLY on a
// fresh session. Sets barSpacing = plotWidth / N directly (deterministic) then scrolls
// the newest bar to the right edge. The chart's width is 0 until its first paint, so
// if called during that load race it retries on a short timer until a width exists.
function frameNewSession(attempt) {
  const n = allBars.length;
  if (!n) return;
  // Setting barSpacing directly is the only thing that reliably changes the zoom in
  // this lightweight-charts build (setVisibleLogicalRange is ignored here). The chart's
  // width passes through tiny transient values during layout (which clamp barSpacing to
  // the 0.5 floor), so wait for a clearly-final width (> 400px — this is a desktop tool)
  // before applying, retrying on a short timer until then.
  const w = $("#chart").clientWidth;
  if (w > 400) {
    chart.timeScale().applyOptions({ barSpacing: Math.max(0.5, w / NEW_SESSION_BARS) });
    chart.timeScale().scrollToPosition(6, false);
  } else if ((attempt || 0) < 30) {
    setTimeout(() => frameNewSession((attempt || 0) + 1), 80);
  }
}
// Focus/refit (◎ Focus button, manual only): frame ~250 candles wide with the newest
// near the right edge, and fit the HEIGHT to the visible candles' high/low + a small pad
// (the tightened price-scale margins do the vertical fit). NOTE: in this lightweight-charts
// build applyOptions({barSpacing}), setVisibleLogicalRange and fitContent are ALL no-ops
// for zoom — only interactive wheel/pinch changes it. Synthesized wheel zoom applies
// synchronously (getVisibleLogicalRange reflects it on the next line), so we loop wheel
// notches, reading the visible count each time, until it lands in [FOCUS_LO, FOCUS_HI].
const FOCUS_LO = 210, FOCUS_HI = 290;
function focusCandles() {
  if (allBars.length < 3) return;
  const ts = chart.timeScale();
  const cv = document.querySelector("#chart canvas");
  if (!cv) return;
  const rect = cv.getBoundingClientRect();
  const cx = rect.left + rect.width * 0.72, cy = rect.top + rect.height * 0.5;    // zoom about the recent candles
  const count = () => { const lr = ts.getVisibleLogicalRange(); return lr ? (lr.to - lr.from) : 0; };
  // deltaY < 0 zooms IN (fewer candles); deltaY > 0 zooms OUT (more candles); ~9% per notch
  for (let i = 0; i < 80; i++) {
    const c = count();
    if (c >= FOCUS_LO && c <= FOCUS_HI) break;
    cv.dispatchEvent(new WheelEvent("wheel", { deltaY: c < FOCUS_LO ? 80 : -80, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
  }
  ts.scrollToPosition(6, false);                                    // re-anchor newest near the right
  try { candle.priceScale().applyOptions({ autoScale: true }); } catch (_) {}  // fit height to visible
}
// Forward cursor jump (+time / →:59): fetch bars up to the new cursor (no VWAP reset)
// and render — but DO NOT move the view (no scroll, no refit). The user presses ◎ Focus
// to snap onto the candles when they want.
async function navRefreshAndSnap() {
  const since = lastBarTime === null ? "" : lastBarTime;
  try {
    const r = await api(`/api/bars?tf=${TF}&since=${since}${flowOn ? "&flow=1" : ""}${heatOn ? "&heat=1" : ""}${vwapOn ? "&vwap=1" : ""}${tapeOn ? "&tape=1" : ""}`);
    if (r.ok) {
      applyBars(r.bars || [], lastBarTime === null);
      renderState(r);
      if (fpOn) fetchFootprint();
      if (ictOn) fetchStructures(true);
      if (liqOn) fetchLevels(true);
      if (zzOn) fetchZigzag(true);
    }
  } catch (e) { /* transient */ }
}

// ── full reload (new session / tf switch) ─────────────────────────────────────
async function fullReload(preOpenView = false) {
  lastBarTime = null;
  vwapClear();                 // VWAP line rebuilds live after a TF switch / new session
  const r = await api(`/api/bars?tf=${TF}&since=`);
  if (r.ok) {
    applyBars(r.bars || [], true);
    renderState(r);
    if (preOpenView && lastBarTime != null) {
      frameNewSession();   // fresh session ONLY: set the zoom to ~350 bars at the open
    } else {
      chart.timeScale().scrollToPosition(6, false);   // TF switch / nav seek: follow at zoom
    }
  }
}

// ── controls wiring ───────────────────────────────────────────────────────────
$("#btnPlay").onclick = async () => {
  const r = await api("/api/state");
  await post("/api/control", { action: r.paused ? "play" : "pause" });
  poll();
  if (ppOn) fetchPP(true);   // a pause just landed -> refresh the markers
};
document.querySelectorAll(".spd").forEach((b) => b.onclick = async () => {
  document.querySelectorAll(".spd").forEach((x) => x.classList.remove("active"));
  b.classList.add("active");
  await post("/api/control", { action: "speed", speed: +b.dataset.spd });
});
$("#btnJump").onclick = async () => { await post("/api/control", { action: "jump", seconds: 300 }); await navRefreshAndSnap(); };
$("#btnClose").onclick = async () => { await post("/api/control", { action: "to_close" }); await navRefreshAndSnap(); };
$("#btnFocus").onclick = () => focusCandles();

document.querySelectorAll(".tf").forEach((b) => b.onclick = async () => {
  document.querySelectorAll(".tf").forEach((x) => x.classList.remove("active"));
  b.classList.add("active");
  TF = b.dataset.tf; tfSec = TF_SECONDS[TF] || 5;
  fpData = []; if (fpOn && fpCtx) fpCtx.clearRect(0, 0, fpW, fpH);
  await fullReload();
  if (fpOn) fetchFootprint();
  if (zzOn) fetchZigzag(true);   // ZigZag is computed on the displayed-TF bars
  if (ppOn) fetchPP(true);       // pause markers re-bucket to the new TF
  loadTouches();   // RSI-confluence touch filter is TF-dependent -> refresh for the new TF
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
  haveSession = true; ended = false; lastBarTime = null;
  slPrice = tpPrice = null;    // re-init SL/TP defaults for the new session
  closedTradeBoxes = []; activeTradeKey = null; lastActiveTrade = null;   // clear old trade boxes
  ictData = [];
  await fullReload(true);      // show the overnight pre-open context + the 09:30 open
  renderState(r);
  loadSetups();                // populate the jump-to-setup table
  loadTouches();               // populate the liquidity-touch navigator
  if (liqOn) fetchLevels(true);
  if (zzOn) fetchZigzag(true);
  ppEvents = []; ppLastSig = "";
  try { candle.setMarkers([]); } catch (_) {}   // clear prior session's pause markers
  if (ppOn) fetchPP(true);
}

// ── hotkeys ───────────────────────────────────────────────────────────────────
window.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return;
  if (e.code === "Space") { e.preventDefault(); $("#btnPlay").click(); }
  else if (e.key === "b" || e.key === "B") doOrder("buy");
  else if (e.key === "s" || e.key === "S") doOrder("sell");
  else if (e.key === "f" || e.key === "F") setSltp(!sltpOn);   // toggle draggable SL/TP + trade box
  else if (e.key === "c" || e.key === "C") $("#btnFlat").click();   // flatten (moved off F)
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

// resize — keep the lightweight-charts canvas matched to its (CSS-driven) box.
// v4 has no auto-resize, and showing/hiding the RSI sub-pane changes #chart's height,
// so an explicit chart.resize() here is what makes the price chart reflow correctly.
new ResizeObserver(() => {
  const el = $("#chart");
  chart.resize(el.clientWidth, el.clientHeight);
  if (fpOn) { fpResize(); drawFootprint(); }
  if (liqOn) { liqResize(); drawLiq(); }
}).observe($("#chart"));

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

// ── study-gated toolbar nav groups — the TJR setup-skip and liquidity-touch-skip
// button groups are HIDDEN by default and only shown when enabled from the Studies
// menu (so a fresh load shows none of them). Pure visibility; the nav still loads. ─
const SETUPNAV_KEY = "replay_trader.setupnav", TOUCHNAV_KEY = "replay_trader.touchnav";
let setupNavOn = false, touchNavOn = false;
function setSetupNav(on) {
  setupNavOn = on;
  $("#btnSetupNav").classList.toggle("active", on);
  $("#setupnav").classList.toggle("hidden", !on);
  try { localStorage.setItem(SETUPNAV_KEY, on ? "1" : "0"); } catch (_) {}
}
function setTouchNav(on) {
  touchNavOn = on;
  $("#btnTouchNav").classList.toggle("active", on);
  $("#touchnav").classList.toggle("hidden", !on);
  try { localStorage.setItem(TOUCHNAV_KEY, on ? "1" : "0"); } catch (_) {}
}
$("#btnSetupNav").onclick = () => setSetupNav(!setupNavOn);
$("#btnTouchNav").onclick = () => setTouchNav(!touchNavOn);
try { if (localStorage.getItem(SETUPNAV_KEY) === "1") setSetupNav(true); } catch (_) {}
try { if (localStorage.getItem(TOUCHNAV_KEY) === "1") setTouchNav(true); } catch (_) {}

// ════════════════════════════════════════════════════════════════════════════
//  TEMPORARY — RSI(15)+Bollinger open-fade LOSER REVIEW navigator. A study-gated
//  toolbar group: step through the 80 losing trades; each Prev/Next loads that
//  loser's market day (real prices, full mode) and seeks ~2.5 min before the entry
//  so the user can watch the setup form, then trade it. Remove with the
//  /api/rsibb_losers route + rsibb_losers.json + the "RSI+BB Losers" study when done.
// ════════════════════════════════════════════════════════════════════════════
const LOSER_KEY = "replay_trader.loser";
const LOSER_LEAD_NS = 150 * 1e9;     // seek ~2.5 min before entry_ns
let loserOn = false, losers = [], loserIdx = -1, loserLoading = false;

async function loadLosers() {
  if (losers.length) return true;
  try {
    const r = await api("/api/rsibb_losers");
    if (r.ok) { losers = r.losers || []; return true; }
  } catch (_) { /* transient */ }
  return false;
}
function renderLoserLabel() {
  $("#losercount").textContent = "Loser " + (loserIdx >= 0 ? (loserIdx + 1) : "–") + "/" + (losers.length || 80);
  const el = $("#loserinfo");
  if (loserIdx < 0 || !losers[loserIdx]) { el.textContent = "—"; return; }
  const L = losers[loserIdx];
  const t = (L.entry_et || "").slice(11, 19);   // HH:MM:SS from the ET string
  el.innerHTML = `${L.date} · ${t} · <b>${L.side}</b> · <span class="${L.pnl < 0 ? "neg" : "pos"}">${money(L.pnl)}</span>`;
}
async function gotoLoser(step) {
  if (loserLoading) return;
  if (!losers.length && !(await loadLosers())) return;
  let ni = loserIdx < 0 ? (step > 0 ? 0 : losers.length - 1) : loserIdx + step;
  ni = Math.max(0, Math.min(losers.length - 1, ni));
  const L = losers[ni];
  loserLoading = true;
  $("#losercount").textContent = "loading…";
  try {
    const r = await post("/api/new_session", { mode: "full", date: L.date, slip_tk: 1, instrument: instrPref() });
    if (!r || !r.ok) { $("#loserinfo").textContent = "date not in cache: " + L.date; return; }
    // adopt the loaded day on the client (mirror newSession's reset)
    haveSession = true; ended = false; lastBarTime = null;
    slPrice = tpPrice = null; closedTradeBoxes = []; activeTradeKey = null; lastActiveTrade = null; ictData = [];
    await fullReload(true);
    renderState(r);
    loadSetups(); loadTouches();
    ppEvents = []; ppLastSig = ""; try { candle.setMarkers([]); } catch (_) {}
    // seek ~2.5 min before the entry, then frame the lead-up (paused, ready to play)
    const r2 = await post("/api/control", { action: "goto", ns: L.entry_ns - LOSER_LEAD_NS });
    await fullReload(false);
    renderState(r2);
    frameNewSession();
    if (liqOn) fetchLevels(true);
    if (zzOn) fetchZigzag(true);
    if (ppOn) fetchPP(true);
    loserIdx = ni;
  } catch (e) { /* transient */ }
  finally { loserLoading = false; renderLoserLabel(); }
}
async function setLoser(on) {
  loserOn = on;
  $("#btnLoser").classList.toggle("active", on);
  $("#losernav").classList.toggle("hidden", !on);
  try { localStorage.setItem(LOSER_KEY, on ? "1" : "0"); } catch (_) {}
  if (on) { await loadLosers(); renderLoserLabel(); }
}
$("#btnLoser").onclick = () => setLoser(!loserOn);
$("#btnLoserNext").onclick = () => gotoLoser(1);
$("#btnLoserPrev").onclick = () => gotoLoser(-1);
try { if (localStorage.getItem(LOSER_KEY) === "1") setLoser(true); } catch (_) {}

// ── flow light ───────────────────────────────────────────────────────────────
// Always-visible toolbar pill = trailing-60s signed order-flow delta (Σ side×size
// over SEEN ticks, server-computed no-lookahead). A PERMISSION read for Parag's
// discretion, NOT a signal: it never blocks a trade. The server only computes the
// delta when flow is ON (poll appends &flow=1); the per-trade flow_delta_entry is
// logged server-side at fill time REGARDLESS of the toggle (it's the science
// record). Default ON, persisted. No-flicker: DOM touched only when state changes.
const FLOW_KEY = "replay_trader.flow";
let flowOn = true;
const flowEl = $("#flowpill");
let flowLastState = null;   // "long" | "short" | "neutral" | "off"
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
  try { localStorage.setItem(FLOW_KEY, on ? "1" : "0"); } catch (_) {}
  renderFlow(on ? null : undefined);   // reflect off-state / reset to neutral now
}
$("#btnFlow").onclick = () => setFlow(!flowOn);
// default ON: only off when the user explicitly persisted "0"
try { setFlow(localStorage.getItem(FLOW_KEY) !== "0"); } catch (_) { setFlow(true); }

// ── open heat ──────────────────────────────────────────────────────────────────
// Always-visible toolbar pill = 5-min opening-range width in ticks (max−min of PX
// over 09:30:00–09:35:00 ET, server-computed no-lookahead). Live-accumulates until
// the replay clock passes 09:35, then FREEZES. A RISK-PROTOCOL read for Parag's
// discretion (his P&L correlates −0.68 with this): green <250 quiet, amber 250–400,
// red >400 heat protocol. The server only computes it when heat is ON (poll appends
// &heat=1); open5m_range is logged into the session JSON stats at trade close
// REGARDLESS of the toggle (the science record). Default ON, persisted. No-flicker:
// DOM touched only when state changes.
const HEAT_KEY = "replay_trader.heat";
let heatOn = true;
const heatEl = $("#heatpill");
let heatLastState = null;   // "quiet" | "warm" | "hot" | "neutral" | "off"
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
  if (r === null || r === undefined) state = "neutral";   // before 09:30 / no data
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
  try { localStorage.setItem(HEAT_KEY, on ? "1" : "0"); } catch (_) {}
  renderHeat(on ? null : undefined);   // reflect off-state / reset to neutral now
}
$("#btnHeat").onclick = () => setHeat(!heatOn);
// default ON: only off when the user explicitly persisted "0"
try { setHeat(localStorage.getItem(HEAT_KEY) !== "0"); } catch (_) { setHeat(true); }

// ── tape regime ────────────────────────────────────────────────────────────────
// Toolbar pill = rolling 30-min variance ratio (server-computed, no-lookahead).
// VR<0.9 GREEN "FADE-ABLE" (mean-reverting — Parag's VA-fade habitat); 0.9-1.1 GREY
// "NEUTRAL"; VR>1.1 RED "EXTENDING" (trending — stand down). A regime read for his
// discretion, never blocks a trade. The server only computes VR when ON (poll
// appends &tape=1); tape_vr_entry is logged server-side at fill REGARDLESS of the
// toggle (the science record). Default ON, persisted. No-flicker.
const TAPE_KEY = "replay_trader.tape";
let tapeOn = true;
const tapeEl = $("#tapepill");
let tapeLastState = null;   // "fade" | "extend" | "neutral" | "off"
let tapeLastLabel = null;
let tapeLastVal = null;

function renderTape(s) {
  if (!tapeEl) return;
  if (!tapeOn) {
    if (tapeLastState !== "off") {
      tapeEl.className = "tapepill off";
      $("#tapelabel").textContent = "TAPE"; $("#tapeval").textContent = "off";
      tapeLastState = "off"; tapeLastLabel = "TAPE"; tapeLastVal = "off";
    }
    return;
  }
  const vr = s ? s.tape_vr : undefined;
  const fade  = (s && s.tape_vr_fade  != null) ? s.tape_vr_fade  : 0.9;
  const trend = (s && s.tape_vr_trend != null) ? s.tape_vr_trend : 1.1;
  let state, label;
  if (vr === null || vr === undefined) { state = "neutral"; label = "TAPE"; }  // warming
  else if (vr < fade)  { state = "fade";    label = "FADE-ABLE"; }
  else if (vr > trend) { state = "extend";  label = "EXTENDING"; }
  else                 { state = "neutral"; label = "NEUTRAL"; }
  if (state !== tapeLastState) { tapeEl.className = "tapepill " + state; tapeLastState = state; }
  if (label !== tapeLastLabel) { $("#tapelabel").textContent = label; tapeLastLabel = label; }
  const vtxt = (vr === null || vr === undefined) ? "…" : vr.toFixed(2);
  if (vtxt !== tapeLastVal) { $("#tapeval").textContent = vtxt; tapeLastVal = vtxt; }
}

function setTape(on) {
  tapeOn = on;
  $("#btnTape").classList.toggle("active", on);
  try { localStorage.setItem(TAPE_KEY, on ? "1" : "0"); } catch (_) {}
  renderTape(on ? null : undefined);   // reflect off-state / reset to warming now
}
$("#btnTape").onclick = () => setTape(!tapeOn);
// default ON: only off when the user explicitly persisted "0"
try { setTape(localStorage.getItem(TAPE_KEY) !== "0"); } catch (_) { setTape(true); }

// ── VWAP ───────────────────────────────────────────────────────────────────────
// Session VWAP line from the 09:30 RTH open (server-computed in the snapshot, gated
// by &vwap=1; incremental running sums, no-lookahead). Built LIVE: each poll appends
// the current VWAP at the current bar time. Default OFF, persisted, hidden when off
// (empty series, server calc skipped). Switching TF / new session resets the line
// (vwapClear in fullReload); it rebuilds live from the current point since the
// snapshot carries only the current value.
const VWAP_KEY = "replay_trader.vwap";
let vwapOn = false;
let vwapLastT = null;          // last applied point time (keep the series monotonic)

function renderVwap(s) {
  if (!vwapOn) return;
  const v = s ? s.vwap : undefined;
  if (v === null || v === undefined || lastBarTime === null) return;
  if (vwapLastT !== null && lastBarTime < vwapLastT) return;   // never go back in time
  vwapSeries.update({ time: lastBarTime, value: v });
  vwapLastT = lastBarTime;
}

function vwapClear() {
  vwapSeries.setData([]);
  vwapLastT = null;
}

function setVwap(on) {
  vwapOn = on;
  $("#btnVWAP").classList.toggle("active", on);
  try { localStorage.setItem(VWAP_KEY, on ? "1" : "0"); } catch (_) {}
  if (!on) vwapClear();        // hide the line; poll drops &vwap=1 -> server skips calc
}
$("#btnVWAP").onclick = () => setVwap(!vwapOn);
// default OFF: only on when the user explicitly persisted "1"
try { setVwap(localStorage.getItem(VWAP_KEY) === "1"); } catch (_) { setVwap(false); }

// ── contract selector: Mini (NQ) ↔ Micro (MNQ) ─────────────────────────────
// Pure math switch — micro = 1/10 the $/tick & commission of a mini (10 micros
// = 1 mini). Lets you hold wider/longer for the same dollar risk. No new data.
const INSTR_KEY = "replay_trader.instrument";
const instrEl = $("#instrument");
// Persisted instrument preference (sent to the server when a session is created).
function instrPref() {
  try { return localStorage.getItem(INSTR_KEY) || "mini"; } catch (_) { return "mini"; }
}
// Change the live session's instrument and persist the choice.
async function instrApply() {
  try {
    localStorage.setItem(INSTR_KEY, instrEl.value);
  } catch (_) {}
  try {
    const r = await post("/api/control", { action: "instrument", instrument: instrEl.value });
    renderState(r);   // reflect confirmed server state immediately
  } catch (_) {}
}
// SERVER IS THE SOURCE OF TRUTH for the label: the dropdown always mirrors the
// snapshot's instrument, so what the UI shows is exactly what the engine bills.
function renderInstr(s) {
  if (!instrEl || !s || !s.instrument) return;
  if (instrEl.value !== s.instrument) instrEl.value = s.instrument;
  try { localStorage.setItem(INSTR_KEY, s.instrument); } catch (_) {}
}
if (instrEl) {
  try { instrEl.value = instrPref(); } catch (_) {}   // optimistic until the first snapshot
  instrEl.addEventListener("change", instrApply);
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

// ADAPTIVE LEVEL BINNING: choose a bin size (in ticks) so each rendered ladder row
// keeps a roughly constant pixel height — fine 1-tick rows zoomed in, coarse combined
// rows zoomed out, constant font throughout. Clean snap increments (ticks -> points):
// 1=0.25 · 2=0.5 · 4=1 · 10=2.5 · 20=5 · 40=10 · 100=25 · 200=50 · 400=100.
const BA_TARGET_ROW_PX = 12;
const BA_BIN_SNAPS = [1, 2, 4, 10, 20, 40, 100, 200, 400];
function baSnapBin(t) {
  for (const s of BA_BIN_SNAPS) if (t <= s) return s;
  return BA_BIN_SNAPS[BA_BIN_SNAPS.length - 1];
}
// Aggregate footprint cells into constant-height price bins. Bin key = floor(priceTicks
// / binTicks) on the absolute tick grid (so bins align across bars and across zoom).
// Conserves volume exactly: every cell maps to exactly one bin (Σbinned == Σraw).
function baBinCells(cells, binTicks) {
  const bins = new Map();
  for (const c of cells) {
    const pt = Math.round(c.p / 0.25);                 // display price -> integer ticks
    const k = Math.floor(pt / binTicks);
    let e = bins.get(k);
    if (!e) { e = { k: k, b: 0, s: 0 }; bins.set(k, e); }
    e.b += c.b; e.s += c.s;
  }
  return bins;
}

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
  // No mappable range (e.g. zoomed/panned past the data) — keep drawing what we
  // already have and bail WITHOUT setting the in-flight guard, so the next zoom/
  // interval retries cleanly. (Root-cause of the "vanishes till restart" bug: an
  // early return here used to leave the ladder un-refetched on zoom-back-in.)
  if (!vr) { baDraw(); return; }
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
      fp[b.time] = { cells: b.cells || [], poc: b.poc };   // per-level cells only (no sums)
    }
    if (rb && rb.ok) {
      baBars = (rb.bars || [])
        .filter((b) => b.time >= from - 1 && b.time <= to + 1)
        .map((b) => Object.assign({}, b, fp[b.time] || { cells: [], poc: null }));
    }
    baDraw();
  } catch (e) { /* transient */ }
  finally { baFetching = false; }   // ALWAYS release the guard — never stays stuck
}

function baDraw() {
  if (!baOn || !baCtx) return;
  try {
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
    // px per single tick (0.25 pt) from a VISIBLE bar's close — robust probe so the
    // ladder never gets stuck blank just because one cell price is off-screen.
    let ppt = 0;
    for (const b of baBars) {
      const y0 = candle.priceToCoordinate(b.close), y1 = candle.priceToCoordinate(b.close + 0.25);
      if (y0 != null && y1 != null && Math.abs(y0 - y1) > 0) { ppt = Math.abs(y0 - y1); break; }
    }
    if (ppt <= 0) ppt = 1;   // last-ditch fallback; candles still draw, ladder retries next frame
    // ADAPTIVE BIN: pick bin ticks so each row is ~BA_TARGET_ROW_PX tall, font constant.
    const binTicks = baSnapBin(Math.max(1, Math.ceil(BA_TARGET_ROW_PX / ppt)));
    const rowPx = Math.max(1, binTicks * ppt);
    const fs = Math.max(8, Math.min(11, Math.round(rowPx) - 2));   // ~constant font at every zoom
    baCtx.font = `${fs}px ui-monospace,Menlo,Consolas,monospace`;
    baCtx.textBaseline = "middle";
    const avail = cellW / 2 - tw / 2 - 3;
    // horizontal stride: if a candle column is narrower than both number columns +
    // body, ladder only every Nth bar (numbers don't collide) — never fall back to sums.
    const minLadderW = 2 * (fs * 1.5) + tw + 6;
    const stride = (cellW >= minLadderW) ? 1 : Math.max(1, Math.ceil(minLadderW / cellW));
    for (let bi = 0; bi < baBars.length; bi++) {
      const b = baBars[bi];
      const x = ts.timeToCoordinate(b.time);
      if (x == null) continue;
      const yO = candle.priceToCoordinate(b.open), yC = candle.priceToCoordinate(b.close);
      const yH = candle.priceToCoordinate(b.high), yL = candle.priceToCoordinate(b.low);
      if (yO == null || yC == null || yH == null || yL == null) continue;
      const up = b.close >= b.open;
      const col = up ? "#26a69a" : "#ef5350";
      // wick + thin body — drawn for EVERY bar so price action stays continuous
      baCtx.strokeStyle = col; baCtx.lineWidth = 1;
      baCtx.beginPath(); baCtx.moveTo(x + 0.5, yH); baCtx.lineTo(x + 0.5, yL); baCtx.stroke();
      const bodyTop = Math.min(yO, yC), bodyH = Math.max(1, Math.abs(yC - yO));
      baCtx.fillStyle = col; baCtx.fillRect(Math.round(x - tw / 2), bodyTop, tw, bodyH);

      if ((bi % stride) !== 0 || !b.cells || !b.cells.length) continue;
      // bin the raw cells into constant-height rows (conserves volume exactly)
      const bins = baBinCells(b.cells, binTicks);
      let pocK = null, pocV = -1;
      for (const e of bins.values()) { const t = e.b + e.s; if (t > pocV) { pocV = t; pocK = e.k; } }
      const bandHalf = Math.max(tw, Math.min(cellW * 0.46, avail + tw / 2 + 4));
      for (const e of bins.values()) {
        // bin center price (ticks) -> display points; rows tile by rowPx without gaps
        const centerPt = e.k * binTicks + (binTicks - 1) / 2;
        const y = candle.priceToCoordinate(centerPt * 0.25);
        if (y == null) continue;                                        // off-screen row culled
        if (e.k === pocK) {
          // POC bin: inverse/grey band spanning the ladder width + total volume centered
          baCtx.fillStyle = "rgba(139,148,158,.32)";
          baCtx.fillRect(x - bandHalf, y - rowPx / 2, bandHalf * 2, rowPx);
          baCtx.fillStyle = "#e6edf3"; baCtx.textAlign = "center";
          baCtx.fillText(baFmt(e.b + e.s), x, y);
          continue;
        }
        // diagonal imbalance (>=3:1) on the BINNED ladder: ask(buy) vs bid one BIN UP;
        // bid(sell) vs ask one BIN DOWN. Dominant side's number turns RED; rest blue-grey.
        const above = bins.get(e.k + 1);   // sells (bid) one bin up
        const below = bins.get(e.k - 1);   // buys (ask) one bin down
        const bidImb = e.s > 0 && below && below.b > 0 && e.s >= 3 * below.b;
        const askImb = e.b > 0 && above && above.s > 0 && e.b >= 3 * above.s;
        if (e.s) {  // BID column = sell-aggressor (hit bid), LEFT
          baCtx.fillStyle = bidImb ? "#ef5350" : "#9fb6d4";
          baCtx.textAlign = "right"; baCtx.fillText(baFmt(e.s), x - tw / 2 - 2, y);
        }
        if (e.b) {  // ASK column = buy-aggressor (lift ask), RIGHT
          baCtx.fillStyle = askImb ? "#ef5350" : "#9fb6d4";
          baCtx.textAlign = "left"; baCtx.fillText(baFmt(e.b), x + tw / 2 + 2, y);
        }
      }
    }
  } catch (e) { /* never let a draw error kill the study / its subscriptions */ }
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

// ════════════════════════════════════════════════════════════════════════════
//  ICT / TJR — live structure overlays, jump-to-setup, setup-only, draggable SL/TP
// ════════════════════════════════════════════════════════════════════════════
const TICK = 0.25;
const round2 = (p) => Math.round(p / TICK) * TICK;
function _cvResize(cv) {
  const wrap = $("#chartwrap"), w = wrap.clientWidth, h = wrap.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  cv.style.width = w + "px"; cv.style.height = h + "px";
  const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

// ── live structure overlay (FVG/IFVG/BOS/MSS/sweep) ───────────────────────────
// Only currently-active/relevant structures (server-filtered, causal). FVG boxes
// vanish when filled; close-throughs show as IFVG; stale BOS/MSS/sweep drop off.
const ICT_KEY = "replay_trader.ict";
let ictOn = false, ictData = [], ictFetching = false;
const ictcv = $("#ictcanvas");
let ictCtx = null, ictW = 0, ictH = 0;
function ictResize() { const r = _cvResize(ictcv); ictCtx = r.ctx; ictW = r.w; ictH = r.h; }

let ictLastFetch = 0;
async function fetchStructures(force) {
  if (!ictOn || !haveSession || ictFetching) return;
  const now = Date.now();
  if (!force && now - ictLastFetch < 600) return;   // throttle: structures move at 1-min cadence
  ictLastFetch = now;
  ictFetching = true;
  try {
    const r = await api("/api/structures");
    if (r.ok) { ictData = r.structures || []; drawIct(); }
  } catch (e) { /* transient */ }
  ictFetching = false;
}

function drawIct() {
  if (!ictOn || !ictCtx) return;
  ictCtx.clearRect(0, 0, ictW, ictH);
  if (!ictData.length) return;
  const ts = chart.timeScale();
  const xR = ictW;                       // active structures extend to "now" (right edge)
  ictCtx.font = "10px ui-monospace,Menlo,Consolas,monospace";
  for (const st of ictData) {
    if (st.kind === "FVG" || st.kind === "IFVG") {
      const x0 = ts.timeToCoordinate(st.t0);
      const yLo = candle.priceToCoordinate(st.lo), yHi = candle.priceToCoordinate(st.hi);
      if (x0 == null || yLo == null || yHi == null) continue;
      const x = Math.max(0, x0), top = Math.min(yLo, yHi), h = Math.max(1, Math.abs(yLo - yHi));
      const bull = st.dir === "bull", isI = st.kind === "IFVG";
      ictCtx.fillStyle = isI ? "rgba(176,124,255,.10)" : (bull ? "rgba(38,166,154,.13)" : "rgba(239,83,80,.13)");
      ictCtx.fillRect(x, top, xR - x, h);
      ictCtx.strokeStyle = isI ? "#b07cff" : (bull ? "#26a69a" : "#ef5350");
      ictCtx.lineWidth = 1; ictCtx.setLineDash(isI ? [4, 3] : []);
      ictCtx.strokeRect(x, top, xR - x, h); ictCtx.setLineDash([]);
      ictCtx.fillStyle = isI ? "#b07cff" : (bull ? "#26a69a" : "#ef5350");
      ictCtx.textAlign = "left"; ictCtx.textBaseline = "bottom";
      ictCtx.fillText(st.label, x + 3, top - 1);
    } else {
      const x0 = ts.timeToCoordinate(st.t), y = candle.priceToCoordinate(st.level);
      if (x0 == null || y == null) continue;
      const col = st.kind === "SWEEP" ? "#b07cff" : st.kind === "MSS" ? "#ff9f40" : "#4d9fff";
      ictCtx.strokeStyle = col; ictCtx.lineWidth = 1.5; ictCtx.setLineDash([2, 3]);
      ictCtx.beginPath(); ictCtx.moveTo(Math.max(0, x0), y); ictCtx.lineTo(xR, y); ictCtx.stroke();
      ictCtx.setLineDash([]);
      ictCtx.fillStyle = col; ictCtx.textAlign = "left"; ictCtx.textBaseline = "bottom";
      ictCtx.fillText(st.label + (st.dir === "bull" ? " ↑" : " ↓"), Math.max(0, x0) + 3, y - 2);
    }
  }
}

function setIct(on) {
  ictOn = on;
  $("#btnIct").classList.toggle("active", on);
  ictcv.classList.toggle("hidden", !on);
  try { localStorage.setItem(ICT_KEY, on ? "1" : "0"); } catch (_) {}
  if (on) { ictResize(); fetchStructures(true); }
  else { ictData = []; if (ictCtx) ictCtx.clearRect(0, 0, ictW, ictH); }
}
$("#btnIct").onclick = () => setIct(!ictOn);

// ── jump-to-setup navigation ──────────────────────────────────────────────────
// The setups list is sorted ascending by time (server-side). The "current index" is
// derived from the EXACT cursor position (snapshot.cursor_synth), not the 1-min-
// bucketed setup.t — so it can never desync — and ◀/▶ step exactly −1/+1 through the
// list (clamped at the ends). The counter shows idx+1 / N.
let setupsData = [];
let detectTf = 60;     // setup detection-bar seconds (setup.t is bucketed to this)
async function loadSetups() {
  setupsData = [];
  $("#setupcount").textContent = "…";
  try {
    const r = await api("/api/setups");
    if (r.ok) { setupsData = r.setups || []; if (r.detection_tf) detectTf = r.detection_tf; }
  } catch (e) { /* transient */ }
  updateSetupCount();
  if (anatomyOn) drawAnatomy();
}
function cursorSynth() {
  return (lastSnap && lastSnap.cursor_synth != null) ? lastSnap.cursor_synth : (lastBarTime || 0);
}
// index of the setup whose detection bar the cursor is currently INSIDE, else -1.
function curSetupIdx() {
  const cs = cursorSynth();
  for (let i = 0; i < setupsData.length; i++)
    if (setupsData[i].t <= cs && cs < setupsData[i].t + detectTf) return i;
  return -1;
}
function updateSetupCount() {
  const n = setupsData.length;
  if (!n) { $("#setupcount").textContent = "0 setups"; return; }
  const k = curSetupIdx();
  if (k < 0) { $("#setupcount").textContent = "–/" + n + " setups"; return; }
  const su = setupsData[k];
  const g = su.grade ? su.grade + " " : "";
  $("#setupcount").textContent = (k + 1) + "/" + n + " · " + g + (su.dir === "long" ? "LONG" : "SHORT");
}
async function gotoSetup(step) {
  if (!setupsData.length) return;
  const here = curSetupIdx(), cs = cursorSynth();
  let ni;
  if (here >= 0) ni = here + step;                          // on a setup -> step exactly ±1
  else if (step > 0) {                                      // between setups -> the next one ahead
    ni = setupsData.findIndex((su) => su.t > cs);
    if (ni < 0) ni = setupsData.length - 1;
  } else {                                                  // -> the last one behind
    ni = -1; for (let i = setupsData.length - 1; i >= 0; i--) if (setupsData[i].t < cs) { ni = i; break; }
    if (ni < 0) ni = 0;
  }
  ni = Math.max(0, Math.min(setupsData.length - 1, ni));    // clamp at the ends
  const target = setupsData[ni];
  const r = await post("/api/control", { action: "goto", ns: target.ns });
  await fullReload(false);     // re-render revealed bars + follow at current zoom (no recenter)
  renderState(r);
  if (ictOn) fetchStructures(true);
  updateSetupCount();
}
$("#btnSetupNext").onclick = () => gotoSetup(1);
$("#btnSetupPrev").onclick = () => gotoSetup(-1);

// ── setup-only entry toggle ───────────────────────────────────────────────────
async function setSetupOnly(on) {
  const r = await post("/api/control", { action: "setup_only", on });
  renderState(r);   // reflect the toggle immediately
}
$("#btnSetupOnly").onclick = () => setSetupOnly(!(lastSnap && lastSnap.setup_only));
function renderIctState(s) {
  $("#btnSetupOnly").classList.toggle("active", !!(s && s.setup_only));
  if (sltpOn) { sltpSyncToPosition(); drawSltp(); }   // anchor + bracket follow the position
  if (anatomyOn) drawAnatomy();  // reveal the nearest setup's parts as the cursor advances
  if (setupsData.length) updateSetupCount();   // keep the k/N counter live as the cursor moves
  if (touchesData.length) updateTouchCount();  // keep the liquidity-touch counter live
  if (liqOn) drawLiq();          // re-anchor pool labels to the current price scale
  if (zzOn) drawZZ();            // re-anchor the zigzag to the current price scale
}

// ── draggable SL/TP with live R:R ─────────────────────────────────────────────
const SLTP_KEY = "replay_trader.sltp";
let sltpOn = false, slPrice = null, tpPrice = null, sltpDrag = null;
// Trade boxes: the active position's risk/reward box grows from its entry bar to the
// live bar; on close it freezes at the close bar and is kept in `closedTradeBoxes` as
// a persistent historical record. `lastActiveTrade` holds the open trade's committed
// bracket so the close can be frozen accurately.
let closedTradeBoxes = [], activeTradeKey = null, lastActiveTrade = null;
// Capture position open/close transitions to drive the trade boxes (called per render).
function trackTradeBoxes(s) {
  const p = s && s.position;
  if (p && p.entry_synth != null) {
    activeTradeKey = `${p.entry}/${p.side}/${p.entry_synth}`;
    lastActiveTrade = { entry: p.entry, entrySynth: p.entry_synth, sl: p.stop, tp: p.target, side: p.side };
  } else if (activeTradeKey != null) {        // position just closed -> freeze + keep the box
    if (lastActiveTrade && lastBarTime != null) {
      closedTradeBoxes.push({ ...lastActiveTrade, exitSynth: lastBarTime });
      if (closedTradeBoxes.length > 50) closedTradeBoxes.shift();
    }
    activeTradeKey = null; lastActiveTrade = null;
  }
}
const sltpcv = $("#sltpcanvas");
let sltpCtx = null, sltpW = 0, sltpH = 0;
function sltpResize() { const r = _cvResize(sltpcv); sltpCtx = r.ctx; sltpW = r.w; sltpH = r.h; }
function sltpAnchor() {
  if (lastSnap && lastSnap.position) return lastSnap.position.entry;   // managing a trade
  return lastSnap ? lastSnap.cur_price : null;                         // planning at "now"
}
// when a NEW position opens, snap the SL/TP lines to its real bracket so SHORTS get
// SL above / TP below automatically (handles bug-2 (e)). Re-inits only on a position
// CHANGE, never mid-drag, so it can't fight the user.
let sltpPosKey = null;
function sltpSyncToPosition() {
  if (!lastSnap || !lastSnap.position) { sltpPosKey = null; return; }
  const p = lastSnap.position;
  const key = `${p.entry}/${p.side}/${p.size}`;
  if (key !== sltpPosKey) {
    sltpPosKey = key;
    const d = p.side === "LONG" ? 1 : -1;
    slPrice = (p.stop != null) ? p.stop : round2(p.entry - d * 40 * TICK);
    tpPrice = (p.target != null) ? p.target : round2(p.entry + d * 80 * TICK);
  }
}
const _sltpDbg = (...a) => { if (window.SLTP_DEBUG) console.log("[sltp]", ...a); };
window._sltpState = () => ({ on: sltpOn, slPrice, tpPrice, anchor: sltpAnchor(),
  stop_input: $("#stop").value, target_input: $("#target").value,
  inPosition: !!(lastSnap && lastSnap.position) });
function syncSltpInputs() {
  const a = sltpAnchor();
  if (a == null || slPrice == null || tpPrice == null) return;
  $("#stop").value = Math.max(1, Math.round(Math.abs(a - slPrice) / TICK));
  $("#target").value = Math.max(1, Math.round(Math.abs(tpPrice - a) / TICK));
  saveBrackets();
}
// One trade's entry-anchored risk/reward box: shaded entry→SL (red) + entry→TP (green)
// from the entry bar (xL) to xRsynth (the live bar while open / the close bar once
// closed). Never spans the whole chart — only entry-forward. `faint` dims closed boxes.
function drawTradeBox(ts, b, xRsynth, faint) {
  const yE = candle.priceToCoordinate(b.entry);
  if (yE == null) return;
  // snap entry/right times to the current TF's bar bucket — timeToCoordinate only
  // maps actual bar times, not the exact (between-bar) tick second of the fill.
  const bkt = (t) => Math.floor(t / tfSec) * tfSec;
  let xL = ts.timeToCoordinate(bkt(b.entrySynth));
  let xR = ts.timeToCoordinate(bkt(xRsynth));
  if (xL == null) xL = 0;             // entry scrolled off the left edge -> clamp
  if (xR == null) xR = sltpW;
  if (xR < xL) xR = xL;
  const bw = Math.max(2, xR - xL);
  const aFill = faint ? 0.08 : 0.15;
  const ySL = b.sl != null ? candle.priceToCoordinate(b.sl) : null;
  const yTP = b.tp != null ? candle.priceToCoordinate(b.tp) : null;
  if (ySL != null) { sltpCtx.fillStyle = `rgba(239,83,80,${aFill})`; sltpCtx.fillRect(xL, Math.min(yE, ySL), bw, Math.abs(ySL - yE)); }
  if (yTP != null) { sltpCtx.fillStyle = `rgba(38,166,154,${aFill})`; sltpCtx.fillRect(xL, Math.min(yE, yTP), bw, Math.abs(yTP - yE)); }
  // entry edge (left) + close edge (right, only for frozen boxes)
  const ys = [yE, ySL, yTP].filter((v) => v != null);
  const yTop = Math.min(...ys), yBot = Math.max(...ys);
  sltpCtx.lineWidth = 1; sltpCtx.setLineDash([3, 2]);
  sltpCtx.strokeStyle = faint ? "rgba(154,164,178,.4)" : "rgba(154,164,178,.75)";
  sltpCtx.beginPath(); sltpCtx.moveTo(xL + 0.5, yTop); sltpCtx.lineTo(xL + 0.5, yBot); sltpCtx.stroke();
  if (faint) { sltpCtx.beginPath(); sltpCtx.moveTo(xR - 0.5, yTop); sltpCtx.lineTo(xR - 0.5, yBot); sltpCtx.stroke(); }
  sltpCtx.setLineDash([]);
}

function drawSltp() {
  if (!sltpOn || !sltpCtx) return;
  sltpCtx.clearRect(0, 0, sltpW, sltpH);
  const ts = chart.timeScale();
  // persistent closed-trade boxes (frozen at their close bar, kept as a record)
  for (const b of closedTradeBoxes) drawTradeBox(ts, b, b.exitSynth, true);
  const inPos = !!(lastSnap && lastSnap.position && lastSnap.position.entry_synth != null);
  // active trade box: grows entry -> live bar, tracks the live (draggable) SL/TP
  if (inPos && slPrice != null && tpPrice != null) {
    drawTradeBox(ts, { entry: lastSnap.position.entry, entrySynth: lastSnap.position.entry_synth,
                       sl: slPrice, tp: tpPrice }, lastBarTime, false);
  }
  const a = sltpAnchor();
  if (a == null || slPrice == null || tpPrice == null) return;
  const yE = candle.priceToCoordinate(a), ySL = candle.priceToCoordinate(slPrice), yTP = candle.priceToCoordinate(tpPrice);
  if (yE == null || ySL == null || yTP == null) return;
  const W = sltpW;
  // planning mode (flat): a thin forward preview from the current bar -> right edge,
  // NOT a full-width highlight.
  if (!inPos) {
    const xL = ts.timeToCoordinate(lastBarTime);
    if (xL != null) {
      sltpCtx.fillStyle = "rgba(239,83,80,.10)"; sltpCtx.fillRect(xL, Math.min(yE, ySL), Math.max(2, W - xL), Math.abs(ySL - yE));
      sltpCtx.fillStyle = "rgba(38,166,154,.10)"; sltpCtx.fillRect(xL, Math.min(yE, yTP), Math.max(2, W - xL), Math.abs(yTP - yE));
    }
  }
  const line = (y, col, lbl, val) => {
    sltpCtx.strokeStyle = col; sltpCtx.lineWidth = 1.5; sltpCtx.setLineDash([6, 3]);
    sltpCtx.beginPath(); sltpCtx.moveTo(0, y); sltpCtx.lineTo(W, y); sltpCtx.stroke(); sltpCtx.setLineDash([]);
    sltpCtx.fillStyle = col; sltpCtx.textAlign = "left"; sltpCtx.textBaseline = "bottom";
    sltpCtx.font = "11px ui-monospace,Menlo,Consolas,monospace";
    sltpCtx.fillText(`${lbl} ${val.toFixed(2)}`, 6, y - 2);
  };
  line(yE, "#9aa4b2", "ENTRY", a); line(ySL, "#ef5350", "SL", slPrice); line(yTP, "#26a69a", "TP", tpPrice);
  const risk = Math.abs(a - slPrice), reward = Math.abs(tpPrice - a), rr = risk > 0 ? reward / risk : 0;
  const txt = `R:R ${rr.toFixed(2)}  ·  risk ${Math.round(risk / TICK)}tk / reward ${Math.round(reward / TICK)}tk`;
  sltpCtx.font = "bold 12px ui-monospace,Menlo,Consolas,monospace";
  const tw = sltpCtx.measureText(txt).width + 12, bx = W - tw - 12;
  sltpCtx.fillStyle = "rgba(13,17,23,.88)"; sltpCtx.fillRect(bx, 8, tw, 22);
  sltpCtx.strokeStyle = rr >= 2 ? "#26a69a" : rr >= 1 ? "#e3d14b" : "#ef5350";
  sltpCtx.lineWidth = 1.5; sltpCtx.strokeRect(bx, 8, tw, 22);
  sltpCtx.fillStyle = "#e6edf3"; sltpCtx.textAlign = "left"; sltpCtx.textBaseline = "middle";
  sltpCtx.fillText(txt, bx + 6, 19);
}
function setSltp(on) {
  sltpOn = on;
  $("#btnSltp").classList.toggle("active", on);
  sltpcv.classList.toggle("hidden", !on);
  try { localStorage.setItem(SLTP_KEY, on ? "1" : "0"); } catch (_) {}
  if (on) {
    sltpResize();
    if (lastSnap && lastSnap.position) { sltpPosKey = null; sltpSyncToPosition(); }   // snap to live bracket
    else {
      const a = sltpAnchor();
      if (a != null && (slPrice == null || tpPrice == null)) { slPrice = round2(a - 40 * TICK); tpPrice = round2(a + 80 * TICK); }
    }
    drawSltp(); syncSltpInputs();
  } else {
    if (sltpCtx) sltpCtx.clearRect(0, 0, sltpW, sltpH);
    chart.applyOptions({ handleScroll: true, handleScale: true });   // safety: never leave the chart frozen
  }
}
$("#btnSltp").onclick = () => setSltp(!sltpOn);

// Grab the SL or TP line when the mouse is near it; otherwise let the chart pan.
// THE FIX: lightweight-charts drives pan/zoom from POINTER events, so a mousedown
// stopPropagation alone never stopped it — the chart panned under the drag. While
// dragging we FREEZE the chart (handleScroll/handleScale=false) and restore on drop.
const SLTP_HIT_PX = 8;
$("#chartwrap").addEventListener("mousedown", (e) => {
  if (!sltpOn) return;
  if (slPrice == null || tpPrice == null) {            // lazy-init if never set
    const a = sltpAnchor();
    if (a == null) return;
    slPrice = round2(a - 40 * TICK); tpPrice = round2(a + 80 * TICK);
  }
  const rect = $("#chartwrap").getBoundingClientRect(), y = e.clientY - rect.top;
  const ySL = candle.priceToCoordinate(slPrice), yTP = candle.priceToCoordinate(tpPrice);
  const dSL = ySL != null ? Math.abs(y - ySL) : 1e9, dTP = yTP != null ? Math.abs(y - yTP) : 1e9;
  let grab = null;
  if (dSL <= SLTP_HIT_PX && dSL <= dTP) grab = "sl";
  else if (dTP <= SLTP_HIT_PX) grab = "tp";
  _sltpDbg("mousedown", { y: +y.toFixed(1), ySL, yTP, dSL: +dSL.toFixed(1), dTP: +dTP.toFixed(1), grab });
  if (!grab) return;                                   // not near a line -> chart pans normally
  e.preventDefault(); e.stopPropagation();
  sltpDrag = grab;
  $("#chartwrap").classList.add("sltp-grab");
  chart.applyOptions({ handleScroll: false, handleScale: false });   // freeze chart during drag
  const onMove = (ev) => {
    const yy = ev.clientY - rect.top, price = candle.coordinateToPrice(yy);
    if (price == null) return;
    if (sltpDrag === "sl") slPrice = round2(price); else tpPrice = round2(price);
    drawSltp(); syncSltpInputs();
    _sltpDbg("drag", sltpDrag, "->", sltpDrag === "sl" ? slPrice : tpPrice);
  };
  const onUp = async () => {
    window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp);
    sltpDrag = null; $("#chartwrap").classList.remove("sltp-grab");
    chart.applyOptions({ handleScroll: true, handleScale: true });   // un-freeze
    syncSltpInputs();
    if (lastSnap && lastSnap.position) {               // managing a trade -> apply the bracket now
      const a = sltpAnchor();
      const stop_tk = Math.max(1, Math.round(Math.abs(a - slPrice) / TICK));
      const target_tk = Math.max(1, Math.round(Math.abs(tpPrice - a) / TICK));
      const r = await post("/api/modify", { stop_tk, target_tk });
      sltpPosKey = null;                               // let it re-snap to the applied bracket
      renderState(r);
      _sltpDbg("modify applied", { stop_tk, target_tk, position: r && r.position });
    }
  };
  window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
}, true);

// ── setup anatomy overlay ─────────────────────────────────────────────────────
// Highlights the NEAREST setup's mechanical parts (swing / liquidity / swept /
// MSS|BOS break / FVG entry / entry-stop-target), each labeled and revealed CAUSALLY
// (only once the cursor reaches its reveal time). Pure client draw from the already-
// loaded setupsData (+ each setup's `components`) — no extra server load.
const ANAT_KEY = "replay_trader.anatomy";
const ANAT_NEAR_SEC = 90 * 60;     // only show anatomy when within this of a setup
let anatomyOn = false;
const anatcv = $("#anatomycanvas");
let anatCtx = null, anatW = 0, anatH = 0;
function anatResize() { const r = _cvResize(anatcv); anatCtx = r.ctx; anatW = r.w; anatH = r.h; }
const ROLE_COL = {
  liquidity: "#e3d14b", swing: "#9aa4b2", sweep: "#b07cff", structure: "#ff9f40",
  fvg: "#4d9fff", entry: "#cfe3ff", stop: "#ef5350", target: "#26a69a",
};
function nearestSetup() {
  if (!setupsData.length) return null;
  const ct = lastBarTime || 0;
  let best = null, bd = Infinity;
  for (const su of setupsData) { const d = Math.abs(su.t - ct); if (d < bd) { bd = d; best = su; } }
  return (best && bd <= ANAT_NEAR_SEC) ? best : null;
}
function drawAnatomy() {
  if (!anatomyOn || !anatCtx) return;
  anatCtx.clearRect(0, 0, anatW, anatH);
  const su = nearestSetup();
  if (!su || !su.components) return;
  const ct = lastBarTime || 0, ts = chart.timeScale(), xR = anatW;
  anatCtx.lineWidth = 1.5;
  anatCtx.font = "10px ui-monospace,Menlo,Consolas,monospace";
  let shown = 0;
  for (const c of su.components) {
    if ((c.reveal_t != null ? c.reveal_t : c.t) > ct) continue;   // causal: not reached yet
    const col = ROLE_COL[c.role] || "#9aa4b2";
    if (c.kind === "box") {
      const x0 = ts.timeToCoordinate(c.t), yLo = candle.priceToCoordinate(c.lo), yHi = candle.priceToCoordinate(c.hi);
      if (x0 == null || yLo == null || yHi == null) continue;
      const x = Math.max(0, x0), top = Math.min(yLo, yHi), h = Math.max(1, Math.abs(yLo - yHi));
      anatCtx.fillStyle = "rgba(77,159,255,.12)"; anatCtx.fillRect(x, top, xR - x, h);
      anatCtx.strokeStyle = col; anatCtx.setLineDash([]); anatCtx.strokeRect(x, top, xR - x, h);
      anatCtx.fillStyle = col; anatCtx.textAlign = "left"; anatCtx.textBaseline = "bottom";
      anatCtx.fillText(c.label, x + 3, top - 1);
    } else if (c.kind === "level") {
      const x0 = ts.timeToCoordinate(c.t), y = candle.priceToCoordinate(c.price);
      if (x0 == null || y == null) continue;
      const dash = c.role === "liquidity" ? [] : c.role === "structure" ? [7, 4] : [5, 3];
      anatCtx.strokeStyle = col; anatCtx.setLineDash(dash);
      anatCtx.beginPath(); anatCtx.moveTo(Math.max(0, x0), y); anatCtx.lineTo(xR, y); anatCtx.stroke();
      anatCtx.setLineDash([]);
      anatCtx.fillStyle = col; anatCtx.textAlign = "left"; anatCtx.textBaseline = "bottom";
      anatCtx.fillText(c.label, Math.max(0, x0) + 3, y - 2);
    } else {   // point (swing / swept)
      const x = ts.timeToCoordinate(c.t), y = candle.priceToCoordinate(c.price);
      if (x == null || y == null) continue;
      anatCtx.fillStyle = col; anatCtx.beginPath(); anatCtx.arc(x, y, 4, 0, 2 * Math.PI); anatCtx.fill();
      anatCtx.strokeStyle = "#0d1117"; anatCtx.setLineDash([]); anatCtx.lineWidth = 1; anatCtx.stroke();
      anatCtx.lineWidth = 1.5; anatCtx.fillStyle = col; anatCtx.textAlign = "left"; anatCtx.textBaseline = "middle";
      anatCtx.fillText(" " + c.label, x + 5, y);
    }
    shown++;
  }
  if (shown) {   // tag the setup being dissected — grade + direction + (killzone)
    const grade = su.grade || "";
    const gcol = grade === "A+" ? "#e3d14b" : grade === "A" ? "#4d9fff" : "#9aa4b2";
    anatCtx.font = "bold 11px ui-monospace,Menlo,Consolas,monospace";
    anatCtx.textAlign = "left"; anatCtx.textBaseline = "top";
    anatCtx.fillStyle = gcol;
    const gtxt = grade ? grade + " " : "";
    anatCtx.fillText(`SETUP ${gtxt}`, 8, 30);
    const w = anatCtx.measureText(`SETUP ${gtxt}`).width;
    anatCtx.fillStyle = su.dir === "long" ? "#26a69a" : "#ef5350";
    anatCtx.fillText(`· ${su.dir.toUpperCase()}${su.killzone ? " · " + su.killzone : ""}`, 8 + w, 30);
  }
}
function setAnatomy(on) {
  anatomyOn = on;
  $("#btnAnatomy").classList.toggle("active", on);
  anatcv.classList.toggle("hidden", !on);
  try { localStorage.setItem(ANAT_KEY, on ? "1" : "0"); } catch (_) {}
  if (on) { anatResize(); drawAnatomy(); }
  else if (anatCtx) anatCtx.clearRect(0, 0, anatW, anatH);
}
$("#btnAnatomy").onclick = () => setAnatomy(!anatomyOn);

// redraw ICT + anatomy + SL/TP on pan/zoom and resize
chart.timeScale().subscribeVisibleTimeRangeChange(() => { if (ictOn) drawIct(); if (anatomyOn) drawAnatomy(); if (sltpOn) drawSltp(); });
chart.timeScale().subscribeVisibleLogicalRangeChange(() => { if (ictOn) drawIct(); if (anatomyOn) drawAnatomy(); if (sltpOn) drawSltp(); });
new ResizeObserver(() => {
  if (ictOn) { ictResize(); drawIct(); }
  if (anatomyOn) { anatResize(); drawAnatomy(); }
  if (sltpOn) { sltpResize(); drawSltp(); }
}).observe($("#chart"));
try { if (localStorage.getItem(ICT_KEY) === "1") setIct(true); } catch (_) {}
try { if (localStorage.getItem(ANAT_KEY) === "1") setAnatomy(true); } catch (_) {}
try { if (localStorage.getItem(SLTP_KEY) === "1") setSltp(true); } catch (_) {}

// ════════════════════════════════════════════════════════════════════════════
//  RSI(14) oscillator sub-pane — a second lightweight-charts instance below the
//  price chart, with its x-axis (logical range) synced to the price chart. RSI is
//  computed CLIENT-SIDE from the displayed bars (current TF), so no-lookahead holds
//  (the bars only ever come from /api/bars up to the cursor). Default OFF.
// ════════════════════════════════════════════════════════════════════════════
const RSI_KEY = "replay_trader.rsi";
let rsiOn = false;
let allBars = [];          // {time, high, low, close} mirror of the candle series
                           // (close = RSI/BB source; high/low = Focus vertical fit)

// keep allBars in sync with whatever applyBars pushed (replace = setData, else update)
function updateBarsArray(bars, replace) {
  if (replace) { allBars = bars.map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close })); return; }
  for (const b of bars) {
    const last = allBars[allBars.length - 1];
    if (last && last.time === b.time) { last.high = b.high; last.low = b.low; last.close = b.close; }  // forming bar refresh
    else if (!last || b.time > last.time) allBars.push({ time: b.time, high: b.high, low: b.low, close: b.close });
  }
}

const rsiChart = LightweightCharts.createChart($("#rsipane"), {
  autoSize: true,
  layout: { background: { color: "#0d1117" }, textColor: "#8b949e", fontSize: 11 },
  grid: { vertLines: { color: "#1b2230" }, horzLines: { color: "#1b2230" } },
  rightPriceScale: { borderColor: "#2a3340", minimumWidth: 64, scaleMargins: { top: 0.12, bottom: 0.12 } },
  timeScale: { borderColor: "#2a3340", visible: false },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  handleScroll: false, handleScale: false,
});
const rsiSeries = rsiChart.addLineSeries({
  color: "#c792ea", lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
  crosshairMarkerVisible: false,
  // pin the pane to a fixed 0–100 scale regardless of the data window
  autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
});
rsiSeries.createPriceLine({ price: 70, color: "#ef5350", lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "70" });
rsiSeries.createPriceLine({ price: 30, color: "#26a69a", lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "30" });
rsiSeries.createPriceLine({ price: 50, color: "#3a4250", lineStyle: 3, lineWidth: 1, axisLabelVisible: false });

// Incremental RSI to keep the per-poll cost ~O(1): rsiRebuild does the full
// recompute + setData (used on a replace / TF switch / toggle / backward jump);
// rsiStep advances the running Wilder state and only update()s the newly-sealed
// + forming bars. rsiState holds the avg gain/loss committed through the last
// SEALED bar (the forming last bar is never committed — its close still moves).
const RSI_LEN_KEY = "replay_trader.rsi.len";
let rsiPeriod = 14;                  // adjustable RSI length (Studies → RSI gear)
try { const v = parseInt(localStorage.getItem(RSI_LEN_KEY), 10); if (v >= 2 && v <= 100) rsiPeriod = v; } catch (_) {}
let rsiState = null;
const _rsiOf = (ag, al) => (al === 0 ? 100 : 100 - 100 / (1 + ag / al));

function rsiRebuild() {
  if (!rsiOn) return;
  rsiState = null;
  const n = allBars.length, P = rsiPeriod;
  if (n <= P) { rsiSeries.setData([]); return; }
  let g = 0, l = 0;
  for (let i = 1; i <= P; i++) { const ch = allBars[i].close - allBars[i - 1].close; if (ch >= 0) g += ch; else l -= ch; }
  let avgG = g / P, avgL = l / P, prev = allBars[P].close;
  const data = [{ time: allBars[P].time, value: _rsiOf(avgG, avgL) }];
  let state = { avgG, avgL, prevClose: prev, committedIdx: P };
  for (let i = P + 1; i < n; i++) {
    const ch = allBars[i].close - prev;
    avgG = (avgG * (P - 1) + (ch > 0 ? ch : 0)) / P;
    avgL = (avgL * (P - 1) + (ch < 0 ? -ch : 0)) / P;
    prev = allBars[i].close;
    data.push({ time: allBars[i].time, value: _rsiOf(avgG, avgL) });
    if (i < n - 1) state = { avgG, avgL, prevClose: prev, committedIdx: i };  // commit sealed only
  }
  rsiSeries.setData(data);
  rsiState = state;
}

function rsiStep() {
  if (!rsiOn) return;
  const n = allBars.length, P = rsiPeriod;
  if (!rsiState || rsiState.committedIdx >= n) { rsiRebuild(); return; }   // replaced/rewound -> full
  while (rsiState.committedIdx < n - 2) {        // commit any bars that just sealed
    const i = rsiState.committedIdx + 1;
    const ch = allBars[i].close - rsiState.prevClose;
    rsiState.avgG = (rsiState.avgG * (P - 1) + (ch > 0 ? ch : 0)) / P;
    rsiState.avgL = (rsiState.avgL * (P - 1) + (ch < 0 ? -ch : 0)) / P;
    rsiState.prevClose = allBars[i].close;
    rsiState.committedIdx = i;
    rsiSeries.update({ time: allBars[i].time, value: _rsiOf(rsiState.avgG, rsiState.avgL) });
  }
  const f = n - 1;                                // provisional value for the forming bar
  if (f > rsiState.committedIdx) {
    const ch = allBars[f].close - rsiState.prevClose;
    const ag = (rsiState.avgG * (P - 1) + (ch > 0 ? ch : 0)) / P;
    const al = (rsiState.avgL * (P - 1) + (ch < 0 ? -ch : 0)) / P;
    rsiSeries.update({ time: allBars[f].time, value: _rsiOf(ag, al) });
  }
}

// Sync the two charts' x-axes via logical range. CRITICAL: only when RSI is ON — the
// pane is hidden (0-width, stale range) when off, and its echo back through this sync
// was corrupting the PRICE chart's zoom (collapsing barSpacing to the 0.5 floor). The
// equality check breaks the A->B->A echo loop across frames (the boolean guard alone
// doesn't, since the callbacks fire asynchronously).
function _bindRangeSync(src, dst) {
  src.timeScale().subscribeVisibleLogicalRangeChange((rg) => {
    if (!rsiOn || !rg) return;
    const cur = dst.timeScale().getVisibleLogicalRange();
    if (cur && Math.abs(cur.from - rg.from) < 0.5 && Math.abs(cur.to - rg.to) < 0.5) return;
    try { dst.timeScale().setVisibleLogicalRange(rg); } catch (_) {}
  });
}
_bindRangeSync(chart, rsiChart);
_bindRangeSync(rsiChart, chart);

function setRsi(on) {
  rsiOn = on;
  $("#btnRsi").classList.toggle("active", on);
  $("#rsiwrap").classList.toggle("hidden", !on);
  try { localStorage.setItem(RSI_KEY, on ? "1" : "0"); } catch (_) {}
  if (on) {
    rsiRebuild();
    // mirror the price chart's current x-window so the panes line up immediately
    const rg = chart.timeScale().getVisibleLogicalRange();
    if (rg) { try { rsiChart.timeScale().setVisibleLogicalRange(rg); } catch (_) {} }
  }
}
$("#btnRsi").onclick = () => setRsi(!rsiOn);
try { if (localStorage.getItem(RSI_KEY) === "1") setRsi(true); } catch (_) {}

// RSI length — adjustable via the Studies → RSI gear. Recomputes/redraws on change.
function rsiUpdateLabel() { const el = $("#rsipanelabel"); if (el) el.textContent = "RSI(" + rsiPeriod + ")"; }
function rsiApplyLen() {
  let v = parseInt($("#rsiLen").value, 10);
  if (!(v >= 2)) v = 14; if (v > 100) v = 100;
  rsiPeriod = v;
  try { localStorage.setItem(RSI_LEN_KEY, String(v)); } catch (_) {}
  rsiUpdateLabel();
  if (rsiOn) rsiRebuild();
}
if ($("#rsiLen")) $("#rsiLen").value = rsiPeriod;
rsiUpdateLabel();
$("#btnRsicfg").onclick = () => $("#rsicfg").classList.toggle("hidden");
if ($("#rsiLen")) $("#rsiLen").addEventListener("change", rsiApplyLen);

// ════════════════════════════════════════════════════════════════════════════
//  BOLLINGER BANDS — SMA basis ± mult·stdev on the price chart (displayed-TF bars).
//  Adjustable length & multiplier. Incremental like RSI: full rebuild on replace,
//  cheap per-poll step on the newly-sealed + forming bars.
// ════════════════════════════════════════════════════════════════════════════
const BB_KEY = "replay_trader.bb";
const BBCFG_KEY = "replay_trader.bb.cfg";
let bbOn = false;
const bbCfg = { len: 20, mult: 2.0 };
let bbCommitted = -1;
function bbLoadCfg() {
  try { Object.assign(bbCfg, JSON.parse(localStorage.getItem(BBCFG_KEY) || "{}")); } catch (_) {}
  if ($("#bbLen")) $("#bbLen").value = bbCfg.len;
  if ($("#bbMult")) $("#bbMult").value = bbCfg.mult;
}
function bbSaveCfg() {
  bbCfg.len = Math.max(2, Math.min(200, parseInt($("#bbLen").value, 10) || 20));
  bbCfg.mult = Math.max(0.1, Math.min(10, parseFloat($("#bbMult").value) || 2));
  try { localStorage.setItem(BBCFG_KEY, JSON.stringify(bbCfg)); } catch (_) {}
}
function _bbAt(i) {              // {m, sd} over the window of bbCfg.len bars ending at i
  const P = bbCfg.len; let s = 0, ss = 0;
  for (let k = i - P + 1; k <= i; k++) { const c = allBars[k].close; s += c; ss += c * c; }
  const m = s / P; let v = ss / P - m * m; if (v < 0) v = 0;
  return { m, sd: Math.sqrt(v) };
}
function bbRebuild() {
  if (!bbOn) return;
  const n = allBars.length, P = bbCfg.len, M = bbCfg.mult;
  if (n < P) { bbUpper.setData([]); bbLower.setData([]); bbBasis.setData([]); bbCommitted = -1; return; }
  const up = [], lo = [], mid = [];
  let s = 0, ss = 0;
  for (let i = 0; i < P; i++) { const c = allBars[i].close; s += c; ss += c * c; }
  const push = (i) => {
    const m = s / P; let v = ss / P - m * m; if (v < 0) v = 0; const sd = Math.sqrt(v); const t = allBars[i].time;
    mid.push({ time: t, value: m }); up.push({ time: t, value: m + M * sd }); lo.push({ time: t, value: m - M * sd });
  };
  push(P - 1);
  for (let i = P; i < n; i++) { const cin = allBars[i].close, cout = allBars[i - P].close; s += cin - cout; ss += cin * cin - cout * cout; push(i); }
  bbBasis.setData(mid); bbUpper.setData(up); bbLower.setData(lo);
  bbCommitted = n - 2;
}
function bbStep() {
  if (!bbOn) return;
  const n = allBars.length, P = bbCfg.len, M = bbCfg.mult;
  if (n < P) return;
  if (bbCommitted < P - 1 || bbCommitted >= n) { bbRebuild(); return; }   // fresh/rewound -> full
  for (let i = bbCommitted + 1; i < n; i++) {
    const r = _bbAt(i), t = allBars[i].time;
    bbBasis.update({ time: t, value: r.m }); bbUpper.update({ time: t, value: r.m + M * r.sd }); bbLower.update({ time: t, value: r.m - M * r.sd });
  }
  bbCommitted = n - 2;     // forming bar (n-1) re-updated on the next step
}
function bbClear() { try { bbUpper.setData([]); bbLower.setData([]); bbBasis.setData([]); } catch (_) {} bbCommitted = -1; }
function setBB(on) {
  bbOn = on;
  $("#btnBB").classList.toggle("active", on);
  try { localStorage.setItem(BB_KEY, on ? "1" : "0"); } catch (_) {}
  if (on) bbRebuild(); else bbClear();
}
$("#btnBB").onclick = () => setBB(!bbOn);
$("#btnBBcfg").onclick = () => $("#bbcfg").classList.toggle("hidden");
["bbLen", "bbMult"].forEach((id) => {
  const el = $("#" + id); if (!el) return;
  el.addEventListener("change", () => { bbSaveCfg(); if (bbOn) bbRebuild(); });
});
bbLoadCfg();
try { if (localStorage.getItem(BB_KEY) === "1") setBB(true); } catch (_) {}

// ════════════════════════════════════════════════════════════════════════════
//  LIQUIDITY POOLS — labeled horizontal levels for every resting-liquidity pool
//  (PDH/PDL, recent dailies, ONH/ONL, ORH/ORL, PWH/PWL, session HOD/LOD, swing
//  highs/lows, equal highs/lows). Server-computed CAUSALLY as of the cursor.
// ════════════════════════════════════════════════════════════════════════════
const LIQ_KEY = "replay_trader.liq";
let liqOn = false, liqData = [], liqFetching = false, liqLastFetch = 0;
const liqcv = $("#liqcanvas");
let liqCtx = null, liqW = 0, liqH = 0;
function liqResize() { const r = _cvResize(liqcv); liqCtx = r.ctx; liqW = r.w; liqH = r.h; }
// per-category styling: bright/solid for the major reference pools, dimmer/dashed
// for the many swing & equal-high/low pools so the chart stays readable.
const LIQ_STYLE = {
  daily:     { col: "#4d9fff", dash: [], major: true },
  weekly:    { col: "#b07cff", dash: [], major: true },
  overnight: { col: "#e3d14b", dash: [6, 3], major: true },
  or:        { col: "#ff9f40", dash: [6, 3], major: true },
  rth:       { col: "#c9d1d9", dash: [4, 3], major: true },
  swing:     { col: "#6b7787", dash: [2, 3], major: false },
  eq:        { col: "#26a69a", dash: [5, 3], major: false },
};
async function fetchLevels(force) {
  if (!liqOn || !haveSession || liqFetching) return;
  const now = Date.now();
  if (!force && now - liqLastFetch < 500) return;   // levels move at most at 1-min cadence
  liqLastFetch = now;
  liqFetching = true;
  try {
    const r = await api("/api/levels");
    if (r.ok) { liqData = r.levels || []; drawLiq(); }
  } catch (e) { /* transient */ }
  liqFetching = false;
}
function drawLiq() {
  if (!liqOn || !liqCtx) return;
  liqCtx.clearRect(0, 0, liqW, liqH);
  if (!liqData.length) return;
  liqCtx.font = "9px ui-monospace,Menlo,Consolas,monospace";
  liqCtx.textBaseline = "middle";
  // pin the tags at the right, just left of the price axis, so they never cover the
  // candles or each other (the price itself is already on the axis).
  let axisW = 0;
  try { axisW = chart.priceScale("right").width() || 0; } catch (_) {}
  const xEnd = liqW - axisW - 4;
  const rows = [];
  for (const lv of liqData) {
    const y = candle.priceToCoordinate(lv.price);
    if (y != null) rows.push({ lv, y });
  }
  rows.sort((a, b) => a.y - b.y);
  let lastY = -1e9;
  for (const { lv, y } of rows) {
    const st = LIQ_STYLE[lv.cat] || LIQ_STYLE.swing;
    // thin level line, stopping before the axis
    liqCtx.strokeStyle = st.col;
    liqCtx.globalAlpha = st.major ? 0.8 : 0.45;
    liqCtx.lineWidth = 1;
    liqCtx.setLineDash(st.dash);
    liqCtx.beginPath(); liqCtx.moveTo(0, y); liqCtx.lineTo(xEnd, y); liqCtx.stroke();
    liqCtx.setLineDash([]);
    // compact tag chip pinned right; nudge down to avoid overlapping the previous tag
    let ly = y < lastY + 11 ? lastY + 11 : y;
    lastY = ly;
    const tw = liqCtx.measureText(lv.label).width;
    const cx = xEnd - tw - 6;
    liqCtx.globalAlpha = 1;
    liqCtx.fillStyle = "rgba(13,17,23,.82)";
    liqCtx.fillRect(cx, ly - 6, tw + 6, 12);
    liqCtx.fillStyle = st.col;
    liqCtx.textAlign = "left";
    liqCtx.fillText(lv.label, cx + 3, ly + 0.5);
  }
  liqCtx.globalAlpha = 1;
}
function setLiq(on) {
  liqOn = on;
  $("#btnLiq").classList.toggle("active", on);
  liqcv.classList.toggle("hidden", !on);
  try { localStorage.setItem(LIQ_KEY, on ? "1" : "0"); } catch (_) {}
  if (on) { liqResize(); fetchLevels(true); }
  else { liqData = []; if (liqCtx) liqCtx.clearRect(0, 0, liqW, liqH); }
}
$("#btnLiq").onclick = () => setLiq(!liqOn);
chart.timeScale().subscribeVisibleTimeRangeChange(() => { if (liqOn) drawLiq(); });
chart.timeScale().subscribeVisibleLogicalRangeChange(() => { if (liqOn) drawLiq(); });
new ResizeObserver(() => { if (liqOn) { liqResize(); drawLiq(); } }).observe($("#chart"));

// ════════════════════════════════════════════════════════════════════════════
//  ZIGZAG++ (MT4-style, Dev Lucem) — alternating swing-high/low legs (lime up /
//  red down) with HH/HL/LH/LL labels. Server-computed on the displayed-TF bars up
//  to the cursor (causal); the last leg repaints as price extends, like the Pine.
// ════════════════════════════════════════════════════════════════════════════
const ZZ_KEY = "replay_trader.zigzag";
const ZZCFG_KEY = "replay_trader.zigzag.cfg";
let zzOn = false, zzData = [], zzFetching = false, zzLastFetch = 0;
const zzcv = $("#zzcanvas");
let zzCtx = null, zzW = 0, zzH = 0;
function zzResize() { const r = _cvResize(zzcv); zzCtx = r.ctx; zzW = r.w; zzH = r.h; }
const ZZ_UP = "#a6e22e", ZZ_DN = "#ef5350";   // bull-leg lime / bear-leg red
const ZZ_LABEL_COL = { HH: "#7CFC9B", LH: "#9fc3a0", LL: "#ff7b78", HL: "#e0a9a7" };
const zzCfg = { depth: 12, dev: 5, back: 2, labels: true };

function zzLoadCfg() {
  try { Object.assign(zzCfg, JSON.parse(localStorage.getItem(ZZCFG_KEY) || "{}")); } catch (_) {}
  $("#zzDepth").value = zzCfg.depth; $("#zzDev").value = zzCfg.dev;
  $("#zzBack").value = zzCfg.back; $("#zzLabels").checked = zzCfg.labels;
}
function zzSaveCfg() {
  zzCfg.depth = Math.max(1, +$("#zzDepth").value || 12);
  zzCfg.dev = Math.max(1, +$("#zzDev").value || 5);
  zzCfg.back = Math.max(1, +$("#zzBack").value || 2);
  zzCfg.labels = $("#zzLabels").checked;
  try { localStorage.setItem(ZZCFG_KEY, JSON.stringify(zzCfg)); } catch (_) {}
}

async function fetchZigzag(force) {
  if (!zzOn || !haveSession || zzFetching) return;
  const now = Date.now();
  if (!force && now - zzLastFetch < 500) return;   // pivots move at most at bar cadence
  zzLastFetch = now;
  zzFetching = true;
  try {
    const r = await api(`/api/zigzag?tf=${TF}&depth=${zzCfg.depth}&dev=${zzCfg.dev}&back=${zzCfg.back}`);
    if (r.ok) { zzData = r.pivots || []; drawZZ(); }
  } catch (e) { /* transient */ }
  zzFetching = false;
}

function drawZZ() {
  if (!zzOn || !zzCtx) return;
  zzCtx.clearRect(0, 0, zzW, zzH);
  if (zzData.length < 2) return;
  const ts = chart.timeScale();
  // map each pivot to pixel coords (null when off-screen)
  const pts = zzData.map((p) => ({ p, x: ts.timeToCoordinate(p.t), y: candle.priceToCoordinate(p.price) }));
  // legs: a segment ENDING at a high pivot is a bull (up) leg = lime; ending at a low = red
  zzCtx.lineWidth = 2;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.x == null || a.y == null || b.x == null || b.y == null) continue;
    zzCtx.strokeStyle = b.p.type === "high" ? ZZ_UP : ZZ_DN;
    zzCtx.beginPath(); zzCtx.moveTo(a.x, a.y); zzCtx.lineTo(b.x, b.y); zzCtx.stroke();
  }
  // pivot dots + HH/HL/LH/LL labels
  zzCtx.font = "bold 10px ui-monospace,Menlo,Consolas,monospace";
  zzCtx.textAlign = "center";
  for (const { p, x, y } of pts) {
    if (x == null || y == null) continue;
    const isHigh = p.type === "high";
    zzCtx.fillStyle = isHigh ? ZZ_UP : ZZ_DN;
    zzCtx.beginPath(); zzCtx.arc(x, y, 2.5, 0, 2 * Math.PI); zzCtx.fill();
    if (!zzCfg.labels) continue;
    const ly = isHigh ? y - 7 : y + 7;             // above highs, below lows
    zzCtx.textBaseline = isHigh ? "bottom" : "top";
    const tw = zzCtx.measureText(p.label).width;
    zzCtx.fillStyle = "rgba(13,17,23,.78)";
    zzCtx.fillRect(x - tw / 2 - 2, isHigh ? ly - 11 : ly, tw + 4, 11);
    zzCtx.fillStyle = ZZ_LABEL_COL[p.label] || "#e6edf3";
    zzCtx.fillText(p.label, x, ly);
  }
}

function setZZ(on) {
  zzOn = on;
  $("#btnZZ").classList.toggle("active", on);
  zzcv.classList.toggle("hidden", !on);
  try { localStorage.setItem(ZZ_KEY, on ? "1" : "0"); } catch (_) {}
  if (on) { zzResize(); fetchZigzag(true); }
  else { zzData = []; if (zzCtx) zzCtx.clearRect(0, 0, zzW, zzH); }
}
$("#btnZZ").onclick = () => setZZ(!zzOn);
$("#btnZZcfg").onclick = () => $("#zzcfg").classList.toggle("hidden");
["zzDepth", "zzDev", "zzBack", "zzLabels"].forEach((id) => {
  const el = $("#" + id); if (!el) return;
  el.addEventListener("change", () => { zzSaveCfg(); fetchZigzag(true); });
});
chart.timeScale().subscribeVisibleTimeRangeChange(() => { if (zzOn) drawZZ(); });
chart.timeScale().subscribeVisibleLogicalRangeChange(() => { if (zzOn) drawZZ(); });
new ResizeObserver(() => { if (zzOn) { zzResize(); drawZZ(); } }).observe($("#chart"));
zzLoadCfg();
try { if (localStorage.getItem(ZZ_KEY) === "1") setZZ(true); } catch (_) {}

// ════════════════════════════════════════════════════════════════════════════
//  PAUSE MARKS — a chart marker at every PAUSE the user took (the catcher logs
//  each play/pause + instant microstructure server-side regardless of this toggle;
//  this just visualizes the pauses). Pre-entry pauses (an order followed) stand out.
// ════════════════════════════════════════════════════════════════════════════
const PP_KEY = "replay_trader.pausemarks";
let ppOn = false, ppEvents = [], ppFetching = false, ppLastFetch = 0, ppLastSig = "";
async function fetchPP(force) {
  if (!ppOn || !haveSession || ppFetching) return;
  const now = Date.now();
  if (!force && now - ppLastFetch < 1000) return;
  ppLastFetch = now;
  ppFetching = true;
  try {
    const r = await api("/api/play_pause");
    if (r.ok) { ppEvents = r.events || []; drawPP(); }
  } catch (e) { /* transient */ }
  ppFetching = false;
}
function drawPP() {
  if (!ppOn) return;
  // pause events -> markers at the bar bucket of the pause (above the bar). Pre-entry
  // pauses are orange arrows; ordinary pauses are small gray circles.
  const markers = ppEvents
    .filter((e) => e.kind === "pause")
    .map((e) => ({
      time: Math.floor(e.synth_t / tfSec) * tfSec,
      position: "aboveBar",
      color: e.pre_entry ? "#ff9f40" : "#8b949e",
      shape: e.pre_entry ? "arrowDown" : "circle",
      text: e.pre_entry ? "entry" : "",
      size: e.pre_entry ? 1.4 : 0.6,
    }))
    .sort((a, b) => a.time - b.time);
  const sig = markers.length + ":" + (markers.length ? markers[markers.length - 1].time : "");
  if (sig === ppLastSig) return;     // no change -> skip the setMarkers churn
  ppLastSig = sig;
  try { candle.setMarkers(markers); } catch (_) {}
}
function setPP(on) {
  ppOn = on;
  $("#btnPP").classList.toggle("active", on);
  try { localStorage.setItem(PP_KEY, on ? "1" : "0"); } catch (_) {}
  if (on) { ppLastSig = ""; fetchPP(true); }
  else { ppLastSig = ""; try { candle.setMarkers([]); } catch (_) {} }
}
$("#btnPP").onclick = () => setPP(!ppOn);
try { if (localStorage.getItem(PP_KEY) === "1") setPP(true); } catch (_) {}

// ════════════════════════════════════════════════════════════════════════════
//  LIQUIDITY-TOUCH NAVIGATOR — skip to 5 min before EVERY liquidity-pool touch
//  (every touch is a "stop", not only the adverse ones), stepping forward/back.
// ════════════════════════════════════════════════════════════════════════════
let touchesData = [];
let touchPtr = -1;     // index of the touch last navigated to (for monotonic stepping)
async function loadTouches() {
  touchPtr = -1;
  $("#touchcount").textContent = "…";
  try {
    // the RSI-confluence filter is TF-dependent, so the touch list is fetched per TF
    const r = await api("/api/touches?tf=" + TF);
    if (r.ok) touchesData = r.touches || [];
  } catch (e) { /* transient */ }
  updateTouchCount();
}
// the next touch ahead of the cursor (what the user is approaching), for the counter
function nextTouchIdx() {
  const cs = cursorSynth();
  for (let i = 0; i < touchesData.length; i++) if (touchesData[i].t > cs) return i;
  return -1;
}
function updateTouchCount() {
  const n = touchesData.length;
  if (!n) { $("#touchcount").textContent = "0 touches"; return; }
  // While stepping with the nav buttons, show the touch we're HEADING to (touchPtr) so
  // the counter advances even when several early touches all clamp their 5-min-before
  // seek to the 09:30 open. Once playback carries the cursor past that touch, fall back
  // to the cursor-based "next upcoming" touch (and clear the nav pointer).
  let k;
  if (touchPtr >= 0 && touchPtr < n && cursorSynth() <= touchesData[touchPtr].t) {
    k = touchPtr;
  } else {
    touchPtr = -1;
    k = nextTouchIdx();
  }
  if (k < 0) { $("#touchcount").textContent = n + "/" + n + " touches"; return; }
  const tc = touchesData[k];
  $("#touchcount").textContent = (k + 1) + "/" + n + " · " + tc.label + " " + tc.price.toFixed(2)
    + (tc.rsi ? " · RSI " + tc.rsi : "");
}
async function gotoTouch(step) {
  if (!touchesData.length) return;
  const cs = cursorSynth();
  let ni;
  if (step > 0) {
    ni = touchesData.findIndex((tc) => tc.t > cs + 1);     // next touch strictly ahead
    if (ni < 0) ni = touchesData.length - 1;
    if (touchPtr >= 0 && ni <= touchPtr) ni = touchPtr + 1;  // guarantee forward progress
  } else {
    ni = -1;
    for (let i = touchesData.length - 1; i >= 0; i--) if (touchesData[i].t < cs - 1) { ni = i; break; }
    if (ni < 0) ni = 0;
    if (touchPtr >= 0 && ni >= touchPtr) ni = touchPtr - 1;  // guarantee backward progress
  }
  ni = Math.max(0, Math.min(touchesData.length - 1, ni));
  touchPtr = ni;
  const target = touchesData[ni];
  // seek the replay clock to the EXACT moment of the touch (server-provided seek_ns).
  // goto resolves any open position honestly / re-hides future bars.
  const r = await post("/api/control", { action: "goto", ns: target.seek_ns });
  await fullReload(false);     // re-render up to the seek point + follow at current zoom
  renderState(r);
  if (ictOn) fetchStructures(true);
  if (liqOn) fetchLevels(true);
  if (zzOn) fetchZigzag(true);
  updateTouchCount();
}
$("#btnTouchNext").onclick = () => gotoTouch(1);
$("#btnTouchPrev").onclick = () => gotoTouch(-1);
