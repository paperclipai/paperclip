import json
import os
from functools import wraps
from flask import Flask, request, Response, jsonify

app = Flask(__name__)
DATA_DIR = os.environ.get(
    "DATA_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"),
)
DASHBOARD_PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "changeme")

# ---------------------------------------------------------------------------
# Data-source selector (Task 14.4)
# When USE_SQLITE_STATE=true the dashboard reads from SQLite via state_store.
# When false (default) it falls back to the existing file-based path.
# ---------------------------------------------------------------------------

USE_SQLITE_STATE = os.environ.get("USE_SQLITE_STATE", "false").lower() == "true"
STATE_DB_PATH = os.environ.get(
    "STATE_DB_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "state.db"),
)


# TODO(Task 22): Wire _data_source() into existing routes. Currently the selector
# is correct (returns "sqlite" or "file" based on USE_SQLITE_STATE) but no existing
# route calls it — /api/state continues reading real_state.json regardless. This is
# acceptable for the cutover watch window where file writes continue (cutover plan
# §45-46), but must be wired before Task 22 decommission. Requires adding
# query_positions / query_fills / query_audit helpers to state_store.py.
def _data_source():
    """Return 'sqlite' when SQLite is enabled and the DB exists, else 'file'."""
    if USE_SQLITE_STATE and os.path.exists(STATE_DB_PATH):
        return "sqlite"
    return "file"


# ---------------------------------------------------------------------------
# Register reconciliation blueprint
# ---------------------------------------------------------------------------
from dashboard_recon import recon_bp  # noqa: E402

app.register_blueprint(recon_bp)

# ---------------------------------------------------------------------------
# Auth helper
# ---------------------------------------------------------------------------


def check_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.authorization
        if not auth or auth.password != DASHBOARD_PASSWORD:
            return Response(
                "Unauthorized",
                401,
                {"WWW-Authenticate": 'Basic realm="Paperclip Dashboard"'},
            )
        return f(*args, **kwargs)

    return decorated


# ---------------------------------------------------------------------------
# Single-page HTML (dark theme, TradingView lightweight-charts)
# Data rendered into the page comes exclusively from the server-side state
# file (real_state.json) and is accessible only to authenticated users.
# ---------------------------------------------------------------------------

HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Paperclip Trader &mdash; LIVE</title>
<script src="https://unpkg.com/lightweight-charts@4.1.0/dist/lightweight-charts.standalone.production.js"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:    #0d1117;
    --card:  #161b22;
    --bdr:   #30363d;
    --text:  #c9d1d9;
    --muted: #8b949e;
    --acc:   #4e8cff;
    --grn:   #3fb950;
    --red:   #f85149;
    --ylw:   #d29922;
    --mono:  'Fira Mono', 'Cascadia Code', 'Consolas', monospace;
  }

  html, body { height: 100%; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px; }

  .layout { max-width: 1600px; margin: 0 auto; padding: 16px;
    display: flex; flex-direction: column; gap: 16px; }

  /* header */
  .header { background: var(--card); border: 1px solid var(--bdr);
    border-radius: 8px; padding: 14px 20px;
    display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
  .header h1 { font-size: 18px; font-weight: 600; letter-spacing: .02em; }
  .header h1 span { color: var(--acc); }
  .sdot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .dot-g { background: var(--grn); box-shadow: 0 0 6px var(--grn); }
  .dot-r { background: var(--red); box-shadow: 0 0 6px var(--red); }
  .badge { padding: 2px 8px; border-radius: 4px; font-size: 11px;
    font-weight: 600; letter-spacing: .05em; }
  .bdry  { background:#2d1f00; color:var(--ylw); border:1px solid var(--ylw); }
  .blive { background:#0f2f0f; color:var(--grn); border:1px solid var(--grn); }
  .hstat { display:flex; flex-direction:column; align-items:flex-end; }
  .hstat .lbl { font-size:11px; color:var(--muted);
    text-transform:uppercase; letter-spacing:.06em; }
  .hstat .val { font-family:var(--mono); font-size:16px; font-weight:700; }
  .spacer { flex:1; }
  .lupd { font-size:11px; color:var(--muted); }

  /* controls */
  .ctrls { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  .btn { padding:7px 16px; border-radius:6px; border:none; cursor:pointer;
    font-size:13px; font-weight:600; transition:opacity .15s; }
  .btn:hover  { opacity:.8; }
  .btn:active { opacity:.6; }
  .bstop  { background:var(--red);  color:#fff; }
  .bstart { background:var(--grn);  color:#fff; }
  .bdrun  { background:var(--ylw);  color:#000; }
  #cstat  { font-size:12px; color:var(--muted); }

  /* card */
  .card { background:var(--card); border:1px solid var(--bdr);
    border-radius:8px; padding:16px; }
  .ctitle { font-size:12px; font-weight:600; text-transform:uppercase;
    letter-spacing:.07em; color:var(--muted); margin-bottom:12px; }

  /* stats */
  .sgrid { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }
  @media(max-width:700px){ .sgrid { grid-template-columns:repeat(2,1fr); } }
  .sbox { background:var(--bg); border:1px solid var(--bdr);
    border-radius:6px; padding:12px 16px; }
  .sbox .sl { font-size:11px; color:var(--muted);
    text-transform:uppercase; letter-spacing:.06em; margin-bottom:4px; }
  .sbox .sv { font-family:var(--mono); font-size:22px; font-weight:700; }

  /* chart */
  #echart { width:100%; height:260px; }

  /* tables */
  .tw { overflow-x:auto; max-height:320px; overflow-y:auto; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  thead th { position:sticky; top:0; background:var(--card); color:var(--muted);
    text-align:left; padding:6px 10px; font-weight:600;
    text-transform:uppercase; letter-spacing:.05em;
    border-bottom:1px solid var(--bdr); white-space:nowrap; }
  tbody tr:nth-child(even) { background:rgba(255,255,255,.02); }
  tbody tr:hover { background:rgba(78,140,255,.07); }
  tbody td { padding:5px 10px; color:var(--text); font-family:var(--mono);
    font-size:12px; white-space:nowrap;
    border-bottom:1px solid rgba(48,54,61,.5); }
  .nd { color:var(--muted); text-align:center; padding:24px; font-size:13px; }

  /* balances */
  .bgrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:10px; }
  .bbox { background:var(--bg); border:1px solid var(--bdr); border-radius:6px; padding:12px; }
  .bbox .en { font-size:13px; font-weight:700; color:var(--acc);
    margin-bottom:8px; display:flex; align-items:center; gap:8px; }
  .hdot { width:8px; height:8px; border-radius:50%; }
  .bbox .br { display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px; }
  .bbox .brl { color:var(--muted); }
  .bbox .brv { font-family:var(--mono); }

  /* utils */
  .g { color:var(--grn)!important; }
  .r { color:var(--red)!important; }
  .y { color:var(--ylw)!important; }
  .m { color:var(--muted)!important; }
  .a { color:var(--acc)!important; }
</style>
</head>
<body>
<div class="layout">

<!-- HEADER -->
<div class="header">
  <span id="sdot" class="sdot dot-r"></span>
  <h1>Paperclip Trader &mdash; <span>LIVE (EU)</span></h1>
  <span id="mbadge" class="badge bdry">DRY RUN</span>
  <div class="spacer"></div>
  <div class="hstat">
    <span class="lbl">Equity</span>
    <span class="val a" id="h-eq">&#x2014;</span>
  </div>
  <div class="hstat">
    <span class="lbl">Drawdown</span>
    <span class="val r" id="h-dd">&#x2014;</span>
  </div>
  <div class="hstat">
    <span class="lbl">Total P&amp;L</span>
    <span class="val" id="h-pnl">&#x2014;</span>
  </div>
  <span class="lupd" id="lupd">&#x2014;</span>
  <a href="/recon/" style="font-size:12px;color:var(--acc);text-decoration:none;white-space:nowrap;"
     title="Reconciliation events &amp; invariant status">Recon Panel</a>
</div>

<!-- CONTROLS -->
<div class="card ctrls">
  <button class="btn bstop"  onclick="ctrl('stop')">Stop Bot</button>
  <button class="btn bstart" onclick="ctrl('start')">Start Bot</button>
  <button class="btn bdrun"  onclick="ctrl('dryrun')">Toggle DRY RUN</button>
  <span id="cstat"></span>
</div>

<!-- STATS -->
<div class="card">
  <div class="ctitle">Statistics</div>
  <div class="sgrid">
    <div class="sbox"><div class="sl">Total Trades</div><div class="sv" id="s-tr">0</div></div>
    <div class="sbox"><div class="sl">Win Rate</div><div class="sv g" id="s-wr">&#x2014;</div></div>
    <div class="sbox"><div class="sl">Total P&amp;L</div><div class="sv" id="s-pnl">$0.00</div></div>
    <div class="sbox"><div class="sl">Max Drawdown</div><div class="sv r" id="s-mdd">0.00%</div></div>
  </div>
</div>

<!-- EQUITY CURVE -->
<div class="card">
  <div class="ctitle">Equity Curve</div>
  <div id="echart"></div>
</div>

<!-- BALANCES -->
<div class="card">
  <div class="ctitle">Exchange Balances</div>
  <div class="bgrid" id="bgrid"><div class="nd">Loading&#x2026;</div></div>
</div>

<!-- OPEN POSITIONS -->
<div class="card">
  <div class="ctitle">Open Positions</div>
  <div class="tw">
    <table>
      <thead><tr>
        <th>Symbol</th><th>Short Exch</th><th>Long Exch</th>
        <th>Entry Spread</th><th>Cur Spread</th><th>Unreal P&amp;L</th>
        <th>Duration</th><th>Status</th><th>Order IDs</th>
      </tr></thead>
      <tbody id="op-body"><tr><td colspan="9" class="nd">Loading&#x2026;</td></tr></tbody>
    </table>
  </div>
</div>

<!-- CLOSED POSITIONS -->
<div class="card">
  <div class="ctitle">Closed Positions (last 50)</div>
  <div class="tw">
    <table>
      <thead><tr>
        <th>Symbol</th><th>Short Exch</th><th>Long Exch</th>
        <th>Entry Spread</th><th>Exit Spread</th><th>P&amp;L</th>
        <th>Fees</th><th>Duration</th><th>Reason</th>
      </tr></thead>
      <tbody id="cp-body"><tr><td colspan="9" class="nd">Loading&#x2026;</td></tr></tbody>
    </table>
  </div>
</div>

<!-- TRADE DIAGNOSTICS -->
<div class="card">
  <div class="ctitle">Trade Diagnostics &mdash; what went wrong</div>
  <div id="td-summary" class="nd" style="padding:8px 4px;font-size:13px;">Loading&#x2026;</div>
  <div class="tw">
    <table>
      <thead><tr>
        <th>ID</th><th>Symbol</th><th>Net P&amp;L</th>
        <th title="Per-leg PnL: SHORT / LONG. Asymmetric values mean the trade was driven by direction, not convergence.">Short / Long P&amp;L</th>
        <th title="Sum of both legs' slippage at entry. Positive = adverse (paid more than expected).">Entry Slip $</th>
        <th title="Sum of both legs' slippage at exit.">Exit Slip $</th>
        <th title="Net funding paid. Positive = bot paid; negative = bot received.">Funding $</th>
        <th>Hold (min)</th>
        <th title="Older of the two leg quotes at decision. Stale quotes mean the bot may have decided on data that no longer reflected the market.">Quote Age (ms)</th>
        <th title="Spread implied by actual fill prices. Negative means orders crossed the book.">Realized Entry %</th>
        <th>Realized Exit %</th>
        <th>Reason</th>
      </tr></thead>
      <tbody id="td-body"><tr><td colspan="12" class="nd">Loading&#x2026;</td></tr></tbody>
    </table>
  </div>
</div>

<!-- AUDIT LOG -->
<div class="card">
  <div class="ctitle">Order Audit Log (last 50)</div>
  <div class="tw">
    <table>
      <thead><tr>
        <th>Time</th><th>Action</th><th>Exchange</th><th>Symbol</th>
        <th>Side</th><th>Size</th><th>Filled</th><th>Fill Price</th>
        <th>Fees</th><th>Order ID</th><th>Latency</th><th>Result</th>
      </tr></thead>
      <tbody id="al-body"><tr><td colspan="12" class="nd">Loading&#x2026;</td></tr></tbody>
    </table>
  </div>
</div>

</div><!-- /layout -->
<script>
// ---- Chart setup ----
const chartEl = document.getElementById('echart');
const lc = LightweightCharts;
const chart = lc.createChart(chartEl, {
  layout:    { background: { color: '#161b22' }, textColor: '#8b949e' },
  grid:      { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } },
  crosshair: { mode: lc.CrosshairMode.Normal },
  rightPriceScale: { borderColor: '#30363d' },
  timeScale: { borderColor: '#30363d', timeVisible: true, secondsVisible: false },
  width: chartEl.clientWidth, height: 260,
});
const eqSeries = chart.addLineSeries({ color: '#4e8cff', lineWidth: 2, priceLineVisible: false });
new ResizeObserver(() => chart.resize(chartEl.clientWidth, 260)).observe(chartEl);

// ---- Helpers ----
const f2  = v => v == null ? '\u2014' : Number(v).toFixed(2);
const fusd = v => v == null ? '\u2014' : '$' + Number(v).toFixed(2);
const fpct = v => v == null ? '\u2014' : Number(v).toFixed(2) + '%';
const pc   = v => v > 0 ? 'g' : v < 0 ? 'r' : '';

function tAgo(iso) {
  if (!iso) return '\u2014';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return Math.round(d) + 's';
  if (d < 3600) return Math.round(d / 60) + 'm';
  if (d < 86400) return (d / 3600).toFixed(1) + 'h';
  return (d / 86400).toFixed(1) + 'd';
}
function sTs(iso) {
  if (!iso) return '\u2014';
  try { return new Date(iso).toISOString().replace('T', ' ').slice(0, 19); }
  catch(e) { return String(iso); }
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ---- Open equity ----
function openEq(s) {
  return (s.open_positions || []).reduce((a, p) => a + (p.net_pnl_usd || 0), 0);
}

// ---- Render functions ----
function renderHeader(s) {
  const eq = (s.cash || 0) + openEq(s);
  const isDry = s.dry_run !== false;
  const kill  = s.kill_switch || false;

  document.getElementById('h-eq').textContent  = fusd(eq);
  document.getElementById('h-dd').textContent  = fpct(s.max_drawdown_pct);
  const pEl = document.getElementById('h-pnl');
  pEl.textContent = fusd(s.total_pnl_usd);
  pEl.className = 'val ' + pc(s.total_pnl_usd);

  const dot = document.getElementById('sdot');
  dot.className = 'sdot ' + (kill ? 'dot-r' : 'dot-g');

  const bdg = document.getElementById('mbadge');
  if (isDry) { bdg.className = 'badge bdry'; bdg.textContent = 'DRY RUN'; }
  else       { bdg.className = 'badge blive'; bdg.textContent = 'LIVE'; }

  document.getElementById('lupd').textContent = 'Updated: ' + new Date().toLocaleTimeString();
}

function renderStats(s) {
  const tr = s.total_trades || 0;
  const tw = s.total_wins   || 0;
  document.getElementById('s-tr').textContent  = tr;
  document.getElementById('s-wr').textContent  = tr > 0 ? fpct(tw / tr * 100) : '\u2014';
  const pEl = document.getElementById('s-pnl');
  pEl.textContent = fusd(s.total_pnl_usd);
  pEl.className = 'sv ' + pc(s.total_pnl_usd);
  document.getElementById('s-mdd').textContent = fpct(s.max_drawdown_pct);
}

function renderChart(s) {
  const hist = s.equity_history || [];
  if (!hist.length) return;
  const seen = new Map();
  hist.forEach(pt => {
    const t = Math.floor(new Date(pt.t).getTime() / 1000);
    if (!isNaN(t)) seen.set(t, { time: t, value: pt.v });
  });
  const sorted = Array.from(seen.values()).sort((a, b) => a.time - b.time);
  if (sorted.length) eqSeries.setData(sorted);
}

function renderBalances(s) {
  const cache = s.balance_cache || {};
  const grid  = document.getElementById('bgrid');
  const keys  = Object.keys(cache);
  if (!keys.length) {
    grid.innerHTML = '<div class="nd">No balance data</div>';
    return;
  }
  let html = '';
  keys.forEach(ex => {
    const b = cache[ex] || {};
    const av  = b.available != null ? b.available : (b.free  || 0);
    const lk  = b.locked    != null ? b.locked    : (b.used  || 0);
    const tot = av + lk;
    const ok  = b.healthy !== false && b.error == null;
    const dc  = ok ? 'var(--grn)' : 'var(--red)';
    html += '<div class="bbox">';
    html += '<div class="en"><span class="hdot" style="background:' + dc + '"></span>' + esc(ex) + '</div>';
    html += '<div class="br"><span class="brl">Available</span><span class="brv">' + f2(av) + '</span></div>';
    html += '<div class="br"><span class="brl">Locked</span><span class="brv">' + f2(lk) + '</span></div>';
    html += '<div class="br"><span class="brl">Total</span><span class="brv">' + f2(tot) + '</span></div>';
    if (b.error) {
      html += '<div class="br"><span class="brl r" style="font-size:11px">' + esc(b.error) + '</span></div>';
    }
    html += '</div>';
  });
  grid.innerHTML = html;
}

function renderOpen(s) {
  const rows = s.open_positions || [];
  const tb   = document.getElementById('op-body');
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="9" class="nd">No open positions</td></tr>';
    return;
  }
  let html = '';
  rows.forEach(p => {
    const pnl = p.net_pnl_usd || 0;
    const st  = p.degraded_leg
      ? '<span class="y">DEGRADED</span>'
      : '<span class="g">OPEN</span>';
    const oids = [p.order_id_short, p.order_id_long].filter(Boolean).join(' / ') || '\u2014';
    html += '<tr>';
    html += '<td class="a">' + esc(p.symbol) + '</td>';
    html += '<td>' + esc(p.exchange_short || '\u2014') + '</td>';
    html += '<td>' + esc(p.exchange_long  || '\u2014') + '</td>';
    html += '<td>' + f2(p.entry_spread_pct) + '</td>';
    html += '<td>' + f2(p.current_spread_pct) + '</td>';
    html += '<td class="' + pc(pnl) + '">' + fusd(pnl) + '</td>';
    html += '<td>' + tAgo(p.entry_time) + '</td>';
    html += '<td>' + st + '</td>';
    html += '<td class="m" style="font-size:10px">' + esc(oids) + '</td>';
    html += '</tr>';
  });
  tb.innerHTML = html;
}

function renderClosed(s) {
  const rows = (s.closed_positions || []).slice(-50).reverse();
  const tb   = document.getElementById('cp-body');
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="9" class="nd">No closed positions</td></tr>';
    return;
  }
  let html = '';
  rows.forEach(p => {
    const pnl = p.net_pnl_usd || 0;
    const fees = (p.entry_fees_usd || 0) + (p.exit_fees_usd || 0);
    html += '<tr>';
    html += '<td class="a">' + esc(p.symbol) + '</td>';
    html += '<td>' + esc(p.exchange_short || '\u2014') + '</td>';
    html += '<td>' + esc(p.exchange_long  || '\u2014') + '</td>';
    html += '<td>' + f2(p.entry_spread_pct) + '</td>';
    html += '<td>' + f2(p.exit_spread_pct)  + '</td>';
    html += '<td class="' + pc(pnl) + '">' + fusd(pnl) + '</td>';
    html += '<td>' + fusd(fees) + '</td>';
    html += '<td>' + tAgo(p.entry_time) + '</td>';
    html += '<td class="m">' + esc(p.exit_reason || '\u2014') + '</td>';
    html += '</tr>';
  });
  tb.innerHTML = html;
}

function renderAudit(s) {
  const rows = (s.order_audit_log || []).slice(-50).reverse();
  const tb   = document.getElementById('al-body');
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="12" class="nd">No orders yet</td></tr>';
    return;
  }
  let html = '';
  rows.forEach(o => {
    const ok  = o.success !== false && !o.error;
    const res = ok
      ? '<span class="g">OK</span>'
      : '<span class="r" title="' + esc(o.error || '') + '">' + (o.error ? 'ERR' : 'FAIL') + '</span>';
    const lat = o.latency_ms != null ? o.latency_ms + 'ms' : '\u2014';
    const sc  = (o.side === 'sell') ? 'r' : 'g';
    html += '<tr>';
    html += '<td>' + sTs(o.timestamp) + '</td>';
    html += '<td>' + esc(o.action) + '</td>';
    html += '<td>' + esc(o.exchange) + '</td>';
    html += '<td class="a">' + esc(o.symbol) + '</td>';
    html += '<td class="' + sc + '">' + esc(o.side) + '</td>';
    html += '<td>' + f2(o.size) + '</td>';
    html += '<td>' + f2(o.filled) + '</td>';
    html += '<td>' + f2(o.fill_price) + '</td>';
    html += '<td>' + fusd(o.fees) + '</td>';
    html += '<td class="m" style="font-size:10px">' + esc(o.order_id || '\u2014') + '</td>';
    html += '<td>' + lat + '</td>';
    html += '<td>' + res + '</td>';
    html += '</tr>';
  });
  tb.innerHTML = html;
}

// ---- Trade Diagnostics renderer ----
// Pulls the joined view from /api/diagnostics. Failures are logged but
// don't break the rest of the dashboard — diagnostics are nice-to-have.
// All string fields are escaped via esc() to prevent XSS through malicious
// or buggy state.json content.
function renderDiagnostics(d) {
  const sum = d.summary || {};
  const trades = d.trades || [];
  const sumEl = document.getElementById('td-summary');
  if (!trades.length) {
    sumEl.textContent = 'No closed trades with diagnostic records yet.';
    document.getElementById('td-body').innerHTML =
      '<tr><td colspan="12" class="nd">No data</td></tr>';
    return;
  }
  // Color helpers reuse existing dashboard idioms.
  const cls = (v) => v > 0 ? 'g' : (v < 0 ? 'r' : '');
  const fmt = (v, n) => (typeof v === 'number') ? v.toFixed(n) : '\u2014';
  const fmtUSD = (v) => (typeof v === 'number') ? '$' + v.toFixed(4) : '\u2014';

  // Summary line — built from numeric summary stats only (no user-controlled
  // strings), so direct innerHTML is safe here.
  sumEl.innerHTML = (
    '<b>' + (sum.n_trades_with_diagnostics | 0) + '</b> trades' +
    ' &middot; entry slip <span class="' + cls(sum.total_entry_slippage_usd) + '">' +
        fmtUSD(sum.total_entry_slippage_usd) + '</span>' +
    ' &middot; exit slip <span class="' + cls(sum.total_exit_slippage_usd) + '">' +
        fmtUSD(sum.total_exit_slippage_usd) + '</span>' +
    ' &middot; funding <span class="' + cls(sum.total_funding_paid_usd) + '">' +
        fmtUSD(sum.total_funding_paid_usd) + '</span>' +
    ' &middot; <b>' + (sum.stale_quote_count | 0) + '</b> with stale quotes (>' +
        ((sum.stale_quote_threshold_ms || 0) / 1000).toFixed(0) + 's)' +
    ' &middot; <b>' + (sum.negative_realized_entry_count | 0) + '</b> with negative realized entry' +
    ' &middot; <b>' + (sum.asymmetric_pnl_count | 0) + '</b> with asymmetric per-leg P&amp;L'
  );

  // Per-trade rows (limit to 50 for compactness). String columns escaped.
  const tb = document.getElementById('td-body');
  let html = '';
  for (const t of trades.slice(0, 50)) {
    html += '<tr>';
    html += '<td>' + ((t.id | 0) || '') + '</td>';
    html += '<td class="a">' + esc(t.symbol || '') + '</td>';
    html += '<td class="' + cls(t.net_pnl_usd) + '">' + fmtUSD(t.net_pnl_usd) + '</td>';
    html +=
      '<td><span class="' + cls(t.short_pnl_usd) + '">' + fmt(t.short_pnl_usd, 3) + '</span>' +
      ' / <span class="' + cls(t.long_pnl_usd) + '">' + fmt(t.long_pnl_usd, 3) + '</span></td>';
    html += '<td class="' + cls(-t.entry_slippage_usd) + '">' + fmtUSD(t.entry_slippage_usd) + '</td>';
    html += '<td class="' + cls(-t.exit_slippage_usd) + '">' + fmtUSD(t.exit_slippage_usd) + '</td>';
    html += '<td class="' + cls(-t.funding_paid_usd) + '">' + fmtUSD(t.funding_paid_usd) + '</td>';
    html += '<td>' + fmt(t.hold_minutes, 1) + '</td>';
    const stale = t.max_quote_age_ms >= 5000;
    html += '<td' + (stale ? ' class="r"' : '') + '>' + ((t.max_quote_age_ms | 0) || 0) + '</td>';
    const negRealized = t.realized_entry_spread_pct < 0;
    html += '<td' + (negRealized ? ' class="r"' : '') + '>' + fmt(t.realized_entry_spread_pct, 3) + '%</td>';
    html += '<td>' + fmt(t.realized_exit_spread_pct, 3) + '%</td>';
    html += '<td>' + esc(t.exit_reason || '') + '</td>';
    html += '</tr>';
  }
  tb.innerHTML = html;
}

async function refreshDiagnostics() {
  try {
    const r = await fetch('/api/diagnostics');
    if (!r.ok) return;
    const d = await r.json();
    renderDiagnostics(d);
  } catch(e) { console.warn('diagnostics refresh:', e); }
}

// ---- Poll loop ----
async function refresh() {
  try {
    const r = await fetch('/api/state');
    if (!r.ok) return;
    const s = await r.json();
    renderHeader(s);
    renderStats(s);
    renderChart(s);
    renderBalances(s);
    renderOpen(s);
    renderClosed(s);
    renderAudit(s);
  } catch(e) { console.warn('refresh:', e); }
  // Diagnostics is a separate fetch so a failure here doesn't break the
  // main view; conversely a state-fetch failure doesn't kill diagnostics.
  refreshDiagnostics();
}
refresh();
setInterval(refresh, 3000);

// ---- Controls ----
async function ctrl(action) {
  const el = document.getElementById('cstat');
  el.textContent = 'Sending\u2026';
  try {
    const r = await fetch('/api/' + action, { method: 'POST' });
    const d = await r.json();
    el.textContent = d.status || 'OK';
  } catch(e) { el.textContent = 'Error: ' + e.message; }
  setTimeout(() => { el.textContent = ''; }, 4000);
}
</script>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.route("/")
@check_auth
def index():
    return HTML


@app.route("/api/state")
@check_auth
def api_state():
    try:
        with open(os.path.join(DATA_DIR, "real_state.json")) as f:
            return jsonify(json.load(f))
    except (FileNotFoundError, json.JSONDecodeError):
        return jsonify({})


# ---------------------------------------------------------------------------
# /api/diagnostics — joined view of closed positions + their TradeDiagnostic
# records. Server-side join + summary stats so the dashboard can display
# forensic data without re-implementing the join in JavaScript.
#
# Returns a structure that's friendly for the small Trade Diagnostics panel:
#   {
#     "summary": {<aggregate stats>},
#     "trades":  [<per-trade joined records, most recent first>],
#   }
# ---------------------------------------------------------------------------
_STALE_QUOTE_MS_THRESHOLD = 5_000   # 5 seconds


@app.route("/api/diagnostics")
@check_auth
def api_diagnostics():
    """Return joined closed-positions + diagnostics with summary stats."""
    try:
        with open(os.path.join(DATA_DIR, "real_state.json")) as f:
            state = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return jsonify({"summary": {}, "trades": []})

    diagnostics = state.get("diagnostics") or {}
    closed = state.get("closed_positions") or []

    trades = []
    sum_entry_slip = 0.0
    sum_exit_slip = 0.0
    sum_funding = 0.0
    n_stale = 0
    n_neg_realized = 0
    n_asym_pnl = 0

    # Iterate most-recent-first.
    for pos in reversed(closed):
        pid = pos.get("id")
        diag = diagnostics.get(str(pid))
        if not diag:
            # Trade closed before the diagnostic feature shipped — skip
            # rather than render a half-empty row.
            continue

        entry_slip = (
            float(diag.get("short_entry_slippage_usd", 0.0))
            + float(diag.get("long_entry_slippage_usd", 0.0))
        )
        exit_slip = (
            float(diag.get("short_exit_slippage_usd", 0.0))
            + float(diag.get("long_exit_slippage_usd", 0.0))
        )
        funding = (
            float(diag.get("funding_paid_short_usd", 0.0))
            + float(diag.get("funding_paid_long_usd", 0.0))
        )
        max_quote_age = max(
            int(diag.get("detection_short_quote_age_ms", 0)),
            int(diag.get("detection_long_quote_age_ms", 0)),
        )
        short_pnl = float(diag.get("short_pnl_usd", 0.0))
        long_pnl = float(diag.get("long_pnl_usd", 0.0))

        sum_entry_slip += entry_slip
        sum_exit_slip += exit_slip
        sum_funding += funding
        if max_quote_age >= _STALE_QUOTE_MS_THRESHOLD:
            n_stale += 1
        # Realized entry spread on the position itself (Plan 3 commit
        # 72ee1bbb persisted this on LivePosition).
        realized_entry = float(pos.get("realized_entry_spread_pct", 0.0))
        if realized_entry < 0:
            n_neg_realized += 1
        # "Asymmetric PnL": one leg made money, the other lost. Indicates
        # the trade's outcome was driven by directional price movement
        # rather than convergence — useful signal even when net PnL is
        # close to zero.
        if (short_pnl > 0) != (long_pnl > 0) and abs(short_pnl) + abs(long_pnl) > 0.01:
            n_asym_pnl += 1

        trades.append({
            "id": pid,
            "symbol": pos.get("symbol"),
            "exchange_short": pos.get("exchange_short"),
            "exchange_long": pos.get("exchange_long"),
            "entry_time": pos.get("entry_time"),
            "net_pnl_usd": float(pos.get("net_pnl_usd", 0.0)),
            "short_pnl_usd": short_pnl,
            "long_pnl_usd": long_pnl,
            "entry_slippage_usd": entry_slip,
            "exit_slippage_usd": exit_slip,
            "funding_paid_usd": funding,
            "hold_minutes": float(diag.get("hold_minutes", 0.0)),
            "max_quote_age_ms": max_quote_age,
            "realized_entry_spread_pct": realized_entry,
            "realized_exit_spread_pct": float(diag.get("exit_realized_spread_pct", 0.0)),
            "exit_reason": pos.get("exit_reason"),
            "candidate_score": float(diag.get("candidate_score", 0.0)),
            "candidate_rank": int(diag.get("candidate_rank", 0)),
        })

    return jsonify({
        "summary": {
            "n_trades_with_diagnostics": len(trades),
            "total_entry_slippage_usd": round(sum_entry_slip, 4),
            "total_exit_slippage_usd": round(sum_exit_slip, 4),
            "total_funding_paid_usd": round(sum_funding, 4),
            "stale_quote_count": n_stale,
            "stale_quote_threshold_ms": _STALE_QUOTE_MS_THRESHOLD,
            "negative_realized_entry_count": n_neg_realized,
            "asymmetric_pnl_count": n_asym_pnl,
        },
        "trades": trades,
    })


@app.route("/api/stop", methods=["POST"])
@check_auth
def api_stop():
    os.makedirs(DATA_DIR, exist_ok=True)
    flag = os.path.join(DATA_DIR, "stop.flag")
    with open(flag, "w") as f:
        f.write("1")
    return jsonify({"status": "stop flag written", "flag": flag})


@app.route("/api/start", methods=["POST"])
@check_auth
def api_start():
    os.makedirs(DATA_DIR, exist_ok=True)
    stop_flag = os.path.join(DATA_DIR, "stop.flag")
    if os.path.exists(stop_flag):
        os.remove(stop_flag)
    flag = os.path.join(DATA_DIR, "start.flag")
    with open(flag, "w") as f:
        f.write("1")
    return jsonify({"status": "start flag written", "flag": flag})


@app.route("/api/dryrun", methods=["POST"])
@check_auth
def api_dryrun():
    os.makedirs(DATA_DIR, exist_ok=True)
    flag = os.path.join(DATA_DIR, "dryrun.flag")
    with open(flag, "w") as f:
        f.write("1")
    return jsonify({"status": "dryrun toggle flag written", "flag": flag})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=False)
