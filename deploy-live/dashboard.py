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
