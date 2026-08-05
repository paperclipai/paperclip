#!/usr/bin/env python3
"""
claude-window-flip — windows ONLY the claude CTO sprint lane. (2026-06-21: the CEO is now
PERMANENTLY on its codex/gpt-5.4 sister — gpt-5.4 ties opus on CEO judgment, so a claude CEO buys
no quality; parking it saves the thin Claude sub. opus DOES win CTO, so the claude CTO still gets
the windowed sprint overlay.) Codex sister stays the 24/7 always-on ops lane (routines live there).

Per company: claude CTO window = [startHour, endHour] (window-only; flanks trimmed 2026-07-07).
  CEO: pause claude permanently -> codex sister (gpt-5.4) is primary (claude = resumable fallback).
  CTO: in window -> resume claude (opus);  out window -> pause (codex covers).
  agent with no codex sister -> left on Claude (logged).
TSMC (always-on) -> claude CTO always active; claude CEO still parked (codex primary).

The codex sister is the 24/7 always-on OPS lane (routines live here; Hermes-backed
session-limit failover owns its pause/resume). window-flip governs ONLY the Claude
sprint lane and never pauses/resumes codex — touching it would fight session-limit-watch
(it would resume a codex agent the watcher paused for a real limit, causing a flap).

Agents missing a codex sister are left on Claude (logged). Both lanes must be
activity-window-exempt (set once) so they run during the 2h dormant flanks.

Usage:
  claude-window-flip.py            # DRY RUN (prints planned actions, changes nothing)
  claude-window-flip.py --apply    # execute pause/resume
"""
import json, os, subprocess, sys, urllib.request, urllib.error
from datetime import datetime
from zoneinfo import ZoneInfo

BASE = "http://127.0.0.1:3100"
PG = ["/opt/homebrew/bin/psql", "-h127.0.0.1", "-p54329", "-U", "paperclip", "-d", "paperclip", "-tA", "-F", "\t"]
APPLY = "--apply" in sys.argv
# Ad-hoc sprints (scripts/adhoc-sprint.sh) drop a <cid>.json flag here; while
# present we keep that company's claude CTO (and CEO if claudeCeo) active for the
# whole sprint — no mid-sprint park/swap. The revert clears the flag.
SPRINT_DIR = "/Users/glad0s/paperclip/scripts/.adhoc-sprint"
# Companies whose CTO runs on the codex sister (gpt-5.4) BY DEFAULT, with the
# claude-opus CTO PARKED as a resumable on-escalation lane. Added 2026-06-27:
# TSMC/Astra's always-on opus was the #1 Claude-sub drain. The triage gate (or a
# manual resume / ad-hoc sprint flag) brings opus back for genuinely hard CTO work.
CTO_CODEX_DEFAULT = {"e6361895-a6a4-438d-bb76-b17a0ad026cb"}  # TSMC

def q(sql):
    r = subprocess.run(PG + ["-c", sql], env={**os.environ, "PGPASSWORD": "paperclip"}, capture_output=True, text=True)
    if r.returncode != 0 and r.stderr.strip():
        print(f"  [psql err] {r.stderr.strip()[:160]}")
    return r.stdout.strip()

def api(path, method="POST", body=None):
    data = json.dumps(body).encode() if body is not None else b"{}"
    req = urllib.request.Request(f"{BASE}/api{path}", data=data, headers={"Content-Type": "application/json"}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode()[:80]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:120]
    except Exception as e:
        return 0, str(e)[:120]

def load_sprints():
    """cid -> sprint state dict, for any ad-hoc sprint currently in flight."""
    out = {}
    try:
        for fn in os.listdir(SPRINT_DIR):
            if not fn.endswith(".json"):
                continue
            try:
                with open(os.path.join(SPRINT_DIR, fn)) as f:
                    d = json.load(f)
                if d.get("cid"):
                    out[d["cid"]] = d
            except Exception:
                pass
    except FileNotFoundError:
        pass
    return out

def in_claude_window(h, start, end):
    # 2026-07-07 operator decision (regime v2): flanks trimmed to ±0 — the CTO
    # Claude sprint now equals the 10h company window exactly (was ±2h; with 10h
    # windows the flanked exposure would have been 14h/day/OpCo on the thin sub).
    cs = start % 24
    ce = end % 24
    if cs == ce:
        return True
    return (cs <= h < ce) if cs < ce else (h >= cs or h < ce)

def main():
    now_dublin = datetime.now(ZoneInfo("Europe/Dublin"))
    h = now_dublin.hour
    print(f"=== claude-window-flip {'APPLY' if APPLY else 'DRY-RUN'} @ {now_dublin:%Y-%m-%d %H:%M} Dublin (hour={h}) ===")

    # companies + windows
    comp_rows = q("SELECT id || '\t' || name || '\t' || COALESCE(activity_window::text,'') FROM companies WHERE status<>'archived';")
    companies = {}
    for line in comp_rows.splitlines():
        cid, name, win = (line.split("\t") + ["", "", ""])[:3]
        companies[cid] = {"name": name, "win": json.loads(win) if win.strip().startswith("{") else None}

    # ceo/cto claude primaries + their codex sisters, with current status
    agent_rows = q("""
      SELECT a.company_id || '\t' || a.role || '\t' || a.name || '\t' || a.adapter_type || '\t' || a.status || '\t' || a.id
      FROM agents a WHERE a.role IN ('ceo','cto') AND a.status<>'terminated'
        AND a.adapter_type IN ('claude_local','codex_local');""")
    # index: company -> role -> {claude:{}, codex:{}}
    fleet = {}
    for line in agent_rows.splitlines():
        cid, role, name, adapter, status, aid = (line.split("\t") + [""]*6)[:6]
        fleet.setdefault(cid, {}).setdefault(role, {})
        if adapter == "claude_local" and not name.endswith(("-Codex", "-Hermes", "-Grok")):
            fleet[cid][role]["claude"] = {"name": name, "status": status, "id": aid}
        elif adapter == "codex_local" and name.endswith("-Codex"):
            fleet[cid][role].setdefault("codex_by_base", {})[name[:-6]] = {"name": name, "status": status, "id": aid}

    actions = []
    def want(agent, desired):  # desired: 'active'(resume) or 'paused'(pause)
        if not agent: return
        cur = agent["status"]
        is_paused = cur == "paused"
        if desired == "active" and is_paused:
            actions.append(("resume", agent))
        elif desired == "paused" and not is_paused:
            actions.append(("pause", agent))

    sprints = load_sprints()

    for cid, comp in companies.items():
        roles = fleet.get(cid, {})
        win = comp["win"]
        always_on = win is None  # TSMC
        in_win = True if always_on else in_claude_window(h, int(win["startHour"]), int(win["endHour"]))
        sprint = sprints.get(cid)
        wlabel = "always-on" if always_on else f"sprint {win['startHour']:02d}-{win['endHour']:02d} → claude-window {'OPEN' if in_win else 'closed'}"
        if sprint:
            wlabel += f"  [AD-HOC SPRINT: claude CTO{' + CEO' if sprint.get('claudeCeo') else ''} active]"
        print(f"\n[{comp['name']}] {wlabel}")
        for role in ("ceo", "cto"):
            r = roles.get(role)
            if not r or "claude" not in r:
                continue
            claude = r["claude"]
            sister = (r.get("codex_by_base") or {}).get(claude["name"])
            # Ad-hoc sprint override: keep the claude sprint lane(s) active for the
            # whole sprint (CTO always; CEO only if the sprint opted its claude in).
            if sprint and (role == "cto" or (role == "ceo" and sprint.get("claudeCeo"))):
                print(f"  {role}: claude {claude['name']}[{claude['status']}] ACTIVE (ad-hoc sprint override)")
                want(claude, "active")
                continue
            if not sister:
                print(f"  {role}: {claude['name']} (claude) — NO codex sister, leaving on Claude")
                want(claude, "active")
                continue
            # QUOTA-DEAD SISTER OVERRIDE (2026-08-05). Parking the claude lane is only safe
            # while the codex sister can actually carry the role. On 2026-08-05 the whole
            # ChatGPT/Codex account exhausted its quota until Aug 9 and this hourly flip kept
            # re-parking the claude CEOs/CTOs the operator had just resumed as failover cover —
            # every hour, on the hour, the fleet lost its C-suite again (9 lanes re-paused at
            # 22:00:05 within 30 min of the operator's restore). Availability beats the bench
            # preference: a parked claude lane behind a dead codex sister is NOBODY running the
            # role. Self-reverting — when swap-back resumes the codex lanes, the next flip
            # re-parks claude per the normal policy below.
            if sister["status"] in ("paused", "error"):
                print(f"  {role}: codex sister {sister['name']}[{sister['status']}] UNAVAILABLE — keeping claude {claude['name']} ACTIVE (quota failover)")
                want(claude, "active")
                continue
            # Codex sister is the always-on ops lane — NOT pause/resumed here (owned by
            # session-limit-watch failover). window-flip only moves the Claude sprint lane.
            # CEO: gpt-5.4 TIES opus on CEO judgment (0.97 vs 0.98, within noise) — a claude CEO
            # buys no quality, so park it PERMANENTLY and run CEO on the codex sister (gpt-5.4),
            # saving the thin Claude sub. Claude CEO stays a resumable fallback.
            # CTO: opus has a REAL CTO edge (0.986 vs 0.965), so keep the windowed claude-opus
            # sprint overlay — spend Claude exactly when CTO work peaks, codex covers off-window.
            if role == "ceo" or (role == "cto" and cid in CTO_CODEX_DEFAULT):
                tag = "permanent primary" if role == "ceo" else "codex-default CTO; opus parked for escalation"
                print(f"  {role}: claude {claude['name']}[{claude['status']}] PARK (codex {sister['name']} = {tag})")
                want(claude, "paused")
            elif in_win:
                print(f"  cto: claude {claude['name']}[{claude['status']}] ACTIVE (sprint window) | codex {sister['name']} covers off-window")
                want(claude, "active")
            else:
                print(f"  cto: claude {claude['name']}[{claude['status']}] PAUSE (off-window) | codex {sister['name']} covers")
                want(claude, "paused")

    print(f"\n=== {len(actions)} action(s) {'to apply' if APPLY else 'planned (dry-run)'} ===")
    for act, agent in actions:
        if APPLY:
            code, _ = api(f"/agents/{agent['id']}/{act}", body={"reason": "claude-window-flip: 8h CEO/CTO window"})
            print(f"  {act} {agent['name']} -> HTTP {code}")
        else:
            print(f"  WOULD {act} {agent['name']} ({agent['status']})")

if __name__ == "__main__":
    main()
