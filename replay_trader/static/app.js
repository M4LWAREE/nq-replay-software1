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

// session VWAP line (Σpx·sz / Σsz from the 09:30 RTH open; server-computed,
// no-lookahead). Empty data when the study is off (hidden). Default off.
const vwapSeries = chart.addLineSeries({
  color: "#e3d14b", lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
  crosshairMarkerVisible: false, lineStyle: LightweightCharts.LineStyle.Solid,
});

// price line markers for live position (stop / target / entry)
let posPriceLines = [];
function clearPosLines() { posPriceLines.forEach((l) => candle.removePriceLine(l)); posPriceLines = []; }

// ── client state ────────────────────────────────────────────────────────────
// TF label -> bucket seconds. Mirrors the server's TF_SECONDS (one source of
// truth per side). Adding a TF = one entry here + one button in index.html.
const TF_SECONDS = { "5s": 5, "30s": 30, "1m": 60, "15m": 900 };
let TF = "5s";
let tfSec = TF_SECONDS[TF];
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
  renderFlow(s);
  renderHeat(s);
  renderVwap(s);
  renderInstr(s);
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
    const r = await api(`/api/bars?tf=${TF}&since=${since}${flowOn ? "&flow=1" : ""}${heatOn ? "&heat=1" : ""}${vwapOn ? "&vwap=1" : ""}`);
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
  vwapClear();                 // VWAP line rebuilds live after a TF switch / new session
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
  TF = b.dataset.tf; tfSec = TF_SECONDS[TF] || 5;
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
