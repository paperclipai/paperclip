#!/usr/bin/env python3
"""idle-lane-work-sweep — wake idle lanes that hold dispatchable todo work.

WHY (2026-08-17): dispatch is event-driven only — a todo card creates a run ONLY
at its assignment moment or on a comment/dependency event. If that moment misses
(lane busy, window closed, run clipped by a restart), NOTHING ever re-offers the
card: lanes sat idle for 3+ hours in open windows holding todos (Showrunner-Hermes,
MIDAS-Codex, Quant, Atlas-Codex measured woken NEVER) while the operator watched
an idle fleet above a full queue. This sweep is the missing periodic re-offer:
idle lane + todo card + inside the company window + no wake in 20 min -> invoke.
Bounded: one invoke per lane per pass, max 12 per pass. Runs every 60s (launchd
StartInterval; the cadence was shortened from 10 min on 2026-08-22 to chase todo/
in_review latency -- keep this line in step with the plist).
"""
import json, os, subprocess, sys
from pathlib import Path

# launchd strips PATH — psql lives in homebrew (first scheduled run failed psql-not-found).
os.environ["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + os.environ.get("PATH", "/usr/bin:/bin")

HOME = Path.home()
PSQL = str(HOME / ".claude/psql-ro.sh")
API = str(HOME / ".claude/board-api.sh")

Q = r"""
WITH work AS (
  SELECT a.id, c.issue_prefix || '/' || a.name AS lane,
         -- PRODUCT-FIRST (2026-08-19, operator: the system churns on alerts, not
         -- output): meta/system cards only get a lane's attention when no product
         -- card is dispatchable. Product = everything that is NOT a meta/guard/
         -- courier/rail card.
         (array_agg(i.id ORDER BY
            CASE WHEN i.title ~* '^(recover |unblock:|\[guard|.*guard courier|sprint close|weekly cadence|daily summary|ceo sprint report|mc token-burn|review productivity)' THEN 1 ELSE 0 END,
            i.created_at) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM agent_wakeup_requests wq
           WHERE wq.payload->>'issueId' = i.id::text
             -- 2026-08-22: card rotation 10 -> 4 min and lane cooldown 3 -> 1 min,
             -- sweep cadence 300s -> 60s (operator: "design it to work continuously
             -- or shorten the bursts"). Runs finish in 1-2 min; the per-issue rewake
             -- throttle (90s..6min) still damps genuine no-progress loops.
             AND wq.created_at > now() - interval '4 minutes')
             -- TSMC-21356 (2026-08-23): stop re-offering a card that keeps
             -- reporting it cannot proceed. Measured: 809 blocked codex runs in
             -- 24h across only 138 issues -- 82% of the volume was 50 issues
             -- re-blocking, one of them 32 times. 53.5% of those blockers are
             -- structural (lane capability, human/credential gate), so asking
             -- again cannot change the answer.
             -- Signal is the COUNT of blocked dispositions, NOT their text:
             -- models rephrase the blocker every run (924 distinct texts across
             -- 970 runs), so text-matching identifies nothing.
             -- Escalating 20 min per repeat past the second, capped at 4h. A
             -- `user` comment after the last block cancels the skip outright,
             -- so an operator touch always re-opens the card immediately.
             -- Deliberately narrow: 3+ blocks in 6h. Nothing that is making
             -- progress is ever deferred.
             AND NOT EXISTS (
               SELECT 1 FROM (
                 SELECT count(*) blocks, max(r.created_at) last_block
                 FROM heartbeat_runs r
                 WHERE r.status = 'succeeded'
                   AND r.result_json->'disposition'->>'status' = 'blocked'
                   AND r.created_at > now() - interval '6 hours'
                   AND r.context_snapshot->>'issueId' = i.id::text) bl
               WHERE bl.blocks >= 3
                 AND bl.last_block + least(interval '4 hours',
                       (bl.blocks - 2) * interval '20 minutes') > now()
                 AND NOT EXISTS (
                   SELECT 1 FROM issue_comments cm
                   WHERE cm.issue_id = i.id AND cm.author_type = 'user'
                     AND cm.created_at > bl.last_block))))[1] AS oldest_issue
  FROM agents a
  JOIN companies c ON c.id = a.company_id
  JOIN issues i ON i.assignee_agent_id = a.id AND i.status = 'todo'
    -- skip dependency-blocked cards: waking on them just records a skipped wake
    -- (Quant/Atlas measured 2026-08-17); target the oldest card that can RUN.
    AND NOT EXISTS (
      SELECT 1 FROM issue_relations r JOIN issues b ON b.id = r.issue_id
      WHERE r.type = 'blocks' AND r.related_issue_id = i.id
        AND b.status NOT IN ('done', 'cancelled'))
  WHERE a.status = 'idle'
    AND c.issue_prefix != 'TSBC'  -- operator 2026-08-21: bench dispatch is CONTROLLED, never swept
    -- window check handles wrap-around correctly (2026-08-18 fix): the old
    -- predicate required hour>=start ALWAYS, so TSC 12-2 at 00:30 (hour 0)
    -- was never swept — overnight halves of wrap windows were dead hours.
    AND (c.activity_window IS NULL
         OR CASE
              WHEN (c.activity_window->>'endHour')::int > (c.activity_window->>'startHour')::int
              THEN extract(hour from now())::int >= (c.activity_window->>'startHour')::int
                   AND extract(hour from now())::int < (c.activity_window->>'endHour')::int
              ELSE extract(hour from now())::int >= (c.activity_window->>'startHour')::int
                   OR extract(hour from now())::int < (c.activity_window->>'endHour')::int
            END)
  GROUP BY 1, 2)
SELECT w.id, w.lane, w.oldest_issue FROM work w
WHERE NOT EXISTS (
  SELECT 1 FROM agent_wakeup_requests wr
  WHERE wr.agent_id = w.id AND wr.created_at > now() - interval '1 minute')
LIMIT 32
"""

# STALE IN_REVIEW RE-OFFER (2026-08-18, operator: "the system works for the day
# instead of being handicapped"). in_review is a dispatch black hole: NOTHING
# platform-side re-dispatches it (standing law), so lanes flip a card to
# in_review and the work dies there — measured 11:57 today: ONE run in flight
# fleet-wide while ~27 in-window cards sat in_review. Until the platform-proper
# re-dispatch ships (carded with Astra's depth-cap batch), the sweep re-offers
# the assignee its OLDEST in_review card untouched for 2+ hours: the lane either
# completes the handoff, chases its reviewer, or advances the stage. Runs after
# the todo pass, so a lane woken for todo work this pass is naturally excluded
# by the same 35-minute wake-cooldown check. Bounded: max 6 per pass.
# 2026-08-22: threshold 2h -> 25min. Runs now finish in 1-2 minutes; a 2-hour
# parking lot was the dominant designed latency on in_review (measured: 16/20
# reviews aged 19-51 min with idle lanes). in_review is active work.
Q_REVIEW = """
WITH stale AS (
  SELECT a.id, c.issue_prefix || '/' || a.name AS lane,
         (array_agg(i.id ORDER BY i.updated_at) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM agent_wakeup_requests wq
           WHERE wq.payload->>'issueId' = i.id::text
             AND wq.created_at > now() - interval '10 minutes')
             -- TSMC-21356 (2026-08-23): stop re-offering a card that keeps
             -- reporting it cannot proceed. Measured: 809 blocked codex runs in
             -- 24h across only 138 issues -- 82% of the volume was 50 issues
             -- re-blocking, one of them 32 times. 53.5% of those blockers are
             -- structural (lane capability, human/credential gate), so asking
             -- again cannot change the answer.
             -- Signal is the COUNT of blocked dispositions, NOT their text:
             -- models rephrase the blocker every run (924 distinct texts across
             -- 970 runs), so text-matching identifies nothing.
             -- Escalating 20 min per repeat past the second, capped at 4h. A
             -- `user` comment after the last block cancels the skip outright,
             -- so an operator touch always re-opens the card immediately.
             -- Deliberately narrow: 3+ blocks in 6h. Nothing that is making
             -- progress is ever deferred.
             AND NOT EXISTS (
               SELECT 1 FROM (
                 SELECT count(*) blocks, max(r.created_at) last_block
                 FROM heartbeat_runs r
                 WHERE r.status = 'succeeded'
                   AND r.result_json->'disposition'->>'status' = 'blocked'
                   AND r.created_at > now() - interval '6 hours'
                   AND r.context_snapshot->>'issueId' = i.id::text) bl
               WHERE bl.blocks >= 3
                 AND bl.last_block + least(interval '4 hours',
                       (bl.blocks - 2) * interval '20 minutes') > now()
                 AND NOT EXISTS (
                   SELECT 1 FROM issue_comments cm
                   WHERE cm.issue_id = i.id AND cm.author_type = 'user'
                     AND cm.created_at > bl.last_block))))[1] AS oldest_issue
  FROM agents a
  JOIN companies c ON c.id = a.company_id
  JOIN issues i ON i.assignee_agent_id = a.id AND i.status = 'in_review'
    AND greatest(i.updated_at, coalesce((SELECT max(cm.created_at)
        FROM issue_comments cm WHERE cm.issue_id = i.id), i.updated_at))
        < now() - interval '25 minutes'
  WHERE a.status = 'idle'
    AND c.issue_prefix != 'TSBC'  -- operator 2026-08-21: bench dispatch is CONTROLLED, never swept
    -- window check handles wrap-around correctly (2026-08-18 fix): the old
    -- predicate required hour>=start ALWAYS, so TSC 12-2 at 00:30 (hour 0)
    -- was never swept — overnight halves of wrap windows were dead hours.
    AND (c.activity_window IS NULL
         OR CASE
              WHEN (c.activity_window->>'endHour')::int > (c.activity_window->>'startHour')::int
              THEN extract(hour from now())::int >= (c.activity_window->>'startHour')::int
                   AND extract(hour from now())::int < (c.activity_window->>'endHour')::int
              ELSE extract(hour from now())::int >= (c.activity_window->>'startHour')::int
                   OR extract(hour from now())::int < (c.activity_window->>'endHour')::int
            END)
  GROUP BY 1, 2)
SELECT s.id, s.lane, s.oldest_issue FROM stale s
WHERE NOT EXISTS (
  SELECT 1 FROM agent_wakeup_requests wr
  WHERE wr.agent_id = s.id AND wr.created_at > now() - interval '3 minutes')
LIMIT 6
"""


Q_JUDGE = r"""
-- 2026-08-22 rework: judge pass covers ALL non-operator reviews (assigned included).
-- Sequencing: stale-review nudges the assignee at 25 min; if the card is still
-- in_review at 45 min the producer could not advance it (codex producers cannot
-- write board state, and no producer can verdict its own work) — a judge takes it.
-- assign-then-wake transfers the card to the judge because waking a non-assignee
-- self-cancels via issue_assignee_changed (46/46 measured; platform fix TSMC-21229).
-- Self-review is excluded: the judge never takes a card it produced itself.
-- Operator-facing cards (title STARTS with operator / [GATE] / watch card) are excluded —
-- their reviewer is the operator, not a judge. Mid-title mentions ("Unblock: Board/operator…")
-- stay eligible (TSB-5565 sat 237 min behind the broad match, 2026-08-22).
WITH judge AS (
  SELECT c.id AS company_id, c.issue_prefix, j.judge_id, r.review_id
  FROM companies c
  CROSS JOIN LATERAL (
    SELECT a2.id AS judge_id FROM agents a2 WHERE a2.company_id = c.id
      AND a2.status IN ('idle','running')
      AND a2.adapter_type NOT LIKE '%shell%'
      AND (a2.adapter_type = 'claude_local' OR a2.role IN ('ceo','cto') OR a2.name ILIKE '%auditor%' OR a2.name ILIKE 'GLaD0S%')
    -- 2026-08-22 operator budget directive: claude has weekly headroom and
    -- judge/review is its bench-locked class — prefer claude lanes for verdicts.
    ORDER BY CASE WHEN a2.adapter_type='claude_local' THEN 0 WHEN a2.name ILIKE '%auditor%' THEN 1 WHEN a2.role='cto' THEN 2 ELSE 3 END
    LIMIT 1) j
  CROSS JOIN LATERAL (
    SELECT i.id AS review_id FROM issues i WHERE i.company_id = c.id AND i.status = 'in_review'
      AND i.assignee_agent_id IS DISTINCT FROM j.judge_id
      AND i.title !~* '^\W*operator|\[gate\]|watch card'
      AND greatest(i.updated_at, coalesce((SELECT max(cm.created_at)
          FROM issue_comments cm WHERE cm.issue_id = i.id), i.updated_at))
          < now() - interval '45 minutes'
      AND NOT EXISTS (SELECT 1 FROM agent_wakeup_requests wq
          WHERE wq.payload->>'issueId' = i.id::text
            AND wq.created_at > now() - interval '20 minutes')
    ORDER BY i.updated_at LIMIT 1) r
  WHERE c.issue_prefix != 'TSBC')
SELECT j.judge_id, j.issue_prefix || '/judge', j.review_id FROM judge j
WHERE j.judge_id IS NOT NULL AND j.review_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM agent_wakeup_requests wr
    WHERE wr.agent_id = j.judge_id AND wr.created_at > now() - interval '30 minutes')
LIMIT 4
"""

def wake_rows(rows, label, assign_first=False):
    for row in rows:
        aid, lane, issue_id = row.split("|", 2)
        if not issue_id.strip():
            continue  # every card on this lane is inside the platform rewake throttle
        if assign_first:
            # Waking a non-assignee lane self-cancels: dispatch assigns the card to
            # the woken agent and the run guard then cancels on issue_assignee_changed
            # (measured 46/46 judge wakes over 48h). Assign BEFORE waking so the
            # guard sees no change. Used for judge-close wakes; remove once the
            # platform guard fix (TSMC-21229) lands.
            subprocess.run([API, "PATCH", f"/issues/{issue_id}",
                            json.dumps({"assigneeAgentId": aid})],
                           capture_output=True, text=True)
        # Manual LLM wakes are issue-scoped (manual_wake_scope_required) — target the
        # lane's oldest dispatchable card so the wake lands on real work.
        body = json.dumps({"payload": {"issueId": issue_id}})
        res = subprocess.run([API, "POST", f"/agents/{aid}/heartbeat/invoke", body],
                             capture_output=True, text=True)
        tail = (res.stdout.strip().splitlines() or ["?"])[-1]
        print(f"woke {lane} [{label}] ({tail})")

def query(sql):
    r = subprocess.run([PSQL, "-At", "-F", "|", "-c", sql], capture_output=True, text=True)
    if r.returncode != 0:
        print(f"[psql err] {r.stderr[:150]}")
        return None
    return [l for l in r.stdout.strip().split("\n") if l.strip()]

# Stranded-queue re-offer (dispatch race at run-completion, carded on TSMC 08-20):
# a wakeup created within ~1s of another run finishing is dropped by the
# event-only dispatcher and nothing ever re-offers the queued run. Cancel the
# stranded run and re-invoke the same issue so a fresh dispatch event fires.
Q_STRANDED = r"""
SELECT DISTINCT ON (hr.id) hr.id, w.agent_id, a.name, COALESCE(w.payload->>'issueId','')
FROM heartbeat_runs hr
JOIN agent_wakeup_requests w ON w.run_id = hr.id
JOIN agents a ON a.id = hr.agent_id
JOIN companies c ON c.id = a.company_id
WHERE hr.status = 'queued' AND hr.created_at < now() - interval '5 minutes'
  AND c.issue_prefix != 'TSBC'
ORDER BY hr.id, w.created_at DESC
"""

def reoffer_stranded():
    rows = query(Q_STRANDED)
    if not rows:
        return
    for row in rows:
        parts = row.split("|")
        if len(parts) < 3:
            continue
        run_id, aid, lane = parts[0], parts[1], parts[2]
        issue_id = parts[3] if len(parts) > 3 else ""
        subprocess.run([API, "POST", f"/heartbeat-runs/{run_id}/cancel", "{}"],
                       capture_output=True, text=True)
        if issue_id:
            body = json.dumps({"payload": {"issueId": issue_id}})
            subprocess.run([API, "POST", f"/agents/{aid}/heartbeat/invoke", body],
                           capture_output=True, text=True)
        print(f"re-offered stranded queued run for {lane} (run {run_id[:8]})")

# Duplicate-storm containment (churn scan 2026-08-21): generators without
# idempotency (review-productivity rail, ref-drift couriers before the
# guard-bus fix) mint open cards with identical normalized titles. Cancel all
# but the newest of each cluster every pass so storms self-extinguish
# regardless of which generator misbehaves. Only meta/recovery classes are
# touched — organic titles are never deduped by shape.
Q_DUPES = r"""
SELECT i.id FROM issues i JOIN (
  SELECT regexp_replace(title,'[0-9]+','N','g') AS norm, max(created_at) AS keep_at
  FROM issues WHERE status IN ('todo','in_progress','blocked')
  AND company_id NOT IN (SELECT id FROM companies WHERE issue_prefix = 'TSBC')
  AND title ~* '^(review productivity|\[guard courier\]|recover (stalled|missing)|unblock:)'
  GROUP BY 1 HAVING count(*) > 1
) d ON regexp_replace(i.title,'[0-9]+','N','g') = d.norm AND i.created_at < d.keep_at
WHERE i.status IN ('todo','in_progress','blocked')
LIMIT 15
"""

def cancel_duplicate_storms():
    rows = query(Q_DUPES)
    if not rows:
        return
    for iid in rows:
        iid = iid.strip()
        if not iid:
            continue
        subprocess.run([API, "POST", f"/issues/{iid}/comments",
                        '{"body":"[sweep dedup] Older duplicate of a newer open card with identical normalized scope — cancelled by the duplicate-storm containment pass (2026-08-21). The newest sibling carries the work."}'],
                       capture_output=True, text=True)
        subprocess.run([API, "PATCH", f"/issues/{iid}", '{"status":"cancelled"}'],
                       capture_output=True, text=True)
        print(f"deduped storm duplicate {iid[:8]}")

# Parked-in_progress re-offer (operator-spotted 2026-08-21): a lane claims a
# card (todo->in_progress), its run dies without a disposition, and nothing
# re-offers it — the todo pass above only targets status='todo'. Measured: 24
# of 58 in_progress sat >2h with no live run and no activity. Re-invoke the
# assignee (continuation either resumes the work or forces an honest
# disposition). 45-min threshold; live-run and live-assignee guarded.
Q_PARKED = r"""
WITH ip AS (SELECT i.id, i.assignee_agent_id, i.updated_at FROM issues i
            WHERE i.status='in_progress' AND i.assignee_agent_id IS NOT NULL
              AND i.company_id NOT IN (SELECT id FROM companies WHERE issue_prefix='TSBC')),
live AS (SELECT DISTINCT (hr.context_snapshot->>'issueId') AS iid
         FROM heartbeat_runs hr WHERE hr.status IN ('claimed','running')),
lastact AS (SELECT ip.id, GREATEST(COALESCE((SELECT max(ic.created_at) FROM issue_comments ic
            WHERE ic.issue_id=ip.id), 'epoch'), ip.updated_at) AS last_touch FROM ip)
SELECT ip.id || '|' || ip.assignee_agent_id
FROM ip JOIN lastact la ON la.id=ip.id JOIN agents a ON a.id=ip.assignee_agent_id
WHERE ip.id::text NOT IN (SELECT iid FROM live WHERE iid IS NOT NULL)
  -- 2026-08-22: 45 -> 10 min. In-progress cards sat ~35-45 min between touches; after a
  -- control-plane restart interrupted runs leave no continuation wake, so this re-offer is
  -- the only path back. The per-issue rewake throttle (90s..6min) still damps no-progress loops.
  AND la.last_touch < now() - interval '10 minutes'
  AND a.status IN ('idle','running')
LIMIT 10
"""

def reoffer_parked_in_progress():
    rows = query(Q_PARKED)
    if not rows:
        return
    for row in rows:
        parts = row.split("|")
        if len(parts) < 2:
            continue
        iid, aid = parts[0].strip(), parts[1].strip()
        body = json.dumps({"payload": {"issueId": iid}})
        subprocess.run([API, "POST", f"/agents/{aid}/heartbeat/invoke", body],
                       capture_output=True, text=True)
        print(f"re-offered parked in_progress {iid[:8]}")

# STANDING MODEL-SPREAD REBALANCE (operator order 2026-08-21: "spread across the
# models... divide it out between capable lanes"): a codex lane sitting on 2+
# dispatchable todos while a same-family hermes/claude/gemini sister idles is a
# spread failure. Move ONE card per donor lane per pass (max 5 moves/pass) to
# the least-loaded live sister of the same name-family in the same company.
# Never touches in_progress/mid-run cards; never moves the lane's only card.
Q_SPREAD = r"""
WITH donors AS (
  SELECT i.id AS issue_id, i.identifier, a.id AS donor, a.company_id,
         split_part(a.name,'-',1) AS family,
         row_number() OVER (PARTITION BY a.id ORDER BY i.created_at DESC) AS rn,
         count(*) OVER (PARTITION BY a.id) AS pile
  FROM issues i JOIN agents a ON a.id = i.assignee_agent_id
  WHERE i.status = 'todo' AND a.adapter_type = 'codex_local'
    AND a.company_id NOT IN (SELECT id FROM companies WHERE issue_prefix='TSBC')
    -- 2026-08-22: never move a card that already has a queued/running run —
    -- reassignment cancels it (lock_released_on_reassignment; hit TSMC-21233).
    AND NOT EXISTS (SELECT 1 FROM heartbeat_runs hr
                    WHERE hr.status IN ('queued','running')
                      AND coalesce(hr.context_snapshot->>'issueId',
                                   hr.context_snapshot->'issue'->>'id') = i.id::text)
), sisters AS (
  SELECT a.id, a.name, a.company_id, split_part(a.name,'-',1) AS family,
         (SELECT count(*) FROM issues i2 WHERE i2.assignee_agent_id = a.id
            AND i2.status IN ('todo','in_progress')) AS load,
         CASE a.adapter_type WHEN 'hermes_local' THEN 1 WHEN 'claude_local' THEN 2 ELSE 3 END AS pref
  FROM agents a
  WHERE a.adapter_type IN ('hermes_local','claude_local','antigravity_local')
    AND a.status IN ('idle','running')
    -- 2026-08-22: liveness is ARTIFACTS not status (paused-owner-guard law).
    -- The spread twice placed packs on a token-dead claude lane that read
    -- 'idle' — a target must have a SUCCEEDED run in the last 24h.
    AND EXISTS (SELECT 1 FROM heartbeat_runs hr WHERE hr.agent_id = a.id
                AND hr.status = 'succeeded'
                AND hr.finished_at > now() - interval '24 hours')
    -- 2026-08-23: never spread ONTO an antigravity lane mid session-limit
    -- (0 successes in 20 min) — it can read 'idle'+succeeded-24h but is dead now.
    AND NOT (a.adapter_type='antigravity_local' AND
             (SELECT count(*) FROM heartbeat_runs hr2 WHERE hr2.agent_id=a.id
              AND hr2.status='succeeded' AND hr2.finished_at>now()-interval '20 min')=0
             AND (SELECT count(*) FROM heartbeat_runs hr3 WHERE hr3.agent_id=a.id
              AND hr3.error_code='antigravity_transient_silent_exit'
              AND hr3.created_at>now()-interval '60 min')>=1)
)
SELECT DISTINCT ON (d.donor) d.issue_id || '|' || s.id || '|' || d.identifier || '|' || s.name
FROM donors d JOIN sisters s ON s.company_id = d.company_id AND s.family = d.family
WHERE d.pile >= 2 AND d.rn = 1 AND s.load < 2
ORDER BY d.donor, s.load, s.pref
LIMIT 10
"""

def rebalance_model_spread():
    rows = query(Q_SPREAD)
    if not rows:
        return
    for row in rows:
        parts = row.split("|")
        if len(parts) < 4:
            continue
        iid, aid, ident, sister = parts[0], parts[1], parts[2], parts[3]
        subprocess.run([API, "POST", f"/issues/{iid}/comments",
                        json.dumps({"body": f"[sweep spread] Moved to {sister} — standing model-spread rebalance (codex pile with an idle same-family sister). Scope unchanged; closes need verifiable artifacts."})],
                       capture_output=True, text=True)
        subprocess.run([API, "PATCH", f"/issues/{iid}",
                        json.dumps({"assigneeAgentId": aid})],
                       capture_output=True, text=True)
        subprocess.run([API, "POST", f"/agents/{aid}/heartbeat/invoke",
                        json.dumps({"payload": {"issueId": iid}})],
                       capture_output=True, text=True)
        print(f"spread {ident} -> {sister}")

# NAKED-BLOCK HEALER (2026-08-22 night hardening, operator full-auto order):
# the recovery machinery writes issues into `blocked` WITHOUT relations or an
# unblockDescriptor — a state the public API itself refuses to create ("cannot
# enter blocked without...") and which nothing re-dispatches. Measured 03:00:
# 27 of 64 blocked cards fleet-wide were naked. Flip them back to todo so the
# normal wake paths see them. Exclusions: TSBC (controlled dispatch), cards
# with a live blocker, descriptor, or sanctioned External owner/action prose, cards whose recent comments
# mention the aggregate/input ceiling (those need a fresh-card supersede, not a
# flip — flag them in the log for the board), and cards touched <20 min ago
# (recovery may still be mid-flight). Cap 6/pass so a bad batch is visible
# before it is big.
Q_NAKED_BLOCKED = r"""
SELECT i.id, c.issue_prefix || '-' || i.issue_number,
  EXISTS (SELECT 1 FROM issue_comments ic WHERE ic.issue_id = i.id
          AND ic.created_at > now() - interval '48 hours'
          AND ic.body ~* 'aggregate.{0,12}(input|token).{0,12}ceiling|ceiling reached') AS ceiling_marked,
  EXISTS (SELECT 1 FROM heartbeat_runs hr
          WHERE coalesce(hr.context_snapshot->>'issueId', hr.context_snapshot->'issue'->>'id') = i.id::text
            AND hr.created_at > now() - interval '24 hours'
            AND hr.created_at >= i.updated_at - interval '30 minutes'
            AND hr.result_json->'disposition'->>'status' = 'blocked'
            AND coalesce(hr.result_json->'disposition'->>'blocker','') <> '') AS stated_blocker
FROM issues i JOIN companies c ON c.id = i.company_id
WHERE i.status = 'blocked'
  AND c.issue_prefix != 'TSBC'
  AND i.unblock_descriptor IS NULL
  -- Mirror server/src/services/issue-blocked-gate.ts: prose External owner:/
  -- External action: is a sanctioned no-link wait path, not a naked block.
  AND NOT (
    COALESCE(i.description, '') ~* '(^|[\r\n])[ \t]*external owner[ \t]*:[ \t]*[^ \t\r\n]'
    AND COALESCE(i.description, '') ~* '(^|[\r\n])[ \t]*external action[ \t]*:[ \t]*[^ \t\r\n]'
  )
  AND i.updated_at < now() - interval '20 minutes'
  AND NOT EXISTS (
    SELECT 1 FROM issue_relations r JOIN issues b ON b.id = r.issue_id
    WHERE r.type = 'blocks' AND r.related_issue_id = i.id
      AND b.status NOT IN ('done', 'cancelled'))
ORDER BY i.updated_at
LIMIT 12
"""

def heal_naked_blocks():
    rows = query(Q_NAKED_BLOCKED)
    if not rows:
        return
    flipped = 0
    for row in rows:
        parts = row.split("|")
        if len(parts) < 4:
            continue
        iid, ident, ceiling, stated = parts[0], parts[1], parts[2], parts[3]
        if ceiling == "t":
            print(f"naked-block CEILING-marked {ident} — needs fresh-card supersede (board)")
            continue
        if stated == "t":
            # A recent run stated this block with named text — that is a sanctioned
            # block (server honors it), not a stuck state. Flipping it back to todo
            # just re-runs the lane to re-state the same blocker (measured ping-pong:
            # 10 wasted cycles on one card). Surface it instead of healing it.
            print(f"naked-block SKIPPED {ident} — stated named blocker (sanctioned); needs Unblock card or upstream close (board)")
            continue
        if flipped >= 6:
            break
        subprocess.run([API, "PATCH", f"/issues/{iid}",
                        json.dumps({"status": "todo",
                                    "comment": "[sweep naked-block healer] blocked with no live blocker relation, no unblockDescriptor, or sanctioned external-wait prose — a state the public API refuses to create and nothing re-dispatches. Returned to todo so normal wake paths see it. If this card is genuinely waiting on something, record it as a blockedBy relation or an unblockDescriptor."})],
                       capture_output=True, text=True)
        flipped += 1
        print(f"naked-block healed {ident} -> todo")


Q_STUCK_RUNNING = r"""
SELECT a.id, c.issue_prefix || '/' || a.name
FROM agents a JOIN companies c ON c.id = a.company_id
WHERE a.status = 'running'
  AND a.adapter_type != 'paperclip_shell_handler'
  AND NOT EXISTS (SELECT 1 FROM heartbeat_runs hr WHERE hr.agent_id = a.id AND hr.status IN ('running','queued'))
  AND NOT EXISTS (SELECT 1 FROM heartbeat_runs hr WHERE hr.agent_id = a.id AND hr.created_at > now() - interval '3 minutes')
  AND a.updated_at < now() - interval '3 minutes'
LIMIT 12
"""

def heal_stuck_running_agents():
    # 2026-08-22: after a control-plane hot restart, runs interrupted mid-flight are
    # terminalized (interrupted/orphaned_running_run) but the AGENT row can stay
    # status='running' with no live run. The sweep then skips the lane (idle-only)
    # and dispatch treats it as busy — 5 lanes sat dark after the 21:5x promote.
    # Heal: no live run, nothing started in 3 min, status untouched for 3 min -> idle.
    rows = query(Q_STUCK_RUNNING)
    if not rows:
        return
    for row in rows:
        parts = row.split("|")
        if len(parts) < 2:
            continue
        aid, lane = parts[0], parts[1]
        subprocess.run([API, "PATCH", f"/agents/{aid}", json.dumps({"status": "idle"})],
                       capture_output=True, text=True)
        print(f"stuck-running healed {lane} -> idle (no live run)")


Q_HEAL_ERROR = r"""
-- 2026-08-23 (operator "TSK/Kestrel stuck in error — root cause and fix"):
-- a transient adapter fault (exit-143 SIGTERM mid-run, a hot-restart clip, a
-- silent exit) finalizes the run with a transient error_code but flips the AGENT
-- row to status='error'. The scheduled bounded retry then finds the lane not
-- invokable (agent_not_invokable) and cancels — the lane sits dark until a manual
-- clear-error. Heal a FUNDAMENTALLY HEALTHY lane (succeeded in 24h) whose latest
-- terminal run was a transient class -> idle. A lane erroring for a real
-- config/auth reason has a non-transient error_code and is left alone.
SELECT a.id, c.issue_prefix || '/' || a.name
FROM agents a JOIN companies c ON c.id = a.company_id
WHERE a.status = 'error'
  AND a.adapter_type != 'paperclip_shell_handler'
  AND NOT EXISTS (SELECT 1 FROM heartbeat_runs hr WHERE hr.agent_id = a.id AND hr.status IN ('running','queued'))
  AND a.updated_at < now() - interval '5 minutes'
  AND EXISTS (SELECT 1 FROM heartbeat_runs hr WHERE hr.agent_id = a.id
              AND hr.status='succeeded' AND hr.finished_at > now() - interval '24 hours')
  AND (SELECT hr.error_code FROM heartbeat_runs hr
       WHERE hr.agent_id = a.id AND hr.status IN ('failed','cancelled')
       ORDER BY hr.created_at DESC LIMIT 1)
      IN ('adapter_failed','claude_local_transient_silent_exit','hermes_transient_silent_exit',
          'antigravity_transient_silent_exit','token_budget_exhausted','max_turns_exhausted',
          'orphaned_running_run','interrupted')
LIMIT 12
"""

def heal_error_lanes():
    rows = query(Q_HEAL_ERROR)
    if not rows:
        return
    for row in rows:
        parts = row.split("|")
        if len(parts) < 2:
            continue
        aid, lane = parts[0], parts[1]
        subprocess.run([API, "PATCH", f"/agents/{aid}", json.dumps({"status": "idle"})],
                       capture_output=True, text=True)
        print(f"error-lane healed {lane} -> idle (transient fault, succeeded in 24h)")

# 2026-08-23 ANTIGRAVITY SESSION-LIMIT FAILOVER (operator: "fallover from Gemini
# seems non existent since you didnt know session limits hit — root cause and fix").
# ROOT CAUSE: the Antigravity/Gemini CLI's 5h session limit exits with a bare
# `exit 1` and EMPTY stderr, so detectAntigravityQuotaExhausted (a stderr regex)
# never matches -> the run is classed antigravity_transient_silent_exit, a RETRYABLE
# transient with NO quota cooldown -> the platform re-offers the SAME exhausted lane
# (all exit 1), and the codex-only limit-failover (THIAAAAA-853, env-gated off)
# never applies. Assigned in_progress/todo work just sits stranded on the dead lane.
# The session limit is PROVIDER-WIDE (all gemini lanes share one 5h window), and
# once the platform's retries throttle, the silent-exit BURST fades even though the
# lane is still down — so detect at the provider level: 0 successes in 20 min AND
# >=1 silent-exit in 60 min = session-down. Move PRODUCER work (in_progress/todo)
# to a healthy same-family non-gemini sister. in_review left (judge-owned); cards
# with a live run left (reassignment cancels them, TSMC-21233).
Q_AG_FAILOVER = r"""
WITH down AS (
  SELECT a.id FROM agents a WHERE a.adapter_type='antigravity_local'
    AND (SELECT count(*) FROM heartbeat_runs hr WHERE hr.agent_id=a.id
         AND hr.status='succeeded' AND hr.finished_at>now()-interval '20 min')=0
    AND (SELECT count(*) FROM heartbeat_runs hr WHERE hr.agent_id=a.id
         AND hr.error_code='antigravity_transient_silent_exit' AND hr.created_at>now()-interval '60 min')>=1
), donors AS (
  SELECT i.id AS issue_id, i.identifier, a.company_id, split_part(a.name,'-',1) AS family
  FROM issues i JOIN agents a ON a.id=i.assignee_agent_id
  WHERE a.id IN (SELECT id FROM down) AND i.status IN ('in_progress','todo')
    AND NOT EXISTS (SELECT 1 FROM heartbeat_runs hr WHERE hr.status IN ('queued','running')
                    AND coalesce(hr.context_snapshot->>'issueId',
                                 hr.context_snapshot->'issue'->>'id')=i.id::text)
), sisters AS (
  SELECT a.id, a.name, a.company_id, split_part(a.name,'-',1) AS family,
         (SELECT count(*) FROM issues i2 WHERE i2.assignee_agent_id=a.id
            AND i2.status IN ('todo','in_progress')) AS load,
         CASE a.adapter_type WHEN 'hermes_local' THEN 1 ELSE 2 END AS pref
  FROM agents a WHERE a.adapter_type IN ('hermes_local','claude_local') AND a.status IN ('idle','running')
    AND EXISTS (SELECT 1 FROM heartbeat_runs hr WHERE hr.agent_id=a.id
                AND hr.status='succeeded' AND hr.finished_at > now() - interval '24 hours')
)
SELECT DISTINCT ON (d.issue_id) d.issue_id || '|' || s.id || '|' || d.identifier || '|' || s.name
FROM donors d JOIN sisters s ON s.company_id=d.company_id AND s.family=d.family
WHERE s.load < 3 ORDER BY d.issue_id, s.load, s.pref LIMIT 12
"""

def failover_exhausted_antigravity():
    rows = query(Q_AG_FAILOVER)
    if not rows:
        return
    for row in rows:
        parts = row.split("|")
        if len(parts) < 4:
            continue
        iid, aid, ident, sister = parts[0], parts[1], parts[2], parts[3]
        subprocess.run([API, "POST", f"/issues/{iid}/comments",
                        json.dumps({"body": f"[sweep failover] Moved to {sister} — assigned lane hit the Antigravity 5h session limit (silent exit-1, no quota signal). Scope unchanged; closes need verifiable artifacts."})],
                       capture_output=True, text=True)
        subprocess.run([API, "PATCH", f"/issues/{iid}",
                        json.dumps({"assigneeAgentId": aid})],
                       capture_output=True, text=True)
        subprocess.run([API, "POST", f"/agents/{aid}/heartbeat/invoke",
                        json.dumps({"payload": {"issueId": iid}})],
                       capture_output=True, text=True)
        print(f"ag-failover {ident} -> {sister}")

# EGRESS ROUTER (TSMC-21357, 2026-08-23). Capability-aware routing: the fleet had
# no way to move work to a lane that can actually do it.
#
# Measured: 286 egress-class blocked dispositions on codex in 48h. Codex lanes run
# in the ACP sandbox where DNS fails; hermes lanes run on the host and have egress.
# Holding the credential is NOT the same as reaching the network -- 9 codex lanes
# hold Etsy credentials and still cannot make the call. Gate NET1 told lanes to use
# a net-fetch door that is wired ONLY for remote cursor/opencode targets, so no lane
# in this fleet ever had it; they read the rule, found no door, and blocked anyway.
#
# THREE CLASSES, and only one of them is routable:
#   egress      -> a hermes sister CAN do it            -> route (this function)
#   credential  -> "re-authenticate", "token ceiling"   -> operator only, NEVER route
#   dependency  -> "waiting on card Y"                  -> leave, clears on its own
# Routing a credential gate to hermes just moves the block, so it is excluded
# explicitly -- 9 of 10 hermes "egress-looking" blocks were really credential gates.
#
# Safety mirrors Q_AG_FAILOVER, which is the proven pattern here: sister liveness is
# an ARTIFACT (a succeeded run in 24h), never `status`; load-balanced; cards with a
# live run are skipped because reassignment cancels them (TSMC-21233); and the
# routing comment makes the move idempotent so a card is not passed around.
EGRESS_RE = r"sandbox|egress|dns|cannot reach|no configuration|host-side|host-capable|in-sandbox|network (call|access|request|egress)"
CRED_RE = r"secret custodian|re-?authenticat|token ceiling|oauth|credential|api key|password|login"

Q_EGRESS_ROUTE = r"""
WITH last_block AS (
  SELECT DISTINCT ON (r.context_snapshot->>'issueId')
         (r.context_snapshot->>'issueId')::uuid AS iid,
         r.created_at AS at,
         lower(coalesce(r.result_json->'disposition'->>'blocker','')) AS blocker
  FROM heartbeat_runs r
  WHERE r.status = 'succeeded'
    AND r.result_json->'disposition'->>'status' = 'blocked'
    AND r.created_at > now() - interval '12 hours'
    AND r.context_snapshot->>'issueId' IS NOT NULL
  ORDER BY r.context_snapshot->>'issueId', r.created_at DESC
), donors AS (
  SELECT i.id AS issue_id, i.identifier, i.company_id, i.status
  FROM last_block lb
  JOIN issues i ON i.id = lb.iid
  JOIN agents a ON a.id = i.assignee_agent_id
  JOIN companies c ON c.id = i.company_id
  WHERE a.adapter_type <> 'hermes_local'
    AND i.status IN ('todo','in_progress','blocked')
    AND c.issue_prefix <> 'TSBC'
    AND lb.blocker ~ '__EGRESS__'
    AND lb.blocker !~ '__CRED__'
    AND NOT EXISTS (SELECT 1 FROM heartbeat_runs hr WHERE hr.status IN ('queued','running')
                    AND coalesce(hr.context_snapshot->>'issueId',
                                 hr.context_snapshot->'issue'->>'id') = i.id::text)
    AND NOT EXISTS (SELECT 1 FROM issue_comments cm WHERE cm.issue_id = i.id
                    AND cm.body LIKE '[sweep egress-route]%%'
                    AND cm.created_at > now() - interval '12 hours')
), sisters AS (
  SELECT a.id, a.name, a.company_id,
         (SELECT count(*) FROM issues i2 WHERE i2.assignee_agent_id = a.id
            AND i2.status IN ('todo','in_progress')) AS load
  FROM agents a
  WHERE a.adapter_type = 'hermes_local' AND a.status IN ('idle','running')
    AND EXISTS (SELECT 1 FROM heartbeat_runs hr WHERE hr.agent_id = a.id
                AND hr.status = 'succeeded' AND hr.finished_at > now() - interval '24 hours')
)
SELECT DISTINCT ON (d.issue_id)
       d.issue_id || '|' || s.id || '|' || d.identifier || '|' || s.name || '|' || d.status
FROM donors d JOIN sisters s ON s.company_id = d.company_id
WHERE s.load < 4
ORDER BY d.issue_id, s.load LIMIT 10
""".replace("__EGRESS__", EGRESS_RE).replace("__CRED__", CRED_RE)

# NEVER STRAND: the same donor set with NO eligible sister. These are the cards
# that would silently rot -- egress work in a company whose hermes lanes are all
# paused, overloaded, or have no succeeded run in 24h. Reported every pass so the
# absence is visible instead of looking like "nothing to do".
Q_EGRESS_STRANDED = Q_EGRESS_ROUTE.replace(
  "SELECT DISTINCT ON (d.issue_id)\n       d.issue_id || '|' || s.id || '|' || d.identifier || '|' || s.name || '|' || d.status\nFROM donors d JOIN sisters s ON s.company_id = d.company_id\nWHERE s.load < 4\nORDER BY d.issue_id, s.load LIMIT 10",
  "SELECT d.identifier || '|' || d.status FROM donors d\nWHERE NOT EXISTS (SELECT 1 FROM sisters s WHERE s.company_id = d.company_id AND s.load < 4)\nLIMIT 20")

def route_egress_work():
    rows = query(Q_EGRESS_ROUTE)
    if rows:
        for row in rows:
            parts = row.split("|")
            if len(parts) < 5:
                continue
            iid, aid, ident, sister, status = parts[0], parts[1], parts[2], parts[3], parts[4]
            subprocess.run([API, "POST", f"/issues/{iid}/comments",
                            json.dumps({"body":
                              f"[sweep egress-route] Moved to {sister} (Hermes, host egress). The previous lane "
                              f"reported a blocker that needs external network access, which sandboxed ACP lanes "
                              f"cannot do -- that is a property of the LANE, not of this task. Gate NET1: external "
                              f"work is Hermes work. Scope unchanged; closes still need verifiable artifacts. If "
                              f"the real obstacle is a missing credential rather than reachability, say so plainly "
                              f"and send it to the board -- do not route it onward."})],
                           capture_output=True, text=True)
            patch = {"assigneeAgentId": aid}
            if status == "blocked":
                patch["status"] = "todo"
            subprocess.run([API, "PATCH", f"/issues/{iid}", json.dumps(patch)],
                           capture_output=True, text=True)
            subprocess.run([API, "POST", f"/agents/{aid}/heartbeat/invoke",
                            json.dumps({"payload": {"issueId": iid}})],
                           capture_output=True, text=True)
            print(f"egress-route {ident} -> {sister}{' (blocked->todo)' if status == 'blocked' else ''}")
    stranded = query(Q_EGRESS_STRANDED)
    for row in stranded or []:
        ident = row.split("|")[0]
        print(f"egress-route STRANDED {ident} — needs host egress, no healthy hermes sister with capacity in that company (board)")

# UNASSIGNED-WORK REAPER (TSMC-21358, 2026-08-23). Dispatch is assignee-driven:
# every wake path in this sweep offers a lane its OWN cards (i.assignee_agent_id
# = a.id). A card with NO assignee is therefore offered to NOBODY -- it is not
# blocked, not stale, not failing, just invisible. Nothing in the fleet has ever
# picked one up. Measured 2026-08-23: 5 such cards sitting in open states, the
# oldest 11 hours old.
#
# `wake-stale-todos.sh` was written for the adjacent problem in July and NEVER
# SCHEDULED (no plist references it) -- a detector that reaches nobody, same law
# as Gate NET1's phantom door.
#
# Assign to the least-loaded HEALTHY lane in the company, liveness proven by a
# succeeded run in 24h (artifact, never `status`). Engineer-family lanes are
# preferred for [platform]/[RUNTIME] cards because that is where such work lands.
# Deliberately NOT assigned: BOARD ACTION cards (operator-owned by design --
# auto-assigning one would hide a decision the board is meant to make) and TSBC
# (controlled dispatch). A misassignment is cheap and self-correcting: the lane
# says so, and the egress router moves it if the obstacle is reachability.
Q_UNASSIGNED = r"""
WITH orphans AS (
  SELECT i.id AS issue_id, i.identifier, i.company_id, i.title
  FROM issues i JOIN companies c ON c.id = i.company_id
  WHERE c.status = 'active'
    AND i.status IN ('todo','in_progress','in_review')
    AND i.assignee_agent_id IS NULL AND i.assignee_user_id IS NULL
    AND i.hidden_at IS NULL
    AND c.issue_prefix <> 'TSBC'
    AND i.title !~* '^(BOARD ACTION|OPERATOR |⛔ OPERATOR)'
    AND NOT EXISTS (SELECT 1 FROM issue_relations r JOIN issues b ON b.id = r.issue_id
                    WHERE r.type = 'blocks' AND r.related_issue_id = i.id
                      AND b.status NOT IN ('done','cancelled'))
    AND NOT EXISTS (SELECT 1 FROM issue_comments cm WHERE cm.issue_id = i.id
                    AND cm.body LIKE '[sweep unassigned]%%'
                    AND cm.created_at > now() - interval '6 hours')
), candidates AS (
  SELECT a.id, a.name, a.company_id, a.role, a.adapter_type,
         (SELECT count(*) FROM issues i2 WHERE i2.assignee_agent_id = a.id
            AND i2.status IN ('todo','in_progress')) AS load
  FROM agents a
  WHERE a.status IN ('idle','running')
    AND a.adapter_type <> 'paperclip_shell_handler'
    AND EXISTS (SELECT 1 FROM heartbeat_runs hr WHERE hr.agent_id = a.id
                AND hr.status = 'succeeded' AND hr.finished_at > now() - interval '24 hours')
)
SELECT DISTINCT ON (o.issue_id)
       o.issue_id || '|' || cd.id || '|' || o.identifier || '|' || cd.name
FROM orphans o JOIN candidates cd ON cd.company_id = o.company_id
WHERE cd.load < 5
ORDER BY o.issue_id,
         CASE WHEN o.title ~* '^\[(platform|runtime|guard|cost)' AND cd.role = 'engineer' THEN 0 ELSE 1 END,
         cd.load,
         -- Adapter preference breaks the load tie deterministically. Hermes first
         -- (host egress, so it can finish work the others would hand back), then
         -- codex, then claude. Antigravity LAST: 38% run-failure rate and a
         -- provider-wide quota storm measured 2026-08-23, and its egress is
         -- unproven. An arbitrary tie-break had been sending platform work there.
         CASE cd.adapter_type WHEN 'hermes_local' THEN 0 WHEN 'codex_local' THEN 1
              WHEN 'claude_local' THEN 2 ELSE 3 END,
         cd.name
LIMIT 10
"""

Q_UNASSIGNED_STRANDED = Q_UNASSIGNED.replace(
  """SELECT DISTINCT ON (o.issue_id)
       o.issue_id || '|' || cd.id || '|' || o.identifier || '|' || cd.name
FROM orphans o JOIN candidates cd ON cd.company_id = o.company_id
WHERE cd.load < 5
ORDER BY o.issue_id,
         CASE WHEN o.title ~* '^\\[(platform|runtime|guard|cost)' AND cd.role = 'engineer' THEN 0 ELSE 1 END,
         cd.load
LIMIT 10""",
  """SELECT o.identifier FROM orphans o
WHERE NOT EXISTS (SELECT 1 FROM candidates cd WHERE cd.company_id = o.company_id AND cd.load < 5)
LIMIT 20""")

def adopt_unassigned_work():
    rows = query(Q_UNASSIGNED)
    if rows:
        for row in rows:
            parts = row.split("|")
            if len(parts) < 4:
                continue
            iid, aid, ident, lane = parts[0], parts[1], parts[2], parts[3]
            subprocess.run([API, "POST", f"/issues/{iid}/comments",
                            json.dumps({"body":
                              f"[sweep unassigned] Assigned to {lane}. This card had no assignee, and dispatch is "
                              f"assignee-driven -- every wake path offers a lane only its OWN cards, so an "
                              f"unassigned card is offered to nobody and simply sits. Picked as the least-loaded "
                              f"healthy lane in this company (liveness proven by a succeeded run in 24h). If this "
                              f"is not the right owner, reassign and say why; if it needs external network access, "
                              f"leave it and the egress router will move it to a Hermes sister."})],
                           capture_output=True, text=True)
            subprocess.run([API, "PATCH", f"/issues/{iid}",
                            json.dumps({"assigneeAgentId": aid})],
                           capture_output=True, text=True)
            subprocess.run([API, "POST", f"/agents/{aid}/heartbeat/invoke",
                            json.dumps({"payload": {"issueId": iid}})],
                           capture_output=True, text=True)
            print(f"adopted {ident} -> {lane}")
    for row in query(Q_UNASSIGNED_STRANDED) or []:
        print(f"unassigned STRANDED {row.split('|')[0]} — no healthy lane with capacity in that company (board)")

def main():
    reoffer_stranded()
    heal_stuck_running_agents()
    heal_error_lanes()
    failover_exhausted_antigravity()
    cancel_duplicate_storms()
    reoffer_parked_in_progress()
    heal_naked_blocks()
    rebalance_model_spread()
    route_egress_work()
    adopt_unassigned_work()
    todo_rows = query(Q)
    if todo_rows is None:
        return 2
    wake_rows(todo_rows, "todo")
    review_rows = query(Q_REVIEW)
    if review_rows is None:
        return 2
    wake_rows(review_rows, "stale-review")
    judge_rows = query(Q_JUDGE)
    if judge_rows is not None:
        wake_rows(judge_rows, "judge-close", assign_first=True)
    if not todo_rows and not review_rows:
        print("sweep clean — no idle in-window lane starved of wakes")
    return 0

if __name__ == "__main__":
    sys.exit(main())
