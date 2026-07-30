#!/usr/bin/env python3
"""
paperclip_lane.py — agentic "Paperclip function" lane for the model benchmark (#15).

The CLI lanes (adapters.py) measure BASE-MODEL ANSWER QUALITY in an isolated temp
dir with the harness stripped out — which is why they could not catch the failure
that motivated this lane: grok-*-fast-non-reasoning scores ~0.96 on single-shot
answer tasks, yet inside the real Paperclip harness it may never execute the
multi-step agentic loop (wake -> read -> work -> create child / set blocker /
open a review -> set a disposition). This lane measures THAT.

For each (stage, model) it:
  1. picks the configured DEDICATED bench agent for that model (config.paperclip.agents),
  2. creates a fixture issue assigned to that agent in the bench project, optionally
     pre-seeded into a starting state (`paperclip.setup`: initialStatus / seedComment /
     seedBlockerTitle) so stages can test review/blocked/idempotent starting points,
  3. triggers a fresh-session run (forceFreshSession — no stale session to resume),
  4. polls the run to terminal,
  5. gathers a RICH outcome (final status, comment + content, children created,
     first-class blockers, thread interactions, plan documents, reassignment,
     liveness) and emits it as a JSON `output`, plus a set of boolean facts so the
     EXISTING deterministic json_path_equals scorer grades each stage straight from
     its suite rubric — no new scoring code,
  6. tears the fixture (and any children it spawned) down to `cancelled`.

Env: PAPERCLIP_API_URL + PAPERCLIP_API_KEY (board token).
"""

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request

import benchlib

# Each model maps to ONE shared bench agent, but an agent can only run one
# heartbeat at a time. Without this, two same-model cells running concurrently
# collide — the second sits `queued` (agent busy) or its run is `cancelled`,
# corrupting the score. Serialize per agent: same-agent cells run one at a time,
# different-agent (different-model) cells still run in parallel.
_AGENT_LOCKS = {}
_AGENT_CACHE = {}
_COMPANY_AGENTS_CACHE = {}
_LOCKS_GUARD = threading.Lock()
_AGENT_CACHE_GUARD = threading.Lock()
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _agent_lock(agent_id):
    with _LOCKS_GUARD:
        lock = _AGENT_LOCKS.get(agent_id)
        if lock is None:
            lock = _AGENT_LOCKS[agent_id] = threading.Lock()
        return lock


def _clean_text(value):
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _looks_like_uuid(value):
    text = _clean_text(value)
    return bool(text and _UUID_RE.match(text))


def _identity_key(value):
    text = _clean_text(value)
    if not text:
        return None
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or None


def _wait_agent_idle(agent_id, max_wait=90):
    """Wait until the agent is idle (not mid-heartbeat). A just-finished run
    leaves the agent briefly busy; invoking it then returns a `skipped` wakeup,
    which scores 0 on an infra artifact. Bounded best-effort."""
    deadline = time.time() + max_wait
    while time.time() < deadline:
        a = _opt("GET", f"/api/agents/{agent_id}")
        status = a.get("status") if isinstance(a, dict) else None
        if status in (None, "idle"):
            return
        time.sleep(2)

TERMINAL_RUN_STATUSES = {"succeeded", "failed", "cancelled", "timed_out"}
# A `blocked` disposition is VALID only when backed by a first-class blocker.
CLEAN_TERMINAL_STATUSES = {"done", "cancelled", "in_review"}
OPEN_STATUSES = "todo,in_progress,in_review,blocked,done,cancelled"
POLL_INTERVAL_SEC = 4


def _base():
    base = (os.environ.get("PAPERCLIP_API_URL") or "").rstrip("/")
    if not base:
        raise RuntimeError("PAPERCLIP_API_URL not set")
    return base


def _key():
    key = os.environ.get("PAPERCLIP_API_KEY") or ""
    if not key:
        raise RuntimeError("PAPERCLIP_API_KEY not set")
    return key


TRANSIENT_HTTP = {500, 502, 503, 504}
# 120s (was 45s): a slow reasoning model (grok-4.20 observed at 313-444s/run) keeps
# its per-agent environment lease held while it runs. A 45s socket timeout made the
# next cell's heartbeat/invoke — and in-flight status polls — give up and ABANDON the
# slow run, which then lingered as a lease-holding zombie and cascaded Errno 60
# ("Operation timed out") into every following cell. 120s rides out those windows so
# the slow run polls to a clean terminal status and releases the lease normally.
SOCKET_TIMEOUT_SEC = 120
# 5 attempts w/ 1.5s-step backoff (~15s) tolerates a brief server reload/bounce
# (ECONNREFUSED) on the shared box without failing a cell.
MAX_ATTEMPTS = 5

# --- Shadow disposition instrumentation (gated; OFF unless PAPERCLIP_BENCH_SHADOW_DISPOSITION=1) ---
# Measures the disposition EXECUTION GAP: have the agent STATE its chosen
# disposition as a structured token, then compare {token said X} vs {agent
# actually set Y}. A token naming a valid disposition while the issue is left
# without one = exactly the gap a system-side enforcement hook would close
# (the attach-fix analog). Off by default, so the normal bench is unchanged.
SHADOW_DISPOSITION = os.environ.get("PAPERCLIP_BENCH_SHADOW_DISPOSITION") == "1"
SHADOW_DISPOSITION_INSTRUCTION = (
    "\n\n---\nBENCHMARK INSTRUMENTATION (in addition to your normal status update): "
    "as the FINAL line of your response, state the single disposition you chose for "
    "this issue as JSON, e.g.\n"
    'PAPERCLIP_DISPOSITION: {"status": "done|cancelled|in_review|blocked", "hasBlocker": true|false}'
)
_DISPOSITION_TOKEN_RE = re.compile(r"PAPERCLIP_DISPOSITION:\s*(\{.*?\})")


def _parse_disposition_token(text):
    """Return {'status','hasBlocker'} from the LAST token in the text, or None."""
    if not text:
        return None
    last = None
    for last in _DISPOSITION_TOKEN_RE.finditer(text):
        pass
    if not last:
        return None
    try:
        obj = json.loads(last.group(1))
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    return {"status": obj.get("status"), "hasBlocker": bool(obj.get("hasBlocker"))}


def _req(method, path, body=None, timeout=SOCKET_TIMEOUT_SEC):
    """Resilient request: retries transient timeouts / 5xx with backoff, so a single
    slow response under concurrent agentic load doesn't kill a whole bench cell."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    run_id = os.environ.get("PAPERCLIP_RUN_ID")
    last = None
    for attempt in range(MAX_ATTEMPTS):
        req = urllib.request.Request(_base() + path, method=method, data=data)
        req.add_header("Authorization", "Bearer " + _key())
        if run_id:
            req.add_header("X-Paperclip-Run-Id", run_id)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            if exc.code in TRANSIENT_HTTP and attempt < MAX_ATTEMPTS - 1:
                last = exc
                time.sleep(1.5 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
            if attempt < MAX_ATTEMPTS - 1:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise
    raise last if last else RuntimeError("request failed")


def _opt(method, path, body=None, timeout=SOCKET_TIMEOUT_SEC):
    """_req but returns None on 4xx (endpoint absent / forbidden) instead of raising."""
    try:
        return _req(method, path, body, timeout)
    except urllib.error.HTTPError as exc:
        if 400 <= exc.code < 500:
            return None
        raise


def _parse_agent_ref(value):
    if isinstance(value, str):
        text = _clean_text(value)
        if not text:
            return {}
        return {"agentId": text} if _looks_like_uuid(text) else {"agentName": text}
    if not isinstance(value, dict):
        return {}

    out = {}
    for key in ("agentId", "id", "paperclipAgentId", "benchAgentId", "assigneeAgentId"):
        text = _clean_text(value.get(key))
        if text:
            out["agentId"] = text
            break
    for key in ("agentName", "name", "paperclipAgentName", "benchAgentName"):
        text = _clean_text(value.get(key))
        if text:
            out["agentName"] = text
            break
    return out


def _cache_agent(agent):
    agent_id = _clean_text((agent or {}).get("id"))
    if not agent_id:
        return agent
    with _AGENT_CACHE_GUARD:
        _AGENT_CACHE[agent_id] = agent
    return agent


def _fetch_agent(agent_id):
    with _AGENT_CACHE_GUARD:
        cached = _AGENT_CACHE.get(agent_id)
    if cached is not None:
        return cached
    agent = _opt("GET", f"/api/agents/{agent_id}")
    if isinstance(agent, dict) and agent.get("id"):
        return _cache_agent(agent)
    return None


def _list_company_agents(company_id):
    with _AGENT_CACHE_GUARD:
        cached = _COMPANY_AGENTS_CACHE.get(company_id)
    if cached is not None:
        return cached
    payload = _opt("GET", f"/api/companies/{company_id}/agents") or []
    rows = payload if isinstance(payload, list) else _aslist(payload, "agents")
    rows = [row for row in rows if isinstance(row, dict) and row.get("id")]
    for row in rows:
        _cache_agent(row)
    with _AGENT_CACHE_GUARD:
        _COMPANY_AGENTS_CACHE[company_id] = rows
    return rows


def _resolve_agent_by_name(company_id, agent_name):
    want = _clean_text(agent_name)
    if not want:
        return None, "missing bench agent name"
    want_key = _identity_key(want)
    rows = _list_company_agents(company_id)
    exact = [row for row in rows if _clean_text(row.get("name", "")).lower() == want.lower()]
    if len(exact) == 1:
        return exact[0], None
    keyed = [row for row in rows if _identity_key(row.get("name")) == want_key]
    if len(keyed) == 1:
        return keyed[0], None
    if len(exact) > 1 or len(keyed) > 1:
        return None, f"bench agent name {want!r} is ambiguous"
    return None, f"bench agent name {want!r} not found in company {company_id}"


def _resolve_bench_agent(model, cfg, company_id):
    pc = cfg.get("paperclip", {}) or {}
    model_ref = _parse_agent_ref(model.get("paperclipAgent") or model.get("benchAgent"))
    model_ref.update({
        k: v for k, v in {
            "agentId": _clean_text(
                model.get("paperclipAgentId")
                or model.get("benchAgentId")
                or model.get("assigneeAgentId")
            ),
            "agentName": _clean_text(
                model.get("paperclipAgentName")
                or model.get("benchAgentName")
            ),
        }.items() if v
    })

    ref = model_ref
    source = "model"
    if not ref:
        map_entry = (pc.get("agents") or {}).get(model["id"])
        if map_entry is None and model.get("model_arg"):
            map_entry = (pc.get("agents") or {}).get(model.get("model_arg"))
        ref = _parse_agent_ref(map_entry)
        source = "config.paperclip.agents"

    if not ref:
        return None, (
            "no bench agent configured for row "
            f"{model.get('id')} (set model.paperclipAgentId/paperclipAgentName "
            "or config.paperclip.agents)"
        )

    agent = None
    if ref.get("agentId"):
        agent = _fetch_agent(ref["agentId"])
        if not agent:
            return None, f"bench agent id {ref['agentId']} not found"
        expected_name = ref.get("agentName")
        actual_name = _clean_text(agent.get("name"))
        if expected_name and _identity_key(expected_name) != _identity_key(actual_name):
            return None, (
                f"bench agent id {ref['agentId']} resolved to {actual_name!r}, "
                f"not expected name {expected_name!r}"
            )
    else:
        agent, err = _resolve_agent_by_name(company_id, ref.get("agentName"))
        if err:
            return None, err

    if not isinstance(agent, dict):
        return None, "resolved bench agent payload was not a dict"
    if agent.get("companyId") and agent.get("companyId") != company_id:
        return None, (
            f"bench agent {agent.get('id')} belongs to company {agent.get('companyId')}, "
            f"not bench company {company_id}"
        )
    return {
        "id": agent.get("id"),
        "name": agent.get("name"),
        "adapterType": agent.get("adapterType"),
        "source": source,
    }, None


def _aslist(payload, key="issues"):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        return payload.get(key) or payload.get("items") or []
    return []


def sweep_bench_fixtures(cfg):
    """Cancel any leftover OPEN fixtures in the bench project — orphans a killed
    run couldn't tear down (incl. agent-spawned children + pending board cards).
    Best-effort; returns the count cancelled. Run before a sweep so fixtures and
    board-action notices never accumulate in the live company."""
    pc = cfg.get("paperclip", {}) or {}
    company, project = pc.get("benchCompanyId"), pc.get("benchProjectId")
    if not (company and project):
        return 0
    n = 0
    try:
        xs = _aslist(_opt(
            "GET", f"/api/companies/{company}/issues?projectId={project}&status={OPEN_STATUSES}&limit=200",
        ) or [], "issues")
        for i in xs:
            try:
                _opt("PATCH", f"/api/issues/{i['id']}", {"status": "cancelled", "comment": "[agentic-bench] pre-run sweep"})
                n += 1
            except Exception:
                pass
    except Exception:
        pass
    return n


def run_case(task, model, cfg, timeout):
    pc = cfg.get("paperclip", {}) or {}
    company = pc.get("benchCompanyId")
    project = pc.get("benchProjectId")

    res = benchlib.empty_result()
    res["model"] = model.get("model_arg") or model["id"]
    res["requestedModelId"] = model.get("id")
    res["requestedModelArg"] = model.get("model_arg") or model.get("id")
    if not company:
        res["error"] = "config.paperclip.benchCompanyId not set"
        return res
    agent_ref, agent_err = _resolve_bench_agent(model, cfg, company)
    if agent_err:
        res["error"] = agent_err
        return res
    agent_id = agent_ref["id"]
    res["benchAgentId"] = agent_id
    res["benchAgentName"] = agent_ref.get("name")
    res["benchAdapterType"] = agent_ref.get("adapterType") or model.get("adapter")
    res["benchAgentSource"] = agent_ref.get("source")

    spec = task.get("paperclip", {}) or {}
    setup = spec.get("setup", {}) or {}
    expect = spec.get("expect", {}) or {}
    title = spec.get("title") or task.get("title") or task["id"]
    description = task.get("prompt", "")
    requested_status = setup.get("initialStatus", "todo")
    if SHADOW_DISPOSITION:
        description += SHADOW_DISPOSITION_INSTRUCTION

    t0 = time.time()
    trigger_ts = None
    issue_id = None
    seeded_child_id = None
    try:
        if requested_status == "blocked" and not setup.get("seedBlockerTitle"):
            raise RuntimeError("paperclip.setup.initialStatus=blocked requires seedBlockerTitle")
        body = {
            "title": f"[agentic-bench] {title}",
            "description": description,
            # Creating blocked issues now requires a first-class blocker up front.
            # Seed the blocker first, then patch the fixture back to `blocked`.
            "status": "todo" if requested_status == "blocked" else requested_status,
            "priority": "medium",
            "assigneeAgentId": agent_id,
            # Dedicated bench agents can be registered as fallback sisters under the
            # paused Bench-Manager. Preserve the requested sister here so the fixture
            # executes on the model-specific lane instead of being normalized away.
            "preserveFallbackSisterAssignee": True,
        }
        if project:
            body["projectId"] = project
        issue = _req("POST", f"/api/companies/{company}/issues", body)
        issue_id = issue["id"]

        # Optional pre-seed: a prior board comment + a real first-class blocker, so a
        # stage can start from a blocked/idempotent posture.
        if setup.get("seedComment"):
            _opt("POST", f"/api/issues/{issue_id}/comments", {"body": setup["seedComment"]})
        if setup.get("seedBlockerTitle"):
            child = _opt("POST", f"/api/companies/{company}/issues", {
                "title": f"[agentic-bench] {setup['seedBlockerTitle']}",
                "description": "Seeded blocker fixture.",
                "status": "todo",
                "priority": "medium",
                **({"projectId": project} if project else {}),
            })
            if isinstance(child, dict) and child.get("id"):
                seeded_child_id = child["id"]
                patch = {"blockedByIssueIds": [seeded_child_id]}
                if requested_status == "blocked":
                    patch["status"] = "blocked"
                _opt("PATCH", f"/api/issues/{issue_id}", patch)
        elif requested_status == "blocked":
            raise RuntimeError("blocked fixture setup failed to create the seeded blocker")

        # Exclusive per-agent: only one heartbeat per agent at a time (the agent
        # is single-threaded). Same-model cells serialize here; other models run
        # in parallel. Without this, a concurrent same-agent invoke leaves this
        # run `queued`/`cancelled` and the cell scores 0 on an infra artifact.
        with _agent_lock(agent_id):
            _wait_agent_idle(agent_id)  # don't invoke a still-busy agent
            trigger_ts = time.time()
            run = {}
            for _ in range(4):
                run = _req("POST", f"/api/agents/{agent_id}/heartbeat/invoke", {
                    "forceFreshSession": True,
                    "reason": "agentic_bench",
                    "payload": {"issueId": issue_id, "taskId": issue_id},
                })
                if run.get("id"):
                    break
                # skipped wakeup (agent busy/settling) — wait for idle and retry
                _wait_agent_idle(agent_id, max_wait=20)
            run_id = run.get("id")
            run_status = run.get("status")
            deadline = time.time() + timeout
            while run_id and run_status not in TERMINAL_RUN_STATUSES and time.time() < deadline:
                time.sleep(POLL_INTERVAL_SEC)
                run_status = (_req("GET", f"/api/heartbeat-runs/{run_id}") or {}).get("status")
            # settle before releasing the lock so the next same-agent cell's
            # invoke isn't skipped by a still-finalizing agent
            _wait_agent_idle(agent_id)

        run_final = _req("GET", f"/api/heartbeat-runs/{run_id}") if run_id else {}
        liveness = run_final.get("livenessState")

        iss = _req("GET", f"/api/issues/{issue_id}")
        final_status = iss.get("status")
        blocker_count = len(iss.get("blockedBy") or [])
        # exclude the seeded blocker so we measure blockers the AGENT added
        agent_blocker_count = blocker_count - (1 if seeded_child_id else 0)
        assignee_now = iss.get("assigneeAgentId")
        assignee_changed_away = bool(assignee_now) and assignee_now != agent_id

        # comments the AGENT posted after the run started
        clist = _aslist(_opt("GET", f"/api/issues/{issue_id}/comments") or [], "comments")
        # Only the agent's own comments count (seeded board comments are authored by
        # the board, so a no-churn stage that leaves the issue untouched stays false).
        agent_comments = [c for c in clist if c.get("authorAgentId") == agent_id]
        posted_comment = len(agent_comments) > 0
        want = expect.get("commentContains")
        comment_contains = bool(want) and any(
            str(want).lower() in (c.get("body") or "").lower() for c in agent_comments
        )

        # children the agent created (parentId == fixture), excluding the seeded blocker
        proj_issues = _aslist(_opt(
            "GET",
            f"/api/companies/{company}/issues?projectId={project}&status={OPEN_STATUSES}&limit=200",
        ) or [], "issues") if project else []
        children = [i for i in proj_issues
                    if i.get("parentId") == issue_id and i.get("id") != seeded_child_id]
        child_count = len(children)
        child_assigned_count = sum(1 for c in children if c.get("assigneeAgentId"))

        # thread interactions (request_confirmation / ask_user_questions) the agent opened
        ints = _aslist(_opt("GET", f"/api/issues/{issue_id}/interactions") or [], "interactions")
        int_kinds = sorted({i.get("kind") for i in ints if i.get("kind")})
        has_confirmation = "request_confirmation" in int_kinds
        has_questions = "ask_user_questions" in int_kinds

        # plan / issue documents
        docs = _aslist(_opt("GET", f"/api/issues/{issue_id}/documents") or [], "documents")
        doc_keys = sorted({d.get("key") for d in docs if d.get("key")})
        has_plan_doc = "plan" in doc_keys

        # board approvals linked to the issue
        appr = _aslist(_opt("GET", f"/api/issues/{issue_id}/approvals") or [], "approvals")
        approval_count = len(appr)

        disposition_set = final_status not in (None, "todo", "backlog", "in_progress")
        valid_disposition = (
            final_status in CLEAN_TERMINAL_STATUSES
            or (final_status == "blocked" and blocker_count > 0)
        )
        concrete_action = bool(liveness) and liveness != "needs_followup"

        outcome = {
            "finalStatus": final_status,
            "runStatus": run_status,
            "livenessState": liveness,
            "dispositionSet": disposition_set,
            "validDisposition": valid_disposition,
            "concreteAction": concrete_action,
            "postedComment": posted_comment,
            "commentContains": comment_contains,
            "hasChild": child_count > 0,
            "hasAssignedChild": child_assigned_count > 0,
            "hasTwoPlusChildren": child_count >= 2,
            "childCount": child_count,
            "routedToOwner": assignee_changed_away or child_assigned_count > 0,
            "hasBlocker": agent_blocker_count > 0,
            "blockerCount": blocker_count,
            "hasConfirmationInteraction": has_confirmation,
            "hasQuestionsInteraction": has_questions,
            "hasPlanDocument": has_plan_doc,
            "hasApproval": approval_count > 0,
            "assigneeChangedAway": assignee_changed_away,
        }
        if SHADOW_DISPOSITION:
            token = _parse_disposition_token((run_final.get("resultJson") or {}).get("result") or "")
            outcome["dispositionTokenPresent"] = token is not None
            outcome["dispositionToken"] = token
        res["ok"] = True
        res["output"] = json.dumps(outcome)

        usage = run_final.get("usageJson") or {}
        res["inputTokens"] = usage.get("inputTokens")
        res["outputTokens"] = usage.get("outputTokens")
        total = usage.get("totalTokens")
        if total is None and (usage.get("inputTokens") or usage.get("outputTokens")):
            total = (usage.get("inputTokens") or 0) + (usage.get("outputTokens") or 0)
        res["totalTokens"] = total
        if total is None:
            res["tokensEstimated"] = True
    except urllib.error.HTTPError as exc:
        res["error"] = f"HTTP {exc.code}: {exc.read().decode('utf-8','replace')[:200]}"
    except Exception as exc:
        res["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        res["wallMs"] = int((time.time() - t0) * 1000)
        # teardown: cancel the fixture, the seeded blocker, and any spawned children.
        # MUST be bulletproof — a transient server blip here must never escape the
        # finally and mask an otherwise-captured result (the earlier "harness
        # exception" bug). Best-effort only; leftover fixtures are swept separately.
        def _cancel(iid):
            try:
                _opt("PATCH", f"/api/issues/{iid}", {"status": "cancelled", "comment": "[agentic-bench] teardown"})
            except Exception:
                pass
        try:
            for iid in [issue_id, seeded_child_id]:
                if iid:
                    _cancel(iid)
            if issue_id and project:
                proj = _aslist(_opt(
                    "GET",
                    f"/api/companies/{company}/issues?projectId={project}&status={OPEN_STATUSES}&limit=200",
                ) or [], "issues")
                for i in proj:
                    if i.get("parentId") == issue_id and i.get("status") not in ("cancelled", "done"):
                        _cancel(i["id"])
        except Exception:
            pass
    return res
