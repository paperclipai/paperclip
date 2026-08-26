#!/usr/bin/env python3
"""stranded-fence-sweep — mechanically resolve stranded-recovery fence cards.

Born 2026-08-25. Control-plane restarts (three that day) strand in-flight runs;
each strand mints an UNOWNED "BOARD ACTION REQUIRED: Stranded recovery needs a
board decision" card that BLOCKS every card fencing on it. Nobody owns them, so
they accumulate: by evening the five biggest blocked chains in the portfolio were
all such fences (one fenced 7 cards), and the operator resolved 14+ by hand in
three waves — every single one with the same two mechanical rules:

  * source already terminal (done/cancelled)      -> nothing to recover, close fence
  * source open + original owner invokable        -> retry the owner, close fence
  * anything else                                 -> genuinely needs judgment, LEAVE IT

This encodes exactly those rules, nothing more. The judgment cases stay open and
are listed in the log. Rate-bounded, cooldown-guarded, report-only by default.

Durable fix (platform: fence ownership, self-close, restart-residue suppression)
is TSMC's; this is the operator-side backstop per instruction-is-not-enforcement.

Usage: stranded-fence-sweep.py [--apply]
"""
import json
import re
import subprocess
import sys
import time

HOME = "/Users/glad0s"
PSQL = f"{HOME}/.claude/psql-ro.sh"
API = "http://127.0.0.1:3100/api"
LOG = f"{HOME}/scripts/logs/stranded-fence-sweep.log"
STATE = f"{HOME}/scripts/state/stranded-fence-sweep-state.json"
APPLY = "--apply" in sys.argv[1:]
MAX_ACTIONS_PER_RUN = 10
RETRY_COOLDOWN_S = 24 * 3600  # never re-kick the same source twice in a day

SEP = "\x1f"


def log(msg):
    line = f"{time.strftime('%F %T')} {'[APPLY]' if APPLY else '[dry]'} {msg}"
    print(line)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def q(sql):
    r = subprocess.run([PSQL, "-At", "-F", SEP, "-c", sql], capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        log(f"psql failed: {r.stderr.strip()[:150]}")
        sys.exit(2)
    return [ln.split(SEP) for ln in r.stdout.splitlines() if ln]


def api(method, path, body=None):
    cmd = ["/usr/bin/curl", "-s", "-m", "60", "-X", method, f"{API}{path}",
           "-H", "Content-Type: application/json"]
    if body is not None:
        cmd += ["-d", json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=90).stdout
    try:
        return json.loads(out)
    except Exception:
        return {"raw": out[:120]}


def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {"retried": {}}


def save_state(s):
    json.dump(s, open(STATE, "w"))


def main():
    state = load_state()
    now = time.time()
    fences = q(
        "SELECT i.id||'" + SEP + "'||c.id||'" + SEP + "'||c.name||'" + SEP + "'||i.issue_number"
        "||'" + SEP + "'||replace(replace(coalesce(i.description,''), E'\\n',' '), E'\\r',' ') "
        "FROM issues i JOIN companies c ON c.id=i.company_id "
        "WHERE i.status IN ('backlog','todo') AND i.assignee_agent_id IS NULL "
        "AND i.title LIKE 'BOARD ACTION REQUIRED:%' AND i.title ILIKE '%stranded recovery%'"
    )
    if not fences:
        log("clean — no unowned stranded-recovery fences")
        return 0
    actions = 0
    left = 0
    for row in fences:
        if len(row) < 5 or actions >= MAX_ACTIONS_PER_RUN:
            left += 1
            continue
        fid, cid, cname, num, desc = row[0], row[1], row[2], row[3], SEP.join(row[4:])
        m = re.search(r"First source observed: \[([A-Z]+-(\d+))\]", desc)
        if not m:
            log(f"{cname}-{num}: no source ref parsed — LEFT for judgment")
            left += 1
            continue
        srcref, srcnum = m.group(1), m.group(2)
        srow = q(
            f"SELECT i.id||'{SEP}'||i.status||'{SEP}'||coalesce(a.name,'-')||'{SEP}'||coalesce(a.status,'-') "
            f"FROM issues i LEFT JOIN agents a ON a.id=i.assignee_agent_id "
            f"WHERE i.company_id='{cid}' AND i.issue_number={srcnum}"
        )
        if not srow or len(srow[0]) < 4:
            log(f"{cname}-{num}: source {srcref} not found — LEFT")
            left += 1
            continue
        sid, sstat, aname, astat = srow[0][:4]
        if sstat in ("done", "cancelled"):
            verdict = f"source {srcref} already terminal ({sstat}) — nothing to recover"
        elif astat in ("idle", "running"):
            if now - state["retried"].get(sid, 0) < RETRY_COOLDOWN_S:
                log(f"{cname}-{num}: source {srcref} retried <24h ago — LEFT (cooldown; repeat strand needs judgment)")
                left += 1
                continue
            verdict = f"retried original owner {aname} on {srcref}"
            if APPLY:
                api("PATCH", f"/issues/{sid}", {"status": "todo"})
                state["retried"][sid] = now
        else:
            log(f"{cname}-{num}: source {srcref} is {sstat}, owner {aname}({astat}) — LEFT for judgment")
            left += 1
            continue
        if APPLY:
            note = (f"stranded-fence-sweep (mechanical, ~/scripts/stranded-fence-sweep.py): {verdict}. "
                    "Rules: terminal source = nothing to recover; invokable owner = retry once per 24h. "
                    "Judgment cases are never auto-closed. Closing this fence to release the cards it blocks.")
            intid_rows = q(f"SELECT id FROM issue_thread_interactions WHERE issue_id='{fid}' AND status='pending' LIMIT 1")
            if intid_rows:
                api("POST", f"/issues/{fid}/interactions/{intid_rows[0][0]}/accept", {"note": note})
            api("POST", f"/issues/{fid}/comments", {"body": note})
            api("PATCH", f"/issues/{fid}", {"status": "done"})
        log(f"{cname}-{num}: {verdict}{'' if APPLY else ' (would act)'}")
        actions += 1
    save_state(state)
    log(f"done — {actions} resolved, {left} left for judgment")
    # exit 1 only when judgment cases remain AND nothing could be auto-resolved:
    # that is the signal a human or capable lane must look (guard-bus consumable).
    return 1 if (left > 0 and actions == 0) else 0


if __name__ == "__main__":
    sys.exit(main())
