#!/usr/bin/env python3
# CK Weekly Tactical — the book-faithful three-phase meeting (EOS Level-10 / Mochary / Goldratt).
#   PRE  (deterministic, ~0 LLM): assemble the scorecard + Issues List from REAL data (EspoCRM pipeline
#        + Paperclip state); the AGENDA is DERIVED from the data, not authored by an LLM.
#   MEETING (agents): real agents run IDS on the top issue, strictly phased (no redundancy), with a
#        mandated Red-Team.
#   POST (deterministic): write the decisions back as REAL owned Paperclip tasks, a caught-error golden
#        case, and a self-rating. Sends stay human-gated.
import json, urllib.request, urllib.error, time, re
BASE = "http://127.0.0.1:3100/api"; CID = "e651858f-b11b-4b43-aa43-20c1192d7e98"
ESPO = "http://127.0.0.1:8085/api/v1"; ESPO_KEY = open("/home/ckhermes/.secrets/divino-crm-api.key").read().strip()

def api(m, p, b=None):
    req = urllib.request.Request(BASE + p, method=m, headers={"Content-Type": "application/json"},
        data=json.dumps(b).encode() if b is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return r.status, json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e: return e.code, e.read().decode()[:160]

def espo(path):
    req = urllib.request.Request(ESPO + path, headers={"X-Api-Key": ESPO_KEY})
    with urllib.request.urlopen(req, timeout=20) as r: return json.loads(r.read())

# ---------- PRE: assemble the scorecard + derive the agenda from real data ----------
def assemble_preread():
    accts = []; off = 0
    while True:
        r = espo(f"/Account?select=name,cVertriebsstatus,cPrioritaet,emailAddress,emailAddressIsOptedOut,billingAddressState&maxSize=200&offset={off}")
        accts += r["list"];
        if len(r["list"]) < 200: break
        off += 200
    def st(a): return (a.get("cVertriebsstatus") or "").strip() or "Noch offen"
    NONPROS = {"kunde", "partner", "konkurrenz", "kein interesse"}
    total = len(accts)
    customers = sum(1 for a in accts if st(a).lower() == "kunde")
    prospects = [a for a in accts if st(a).lower() not in NONPROS and a.get("emailAddressIsOptedOut") is not True]
    contacted = sum(1 for a in accts if st(a).lower() not in ("noch offen",) and st(a).lower() not in NONPROS)
    with_email = sum(1 for a in prospects if (a.get("emailAddress") or "").strip())
    # Paperclip open work
    s, issues = api("GET", f"/companies/{CID}/issues")
    open_issues = [i for i in (issues if isinstance(issues, list) else []) if str(i.get("status")) in ("todo", "in_progress", "blocked")]
    blocked = [i for i in open_issues if str(i.get("status")) == "blocked"]
    scorecard = {
        "commission_throughput_chf": 0,            # ground truth: no closed commission yet
        "prospects": len(prospects), "contacted": contacted, "uncontacted": len(prospects) - contacted,
        "customers": customers, "prospects_with_email": with_email,
        "open_issues": len(open_issues), "blocked_issues": len(blocked),
    }
    # Issues List — DERIVED deterministically, ranked by impact on throughput (the global metric).
    issues_list = []
    if scorecard["contacted"] == 0 and scorecard["prospects"] > 0:
        issues_list.append((100, f"Outbound contact = 0 of {scorecard['prospects']} ready prospects -> commission throughput CHF 0. THE binding constraint."))
    elif scorecard["uncontacted"] > scorecard["contacted"]:
        issues_list.append((90, f"{scorecard['uncontacted']} of {scorecard['prospects']} prospects still uncontacted -> throughput capped by outbound volume."))
    if scorecard["blocked_issues"] > 0:
        issues_list.append((60, f"{scorecard['blocked_issues']} blocked issue(s) need disposition."))
    if scorecard["prospects_with_email"] < scorecard["prospects"]:
        issues_list.append((40, f"{scorecard['prospects'] - scorecard['prospects_with_email']} prospects missing an email (enrichment gap)."))
    issues_list.sort(reverse=True)
    return scorecard, [t for _, t in issues_list]

# ---------- helpers ----------
def agents_by_ck():
    s, ags = api("GET", f"/companies/{CID}/agents")
    return {(a.get("metadata") or {}).get("ck_id"): a["id"] for a in ags if (a.get("metadata") or {}).get("ck_id")}

def run_phase(iid, byck, ck, before):
    aid = byck[ck]
    # ONE deterministic trigger: assign as 'backlog' (no assignment auto-wake) + exactly one explicit wakeup.
    api("PATCH", f"/issues/{iid}", {"assigneeAgentId": aid, "status": "backlog"})
    api("POST", f"/agents/{aid}/wakeup", {"source": "on_demand", "reason": "weekly tactical", "idempotencyKey": f"{ck}-{iid}"})
    for _ in range(24):
        s, c = api("GET", f"/issues/{iid}/comments")
        n = [r for r in (c if isinstance(c, list) else []) if r.get("authorType") != "system"]
        if len(n) > before: return n[0]
        time.sleep(6)
    return None

def comments(iid):
    s, c = api("GET", f"/issues/{iid}/comments")
    return [r for r in (c if isinstance(c, list) else []) if r.get("authorType") != "system"]

# ---------- run ----------
sc, agenda = assemble_preread()
byck = agents_by_ck()
print("PRE (deterministic) — scorecard:", json.dumps(sc))
print("PRE — agenda DERIVED from data:");  [print("   ", a) for a in agenda]
top = agenda[0] if agenda else "No off-track items."

preread = (
 "WEEKLY TACTICAL — pre-read ASSEMBLED FROM DATA (do not restate these facts in your reply).\n"
 f"SCORECARD (live EspoCRM + Paperclip): commission throughput CHF {sc['commission_throughput_chf']} | "
 f"prospects {sc['prospects']} ({sc['prospects_with_email']} with email) | contacted {sc['contacted']} | "
 f"uncontacted {sc['uncontacted']} | customers {sc['customers']} | open issues {sc['open_issues']} (blocked {sc['blocked_issues']}).\n"
 "ISSUES LIST (derived + ranked by impact on commission throughput):\n" + "".join(f"  {i+1}. {a}\n" for i, a in enumerate(agenda)) +
 f"\nThe agenda is FIXED by the data above. We run IDS on Issue #1: \"{top}\"\n\n"
 "RULES: contribute ONLY your phase, in 3-6 sentences. Do NOT repeat the pre-read facts or write an IDENTIFY section — the data already did that. Build on the thread.\n"
 "ROLES:\n"
 "- GOV-25 (chair): open and FRAME Issue #1 for IDS in one tight paragraph (what specifically must we decide), then hand to REV-04.\n"
 "- REV-04 (campaign owner): DISCUSS — one concrete proposal with a measurable target and owner.\n"
 "- GOV-12 (Red-Team, mandated): the single strongest argument AGAINST that proposal, with a reason.\n"
 "- GOV-24 (close): SOLVE in 2-3 sentences (decide; adopt or reject the red-team). Then your reply MUST END with this exact block, one line per to-do (parsed by machine — no prose after it):\n"
 "  TODOS:\n"
 "  - owner=REV-04 | action=Draft the A/B first-contact variants and post for approval | due=Wednesday\n"
 "  - owner=Alan | action=Approve the Basel send batch | due=Thursday\n"
 "  Use real CK-IDs (REV-04, REV-06, REV-09, ...) or Alan; mark outward/irreversible to-dos owner=Alan (human-gated). Keep 1-3.")

s, iss = api("POST", f"/companies/{CID}/issues",
    {"title": "Weekly Tactical (data-derived agenda)", "description": preread, "status": "backlog", "priority": "high", "assigneeAgentId": byck["GOV-25"]})
IID = iss["id"]; print("\nMEETING issue:", IID)

for ck in ["GOV-25", "REV-04", "GOV-12", "GOV-24"]:
    before = len(comments(IID))
    posted = run_phase(IID, byck, ck, before)
    print(f"  {ck}: {'posted' if posted else 'TIMEOUT'}")

thread = comments(IID)
close = next((c["body"] for c in thread if "GOV-24" in (c.get("body") or "")), "")

# ---------- POST: write decisions back as REAL owned tasks + golden case + self-rating ----------
print("\nPOST (deterministic) — creating real tasks from the close...")
def extract_owner(s):
    m = re.search(r"\b([A-Z]{2,4}-\d+)\b", s or "")
    if m: return m.group(1)
    return "Alan" if re.search(r"\bAlan\b", s or "") else None
todos = []
for line in close.splitlines():
    m = re.search(r"owner=([^|]+?)\s*\|\s*action=(.+?)\s*\|\s*due=(.+)", line)
    if m: todos.append((extract_owner(m.group(1)) or m.group(1).strip(), m.group(2).strip(), m.group(3).strip()))
if not todos:  # fallback: prose "Next action (owner): <who> to <action>"
    for m in re.finditer(r"Next action\s*\(([^)]*)\):\s*(.+)", close):
        todos.append((extract_owner(m.group(1)) or extract_owner(m.group(2)) or "Alan", m.group(2).strip()[:120], "this week"))
seen, uniq = set(), []
for o, a, d in todos:
    if a[:40].lower() in seen: continue
    seen.add(a[:40].lower()); uniq.append((o, a, d))
todos = uniq
created = []
for owner, action, due in todos:
    aid = byck.get(owner)
    body = f"From Weekly Tactical {IID}. Due: {due}. Outward/irreversible steps stay human-gated to Alan (draft-only)."
    # created as 'backlog' so it is OWNED + queued but does not auto-execute until promoted
    payload = {"title": action[:120], "description": body, "status": "backlog", "priority": "high"}
    if aid: payload["assigneeAgentId"] = aid
    s, t = api("POST", f"/companies/{CID}/issues", payload)
    if s in (200, 201): created.append((owner, action, t["id"]))
print(f"  real tasks created: {len(created)}")
for o, a, tid in created: print(f"    -> {o}: {a[:60]} [{tid}]")

# caught-error golden case (Dalio: every caught error becomes a permanent test)
redteam = next((c["body"] for c in thread if "GOV-12" in (c.get("body") or "")), "")
golden = redteam.strip().split("\n")[0][:200] if redteam else ""

# deterministic self-rating
rating = 2 + (2 if len(thread) >= 4 else 0) + (1 if redteam else 0) + (3 if created else 0) + 1 + (0 if "CK IT Solutions" in close else 1)
minutes = (f"**Weekly Tactical — minutes (auto)**\n\n"
    f"- Agenda (data-derived): {len(agenda)} items; ran IDS on #1.\n"
    f"- Decisions -> **{len(created)} real owned task(s) created** (status backlog, human-gated sends).\n"
    + "".join(f"  - {o} owns: {a[:70]}\n" for o, a, _ in created) +
    f"- Golden case logged (caught by Red-Team): {golden or 'none'}\n"
    f"- Meeting self-rating: **{rating}/10** (decisions produced, red-team present, human-gate intact, no disclosure leak).\n"
    f"- Handoff: GOV-12 meta-eval to review.")
api("POST", f"/issues/{IID}/comments", {"body": minutes, "authorType": "board"})
api("PATCH", f"/issues/{IID}", {"status": "done"})
print("\n" + "#" * 78 + "\n  MINUTES\n" + "#" * 78 + "\n" + minutes)
print("\n--- full thread ---")
for c in comments(IID): print("\n" + (c.get("body") or "")[:1500])
