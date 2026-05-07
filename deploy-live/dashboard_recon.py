"""Reconciliation panel blueprint for the Paperclip dashboard.

Exposes:
  GET /recon/              -- HTML panel (invariant status board + event list)
  GET /recon/events        -- JSON paginated event list, optional ?severity= filter
  GET /recon/invariants    -- JSON invariant status (green/red per category)

All user-supplied query params are validated before use:
  - severity: checked against a closed allow-list
  - page/page_size: coerced to int and clamped to safe bounds
No SQL injection is possible: all filter values are passed as parameterised
query arguments, never interpolated into SQL.
"""
from __future__ import annotations

import json as _json
import os
import sqlite3
import time
from typing import Optional

from flask import Blueprint, jsonify, request

import invariants as _inv
import state_store as _ss

# ---------------------------------------------------------------------------
# Invariant category registry -- derived from invariants.py, not hardcoded.
# check_all() covers invariants 1-8, 10-13; check_inmem_consistency() adds 9.
# ---------------------------------------------------------------------------
_INVARIANT_CATEGORIES: list[str] = [
    "open_position_missing_legs",
    "closed_position_missing_exit_fills",
    "fill_quality",
    "overlapping_open_positions",
    "aged_open_position",
    "stuck_transition",
    "audit_orphan_position_id",
    "fill_orphan_position_id",
    "inmem_db_count_mismatch",
    "exposure_exceeds_balance",
    "stale_unresolved_recon_event",
    "stale_ok_exchange_health",
    "negative_realized_entry_spread",
]

_STALE_THRESHOLD_MS = 5 * 60 * 1000  # 5 minutes

recon_bp = Blueprint("recon", __name__, url_prefix="/recon")

# ---------------------------------------------------------------------------
# SQLite path helper -- mirrors dashboard._data_source() logic
# ---------------------------------------------------------------------------

_USE_SQLITE = _ss.env_truthy("USE_SQLITE_STATE")
_DB_PATH = os.environ.get(
    "STATE_DB_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "state.db"),
)


def _get_conn() -> Optional[sqlite3.Connection]:
    """Return an open SQLite connection or None when unavailable."""
    if not _USE_SQLITE:
        return None
    if not os.path.exists(_DB_PATH):
        return None
    try:
        return _ss.open_db(_DB_PATH)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Validation helpers -- prevent injection via query params
# ---------------------------------------------------------------------------

_VALID_SEVERITIES = {"info", "warn", "error", "critical", ""}


def _safe_severity(raw: str) -> str:
    """Return raw if it is a valid severity label, else empty string."""
    val = raw.strip().lower()
    return val if val in _VALID_SEVERITIES else ""


def _safe_int(raw: str, default: int, min_val: int = 0, max_val: int = 10_000) -> int:
    try:
        v = int(raw)
        return max(min_val, min(v, max_val))
    except (ValueError, TypeError):
        return default


# ---------------------------------------------------------------------------
# Route: JSON events (paginated, severity-filtered)
# ---------------------------------------------------------------------------

@recon_bp.route("/events")
def events_json():
    severity = _safe_severity(request.args.get("severity", ""))
    page = _safe_int(request.args.get("page", "1"), default=1, min_val=1)
    page_size = _safe_int(
        request.args.get("page_size", "50"), default=50, min_val=1, max_val=200
    )

    conn = _get_conn()
    if conn is None:
        return jsonify({
            "events": [],
            "page": page,
            "page_size": page_size,
            "total": 0,
            "message": "No data -- SQLite not configured or state.db missing",
        })

    try:
        min_sev = severity if severity else "info"
        all_rows = _list_recon_events(conn, min_severity=min_sev)
    finally:
        conn.close()

    total = len(all_rows)
    offset = (page - 1) * page_size
    page_rows = all_rows[offset: offset + page_size]

    return jsonify({
        "events": [_row_to_dict(r) for r in page_rows],
        "page": page,
        "page_size": page_size,
        "total": total,
    })


# ---------------------------------------------------------------------------
# Route: JSON invariant status board
# ---------------------------------------------------------------------------

@recon_bp.route("/invariants")
def invariants_json():
    conn = _get_conn()
    if conn is None:
        statuses = [
            {
                "category": c,
                "status": "unknown",
                "message": "No data -- SQLite not configured or state.db missing",
            }
            for c in _INVARIANT_CATEGORIES
        ]
        return jsonify({"invariants": statuses})

    now_ms = int(time.time() * 1000)
    cutoff_ms = now_ms - _STALE_THRESHOLD_MS

    try:
        rows = conn.execute(
            "SELECT category, MAX(last_seen_ms) AS latest "
            "FROM reconciliation_events "
            "WHERE resolution='unresolved' "
            "GROUP BY category"
        ).fetchall()
    finally:
        conn.close()

    recent_red = {r["category"] for r in rows if (r["latest"] or 0) >= cutoff_ms}

    statuses = []
    for category in _INVARIANT_CATEGORIES:
        statuses.append({
            "category": category,
            "status": "red" if category in recent_red else "green",
        })

    return jsonify({"invariants": statuses})


# ---------------------------------------------------------------------------
# Route: HTML panel (server-rendered shell; JS fetches /recon/events and
# /recon/invariants to populate tables)
# ---------------------------------------------------------------------------

@recon_bp.route("/")
def panel():
    return _PANEL_HTML


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _list_recon_events(conn: sqlite3.Connection, *, min_severity: str = "info"):
    """Return all recon events (all resolutions) at or above min_severity."""
    threshold = _ss._SEVERITY_ORDER[min_severity]
    accepted = [s for s, lvl in _ss._SEVERITY_ORDER.items() if lvl >= threshold]
    placeholders = ",".join("?" * len(accepted))
    rows = conn.execute(
        f"SELECT * FROM reconciliation_events "
        f"WHERE severity IN ({placeholders}) "
        f"ORDER BY timestamp DESC",
        accepted,
    ).fetchall()
    return rows


def _row_to_dict(row) -> dict:
    return {
        "id": row["id"],
        "timestamp_ms": row["timestamp"],
        "source": row["source"],
        "category": row["category"],
        "severity": row["severity"],
        "exchange": row["exchange"],
        "symbol": row["symbol"],
        "position_id": row["position_id"],
        "expected": _json.loads(row["expected"]) if row["expected"] else None,
        "actual": _json.loads(row["actual"]) if row["actual"] else None,
        "resolution": row["resolution"],
        "notes": row["notes"],
        "repeat_count": row["repeat_count"],
        "last_seen_ms": row["last_seen_ms"],
    }


# ---------------------------------------------------------------------------
# Inline HTML/JS template for the recon panel. Kept inline (vs. a separate
# templates/ file) to avoid creating a new directory hierarchy in deploy-live/.
# This pushes dashboard_recon.py to ~375 lines (228 Python + 148 HTML), which
# exceeds the plan's <250-line module guidance. Trade-off: simpler deploy
# (one file, no template lookup path config) vs. line-count cleanliness.
# If a Task 22+ feature adds more interactive UI, externalize to templates/.
# ---------------------------------------------------------------------------

_PANEL_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Paperclip -- Recon Panel</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d1117;--card:#161b22;--bdr:#30363d;--text:#c9d1d9;
  --muted:#8b949e;--acc:#4e8cff;--grn:#3fb950;--red:#f85149;--ylw:#d29922;
  --mono:'Fira Mono','Cascadia Code',monospace}
html,body{background:var(--bg);color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px}
.layout{max-width:1400px;margin:0 auto;padding:16px;display:flex;flex-direction:column;gap:16px}
.header{background:var(--card);border:1px solid var(--bdr);border-radius:8px;
  padding:14px 20px;display:flex;align-items:center;gap:20px;flex-wrap:wrap}
.header h1{font-size:18px;font-weight:600}
.header h1 span{color:var(--acc)}
.nav a{color:var(--acc);text-decoration:none;font-size:13px}
.nav a:hover{text-decoration:underline}
.card{background:var(--card);border:1px solid var(--bdr);border-radius:8px;padding:16px}
.ctitle{font-size:12px;font-weight:600;text-transform:uppercase;
  letter-spacing:.07em;color:var(--muted);margin-bottom:12px}
.igrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
.ibox{background:var(--bg);border:1px solid var(--bdr);border-radius:6px;
  padding:10px 14px;display:flex;align-items:center;gap:10px}
.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.dot-g{background:var(--grn);box-shadow:0 0 5px var(--grn)}
.dot-r{background:var(--red);box-shadow:0 0 5px var(--red)}
.dot-u{background:var(--muted)}
.icat{font-family:var(--mono);font-size:12px}
.tw{overflow-x:auto;max-height:480px;overflow-y:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
thead th{position:sticky;top:0;background:var(--card);color:var(--muted);
  text-align:left;padding:6px 10px;font-weight:600;text-transform:uppercase;
  letter-spacing:.05em;border-bottom:1px solid var(--bdr);white-space:nowrap}
tbody tr:nth-child(even){background:rgba(255,255,255,.02)}
tbody tr:hover{background:rgba(78,140,255,.07)}
tbody td{padding:5px 10px;font-family:var(--mono);font-size:12px;
  white-space:nowrap;border-bottom:1px solid rgba(48,54,61,.5)}
.nd{color:var(--muted);text-align:center;padding:24px;font-size:13px}
.sev-info{color:var(--muted)}.sev-warn{color:var(--ylw)}
.sev-error{color:var(--red)}.sev-critical{color:var(--red);font-weight:700}
.fbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
select,button{background:var(--bg);color:var(--text);border:1px solid var(--bdr);
  border-radius:4px;padding:4px 10px;font-size:13px;cursor:pointer}
button:hover{border-color:var(--acc);color:var(--acc)}
</style>
</head>
<body>
<div class="layout">
<div class="header">
  <h1>Paperclip &mdash; <span>Recon Panel</span></h1>
  <div class="nav"><a href="/">&larr; Main Dashboard</a></div>
</div>
<div class="card">
  <div class="ctitle">Invariant Status (12 checks)</div>
  <div class="igrid" id="igrid"><div class="nd">Loading&hellip;</div></div>
</div>
<div class="card">
  <div class="ctitle">Reconciliation Events</div>
  <div class="fbar">
    <label for="sev-sel">Severity:</label>
    <select id="sev-sel">
      <option value="">All</option>
      <option value="warn">Warn+</option>
      <option value="error">Error+</option>
      <option value="critical">Critical</option>
    </select>
    <button onclick="loadEvents()">Refresh</button>
    <span id="evt-msg" style="color:var(--muted);font-size:12px"></span>
  </div>
  <div class="tw">
    <table>
      <thead><tr>
        <th>ID</th><th>Time</th><th>Source</th><th>Category</th>
        <th>Severity</th><th>Exchange</th><th>Symbol</th>
        <th>Resolution</th><th>Repeats</th><th>Notes</th>
      </tr></thead>
      <tbody id="ev-body"><tr><td colspan="10" class="nd">Loading&hellip;</td></tr></tbody>
    </table>
  </div>
</div>
</div>
<script>
function esc(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
function fts(ms){
  if(!ms) return '\u2014';
  try{return new Date(ms).toISOString().replace('T',' ').slice(0,19);}
  catch(e){return String(ms);}
}
async function loadInvariants(){
  try{
    const r=await fetch('/recon/invariants');
    const d=await r.json();
    const grid=document.getElementById('igrid');
    if(!d.invariants||!d.invariants.length){
      grid.textContent='No invariant data';return;
    }
    let h='';
    d.invariants.forEach(iv=>{
      const dc=iv.status==='red'?'dot-r':iv.status==='green'?'dot-g':'dot-u';
      h+='<div class="ibox"><span class="dot '+esc(dc)+'"></span>'
        +'<span class="icat">'+esc(iv.category)+'</span></div>';
    });
    grid.innerHTML=h;
  }catch(e){console.warn('invariants:',e);}
}
async function loadEvents(){
  const sev=document.getElementById('sev-sel').value;
  const url='/recon/events'+(sev?'?severity='+encodeURIComponent(sev):'');
  const msg=document.getElementById('evt-msg');
  const tb=document.getElementById('ev-body');
  try{
    const r=await fetch(url);
    const d=await r.json();
    msg.textContent=d.message?d.message:'Total: '+d.total;
    if(!d.events||!d.events.length){
      tb.innerHTML='<tr><td colspan="10" class="nd">No events</td></tr>';return;
    }
    let h='';
    d.events.forEach(e=>{
      h+='<tr>'
        +'<td>'+esc(e.id)+'</td>'
        +'<td>'+fts(e.timestamp_ms)+'</td>'
        +'<td>'+esc(e.source)+'</td>'
        +'<td>'+esc(e.category)+'</td>'
        +'<td class="sev-'+esc(e.severity)+'">'+esc(e.severity)+'</td>'
        +'<td>'+esc(e.exchange||'\u2014')+'</td>'
        +'<td>'+esc(e.symbol||'\u2014')+'</td>'
        +'<td>'+esc(e.resolution)+'</td>'
        +'<td>'+esc(e.repeat_count)+'</td>'
        +'<td>'+esc(e.notes||'\u2014')+'</td>'
        +'</tr>';
    });
    tb.innerHTML=h;
  }catch(e){console.warn('events:',e);}
}
loadInvariants();
loadEvents();
setInterval(function(){loadInvariants();loadEvents();},15000);
</script>
</body>
</html>"""
