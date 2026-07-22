#!/usr/bin/env python3
# Provision the full CK AI-company org as REAL native Paperclip process-agents (no legacy).
# Idempotent: skips agents that already exist (by name). Each agent: process adapter -> the CK runner,
# its own scoped API key injected as CK_PAPERCLIP_KEY, charter in CK_AGENT_CHARTER, heartbeat OFF
# (no spend until tasked/woken). Org chart wired via reportsTo in a second pass.
import json, urllib.request, urllib.error
BASE = "http://127.0.0.1:3100/api"
CID = "e651858f-b11b-4b43-aa43-20c1192d7e98"  # CK IT Solutions

def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        headers={"Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]

# (ck_id, name, charter) — charters are the catalog one-liners (verb+noun+success test, abridged).
ROSTER = [
 # GOV — Governance / Evaluation Office
 ("GOV-25","Chief-of-Staff","Single coordinator of the workforce; own the AoR chart; absorb-don't-escalate so only true CEO decisions reach Alan. No orphaned AoR."),
 ("GOV-11","Department-Evaluator","Synthesize each unit's verdict + narrative from its metrics vs ground truth. Auditable against evidence."),
 ("GOV-01","Spec-Registrar","Keep the Agent Spec registry; reject incomplete specs. Every active spec is schema-valid."),
 ("GOV-02","Metric-Collector","Ingest output events into metrics. Each output produces a metric row."),
 ("GOV-03","Scorecard-Keeper","Compute scorecards on schedule. Numbers reconcile to events."),
 ("GOV-04","Dashboard-Renderer","Render scorecards to a report. No missing fields."),
 ("GOV-05","Threshold-Alerter","Fire only when a metric crosses a bound. No false fires."),
 ("GOV-06","Golden-Set-Curator","Maintain the known-correct golden cases per unit. >=N reviewed cases each."),
 ("GOV-07","Regression-Runner","Run units against their golden set. Deterministic pass/fail grade."),
 ("GOV-08","Rubric-Judge","Score judgment-only output against a rubric. Within tolerance of human spot-check."),
 ("GOV-09","Spot-Check-Sampler","Sample judge verdicts for human review. Representative sample."),
 ("GOV-10","Calibration-Checker","Track judge-vs-human agreement; flag drift."),
 ("GOV-12","Meta-Evaluator","Re-judge a sample of the evaluators themselves; catch mis-grades and drift."),
 ("GOV-13","Consequence-Router","Map a verdict to the consequence ladder (keep/tune/quarantine/retire). Matches the rule table; retire stays human-gated."),
 ("GOV-14","AB-Harness","Run candidate vs incumbent on the golden set. Reproducible winner."),
 ("GOV-15","Auto-Tuner","Propose a revised prompt/skill; adopt only if it wins the A/B."),
 ("GOV-16","Retire-Proposer","Compile a dossier and propose retiring a unit. Human-gated; never executes."),
 ("GOV-17","Change-Logger","Append every action to the immutable audit log. Append-only, nothing lost."),
 ("GOV-18","Policy-Author","Turn a decision into a versioned SOP. Unambiguous; cites the decision."),
 ("GOV-19","Policy-Linter","Check work against machine-checkable rules. Flags only when violated."),
 ("GOV-20","OKR-Architect","Turn a goal into objectives + KRs per role. Each KR has a metric, owner, deadline."),
 ("GOV-21","OKR-Tracker","Compute OKR progress. Reconciles to source metrics."),
 ("GOV-22","Cadence-Scheduler","Trigger the daily/weekly/monthly cycles. Each fires on time."),
 ("GOV-23","Digest-Composer","Assemble the review digests. Complete and accurate."),
 ("GOV-24","Issues-Manager","Run IDS (Identify-Discuss-Solve) to closure in meetings. Every issue ends with state, owner, next-step."),
 # KS — Knowledge & Safety
 ("KS-01","Memory-Schema-Enforcer","Enforce the memory-record schema. Invalid rows rejected."),
 ("KS-02","Expiry-Sweeper","Expire records past their TTL. None active past ttl."),
 ("KS-03","Dedup-Proposer","Propose near-duplicate memory merges (tagged). Vs the labeled dup set."),
 ("KS-04","Contradiction-Detector","Flag conflicting records for the same entity. Vs known conflicts."),
 ("KS-05","Quarantine-Router","Move suspect records to quarantine with a reason. Never hard-delete."),
 ("KS-06","Rescue-Handler","Restore quarantined records (human-confirmed for crown jewels). Restorable."),
 ("KS-07","Pre-compaction-Persister","Persist what matters before context loss. Trigger fires and writes."),
 ("KS-08","Disclosure-Scanner","Scan outward artifacts against the forbidden-pattern list. Flags only when matched."),
 ("KS-09","Disclosure-Semantic-Reviewer","Catch non-literal disclosure risk a regex can't. Vs the labeled risky set."),
 ("KS-10","Reference-Verifier","Re-check every cited URL/claim resolves. Dead refs dropped."),
 # REV — Revenue / GTM (the cigar money engine)
 ("REV-01","Signal-Scanner","Surface why-now B2B placement opportunities among Swiss cigar venues. Relevance vs labeled + the source exists."),
 ("REV-02","Source-Verifier","Verify each lead source/venue resolves. Drops hallucinated venues."),
 ("REV-03","Lead-Qualifier","Score venue fit vs the ICP (cigar lounges/hotels/restaurants). Vs labeled leads."),
 ("REV-04","Account-Researcher","Compile a target-venue dossier (size, channel, who decides). Required fields present and sourced."),
 ("REV-05","Contact-Finder","Find and validate a venue's contact details. Format/deliverability check."),
 ("REV-06","Outreach-Drafter","Draft personalized B2B first-contact to a cigar venue to place Tres Hermanos. Passes Disclosure-Guard; Alan approves the send."),
 ("REV-07","Reply-Classifier","Classify a venue's reply (interested/no/unclear). Vs labeled set."),
 ("REV-08","Meeting-Booker","Schedule from a confirmed positive reply. Calendar event created."),
 ("REV-09","CRM-Updater","Write pipeline state to EspoCRM. Schema-valid row that reconciles."),
 ("REV-10","Pipeline-Forecaster","Compute the commission forecast and follow-up dates. Reconciles to the CRM."),
 ("REV-11","Follow-up-Nudger","Surface overdue venue follow-ups. Matches due/overdue dates."),
 ("REV-12","Proposal-Drafter","Draft a placement proposal/quote for an interested venue. Template-complete; Alan approves."),
 ("REV-13","Pricing-Calculator","Compute the quote numbers (>= treshermanos.ch). Formula."),
 # MKT — Marketing
 ("MKT-01","Topic-Researcher","Find content topics/keywords for the cigar GTM. Keyword data exists."),
 ("MKT-02","Content-Drafter","Draft posts/case studies. Brief-complete; passes human + Disclosure-Guard."),
 ("MKT-03","Fact-Checker","Verify every stat/claim in a draft resolves to a source. Counters the hallucination failure mode."),
 ("MKT-04","Brand-Voice-Linter","Check a draft against the voice spec. Vs rubric; catches voice drift."),
 ("MKT-05","SEO-Optimizer","Run on-page SEO checks. Deterministic checklist."),
 ("MKT-06","Publishing-Gate","Final pre-publish gate (Disclosure + human). Decision logged."),
 ("MKT-07","Distribution-Scheduler","Schedule/post approved content. Posted."),
 ("MKT-08","Analytics-Collector","Pull traffic/engagement data. Data ingested."),
 ("MKT-09","Performance-Reporter","Report content performance. Reconciles to analytics."),
 # CS — Customer Success
 ("CS-01","Ticket-Classifier","Triage inbound support. Vs labeled set."),
 ("CS-02","KB-Answer-Drafter","Draft an answer from the knowledge base. Cites KB; gate before send."),
 ("CS-03","Escalation-Router","Route to human/Alan by rules. Rule match."),
 ("CS-04","Check-in-Scheduler","Schedule account check-ins. Scheduled."),
 ("CS-05","Renewal-Upsell-Signal","Flag renewal/upsell signals for venues. Vs criteria."),
 ("CS-06","Relationship-Memory","Maintain account memory (Curator-governed). Schema + provenance."),
 ("CS-07","CSAT-Collector","Gather satisfaction data. Data ingested."),
 # FIN — Finance (money movements human-only)
 ("FIN-01","Transaction-Ingestor","Import bank/Stripe transactions. Count reconciles."),
 ("FIN-02","Categorizer","Categorize transactions. Vs labeled rules."),
 ("FIN-03","Reconciler","Reconcile ledger vs bank export. Numbers match."),
 ("FIN-04","Invoice-Drafter","Draft invoices. Template-complete; a human sends."),
 ("FIN-05","AR-Chaser","Flag/draft overdue-invoice reminders. Send is human-gated."),
 ("FIN-06","Runway-Calculator","Compute runway/burn. Formula."),
 ("FIN-07","Cashflow-Forecaster","13-week cash flow. Formula reconciles."),
 ("FIN-08","VAT-Prep","Prep Swiss VAT/MwSt figures. Formula; filing via accountant."),
 ("FIN-09","Spend-Watcher","Monitor compute/API spend vs budget. Vs budget."),
 ("FIN-10","Financial-Reporter","Monthly P&L/dashboard. Reconciles to ledger."),
 # LEG — Legal (binding work -> human lawyer)
 ("LEG-01","Contract-Intake","Log/track incoming agreements. Tracked."),
 ("LEG-02","Clause-Reviewer","Flag risky clauses (advisory). Vs checklist; lawyer decides."),
 ("LEG-03","NDA-Generator","Generate NDA/invention-assignment from templates. Template-complete; human/lawyer."),
 ("LEG-04","Patent-Timeline-Tracker","Track patent filing milestones/deadlines. The priority-filing gate."),
 ("LEG-05","Prior-Art-Monitor","Watch relevant public disclosures using ONLY abstract terms (never invention specifics). Results logged; human review."),
 ("LEG-06","Compliance-Checklist-Runner","Run regulatory/registration checklists. Checklist."),
 # SEC — Security / Reliability
 ("SEC-01","Uptime-Monitor","Check website + services are up. HTTP 200."),
 ("SEC-02","IP-Firewall-Verifier","Prove the invention is unreachable from the workforce box. Absent/denied."),
 ("SEC-03","Backup-Runner","Run and verify backups. Backup exists + test-restore passes."),
 ("SEC-04","Secret-Hygiene-Auditor","Check secret scope/perms/rotation. Rules."),
 ("SEC-05","Budget-Circuit-Breaker","Enforce/verify per-agent spend caps. Caps hold."),
 ("SEC-06","Dependency-Watcher","Watch Paperclip/upstream advisories + pin drift. Advisory feed."),
 ("SEC-07","Audit-Log-Integrity","Verify append-only logs untampered. Hash chain intact."),
 ("SEC-08","Incident-Escalator","Alert Alan on anomalies. Rule."),
 # ENG — Engineering / internal tooling (NOT the invention)
 ("ENG-01","Repo-Committer","Single-committer gate for agent-produced artifacts. Clean commit, no lock."),
 ("ENG-02","Doc-Maintainer","Keep project docs/handoff-log current. Structure valid."),
 ("ENG-03","Skill-Scaffolder","Scaffold a new unit from its Agent Spec. Scaffold matches spec."),
 ("ENG-04","Test-Runner","Run the workforce's own test/golden suites. Pass/fail."),
 ("ENG-05","Deploy-Gate","Gate deploys; outward deploys also check the patent gate. Checklist."),
 # FDR — Founder Ops (buy back Alan's time)
 ("FDR-01","Inbox-Triage","Turn email/Telegram into next-actions, one owner each. Vs labeled triage."),
 ("FDR-02","Calendar-Manager","Schedule and protect deep-work blocks. Calendar."),
 ("FDR-03","Founder-Brief-Composer","Compose the 2-minute daily founder brief. Complete and accurate."),
 ("FDR-04","Decision-Queue-Manager","Collect human-gated decisions and route replies back. Each decision tracked."),
 ("FDR-05","Top-Goal-Guard","Protect Alan's #1-priority time. Intrusion rule."),
]

ROLE = {"SEC": "security", "ENG": "engineer"}  # rest -> general; title carries the real role

# Capability allowlists are part of the role definition, not a live-server afterthought.
# REV-06 owns the post-approval execution step, so it must be able to atomically consume
# an accepted decision and send exactly once.  Without this tool the UI can say
# "approved" forever while the assigned agent is structurally unable to finish.
ROLE_TOOLS = {
    "GOV-25": (
        "espo_pipeline,espo_rank_prospects,create_task,list_recent_work,list_open_tasks,"
        "request_decision,espo_list_emailless,espo_read_emails,espo_create_meeting,"
        "espo_get_account,schedule_followup,espo_log_call,espo_create_crm_task,"
        "record_finance_event,plan_visit_route,recall,remember,crm_backfill_city,"
        "espo_create_account,espo_create_contact"
    ),
    "REV-06": (
        "espo_get_account,espo_add_note,review_draft,espo_read_emails,"
        "queue_email_for_approval,complete_approved_send,recall,remember"
    ),
}

def reports_to(ck):
    if ck == "GOV-25": return None          # top agent (reports to Alan, a board user)
    if ck == "GOV-11": return "GOV-25"
    if ck.startswith("GOV") or ck.startswith("KS"): return "GOV-25"
    return "GOV-11"                          # line departments funnel through the Department-Evaluator

def charter_env(ck, name, charter):
    env = {"CK_AGENT_NAME": f"{ck} {name}", "CK_AGENT_ID": ck, "CK_AGENT_MODE": "draft+approve",
           "CK_API_URL": "http://127.0.0.1:3100", "CK_AGENT_CHARTER": charter}
    if ck in ROLE_TOOLS:
        env["CK_TOOLS"] = ROLE_TOOLS[ck]
    return env

# existing agents (skip-if-present, and capture name->id for reportsTo wiring)
s, existing = call("GET", f"/companies/{CID}/agents")
by_name = {a["name"]: a for a in existing} if isinstance(existing, list) else {}
ckid_to_id = {}
created = skipped = failed = 0

for ck, name, charter in ROSTER:
    full = f"{ck} {name}"
    dept = ck.split("-")[0]
    if full in by_name and by_name[full].get("adapterType") == "process":
        ckid_to_id[ck] = by_name[full]["id"]; skipped += 1; continue
    env = charter_env(ck, name, charter)
    body = {"name": full, "role": ROLE.get(dept, "general"), "title": f"{dept} · {name.replace('-', ' ')}",
            "capabilities": charter, "adapterType": "process",
            "adapterConfig": {"command": "node", "args": ["/work/.ck-agent/runner.mjs"], "cwd": "/work",
                              "timeoutSec": 150, "env": env},
            "runtimeConfig": {"heartbeat": {"enabled": False}},
            "budgetMonthlyCents": 300,
            "metadata": {"ck_id": ck, "ck_dept": dept}}
    s, a = call("POST", f"/companies/{CID}/agents", body)
    if s in (200, 201) and isinstance(a, dict):
        aid = a["id"]; ckid_to_id[ck] = aid
        # scoped key -> inject as CK_PAPERCLIP_KEY (PATCH keeps the rest of env)
        sk, k = call("POST", f"/agents/{aid}/keys", {"name": "runner"})
        if isinstance(k, dict) and k.get("token"):
            env2 = dict(env); env2["CK_PAPERCLIP_KEY"] = k["token"]
            cfg = body["adapterConfig"]; cfg["env"] = env2
            call("PATCH", f"/agents/{aid}", {"adapterConfig": cfg})
        created += 1
    else:
        failed += 1; print(f"  FAIL {full}: {s} {a}")

# second pass: wire reportsTo
wired = 0
for ck, name, charter in ROSTER:
    aid = ckid_to_id.get(ck);
    if not aid: continue
    rt_ck = reports_to(ck); rt_id = ckid_to_id.get(rt_ck) if rt_ck else None
    s, _ = call("PATCH", f"/agents/{aid}", {"reportsTo": rt_id})
    if s == 200: wired += 1

print(f"\nDONE: created={created} skipped={skipped} failed={failed} reportsTo-wired={wired} total_roster={len(ROSTER)}")
