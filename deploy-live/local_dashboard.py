#!/usr/bin/env python3
"""
Local Dashboard for Live Trader — proxies state from remote server.

Dependencies: flask, requests
    pip install flask requests
"""
import os
import html as html_mod

from flask import Flask, jsonify, request, Response
import requests

app = Flask(__name__)

REMOTE_HOST = os.environ.get("REMOTE_HOST", "3.0.80.145")
REMOTE_PORT = os.environ.get("REMOTE_PORT", "8080")
REMOTE_PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "changeme")
REMOTE_BASE = f"http://{REMOTE_HOST}:{REMOTE_PORT}"


def _proxy(method: str, path: str):
    """Proxy a request to the remote server with basic auth."""
    url = f"{REMOTE_BASE}{path}"
    auth = ("", REMOTE_PASSWORD)
    try:
        resp = requests.request(method, url, auth=auth, timeout=10)
        return Response(resp.content, status=resp.status_code,
                        content_type=resp.headers.get("Content-Type", "application/json"))
    except requests.RequestException as exc:
        return jsonify({"error": str(exc)}), 502


@app.route("/api/state")
def api_state():
    return _proxy("GET", "/api/state")


@app.route("/api/stop", methods=["POST"])
def api_stop():
    return _proxy("POST", "/api/stop")


@app.route("/api/start", methods=["POST"])
def api_start():
    return _proxy("POST", "/api/start")


@app.route("/api/dryrun", methods=["POST"])
def api_dryrun():
    return _proxy("POST", "/api/dryrun")


DASHBOARD_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Live Trader Dashboard</title>
<script src="https://unpkg.com/lightweight-charts@4.1.0/dist/lightweight-charts.standalone.production.js"></script>
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --bg-0:#080b12;--bg-1:#0d1119;--bg-2:#131825;--bg-3:#1a2035;
    --border:#1c2237;--border-hover:#2a3352;
    --text-0:#e8ecf4;--text-1:#a4adc4;--text-2:#6b7696;--text-3:#404a66;
    --accent:#4e8cff;--accent-dim:#4e8cff20;
    --green:#34d399;--green-dim:#34d39918;--red:#f47272;--red-dim:#f4727218;
    --yellow:#fbbf24;--yellow-dim:#fbbf2418;--purple:#a78bfa;--purple-dim:#a78bfa18;
    --radius:8px;--radius-lg:12px;
    --font:'DM Sans',system-ui,sans-serif;--mono:'IBM Plex Mono',monospace;
  }
  body{font-family:var(--font);background:var(--bg-0);color:var(--text-0);min-height:100vh;overflow-x:hidden;-webkit-font-smoothing:antialiased}

  /* HEADER */
  .header{padding:14px 28px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px);background:rgba(8,11,18,0.92)}
  .header h1{font-size:15px;font-weight:700;letter-spacing:-0.3px;color:var(--text-0)}
  .header h1 span{color:var(--accent);font-weight:400}
  .header-right{display:flex;align-items:center;gap:16px}
  .header .status{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-2);font-family:var(--mono)}
  .header .dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green);animation:pulse 2s infinite}
  .header .dot.red{background:var(--red);box-shadow:0 0 8px var(--red)}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
  .badge{font-size:9px;padding:3px 8px;border-radius:4px;font-weight:600;font-family:var(--mono);text-transform:uppercase}
  .badge-yellow{background:var(--yellow-dim);color:var(--yellow);border:1px solid rgba(251,191,36,0.25)}
  .badge-green{background:var(--green-dim);color:var(--green);border:1px solid rgba(52,211,153,0.25)}
  .badge-red{background:var(--red-dim);color:var(--red);border:1px solid rgba(244,114,114,0.25)}
  .badge-blue{background:var(--accent-dim);color:var(--accent);border:1px solid rgba(78,140,255,0.25)}
  .header-pills{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .header-pill{font-size:11px;font-family:var(--mono);color:var(--text-2)}
  .header-pill .val{font-weight:600;margin-left:4px}

  /* TAB BAR */
  .tab-bar{display:flex;gap:0;padding:0 28px;background:var(--bg-0);border-bottom:1px solid var(--border);position:sticky;top:51px;z-index:99}
  .tab{padding:12px 20px;font-size:12px;font-weight:500;color:var(--text-2);cursor:pointer;border-bottom:2px solid transparent;transition:all .2s;letter-spacing:0.2px}
  .tab:hover{color:var(--text-1)}
  .tab.active{color:var(--accent);border-bottom-color:var(--accent)}
  .tab .tab-badge{background:var(--bg-3);color:var(--text-2);font-size:10px;padding:2px 7px;border-radius:10px;margin-left:6px;font-family:var(--mono)}

  /* LAYOUT */
  .container{max-width:100%;margin:0 auto;padding:20px 28px}
  .page{display:none}
  .page.active{display:block;animation:fadeIn .2s ease}
  @keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

  /* KPI ROW */
  .kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px}
  .kpi{background:var(--bg-1);border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px 18px;position:relative;overflow:hidden}
  .kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--border);transition:background .3s}
  .kpi:first-child::before{background:var(--accent)}
  .kpi:nth-child(2)::before{background:var(--green)}
  .kpi:nth-child(3)::before{background:var(--yellow)}
  .kpi .label{font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-2);margin-bottom:6px;font-weight:500}
  .kpi .value{font-family:var(--mono);font-size:22px;font-weight:600;letter-spacing:-0.5px;line-height:1.1}
  .kpi .sub{font-size:10px;color:var(--text-3);margin-top:4px;font-family:var(--mono)}
  .green{color:var(--green)}.red{color:var(--red)}.yellow{color:var(--yellow)}.blue{color:var(--accent)}.white{color:var(--text-0)}.purple{color:var(--purple)}

  /* GRID */
  .row{display:flex;gap:16px;margin-bottom:16px}
  .col{flex:1;min-width:0}
  .col-2{flex:2;min-width:0}

  /* SECTIONS */
  .section{background:var(--bg-1);border:1px solid var(--border);border-radius:var(--radius-lg);margin-bottom:16px;overflow:hidden;transition:border-color .2s}
  .section:hover{border-color:var(--border-hover)}
  .section-head{padding:14px 20px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none}
  .section-head:hover{background:rgba(255,255,255,0.015)}
  .section-title{font-size:13px;font-weight:600;color:var(--text-1);display:flex;align-items:center;gap:10px;letter-spacing:-0.1px}
  .section-title .cnt{background:var(--bg-3);color:var(--text-2);font-size:10px;padding:2px 8px;border-radius:10px;font-weight:500;font-family:var(--mono)}
  .section-toggle{color:var(--text-3);font-size:10px;transition:transform .25s ease}
  .section-body{padding:0 20px 20px}
  .section.collapsed .section-body{display:none}
  .section.collapsed .section-toggle{transform:rotate(-90deg)}

  /* TABLES */
  table{width:100%;border-collapse:collapse;table-layout:auto}
  th{text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:1.2px;color:var(--text-3);padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap;font-weight:600}
  td{padding:9px 10px;font-size:12px;border-bottom:1px solid rgba(28,34,55,0.5);vertical-align:middle;white-space:nowrap;color:var(--text-1)}
  tr:hover td{background:rgba(78,140,255,0.03)}
  .mono{font-family:var(--mono);font-size:11px}

  /* EXCHANGE CARDS */
  .ex-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
  .ex-card{background:var(--bg-0);border:1px solid var(--border);border-radius:var(--radius);padding:14px;transition:border-color .2s}
  .ex-card:hover{border-color:var(--border-hover)}
  .ex-card .ex-name{font-size:11px;font-weight:600;color:var(--text-1);margin-bottom:6px;letter-spacing:0.3px;display:flex;align-items:center;gap:6px}
  .ex-card .ex-val{font-family:var(--mono);font-size:15px;font-weight:600}
  .ex-card .ex-sub{font-size:9px;color:var(--text-3);margin-top:3px;font-family:var(--mono)}
  .health-dot{width:6px;height:6px;border-radius:50%;display:inline-block}
  .health-dot.ok{background:var(--green);box-shadow:0 0 6px var(--green)}
  .health-dot.warn{background:var(--yellow);box-shadow:0 0 6px var(--yellow)}
  .health-dot.err{background:var(--red);box-shadow:0 0 6px var(--red)}

  /* CHART */
  .chart-area{width:100%;height:380px;position:relative;background:#0f1320;border-radius:var(--radius);overflow:hidden;border:1px solid var(--border)}

  .empty{text-align:center;padding:32px;color:var(--text-3);font-size:13px}

  /* CONTROLS */
  .ctrl-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
  .ctrl-btn{padding:8px 20px;font-size:12px;font-weight:600;border-radius:6px;border:1px solid;cursor:pointer;font-family:var(--font);transition:all .15s}
  .ctrl-btn:hover{filter:brightness(1.15)}
  .ctrl-btn.stop{background:var(--red-dim);color:var(--red);border-color:rgba(244,114,114,0.3)}
  .ctrl-btn.start{background:var(--green-dim);color:var(--green);border-color:rgba(52,211,153,0.3)}
  .ctrl-btn.toggle{background:var(--yellow-dim);color:var(--yellow);border-color:rgba(251,191,36,0.3)}
  .ctrl-status{font-size:11px;color:var(--text-2);font-family:var(--mono)}

  /* RESPONSIVE */
  @media(max-width:1100px){.row{flex-direction:column}}
  @media(max-width:600px){
    body{font-size:13px}
    .header{padding:10px 14px}
    .header h1{font-size:13px}
    .tab-bar{padding:0 10px;overflow-x:auto;scrollbar-width:none;top:43px}
    .tab{padding:10px 14px;font-size:11px;white-space:nowrap;flex-shrink:0}
    .container{padding:12px 10px}
    .kpi-row{grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
    .kpi{padding:12px 14px}
    .kpi .label{font-size:8px}
    .kpi .value{font-size:17px}
    .row{flex-direction:column;gap:10px;margin-bottom:10px}
    .col,.col-2{flex:none;width:100%}
    .section-body{overflow-x:auto}
    .chart-area{height:240px !important}
    table{min-width:520px}
    th{font-size:8px;padding:6px 7px}
    td{padding:6px 7px;font-size:11px}
    .mono{font-size:10px}
    .ex-cards{grid-template-columns:1fr 1fr;gap:6px}
  }
</style>
</head>
<body>

<!-- HEADER -->
<div class="header">
  <h1>Live Trader <span>EU</span></h1>
  <div class="header-pills" id="headerPills">
    <span class="header-pill">Equity <span class="val white" id="hdrEquity">--</span></span>
    <span class="header-pill">P&amp;L <span class="val" id="hdrPnl">--</span></span>
    <span class="header-pill">DD <span class="val red" id="hdrDD">--</span></span>
    <span class="header-pill">Uptime <span class="val" id="hdrUptime">--</span></span>
  </div>
  <div class="header-right">
    <span class="badge badge-yellow" id="dryRunBadge" style="display:none">DRY RUN</span>
    <div class="status">
      <div class="dot" id="statusDot"></div>
      <span id="statusText">Connecting...</span>
    </div>
  </div>
</div>

<!-- TABS -->
<div class="tab-bar">
  <div class="tab active" data-page="overview">Overview</div>
  <div class="tab" data-page="positions">Positions <span class="tab-badge" id="tabOpenBadge">0</span></div>
  <div class="tab" data-page="history">History</div>
  <div class="tab" data-page="audit">Audit Log</div>
  <div class="tab" data-page="controls">Controls</div>
</div>

<div class="container">

<!-- PAGE: OVERVIEW -->
<div class="page active" id="page-overview">
  <div class="kpi-row">
    <div class="kpi"><div class="label">Equity</div><div class="value white" id="kpiEquity">--</div><div class="sub" id="kpiEquitySub">USDT</div></div>
    <div class="kpi"><div class="label">Total P&amp;L</div><div class="value" id="kpiPnl">--</div><div class="sub" id="kpiPnlPct">--</div></div>
    <div class="kpi"><div class="label">Win Rate</div><div class="value blue" id="kpiWinRate">--</div><div class="sub" id="kpiWinSub">0/0</div></div>
    <div class="kpi"><div class="label">Total Trades</div><div class="value white" id="kpiTrades">0</div><div class="sub">closed</div></div>
    <div class="kpi"><div class="label">Max Drawdown</div><div class="value red" id="kpiDrawdown">--</div><div class="sub">from peak</div></div>
    <div class="kpi"><div class="label">Open Positions</div><div class="value purple" id="kpiOpen">0</div><div class="sub" id="kpiOpenSub">--</div></div>
  </div>

  <div class="row">
    <div class="col-2">
      <div class="section">
        <div class="section-head" style="cursor:default">
          <div class="section-title">Equity Curve</div>
        </div>
        <div class="section-body">
          <div class="chart-area" id="chartContainer"></div>
        </div>
      </div>
    </div>
    <div class="col">
      <div class="section">
        <div class="section-head" onclick="toggleSection(this)">
          <div class="section-title">Exchange Balances <span class="cnt" id="exCount">0</span></div>
          <span class="section-toggle">&#9660;</span>
        </div>
        <div class="section-body">
          <div class="ex-cards" id="exchangeCards"></div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- PAGE: POSITIONS -->
<div class="page" id="page-positions">
  <div class="section">
    <div class="section-head" onclick="toggleSection(this)">
      <div class="section-title">Open Positions <span class="cnt" id="openCount">0</span></div>
      <span class="section-toggle">&#9660;</span>
    </div>
    <div class="section-body">
      <div id="openTable"></div>
    </div>
  </div>
</div>

<!-- PAGE: HISTORY -->
<div class="page" id="page-history">
  <div class="section">
    <div class="section-head" onclick="toggleSection(this)">
      <div class="section-title">Closed Positions <span class="cnt" id="closedCount">0</span></div>
      <span class="section-toggle">&#9660;</span>
    </div>
    <div class="section-body">
      <div id="closedTable"></div>
    </div>
  </div>
</div>

<!-- PAGE: AUDIT -->
<div class="page" id="page-audit">
  <div class="section">
    <div class="section-head" onclick="toggleSection(this)">
      <div class="section-title">Order Audit Log <span class="cnt" id="auditCount">0</span></div>
      <span class="section-toggle">&#9660;</span>
    </div>
    <div class="section-body">
      <div id="auditTable"></div>
    </div>
  </div>
</div>

<!-- PAGE: CONTROLS -->
<div class="page" id="page-controls">
  <div class="section">
    <div class="section-head" style="cursor:default">
      <div class="section-title">Bot Controls</div>
    </div>
    <div class="section-body">
      <div class="ctrl-bar">
        <button class="ctrl-btn stop" onclick="ctrlAction('/api/stop')">Stop Bot</button>
        <button class="ctrl-btn start" onclick="ctrlAction('/api/start')">Start Bot</button>
        <button class="ctrl-btn toggle" onclick="ctrlAction('/api/dryrun')">Toggle DRY RUN</button>
        <span class="ctrl-status" id="ctrlStatus"></span>
      </div>
    </div>
  </div>
</div>

</div><!-- /container -->

<script>
// --- Tabs ---
document.querySelectorAll('.tab').forEach(function(t){
  t.addEventListener('click',function(){
    document.querySelectorAll('.tab').forEach(function(x){x.classList.remove('active')});
    document.querySelectorAll('.page').forEach(function(x){x.classList.remove('active')});
    t.classList.add('active');
    document.getElementById('page-'+t.dataset.page).classList.add('active');
  });
});
function toggleSection(el){el.closest('.section').classList.toggle('collapsed')}

// --- Escape HTML ---
function esc(s){if(s==null)return'';var d=document.createElement('div');d.textContent=String(s);return d.innerHTML}
function pnlClass(v){return v>=0?'green':'red'}
function fmtUsd(v){if(v==null)return'--';return(v>=0?'+':'')+v.toFixed(2)}
function fmtPct(v){if(v==null)return'--';return v.toFixed(2)+'%'}
function fmtDur(entry,exit){
  if(!entry)return'--';
  var s=new Date(entry),e=exit?new Date(exit):new Date();
  var diff=Math.floor((e-s)/1000);
  if(diff<0)diff=0;
  var h=Math.floor(diff/3600),m=Math.floor((diff%3600)/60);
  return h>0?(h+'h '+m+'m'):(m+'m');
}
function fmtTime(ts){if(!ts)return'--';var d=new Date(ts);return d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}

// --- Chart ---
var chart=null,series=null;
function initChart(){
  var el=document.getElementById('chartContainer');
  if(!el||chart)return;
  chart=LightweightCharts.createChart(el,{
    width:el.clientWidth,height:el.clientHeight,
    layout:{background:{type:'solid',color:'#0f1320'},textColor:'#6b7696',fontFamily:"'IBM Plex Mono',monospace",fontSize:10},
    grid:{vertLines:{color:'#1c223740'},horzLines:{color:'#1c223740'}},
    crosshair:{mode:0},
    rightPriceScale:{borderColor:'#1c2237',scaleMargins:{top:0.1,bottom:0.05}},
    timeScale:{borderColor:'#1c2237',timeVisible:true,secondsVisible:false},
    handleScale:true,handleScroll:true
  });
  series=chart.addAreaSeries({
    topColor:'rgba(78,140,255,0.25)',bottomColor:'rgba(78,140,255,0.02)',
    lineColor:'#4e8cff',lineWidth:2,
    crosshairMarkerRadius:4,crosshairMarkerBorderColor:'#4e8cff',
    crosshairMarkerBackgroundColor:'#fff'
  });
  new ResizeObserver(function(){chart.applyOptions({width:el.clientWidth,height:el.clientHeight})}).observe(el);
}

function updateChart(eqHist){
  if(!series||!eqHist||!eqHist.length)return;
  var data=eqHist.map(function(p){
    var d=new Date(p.t);
    return{time:Math.floor(d.getTime()/1000),value:p.v};
  }).sort(function(a,b){return a.time-b.time});
  // Deduplicate times
  var seen={},uniq=[];
  for(var i=0;i<data.length;i++){
    if(!seen[data[i].time]){seen[data[i].time]=true;uniq.push(data[i])}
  }
  series.setData(uniq);
}

// --- Build tables using safe DOM methods ---
function clearEl(id){var el=document.getElementById(id);while(el.firstChild)el.removeChild(el.firstChild);return el}

function buildOpenTable(positions){
  var container=clearEl('openTable');
  if(!positions||!positions.length){
    var empty=document.createElement('div');empty.className='empty';empty.textContent='No open positions';
    container.appendChild(empty);return;
  }
  var table=document.createElement('table');
  var thead=document.createElement('tr');
  ['Symbol','Short Exch','Long Exch','Instruments','Entry Spread','Current Spread','Unreal P&L','Duration','Status','Order IDs'].forEach(function(h){
    var th=document.createElement('th');th.textContent=h;thead.appendChild(th);
  });
  table.appendChild(thead);
  positions.forEach(function(p){
    var tr=document.createElement('tr');
    function addTd(text,cls,style){var td=document.createElement('td');td.className=cls||'';if(style)td.style.cssText=style;td.textContent=text;tr.appendChild(td);return td}
    addTd(p.symbol,'mono');
    addTd(p.exchange_short,'mono');
    addTd(p.exchange_long,'mono');
    addTd((p.instrument_short||'')+' / '+(p.instrument_long||''),'mono','font-size:10px');
    addTd(fmtPct(p.entry_spread_pct),'mono');
    addTd(fmtPct(p.current_spread_pct),'mono');
    addTd(fmtUsd(p.net_pnl_usd),'mono '+pnlClass(p.net_pnl_usd));
    addTd(fmtDur(p.entry_time),'mono');
    var statusTd=document.createElement('td');
    var badge=document.createElement('span');
    if(p.status==='DEGRADED'){badge.className='badge badge-yellow';badge.textContent='DEGRADED'}
    else{badge.className='badge badge-green';badge.textContent='OPEN'}
    statusTd.appendChild(badge);tr.appendChild(statusTd);
    var oidTd=document.createElement('td');oidTd.className='mono';oidTd.style.cssText='font-size:9px;color:var(--text-3)';
    oidTd.textContent=(p.order_id_short||'')+' / '+(p.order_id_long||'');
    tr.appendChild(oidTd);
    table.appendChild(tr);
  });
  container.appendChild(table);
}

function buildClosedTable(positions){
  var container=clearEl('closedTable');
  if(!positions||!positions.length){
    var empty=document.createElement('div');empty.className='empty';empty.textContent='No closed positions';
    container.appendChild(empty);return;
  }
  var last50=positions.slice(-50).reverse();
  var table=document.createElement('table');
  var thead=document.createElement('tr');
  ['Symbol','Exchanges','Entry Spread','Exit Spread','Net P&L','Fees','Duration','Exit Reason'].forEach(function(h){
    var th=document.createElement('th');th.textContent=h;thead.appendChild(th);
  });
  table.appendChild(thead);
  last50.forEach(function(p){
    var tr=document.createElement('tr');
    function addTd(text,cls,style){var td=document.createElement('td');td.className=cls||'';if(style)td.style.cssText=style;td.textContent=text;tr.appendChild(td)}
    addTd(p.symbol,'mono');
    addTd((p.exchange_short||'')+' / '+(p.exchange_long||''),'mono','font-size:10px');
    addTd(fmtPct(p.entry_spread_pct),'mono');
    addTd(fmtPct(p.current_spread_pct),'mono');
    addTd(fmtUsd(p.net_pnl_usd),'mono '+pnlClass(p.net_pnl_usd));
    var fees=((p.entry_fees_usd||0)+(p.exit_fees_usd||0)).toFixed(4);
    addTd('$'+fees,'mono','color:var(--text-3)');
    addTd(fmtDur(p.entry_time,p.exit_time),'mono');
    addTd(p.exit_reason||'--','mono');
    table.appendChild(tr);
  });
  container.appendChild(table);
}

function buildAuditTable(logs){
  var container=clearEl('auditTable');
  if(!logs||!logs.length){
    var empty=document.createElement('div');empty.className='empty';empty.textContent='No audit entries';
    container.appendChild(empty);return;
  }
  var last50=logs.slice(-50).reverse();
  var table=document.createElement('table');
  var thead=document.createElement('tr');
  ['Time','Action','Exchange','Symbol','Side','Size','Filled','Fill Price','Fees','Order ID','Latency','Status'].forEach(function(h){
    var th=document.createElement('th');th.textContent=h;thead.appendChild(th);
  });
  table.appendChild(thead);
  last50.forEach(function(e){
    var tr=document.createElement('tr');
    function addTd(text,cls,style){var td=document.createElement('td');td.className=cls||'';if(style)td.style.cssText=style;td.textContent=text;tr.appendChild(td);return td}
    addTd(fmtTime(e.timestamp),'mono');
    addTd(e.action||'','mono');
    addTd(e.exchange||'','mono');
    addTd(e.symbol||'','mono');
    addTd(e.side||'','mono');
    addTd('$'+(e.size_usd||0).toFixed(2),'mono');
    addTd('$'+(e.filled_usd||0).toFixed(2),'mono');
    addTd(e.fill_price!=null?e.fill_price.toFixed(4):'--','mono');
    addTd('$'+(e.fees_usd||0).toFixed(4),'mono','color:var(--text-3)');
    addTd(e.order_id||'--','mono','font-size:9px;color:var(--text-3)');
    addTd(e.latency_ms!=null?e.latency_ms+'ms':'--','mono');
    var statusTd=document.createElement('td');
    var badge=document.createElement('span');
    if(e.success){badge.className='badge badge-green';badge.textContent='OK'}
    else{badge.className='badge badge-red';badge.textContent=e.error||'ERR'}
    statusTd.appendChild(badge);
    if(e.dry_run){
      var drBadge=document.createElement('span');drBadge.className='badge badge-yellow';drBadge.style.cssText='margin-left:4px;font-size:8px';drBadge.textContent='DRY';
      statusTd.appendChild(drBadge);
    }
    tr.appendChild(statusTd);
    table.appendChild(tr);
  });
  container.appendChild(table);
}

// --- Exchange cards (safe DOM) ---
function buildExchangeCards(balCache){
  var container=clearEl('exchangeCards');
  var keys=balCache?Object.keys(balCache):[];
  if(!keys.length){
    var empty=document.createElement('div');empty.className='empty';empty.textContent='No exchange data';
    container.appendChild(empty);return;
  }
  keys.forEach(function(name){
    var b=balCache[name];
    var avail=b.available||0,locked=b.locked||0,total=avail+locked;
    var card=document.createElement('div');card.className='ex-card';
    var nameDiv=document.createElement('div');nameDiv.className='ex-name';
    var dot=document.createElement('span');
    dot.className='health-dot '+(total>10?'ok':(total>0?'warn':'err'));
    nameDiv.appendChild(dot);
    nameDiv.appendChild(document.createTextNode(name));
    card.appendChild(nameDiv);
    var valDiv=document.createElement('div');valDiv.className='ex-val white';valDiv.textContent='$'+avail.toFixed(2);
    card.appendChild(valDiv);
    var subDiv=document.createElement('div');subDiv.className='ex-sub';subDiv.textContent='locked $'+locked.toFixed(2);
    card.appendChild(subDiv);
    container.appendChild(card);
  });
}

// --- Controls ---
function ctrlAction(endpoint){
  var st=document.getElementById('ctrlStatus');
  st.textContent='Sending...';st.style.color='var(--text-2)';
  fetch(endpoint,{method:'POST'}).then(function(r){return r.json()}).then(function(d){
    st.textContent='OK';st.style.color='var(--green)';
    setTimeout(function(){st.textContent=''},2000);
  }).catch(function(e){
    st.textContent='Error: '+e;st.style.color='var(--red)';
  });
}

// --- Uptime tracking ---
var firstSeen=null;

// --- Main update ---
var lastError=false;
function refresh(){
  fetch('/api/state').then(function(r){
    if(!r.ok)throw new Error('HTTP '+r.status);
    return r.json();
  }).then(function(d){
    lastError=false;
    var dot=document.getElementById('statusDot');
    var stxt=document.getElementById('statusText');

    // Status dot
    if(d.kill_switch){
      dot.className='dot red';stxt.textContent='Kill Switch';
    }else{
      dot.className='dot';stxt.textContent='Running';
    }

    // Dry run badge
    document.getElementById('dryRunBadge').style.display=d.dry_run?'inline-block':'none';

    // Header pills
    var eq=d.cash||0;
    document.getElementById('hdrEquity').textContent='$'+eq.toFixed(2);
    var pnl=d.total_pnl_usd||0;
    var hdrPnl=document.getElementById('hdrPnl');
    hdrPnl.textContent=fmtUsd(pnl);hdrPnl.className='val '+pnlClass(pnl);
    document.getElementById('hdrDD').textContent=fmtPct(d.max_drawdown_pct||0);

    // Uptime
    if(!firstSeen)firstSeen=Date.now();
    var upSec=Math.floor((Date.now()-firstSeen)/1000);
    var upH=Math.floor(upSec/3600),upM=Math.floor((upSec%3600)/60);
    document.getElementById('hdrUptime').textContent=upH+'h '+upM+'m';

    // KPIs
    document.getElementById('kpiEquity').textContent='$'+eq.toFixed(2);
    var kpiPnl=document.getElementById('kpiPnl');
    kpiPnl.textContent='$'+fmtUsd(pnl);kpiPnl.className='value '+pnlClass(pnl);
    var peakEq=d.peak_equity||eq;
    if(peakEq>0){
      document.getElementById('kpiPnlPct').textContent=fmtPct((pnl/peakEq)*100);
    }

    var tt=d.total_trades||0,tw=d.total_wins||0;
    var wr=tt>0?((tw/tt)*100):0;
    document.getElementById('kpiWinRate').textContent=fmtPct(wr);
    document.getElementById('kpiWinSub').textContent=tw+'/'+tt;
    document.getElementById('kpiTrades').textContent=tt;
    document.getElementById('kpiDrawdown').textContent=fmtPct(d.max_drawdown_pct||0);

    var openPos=d.open_positions||[];
    document.getElementById('kpiOpen').textContent=openPos.length;
    document.getElementById('tabOpenBadge').textContent=openPos.length;
    document.getElementById('openCount').textContent=openPos.length;

    // Chart
    initChart();
    updateChart(d.equity_history);

    // Exchange cards
    var bc=d.balance_cache||{};
    document.getElementById('exCount').textContent=Object.keys(bc).length;
    buildExchangeCards(bc);

    // Tables
    buildOpenTable(openPos);
    var closed=d.closed_positions||[];
    document.getElementById('closedCount').textContent=closed.length;
    buildClosedTable(closed);
    var audit=d.order_audit_log||[];
    document.getElementById('auditCount').textContent=audit.length;
    buildAuditTable(audit);

  }).catch(function(e){
    if(!lastError){
      document.getElementById('statusDot').className='dot red';
      document.getElementById('statusText').textContent='Disconnected';
    }
    lastError=true;
  });
}

// Initial load + auto-refresh every 3 seconds
refresh();
setInterval(refresh,3000);
</script>
</body>
</html>"""


@app.route("/")
def index():
    return DASHBOARD_HTML


if __name__ == "__main__":
    print(f"[local_dashboard] Proxying to {REMOTE_BASE}")
    print(f"[local_dashboard] Open http://localhost:3000")
    port = int(os.environ.get("LOCAL_PORT", "3001"))
    print(f"[local_dashboard] Open http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=False)
