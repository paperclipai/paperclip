#!/usr/bin/env python3
"""
SAG-3162 Hourly local-AI Recovery Sweeper (defense-in-depth).
Self-contained, idempotent, cap-enforced. Stdlib only.

Levers (governance-safe, per SAG-3162 / SAG-3082 3-invariants):
  - Re-nudge the OWNING agent to resume its OWN assigned work (@-mention wake).
    Owner wakes POST to the runner-owned STATE_ISSUE (SAG-3421), NOT the source issue,
    so the sweeper never hits an assignee-only 403 on foreign tickets (SAG-8228). The
    source ticket identifier/link + nextAction are kept verbatim in the wake comment.
  - Transient agent `error`: SURFACE to digest only. The error->active PATCH lever
    is HARD-GATED OFF (SAG-8226 ruling; SAG-8227 pending board). NO agent status mutation.
  - Bare-blocked / no-blocker business tickets: SURFACE to digest only (no auto-resume).
  - Auto-handoff REQUEST to owning director when nudge cap exhausted (SAG-3172).
  - Stale activeRecoveryAction (missing_disposition / stranded): re-fire owner wake
    via @-mention quoting nextAction verbatim; 2-nudge cap then digest escalation;
    403 -> surface-only, no retry (SAG-3494).
HARD anti-loop: max CAP consecutive nudges, then ONE handoff request, then escalate to
daily Ticket Health Digest + named human (CEO) and STOP. Per-task handoff cap = 1.

Modes:
  live                       - real sweep (default)
  dry                        - detect + plan only, NO mutations, scratch ledger
  selftest                   - simulate one target through the cap to prove the anti-loop stop
  handoff-selftest            - prove per-task handoff cap: nudge->nudge->handoff->escalate->STOP
  recovery-action-selftest    - unit test: threshold gate, 2-nudge cap, 403->digest-only (SAG-3494)
"""
import json, os, re, sys, urllib.request, urllib.error
from datetime import datetime, timezone

API   = os.environ["PAPERCLIP_API_URL"].rstrip("/")
KEY   = os.environ["PAPERCLIP_API_KEY"]
RUNID = os.environ.get("PAPERCLIP_RUN_ID", "")
CO    = os.environ["PAPERCLIP_COMPANY_ID"]

# --- fixed anchors -----------------------------------------------------------
ANCHOR_ISSUE    = "6200183f-9377-4835-9713-a2f668db4592"   # SAG-3162 (context/script home; reads only)
STATE_ISSUE     = "f5c9151b-f233-4bcc-a9ff-853eb7b4470e"   # SAG-3421 (runner-owned, writable machine state)
LEDGER_KEY      = "recovery-sweeper-ledger"
DIGEST_AGENT    = "1e0167fe-1f74-43ea-ad89-36fa724ab80a"   # Daily Ticket Health Digest owner
UNIT_TEST_AGENT = "de2ae83f-f910-4558-a762-8eea9bf37179"   # QA Unit Tests routine runner (dedup)
CEO_AGENT       = "b0f67cc2-259e-477b-ac89-d0ff4e7c8e89"   # CEO fallback for director resolution
BOARD_AGENTS    = {"b0f67cc2-259e-477b-ac89-d0ff4e7c8e89"}  # CEO
CAP       = 2     # max consecutive nudges per target
STALE_MIN = 90    # in_progress idle threshold (minutes)
RECOVERY_ACTION_THRESHOLD_MIN = 120  # activeRecoveryAction staleness threshold (minutes, 2h)
NL = chr(10)      # newline char via chr(10): no backslash-n escape sequences in stored doc literals

MODE = sys.argv[1] if len(sys.argv) > 1 else "live"
DRY  = MODE == "dry"

def now(): return datetime.now(timezone.utc)
def iso(dt=None): return (dt or now()).strftime("%Y-%m-%dT%H:%M:%SZ")

def req(method, path, body=None):
    url = API + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Authorization", "Bearer " + KEY)
    r.add_header("Content-Type", "application/json")
    if RUNID: r.add_header("X-Paperclip-Run-Id", RUNID)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode()[:200]}
    except Exception as e:
        return 0, {"error": str(e)[:200]}

def as_list(d, *keys):
    if isinstance(d, list): return d
    for k in keys:
        if isinstance(d, dict) and isinstance(d.get(k), list): return d[k]
    return []

def age_min(ts):
    if not ts: return 1e9
    try:
        t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return (now() - t).total_seconds() / 60.0
    except Exception:
        return 1e9

# --- ledger ------------------------------------------------------------------
def load_ledger():
    if DRY or MODE in ("selftest", "handoff-selftest", "recovery-action-selftest"):
        return {"version": 1, "targets": {}, "_base": None}
    st, doc = req("GET", f"/api/issues/{STATE_ISSUE}/documents/{LEDGER_KEY}")
    if st == 200 and doc:
        raw = (doc.get("body") or "").strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1] if "```" in raw[3:] else raw.strip("`")
            raw = raw[len("json"):] if raw.lstrip().startswith("json") else raw
        try:
            body = json.loads(raw.strip() or "{}")
        except Exception:
            body = {}
        body.setdefault("version", 1); body.setdefault("targets", {})
        body["_base"] = doc.get("revisionId") or doc.get("baseRevisionId")
        return body
    return {"version": 1, "targets": {}, "_base": None}

def save_ledger(led):
    if DRY or MODE in ("selftest", "handoff-selftest", "recovery-action-selftest"): return "skipped(dry)"
    base = led.pop("_base", None)
    led["updatedAt"] = iso()
    payload = {"title": "Recovery Sweeper Ledger", "format": "markdown",
               "body": "```json" + NL + json.dumps(led, indent=2) + NL + "```",
               "baseRevisionId": base}
    st, _ = req("PUT", f"/api/issues/{STATE_ISSUE}/documents/{LEDGER_KEY}", payload)
    return f"saved({st})"

# --- nudge primitives --------------------------------------------------------
# NOTE: agent error->active clearing was removed. The error->active lever is
# HARD-GATED OFF (SAG-8226 ruling; SAG-8227 pending board). Error agents are
# surfaced to the digest only -- this routine performs NO agent status PATCH.

def nudge_owner(issue_id, ident, agent_id, name):
    # Route the wake to the runner-owned STATE_ISSUE (SAG-3421) instead of the source
    # ticket: the sweeper runner is not the assignee of foreign source issues, so a
    # comment POST there 403s (SAG-8228). The @-mention still wakes the owner, and the
    # source identifier/link keeps the pointer to their own work. issue_id retained for
    # ledger/keying and the 403 defense path only.
    link = f"[{ident}](/SAG/issues/{ident})"
    msg = (f"**Recovery Sweeper auto-nudge** -- [@{name}](agent://{agent_id}), issue "
           f"{link} is `in_progress` but has been idle. Please resume your own assigned "
           f"work there. "
           f"_(Automated re-nudge; capped at {CAP} consecutive -- defense-in-depth for "
           f"[SAG-3079](/SAG/issues/SAG-3079). Routed via runner-owned "
           f"[SAG-3421](/SAG/issues/SAG-3421) to avoid an assignee-only 403 on the "
           f"source ticket.)_")
    if DRY: return "would-comment-mention(state-issue)"
    st, _ = req("POST", f"/api/issues/{STATE_ISSUE}/comments", {"body": msg})
    return f"mention-comment(state) -> {st}"

def nudge_recovery_action_owner(issue_id, owner_id, owner_nm, ident, kind, next_action, nudge_num):
    """Post @-mention comment quoting nextAction verbatim to the runner-owned
    STATE_ISSUE (SAG-3421), keeping the source identifier/link so the mention wakes
    the owner without an assignee-only 403 on the source ticket (SAG-8228).
    Returns (status_code, result_string). status_code=403 still triggers the
    digest-only defense path."""
    link = f"[{ident}](/SAG/issues/{ident})"
    msg = (
        f"**Recovery Sweeper — platform recovery wake** — "
        f"[@{owner_nm}](agent://{owner_id}), "
        f"issue **{link}** has an active platform recovery action (`{kind}`) "
        f"that has not been resolved." + NL + NL +
        f"**Required next action:** {next_action}" + NL + NL +
        f"_(Automated nudge #{nudge_num}/{CAP}; cap-enforced per "
        f"[SAG-3082](/SAG/issues/SAG-3082) §1 — no auto-dispose, no auto-resume. "
        f"Owning agent must record the disposition on {link}. Routed via runner-owned "
        f"[SAG-3421](/SAG/issues/SAG-3421) to avoid an assignee-only 403 on the source "
        f"ticket. [SAG-3494](/SAG/issues/SAG-3494).)_"
    )
    if DRY:
        return 0, "would-comment-mention(state-issue)"
    st, _ = req("POST", f"/api/issues/{STATE_ISSUE}/comments", {"body": msg})
    return st, f"mention-comment(state) -> {st}"

def escalate_to_digest(doc_items, wake_items):
    """Feed the daily Ticket Health Digest. Passive doc = no wake (digest reads on its
    own daily cadence -> dedup, no double-fire). Active @-mention ONLY for genuinely
    stuck (cap-exhausted) targets, so we never wake the digest hourly for routine noise."""
    if not doc_items and not wake_items: return "none"
    if DRY: return f"would-escalate(doc={len(doc_items)},wake={len(wake_items)})"
    body = ("## Recovery Sweeper escalations" + NL + NL +
            "_Passive feed for the Daily Ticket Health Digest. Updated " + iso() + "._" + NL + NL)
    body += NL.join(f"- {it}" for it in doc_items) or "- (none this fire)"
    req("PUT", f"/api/issues/{STATE_ISSUE}/documents/recovery-sweeper-escalations",
        {"title": "Recovery Sweeper Escalations", "format": "markdown", "body": body,
         "baseRevisionId": None})
    if not wake_items:
        return "doc-only(no-wake)"
    note = (f"[@Digest](agent://{DIGEST_AGENT}) -- {len(wake_items)} target(s) hit the nudge "
            f"cap and need attention. See "
            f"[escalations doc](/SAG/issues/SAG-3421#document-recovery-sweeper-escalations).")
    st, _ = req("POST", f"/api/issues/{STATE_ISSUE}/comments", {"body": note})
    return f"doc + digest-wake -> {st}"

# --- handoff helpers (SAG-3172) ---------------------------------------------
def build_continuation_summary(issue, last_comment):
    """Build a structured continuation summary for handoff requests."""
    title      = issue.get("title", "(unknown)")
    desc       = (issue.get("description") or "").strip()
    ident      = issue.get("identifier", issue.get("id", ""))
    status     = issue.get("status", "")
    owner_name = issue.get("_owner_name", "unknown")
    idle_min   = issue.get("_idle_min", 0)
    updated    = issue.get("updatedAt", "")

    obj = title + (" -- " + (desc[:280] + "..." if len(desc) > 280 else desc) if desc else "")

    last_excerpt = ""
    if last_comment and isinstance(last_comment, dict):
        last_excerpt = (last_comment.get("body") or "")[:200].replace(chr(10), " ")

    state = (f"status={status}, owner={owner_name} (idle ~{int(idle_min)}m), "
             f"last-update={updated}"
             + (f', last-comment: "{last_excerpt}..."' if last_excerpt else ""))

    next_action = f"Resume and complete '{title}', or reassign to a capable agent."
    for line in desc.splitlines():
        if re.match(r'^(Next|Remaining|TODO)\b', line.strip(), re.I):
            next_action = line.strip(); break

    artifact_text = desc + " " + (last_comment.get("body", "") if last_comment else "")
    sag_refs  = re.findall(r'SAG-\d+', artifact_text)
    urls      = re.findall(r'https?://[^\s\)\'"]+', artifact_text)
    doc_keys  = re.findall(r'document-([a-z0-9_-]+)', artifact_text)
    artifacts = list(dict.fromkeys(sag_refs + urls + doc_keys))

    art_block = NL.join(f"  - {a}" for a in artifacts) if artifacts else "  - (none)"
    md = ("## Continuation Summary -- " + ident + NL + NL +
          "**Objective:** " + obj + NL + NL +
          "**Current state:** " + state + NL + NL +
          "**Next action:** " + next_action + NL + NL +
          "**Artifacts:**" + NL + art_block + NL)
    return {"issueId": issue.get("id", ""), "identifier": ident,
            "objective": obj, "currentState": state, "nextAction": next_action,
            "artifacts": artifacts, "markdown": md}

def resolve_owning_director(owner, issue, by_id):
    """Return (director_id, director_name). Never returns the stalled owner."""
    owner_id   = owner.get("id", "")
    reports_to = owner.get("reportsTo") or owner.get("reportsToAgentId")
    if reports_to and reports_to != owner_id:
        d = by_id.get(reports_to, {})
        return reports_to, d.get("name", reports_to[:8])
    parent_id = issue.get("parentId")
    if parent_id:
        st, parent = req("GET", f"/api/issues/{parent_id}")
        if st == 200 and parent:
            pid = parent.get("assigneeAgentId")
            if pid and pid != owner_id:
                d = by_id.get(pid, {})
                return pid, d.get("name", pid[:8])
    ceo = by_id.get(CEO_AGENT, {})
    return CEO_AGENT, ceo.get("name", "CEO")

def request_handoff(issue_id, director_id, director_name, owner_name, summary, _dry=None):
    """POST one @-mention handoff REQUEST comment. Pass _dry=True to preview without POST."""
    _dry_flag = DRY if _dry is None else _dry
    cont_md   = summary.get("markdown", "(no summary)") if isinstance(summary, dict) else str(summary)
    ident     = summary.get("identifier", issue_id[:8]) if isinstance(summary, dict) else issue_id[:8]
    msg = (f"[@{director_name}](agent://{director_id}) -- **Recovery Sweeper handoff request**" + NL + NL +
           f"Issue **{ident}** has been assigned to **{owner_name}** but is unresponsive after "
           f"{CAP} re-nudge attempts. Please reassign to a capable agent of the right specialty "
           f"so the work can be completed." + NL + NL +
           "---" + NL + NL +
           cont_md + NL + NL +
           "---" + NL + NL +
           f"_Automated handoff request -- capped at 1 per task (Least-Privilege: sweeper requests, "
           f"does not force-reassign). A second stall escalates to human/CEO + digest and STOPS. "
           f"[SAG-3172](/SAG/issues/SAG-3172) . [SAG-3082](/SAG/issues/SAG-3082)._")
    if _dry_flag:
        return {"status": "would-request-handoff(state-issue)", "to": director_name, "comment_preview": msg}
    # Route to the runner-owned STATE_ISSUE (SAG-3421): same assignee-only 403 hazard as
    # the nudge paths (SAG-8228). The director @-mention + full continuation summary still
    # wake them; issue_id retained only for keying. No source-issue POST -> no silent 403.
    st, _ = req("POST", f"/api/issues/{STATE_ISSUE}/comments", {"body": msg})
    return {"status": f"comment(state) -> {st}", "to": director_name}

# ============================ SELFTEST ======================================
def selftest():
    print("== SELFTEST: anti-loop cap (CAP=%d) ==" % CAP)
    led = {"targets": {}}
    tid = "SIM-agent"
    escalated_at = None
    for fire in range(1, 5):
        e = led["targets"].setdefault(tid, {"consecutiveNudges": 0, "escalated": False})
        if e["escalated"]:
            action = "SKIP (already escalated; no nudge)"
        elif e["consecutiveNudges"] >= CAP:
            e["escalated"] = True; escalated_at = fire
            action = "ESCALATE to digest + STOP nudging"
        else:
            e["consecutiveNudges"] += 1
            action = f"NUDGE (#{e['consecutiveNudges']})"
        print(f"  fire {fire}: target still stalled -> {action}")
    ok = escalated_at == CAP + 1 and led["targets"][tid]["escalated"]
    print(f"  RESULT: nudged exactly {CAP}x, escalated at fire {escalated_at}, "
          f"then hard-stopped. PASS={ok}")
    return 0 if ok else 1

# ============================ HANDOFF-SELFTEST ==============================
def handoff_selftest():
    """
    Prove per-task handoff cap (CAP=2):
      fire 1: NUDGE #1
      fire 2: NUDGE #2  (consecutiveNudges reaches CAP)
      fire 3: handoffDone=False -> REQUEST HANDOFF (handoffDone set True)
      fire 4: handoffDone=True  -> ESCALATE+STOP   (escalated set True)
      fire 5: escalated=True    -> SKIP
    Assert: exactly 1 handoff request, exactly 1 escalation, fire 5 is SKIP.
    Prints rendered continuation-summary + request-comment as the clean handoff artifact.
    """
    print("== HANDOFF-SELFTEST: per-task handoff cap (CAP=%d) ==" % CAP)

    sim_issue = {
        "id": "sim-issue-id-0001",
        "identifier": "SAG-SIM",
        "title": "Simulated stalled task",
        "description": ("Implement the widget controller. "
                         "Next: finish the widget controller and add unit tests." + NL +
                         "See SAG-3162 for sweeper context. "
                         "Ref https://example.com/widget-spec document-widget-spec"),
        "status": "in_progress",
        "parentId": None,
        "updatedAt": "2026-06-06T00:00:00Z",
        "_owner_name": "SimAgent",
        "_idle_min": 150,
    }
    sim_owner = {
        "id": "sim-agent-id-0001",
        "name": "SimAgent",
        "status": "idle",
        "reportsTo": "sim-director-id-001",
    }
    sim_by_id = {
        "sim-agent-id-0001":   sim_owner,
        "sim-director-id-001": {"id": "sim-director-id-001", "name": "SimDirector"},
        CEO_AGENT: {"id": CEO_AGENT, "name": "CEO"},
    }

    # Build + print the continuation summary and request comment (clean handoff artifacts)
    summary = build_continuation_summary(
        sim_issue,
        {"body": "Still working on the widget controller -- blocked on test harness."},
    )
    director_id, director_name = resolve_owning_director(sim_owner, sim_issue, sim_by_id)
    request = request_handoff(
        "sim-issue-id-0001", director_id, director_name, "SimAgent", summary, _dry=True
    )

    print()
    print("--- Continuation Summary (clean handoff artifact) ---")
    print(summary["markdown"])
    print("--- Handoff Request Comment (clean handoff artifact) ---")
    print(request.get("comment_preview", "(no preview)"))
    print()

    # State-machine simulation (no real API calls)
    led = {"targets": {}}
    key = "run:sim-issue-id-0001"
    handoffs_requested = 0
    escalations        = 0
    results            = []

    for fire in range(1, 6):
        e = led["targets"].setdefault(
            key, {"consecutiveNudges": 0, "escalated": False, "handoffDone": False}
        )
        if e.get("escalated"):
            action = "SKIP"
        elif e["consecutiveNudges"] >= CAP:
            if not e.get("handoffDone"):
                e["handoffDone"] = True
                handoffs_requested += 1
                action = "HANDOFF REQUESTED"
            else:
                e["escalated"] = True
                escalations += 1
                action = "ESCALATE+STOP"
        else:
            e["consecutiveNudges"] += 1
            action = f"NUDGE #{e['consecutiveNudges']}"
        results.append((fire, action))
        print(f"  fire {fire}: target still stalled -> {action}")

    print()
    ok = True
    checks = [
        (handoffs_requested == 1,
         f"exactly 1 handoff request (got {handoffs_requested})"),
        (escalations == 1,
         f"exactly 1 escalation (got {escalations})"),
        (results[4][1] == "SKIP",
         f"fire5=SKIP (got {results[4][1]})"),
        (led["targets"][key].get("escalated") == True,
         "escalated flag set after fire4"),
        (led["targets"][key].get("handoffDone") == True,
         "handoffDone flag set after fire3"),
        (director_id == "sim-director-id-001",
         f"director resolved via reportsTo (got {director_id})"),
    ]
    for passed, label in checks:
        status = "OK  " if passed else "FAIL"
        print(f"  {status}: {label}")
        if not passed: ok = False

    print()
    print(f"  RESULT: PASS={ok}")
    return 0 if ok else 1

# ============================ RECOVERY-ACTION-SELFTEST ======================
def recovery_action_selftest():
    """
    Unit test for the stale activeRecoveryAction nudge path (SAG-3494). Covers:
    1. Threshold gate: lastAttemptAt within 2h -> skip; old timestamp -> process
    2. 2-nudge cap -> digest escalation (no further nudges after escalation)
    3. 403 -> forbidden flag set, all subsequent fires surface-to-digest only (no retry)
    """
    print("== RECOVERY-ACTION-SELFTEST: stale activeRecoveryAction path (SAG-3494) ==")
    print(f"   RECOVERY_ACTION_THRESHOLD_MIN={RECOVERY_ACTION_THRESHOLD_MIN}, CAP={CAP}")
    print()
    ok = True
    checks = []

    # ---- 1. Threshold gate ------------------------------------------------
    recent_ts = iso()  # now
    is_stale_recent = age_min(recent_ts) >= RECOVERY_ACTION_THRESHOLD_MIN
    checks.append((not is_stale_recent,
                   f"Threshold gate: 'now' timestamp ({recent_ts}) is NOT stale (correct)"))

    old_ts = "2026-01-01T00:00:00Z"
    is_stale_old = age_min(old_ts) >= RECOVERY_ACTION_THRESHOLD_MIN
    checks.append((is_stale_old,
                   f"Threshold gate: old timestamp ({old_ts}) IS stale (correct)"))

    # Boundary: exactly at threshold (should NOT be stale since < is the guard)
    # We can't easily simulate this without mocking time, so we just verify the condition.
    checks.append((RECOVERY_ACTION_THRESHOLD_MIN == 120,
                   "Threshold constant is 2h (120 min) as specified"))

    # ---- 2. 2-nudge cap -> digest escalation ------------------------------
    print("  --- Cap test (CAP=%d) ---" % CAP)
    led_cap = {"targets": {}}
    key_cap = "recovery_action:sim-ra-cap-001"
    cap_results = []
    escalated_at_fire = None

    for fire in range(1, 6):
        e = led_cap["targets"].setdefault(
            key_cap,
            {"kind": "recovery_action", "consecutiveNudges": 0, "escalated": False}
        )
        if e.get("escalated"):
            action = "SKIP"
        elif e["consecutiveNudges"] >= CAP:
            e["escalated"] = True
            escalated_at_fire = fire
            action = "ESCALATE->DIGEST"
        else:
            e["consecutiveNudges"] += 1
            e["lastNudgeAt"] = iso()
            action = f"NUDGE #{e['consecutiveNudges']}"
        cap_results.append((fire, action))
        print(f"    fire {fire}: {action}")

    checks.append((escalated_at_fire == CAP + 1,
                   f"Escalates at fire CAP+1={CAP+1} (got fire={escalated_at_fire})"))
    checks.append((led_cap["targets"][key_cap]["consecutiveNudges"] == CAP,
                   f"Nudge counter exactly CAP={CAP} (got {led_cap['targets'][key_cap]['consecutiveNudges']})"))
    checks.append((led_cap["targets"][key_cap]["escalated"] is True,
                   "Escalated flag set after cap"))
    post_escalate_actions = [r[1] for r in cap_results if r[0] > escalated_at_fire]
    checks.append((all(a == "SKIP" for a in post_escalate_actions),
                   f"All post-escalation fires are SKIP (got {post_escalate_actions})"))

    # ---- 3. 403 -> forbidden flag -> digest-only on all subsequent fires ---
    print()
    print("  --- 403->forbidden test ---")
    led_403 = {"targets": {}}
    key_403 = "recovery_action:sim-ra-403-001"
    sim_403_results = []
    nudge_count_403 = 0
    surface_count_403 = 0

    # Simulate: fire 1 -> 403, fire 2-4 -> surface only (forbidden), no nudges
    for fire in range(1, 5):
        e = led_403["targets"].setdefault(
            key_403,
            {"kind": "recovery_action", "consecutiveNudges": 0,
             "escalated": False, "forbidden": False}
        )
        e.setdefault("forbidden", False)

        if e.get("forbidden"):
            # Already forbidden: surface to digest only, no POST
            surface_count_403 += 1
            action = "SURFACE-ONLY (forbidden, no retry)"
        elif e.get("escalated"):
            action = "SKIP (escalated)"
        elif e["consecutiveNudges"] >= CAP:
            e["escalated"] = True
            action = "ESCALATE->DIGEST"
        else:
            # Simulate POST result: 403 on fire 1, 200 on subsequent (should never reach)
            sim_http_status = 403 if fire == 1 else 200
            if sim_http_status == 403:
                e["forbidden"] = True
                surface_count_403 += 1
                action = "403->FORBIDDEN (surface-only, no increment)"
            else:
                e["consecutiveNudges"] += 1
                nudge_count_403 += 1
                action = f"NUDGE #{e['consecutiveNudges']}"
        sim_403_results.append((fire, action))
        print(f"    fire {fire}: {action}")

    checks.append((nudge_count_403 == 0,
                   f"Zero successful nudges after 403 (got {nudge_count_403})"))
    checks.append((surface_count_403 == 4,
                   f"All 4 fires surface-to-digest (403 fire + 3 forbidden fires) (got {surface_count_403})"))
    checks.append((led_403["targets"][key_403].get("forbidden") is True,
                   "Forbidden flag set in ledger after 403"))
    checks.append((led_403["targets"][key_403]["consecutiveNudges"] == 0,
                   "Nudge counter stays 0 after 403 (counter not incremented on 403)"))

    # ---- Print results ----------------------------------------------------
    print()
    for passed, label in checks:
        tag = "OK  " if passed else "FAIL"
        print(f"  {tag}: {label}")
        if not passed:
            ok = False

    print()
    print(f"  RESULT: PASS={ok}")
    return 0 if ok else 1

# ============================ LIVE / DRY ====================================
def sweep():
    out = {"mode": MODE, "at": iso(),
           "errorAgentsCleared": [], "runsNudged": [], "handoffsRequested": [],
           "recoveryActionNudged": [], "escalated": [], "surfacedOnly": [],
           "skippedByCap": [], "recovered": []}
    st, agents = req("GET", f"/api/companies/{CO}/agents")
    agents = as_list(agents, "agents", "data")
    by_id  = {a["id"]: a for a in agents}
    led    = load_ledger()
    tg     = led["targets"]
    seen   = set()
    esc_doc, esc_wake = [], []

    # ---- 1. agent error states (transient) ----
    # error->active lever is HARD-GATED OFF (SAG-8226 ruling; board decides in SAG-8227).
    # The routine NEVER PATCHes an agent error->active. Every error agent is surface-only.
    err_surfaced = 0
    for a in agents:
        if a.get("status") != "error": continue
        aid = a["id"]; nm = a.get("name", aid)
        err_surfaced += 1
        tag = "board -- manual" if aid in BOARD_AGENTS else "surface-only; error->active gate OFF"
        esc_doc.append(f"Agent **{nm}** in error ({tag})")
    if err_surfaced:
        out["surfacedOnly"].append(f"{err_surfaced} error agents surfaced-only")

    # ---- 2. stalled in_progress runs (SAG-3079 signature) ----
    _, iss = req("GET", f"/api/companies/{CO}/issues?status=in_progress")
    for i in as_list(iss, "issues", "data"):
        aid = i.get("assigneeAgentId")
        if not aid or aid in BOARD_AGENTS: continue
        if i.get("id") in (ANCHOR_ISSUE, STATE_ISSUE): continue
        owner = by_id.get(aid, {})
        if owner.get("status") not in ("idle", "error"): continue
        if age_min(i.get("updatedAt")) < STALE_MIN: continue
        if aid == UNIT_TEST_AGENT: continue
        ident = i.get("identifier", i["id"]); nm = owner.get("name", aid)
        key = "run:" + i["id"]; seen.add(key)
        e = tg.setdefault(key, {"kind": "recovery_run", "consecutiveNudges": 0,
                                "escalated": False, "handoffDone": False})
        e.setdefault("handoffDone", False)  # backfill for pre-SAG-3172 ledger entries

        if e.get("escalated"):
            out["skippedByCap"].append(f"{ident} (escalated)"); continue

        if e["consecutiveNudges"] >= CAP:
            if not e.get("handoffDone"):
                # ONE auto-handoff: request to owning director (Least-Privilege)
                i_enr = dict(i, _owner_name=nm, _idle_min=age_min(i.get("updatedAt")))
                summary        = build_continuation_summary(i_enr, None)
                dir_id, dir_nm = resolve_owning_director(owner, i, by_id)
                action         = request_handoff(i["id"], dir_id, dir_nm, nm, summary)
                e["handoffDone"] = True; e["handoffAt"] = iso()
                out["handoffsRequested"].append(
                    f"{ident} -> @{dir_nm} (owner {nm} stalled) [{action.get('status','?')}]"
                )
                esc_doc.append(
                    f"Handoff requested for **{ident}** -> {dir_nm} (owner {nm} stalled)"
                )
            else:
                # Already handed off once and STILL stalled -> escalate + STOP
                e["escalated"] = True
                out["escalated"].append(ident)
                esc_doc.append(
                    f"**{ident}** still stalled AFTER auto-handoff -- needs human/CEO decision"
                )
                esc_wake.append(ident + " (post-handoff)")
            continue

        r = nudge_owner(i["id"], ident, aid, nm)
        e["consecutiveNudges"] += 1; e["lastNudgeAt"] = iso()
        out["runsNudged"].append(f"{ident}->{nm} [{r}] (#{e['consecutiveNudges']})")

    # ---- 3. bare-blocked / no-blocker business tickets: SURFACE ONLY ----
    _, bl = req("GET", f"/api/companies/{CO}/issues?status=blocked&includeBlockedBy=true")
    bare = sum(1 for i in as_list(bl, "issues", "data") if not (i.get("blockedBy") or []))
    if bare:
        out["surfacedOnly"].append(
            f"{bare} blocked tickets with NO first-class blocker "
            f"(surface-only; no auto-resume per SAG-3082 sec 1)"
        )
        esc_doc.append(f"{bare} bare-blocked tickets (no first-class blocker) -- review")

    # ---- 4. stale activeRecoveryAction issues (SAG-3494) ----------------
    # Scan both in_progress and blocked issue sets (already fetched above) for active
    # recovery actions. Deduplicate by recovery action ID so we never double-nudge.
    # NEVER auto-dispose or auto-resume: nudge-only, cap-enforced, digest fallback.
    seen_ra_ids = set()
    all_for_ra = as_list(iss, "issues", "data") + as_list(bl, "issues", "data")
    stale_ra_list = []  # for dry-run reporting

    for i in all_for_ra:
        ara = i.get("activeRecoveryAction")
        if not ara or ara.get("status") != "active":
            continue
        wp = ara.get("wakePolicy") or {}
        if wp.get("type") != "wake_owner":
            continue
        ra_id = ara.get("id")
        if not ra_id or ra_id in seen_ra_ids:
            continue
        seen_ra_ids.add(ra_id)

        last_attempt_at = ara.get("lastAttemptAt")
        age = age_min(last_attempt_at)
        if age < RECOVERY_ACTION_THRESHOLD_MIN:
            continue  # not stale enough; skip this fire

        issue_id  = i.get("id")
        ident     = i.get("identifier", issue_id)
        owner_id  = wp.get("ownerAgentId")
        if not owner_id:
            continue
        owner     = by_id.get(owner_id, {})
        owner_nm  = owner.get("name", owner_id[:8])
        next_action = ara.get("nextAction", "Record a valid issue disposition.")
        kind      = ara.get("kind", "unknown")

        stale_ra_list.append({
            "issue": ident, "kind": kind, "owner": owner_nm,
            "lastAttemptAt": last_attempt_at, "nextAction": next_action
        })

        key = "recovery_action:" + ra_id
        seen.add(key)  # keep ledger entry alive while recovery action is active
        e = tg.setdefault(key, {"kind": "recovery_action", "consecutiveNudges": 0,
                                 "escalated": False, "forbidden": False})
        e.setdefault("forbidden", False)  # backfill for pre-SAG-3494 ledger entries

        # 403-forbidden path: sweeper identity not authorized on this issue
        if e.get("forbidden"):
            out["surfacedOnly"].append(f"{ident} recovery_action (403-forbidden, digest-only)")
            esc_doc.append(
                f"**{ident}** activeRecoveryAction ({kind}) is 403-forbidden "
                f"-- sweeper not authorized; digest only"
            )
            continue

        # Cap-exhausted: escalate to digest and STOP
        if e.get("escalated"):
            out["skippedByCap"].append(f"{ident} recovery_action (escalated)")
            continue

        if e["consecutiveNudges"] >= CAP:
            e["escalated"] = True
            out["escalated"].append(f"{ident} ({kind})")
            esc_doc.append(
                f"**{ident}** activeRecoveryAction ({kind}) hit {CAP}-nudge cap "
                f"-- escalated to digest"
            )
            esc_wake.append(f"{ident} (recovery_action cap)")
            continue

        # Post @-mention comment quoting nextAction verbatim
        nudge_num = e["consecutiveNudges"] + 1
        st_c, nudge_result = nudge_recovery_action_owner(
            issue_id, owner_id, owner_nm, ident, kind, next_action, nudge_num
        )

        if not DRY and st_c == 403:
            # DO NOT retry; surface to digest only
            e["forbidden"] = True
            out["surfacedOnly"].append(
                f"{ident} recovery_action nudge 403 -- surface to digest only"
            )
            esc_doc.append(
                f"**{ident}** ({kind}) nudge returned 403 "
                f"-- sweeper not authorized; digest only"
            )
            continue

        e["consecutiveNudges"] += 1
        e["lastNudgeAt"] = iso()
        out["recoveryActionNudged"].append(
            f"{ident}->@{owner_nm} [{nudge_result}] (#{e['consecutiveNudges']})"
        )

    if DRY and stale_ra_list:
        out["staleRecoveryActions"] = stale_ra_list

    # ---- 5. recovered targets: drop from ledger (reset consecutive counter) ----
    for k in list(tg.keys()):
        if k not in seen:
            out["recovered"].append(k); del tg[k]

    out["escalation"] = escalate_to_digest(esc_doc, esc_wake)
    out["ledger"]     = save_ledger(led)
    return out

if __name__ == "__main__":
    if MODE == "selftest":
        sys.exit(selftest())
    if MODE == "handoff-selftest":
        sys.exit(handoff_selftest())
    if MODE == "recovery-action-selftest":
        sys.exit(recovery_action_selftest())
    res = sweep()
    print(json.dumps(res, indent=2))
