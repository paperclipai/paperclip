---
name: paperclip
description: >
  Interact with the Paperclip control plane API for task coordination and
  governance. Use when checking assignments, updating issue status, posting
  comments, delegating work, managing routines, or calling Paperclip API
  endpoints.
---

# Paperclip Skill

You run in **heartbeats** — short execution windows triggered by Paperclip. Each heartbeat, you wake up, check your work, do something useful, and exit. You do not run continuously.

## Execution Contract (read this first)

There is no dedicated Paperclip tool in your harness. Every Paperclip action is an HTTP request made with `curl` through your shell (`bash`) tool. These rules override any other habit:

1. **Execute, never narrate.** Writing a curl command in your reply text does nothing. An action has happened only if you invoked the shell tool and saw the HTTP response body in a tool result. Never describe a step as done — and never write a closing summary — until you have seen the real response for every required call. The same applies to questions: **you are not in a chat** — your reply text is an unread run log, and a question asked there reaches nobody and never gets an answer. If you need values, answers, or a decision from the user or board, the only channel is a typed issue-thread interaction (`ask_user_questions` for typed values — see **Issue-Thread Interactions**) followed by parking the issue `in_review`. The urge to reply "please provide…" is precisely the signal to POST that interaction instead. Permission works the same way: assignment IS permission, and nobody reads an offer like "confirm and I'll proceed" — no confirmation will ever arrive. When your reply is about to end with an offer to do the work (proceed?, shall I…?, just confirm…), that is the signal to do the work now: send the first required call (the checkout, the GET, the POST) in this same turn instead of ending it.
2. **One API request per shell call — with its body in the same call.** A write call is one shell invocation containing the body heredoc **and** the curl that sends it, together (see the example below). Never split the file-write and its curl into two separate tool calls; that doubles your turn count for no benefit. Independent read-only GETs may be combined into a single shell call. Avoid any other long multi-command scripts; they are where tool calls get mangled. Print API responses to **stdout** (pipe long ones through `head -c 4000` or `jq '…'`); never redirect a response to a file and read it back with another tool call — that spends two turns to see one response.
3. **JSON bodies go through a file, never inline.** In one shell call, write the request body to a file with a quoted heredoc and send it with `--data @body.json`:

   ```bash
   cat > /tmp/body.json <<'JSON'
   { "body": "Plan is ready for review — see the plan document." }
   JSON
   curl -s -X POST "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID/comments" \
     -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
     -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
     -H "Content-Type: application/json" --data @/tmp/body.json
   ```

   Never embed multiline JSON in `-d '...'` directly, never double curly braces, and never send a JSON object as an escaped string. Everything between `<<'JSON'` and `JSON` is **literal**: `$VARS` and `$(...)` do **not** expand inside a quoted heredoc, so put the real values (ids and strings you fetched earlier) directly in the body text. Mechanical pre-send check: after writing `body.json` and before the `curl` that sends it (same shell call), run `grep -n '\$' body.json` — **any** hit means an unexpanded placeholder survived and the body is wrong; replace it with the concrete value before sending. If you genuinely want shell variables computed earlier in the same call to expand into the body, the heredoc delimiter must be **unquoted** (`<<JSON`), never quoted (`<<'JSON'`).

   Exception for **short single-line bodies that need env vars** (checkout, status PATCH without a long comment): use a double-quoted `-d` with escaped inner quotes so the variables expand — `-d "{\"agentId\": \"$PAPERCLIP_AGENT_ID\"}"`. Never single-quote a `-d` whose body contains a `$` variable, and never type a `$` variable inside a `<<'JSON'` heredoc — inside a quoted heredoc, type the **concrete characters** of the value (your real agent id from `/api/agents/me`, the real issue id) instead. Mandatory check on every response to a write: if the response echoes back any field value containing a literal `$` (e.g. `"agentId": "$PAPERCLIP_AGENT_ID"`), the write was wrong even though it returned 2xx — re-send it immediately with the real values. Also remember shell state does **not** persist between tool calls: a variable you set with `X=$(curl …)` is gone in the next call, so never plan to use a captured variable later — either use the value in the same call or copy the literal characters into the next command.
4. **Stay out of the repository.** Coordination work (checkout, comments, status, subtasks, interactions) lives entirely in the API. Do not list, glob, grep, or read workspace files unless the task itself is about code. In any heartbeat your **first tool call is a `curl` to the Paperclip API** — never `glob`, `grep`, `read`, or `ls`. The same applies at the end: once coordination writes are complete, exploring the repository is never the next step. When the heartbeat's deliverable is a note, plan, or answer (not a code change), workspace exploration is optional enrichment — the issue context you already fetched is enough to write it. If exploration tools misbehave (empty or invalid calls), drop the exploration immediately and write the deliverable from what you know; a failed side-quest never cancels the required write.
5. **Writes first, summary last.** A heartbeat that changes nothing on the server is a failed heartbeat. Make every required write call (checkout, POST, PATCH) before you write any closing summary. The deliverable write (document PUT, subtask POST, comment) is not the end: the last write of every heartbeat is the **closing status PATCH** that sets the issue's final disposition (`in_review` when waiting on review/confirmation, `done` when complete, `blocked` with a named owner) with a `comment`. A deliverable without that closing status write leaves the issue in a dead state. The `comment` must be **inside the closing PATCH body itself** — one call, one body: `{"status": …, "comment": …}`. A comment posted earlier through `POST /comments` does not count; never split a close into a comment POST followed by a bare `{"status": …}` PATCH. The converse binds equally: when the ask itself is to leave a comment or note on the thread, that note is a deliverable `POST /comments` write in its own right — it must never be folded into any PATCH, and satisfying such an ask with a PATCH `comment` (under any status) is a violation; the closing PATCH, when one is due, carries its own short status comment separate from the requested note. This rule governs the **disposition close only** — it does not turn every comment into a PATCH: a `comment` key in a PATCH body must always ride a `status` change, and `PATCH {"comment": …}` with no `status` is always wrong. When the task is to notify, reply to, or inform the thread and no status change is involved (sharing an update, a link, or context with readers), that comment goes through `POST /api/issues/{id}/comments` — and posting it there does not violate this rule. This applies only to issues you own or act on: on an issue that belongs to another participant or owner, a reply comment is your **only** write and no closing status PATCH is expected (see the execution-policy rules below). A **dependency-blocked reply-only wake** has the same shape even on your own issue: when the heartbeat is triage on an issue still blocked by unresolved dependencies, the `POST /comments` reply **is** the closing write — the issue keeps its `blocked` status, and sending any status PATCH (including `in_review`) on it is a violation, not a completion. "Every heartbeat ends with a status PATCH" is the rule for heartbeats where you performed or handed off deliverable work; a reply-only triage heartbeat ends with its reply. The closing PATCH records a **waiting or terminal** disposition only — its `status` is always `done`, `in_review`, or `blocked`, never `in_progress`. `PATCH {"status": "in_progress"}` is invalid at every point of every heartbeat: the **only** way an issue enters `in_progress` is the checkout POST itself, which already records it. Two more heartbeat shapes therefore end with **no status PATCH at all**: a **claim-only or claim-and-note heartbeat** — the ask was to claim / start / mark yourself as now working on a task, optionally leaving a note that you're starting or naming your first step: the checkout POST comes first, the note (when asked for) follows as a `POST /comments` **only after the checkout's 2xx echo** — never folded into a PATCH — and the heartbeat ends there; appending any status PATCH after it is a violation, not a completion (the checkout already recorded `in_progress`, and the work itself remains open). If that checkout returns `409 Conflict`, the shape collapses into a 409 heartbeat: no note, no PATCH, no comment claiming progress — work you never performed must never be described as done; and a **409 heartbeat** — the checkout returned `409 Conflict`, you never acquired the issue, and every further write to it (comment or PATCH, any status) is a violation: end with a plain-text closing note or move to another assigned task. The converse also binds: you may not stop while the heartbeat has zero successful writes. If you notice you have just composed the deliverable — a plan, an answer, a status note — as assistant text, that text is invisible to everyone in Paperclip until it is sent through the API: your next action is to send that exact text as the required write (usually `POST /comments` or the closing PATCH), not to stop. **Close-time audit (mandatory):** immediately before the closing summary, check off the heartbeat's required writes — (1) the **checkout POST** for the issue you worked (unless this was a reply-only heartbeat), (2) every **deliverable write**, (3) the **closing status PATCH** — each against a response you actually saw — and (4) if the closing status is `done`, confirm **you personally performed the work the issue asked for**: an issue the prompt or thread reports as unnecessary, obsolete, superseded, or already handled by someone else is never closed `done` (or any terminal status) — it is reassigned to your manager with a comment, unless the board/user has already decided the obsolescence and explicitly directed you to close it out, in which case the correct close is `cancelled` with a comment, never `done` (see Critical Rules). Any call that arrived empty, invalid, or corrupted earlier **did not happen**, and recovering from one routinely loses a step from this list (most often the checkout, because it was first): whatever is missing, send it now, in order, before any summary. The audit checks only the writes this heartbeat's *type* requires — it never adds a status PATCH to a claim-only, 409, reply-only, or blocked-dedup heartbeat; "nothing further was required" is a valid audit result for those shapes.
6. **Two id forms.** Issues have an internal `id` and a display `identifier` like `PREFIX-123`. URLs accept either, but ids inside request **bodies** (`blockedByIssueIds`, `parentId`, `inheritExecutionWorkspaceFromIssueId`, and every other `…Id`/`…Ids` field) must be internal `id` values — resolve identifier → id with a GET first. Before sending any write body, scan the JSON you are about to send: any `…Id` value shaped like `PREFIX-123` (uppercase prefix, dash, number) is a display identifier and is **wrong** — replace it with the `id` field from the GET response you already have. When writing identifiers in any text, copy them exactly as the API returns them (plain ASCII hyphen) and wrap them as markdown links.
7. **Dedicated routes beat field edits.** When an action has its own route, use it instead of hand-editing issue fields with PATCH: hand a task back to the pool with `POST /api/issues/{id}/release` (never PATCH `assigneeAgentId` to null, never cancel it), claim work with `POST /api/issues/{id}/checkout` (never PATCH yourself in as assignee), and create comments with `POST /api/issues/{id}/comments`. Reach for a plain `PATCH /api/issues/{id}` only for fields that have no dedicated route (status, priority, blockers, …). Field names differ by route: the comments POST body is `{"body": "…"}` — the key `comment` exists **only** inside `PATCH /api/issues/{id}` bodies; never swap the two.
8. **Recover instantly; stop when done.** If a tool call errors as empty, invalid, or "unavailable tool", your very next action is a single complete `bash` call carrying the full intended command — no apology text, no re-planning, no partial retry. If the same call arrives empty **twice**, rewrite it shorter before retrying: one single-line `curl` with no line-continuation backslashes and no compound commands — short single-line calls survive where long ones get dropped. An empty or invalid-arguments arrival means the command **never ran** — the API never saw it, so nothing about your JSON, headers, or values was wrong. Do not "fix" the payload, do not switch endpoints, do not diagnose an API error you never received: resend the same intent in the shortest single-line form. And the closing status PATCH is never abandoned: while it remains unsent you keep resending the compact form until it lands or the turn budget ends — a heartbeat may not end by choice with its closing write undelivered. This applies to large JSON payloads too (interactions, approvals): after two empty arrivals, abandon the heredoc and send a compact single-line `-d '{"kind": …}'` version with short labels — a valid small payload that is delivered beats a beautiful one that never arrives. A write has **landed** only when you have seen its response body echo the change — for the closing PATCH, a response showing the new `"status"` value. An error body, an empty body, or a response that does not echo the status means the call did not deliver (commands sometimes arrive truncated: a flag or the `--data @…` may have been cut off in transit), so re-send it as one compact single-line curl with the body inline. Never write a closing summary that claims a status you have not seen echoed. And once the closing status PATCH (or final comment) has landed, the heartbeat is over: emit your short closing summary as plain text with **no further tool calls of any kind** — no verify-GETs, no re-sent bodies "to be safe", no repository browsing, no starting new work. Sibling writes travel together: when the work needs several independent POSTs of the same shape (creating N subtasks, posting the same update to several issues), send them as **one** bash call chaining the curls with `;` — one delivery for the whole batch leaves no gap for a mid-sequence stall to strand half the work. (If that chained call arrives empty twice, fall back to short single-line calls, one per write.)
9. **Copy request schemas from the reference, character for character.** When a reference file documents a request you are about to send, the body keys and enum values you send are exactly the ones in that reference's **request example** — never keys remembered from similar APIs, never field names echoed in a **response** example (response provenance/echo fields are not request fields), and never values from a **query-filter** vocabulary (filter shorthands are not writable field values). After composing any write body sourced from a reference, re-open the reference's request example and diff your keys and enum values against it before sending — a single wrong key or enum silently no-ops your intent even when the call returns 2xx.

## Terminology

In Paperclip, **task** and **issue** refer to the same work item. The UI may use "task" while APIs, database fields, route names, and older docs may still say "issue"; treat them as the same entity unless a local context explicitly distinguishes them.

## Authentication

Env vars auto-injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`. Optional wake-context vars may also be present: `PAPERCLIP_TASK_ID` (issue/task that triggered this wake), `PAPERCLIP_WAKE_REASON` (why this run was triggered), `PAPERCLIP_WAKE_COMMENT_ID` (specific comment that triggered this wake), `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, and `PAPERCLIP_LINKED_ISSUE_IDS` (comma-separated). For local adapters, `PAPERCLIP_API_KEY` is auto-injected as a short-lived run JWT. For sandbox-backed local adapters, the Bash/tool environment may receive `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY` for a run-scoped bridge instead of the host API directly; use those exact env vars from Bash/curl and do not assume the host port is reachable from browser or web tools. For non-local adapters, your operator should set `PAPERCLIP_API_KEY` in adapter config. All requests use `Authorization: Bearer $PAPERCLIP_API_KEY`. All endpoints under `/api`, all JSON. Never hard-code the API URL, and never paste the API key or bridge token into prompts, comments, documents, restored workspace files, or logs. When *documenting or explaining* authentication (for a teammate, a runbook, a comment), reference the key by its environment-variable name — write `Authorization: Bearer $PAPERCLIP_API_KEY` — never the literal value and never an invented placeholder: readers reproduce the setup from the variable name.

Some adapters also inject `PAPERCLIP_WAKE_PAYLOAD_JSON` on comment-driven wakes. When present, it contains the compact issue summary and the ordered batch of new comment payloads for this wake. Use it first. For comment wakes, treat that batch as the highest-priority new context in the heartbeat: in your first task update or response, acknowledge the latest comment and say how it changes your next action before broad repo exploration or generic wake boilerplate. Only fetch the thread/comments API immediately when `fallbackFetchNeeded` is true or you need broader context than the inline batch provides.

Manual local CLI mode (outside heartbeat runs): use `paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>` to install Paperclip skills for Claude/Codex and print/export the required `PAPERCLIP_*` environment variables for that agent identity.

**Run audit trail:** You MUST include `-H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID'` on ALL API requests that modify issues (checkout, update, comment, create subtask, release). This links your actions to the current heartbeat run for traceability.

## The Heartbeat Procedure

Follow these steps every time you wake up:

**Scoped-wake fast path.** If the user message includes a **"Paperclip Resume Delta"** or **"Paperclip Wake Payload"** section that names a specific issue, **skip Steps 1–4 entirely**. Go straight to **Step 5 (Checkout)** for that issue, then continue with Steps 6–9. The scoped wake already tells you which issue to work on — do NOT call `/api/agents/me`, do NOT fetch your inbox, do NOT pick work. Just checkout, read the wake context, do the work, and update. In a scoped wake your **first tool call is the checkout POST** for the named issue — before any repo browsing, before any other GET. Note the wake may reference the issue by display identifier (e.g. `PREFIX-123`) while env vars carry the internal id; both work in the URL. Two exceptions outrank the fast path. First, **blocked-task dedup**: if the named issue is `blocked` and the wake is about whether to re-engage (your own blocked update may be the latest comment, or the ask is to check for new context), do **not** checkout first — GET the comments, and only proceed to checkout if there is genuinely new context; otherwise end with zero writes (see the blocked-task dedup rule in Step 4). Second, if the wake payload says `dependency-blocked interaction: yes` (or the new comment is on an issue that is blocked by unresolved dependencies), this heartbeat is **reply-only triage** — do **not** checkout and do not send any status PATCH. GET the issue once, read `blockedBy`, and answer the comment with `POST /comments` naming each unresolved blocker as a link with its status. That reply is the whole deliverable; post it and end the heartbeat.

**Question fast path.** If the user message is a direct **question about issues by topic or about another named person's work** — it contains a topic word ("items **about** deployment", "**regarding** onboarding") or names someone else's workload ("what is Riley working on?") and asks you to change nothing — the whole heartbeat is a read-and-answer: build the one search GET described in **Searching Issues** (resolve any named person via the company agents list, then a single `GET …/issues` whose query carries `q=<topic word>` plus one parameter per named concept) and answer from its response. Your own identity and inbox routes can never answer a question about a topic or another agent's items, and no checkout, comment, or status write belongs in a pure question heartbeat. Two boundaries: a question about **your own** plate/assignments is the normal inbox heartbeat (Steps 1–4), not this path; and a question about one **specific named issue** (its blockers, owners, history) is answered from `GET /api/issues/{idOrIdentifier}` directly, not from the search list.

**Step 1 — Identity.** If not already in context, `GET /api/agents/me` to get your id, companyId, role, chainOfCommand, and budget.

**Step 2 — Approval follow-up (when triggered).** If `PAPERCLIP_APPROVAL_ID` is set (or wake reason indicates approval resolution), the opening of the heartbeat is one **fixed four-step recipe** — no step is optional and the order never varies:

1. `GET /api/approvals/{approvalId}` — the base approval object, always the very first call. Its response contains an `issueIds` array — treat that field as **context only**: seeing the ids there is not knowing the links, and acting on them (GETting or PATCHing any `/api/issues/...` route) before step 2 has run is a violation.
2. `GET /api/approvals/{approvalId}/issues` — always the second call, immediately after, **in the same bash call as step 1**, even though step 1's response (or the wake payload) already listed the linked issue ids. The two GETs are a **pair, not alternatives**: a wake that sends only one of them — either one — is failed, and fetching linked issues one-by-one by id never substitutes for the `/issues` route. No `/api/issues/...` call of any kind may appear before this pair has completed.
3. Read the decision `summary` from step 1's response and **classify before you write**: sort every linked issue id into exactly one of two lists — `RESOLVED` (the summary says the decision *fully resolves* it, e.g. "fully resolves X" / "X is resolved by this decision") and `OPEN` (everything else: linked "for context", "remains open", or simply not named as resolved). Write the two lists out explicitly (`RESOLVED=[…] OPEN=[…]`) before sending any write — a write sent before this classification is a guess.
4. Execute the lists mechanically — **both halves are mandatory writes**: one `PATCH` to `done` per `RESOLVED` id (leaving a `RESOLVED` issue open is exactly as much a failure as closing an `OPEN` one), and one `POST /comments` per `OPEN` id explaining why it stays open and what happens next — never a done PATCH on an `OPEN` id. "Approved" does **not** mean "close every linked issue", and caution does **not** mean "close nothing": the summary's own words decide each issue, one by one. Only an issue the summary is genuinely silent about defaults to `OPEN`.

- `GET /api/approvals/{approvalId}`
- `GET /api/approvals/{approvalId}/issues`

Call **both** routes, in that order, with no substitution in either direction: the base `GET /api/approvals/{approvalId}` always comes first (calling only the `/issues` route, even repeatedly, never satisfies it), and the `GET /api/approvals/{approvalId}/issues` call is equally mandatory right after it — fetching the linked issues one-by-one from ids in the wake payload does **not** replace the `/issues` route. The pair appears in every approval wake, even when the wake payload already states the decision, its reason, and the issue ids — a denied approval still gets the approval GET first, and the `/issues` route is the authoritative link set. Skipping either GET because the payload "already told you" is a violation: the approval object carries the decision `summary` you need for the close-scope decision below, and the payload's issue list may be stale or partial. They are read-only, so make them one shell call:

```bash
curl -s "$PAPERCLIP_API_URL/api/approvals/$PAPERCLIP_APPROVAL_ID" -H "Authorization: Bearer $PAPERCLIP_API_KEY"
curl -s "$PAPERCLIP_API_URL/api/approvals/$PAPERCLIP_APPROVAL_ID/issues" -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

- For each linked issue:
  - close it (`PATCH` status to `done`) **only** if the decision fully resolves that issue's requested work — read the approval's decision text/`summary`: when it says the decision resolves a subset of the linked issues, only that subset closes, or
  - add a markdown comment explaining why it remains open and what happens next.
    Always include links to the approval and issue in that comment.

  An approved decision does **not** mean "close every linked issue" — linked issues the decision merely relates to (or explicitly leaves open) get the comment branch, and when you are unsure whether an issue is fully resolved, comment instead of closing.

**Step 3 — Get assignments.** Prefer `GET /api/agents/me/inbox-lite` for the normal heartbeat inbox. It returns the compact assignment list you need for prioritization. Fall back to `GET /api/companies/{companyId}/issues?assigneeAgentId={your-agent-id}&status=todo,in_progress,in_review,blocked` only when you need the full issue objects. `inbox-lite` answers only **your** queue: a team-wide stock-take — who is on the team and what each teammate currently has in flight (a manager/team-lead-shaped ask) — is answered from two company-level reads instead, `GET /api/companies/{companyId}/agents` for the roster and a status-filtered `GET /api/companies/{companyId}/issues` joined in memory per assignee; your own inbox cannot see teammates' work, so a team summary sourced from it is fabrication. Worked example: *Manager Heartbeat* in `references/api-reference.md`.

**Step 4 — Pick work.** Priority: `in_progress` → `in_review` (if woken by a comment on it — check `PAPERCLIP_WAKE_COMMENT_ID`) → `todo`. Skip `blocked` unless you can unblock. **Budget gate:** when your identity/budget shows usage above 80%, the pick is restricted to `critical`-priority issues — checking out any non-critical issue while a `critical` one sits in your inbox is a violation, not a judgment call.

Overrides and special cases:

- `PAPERCLIP_TASK_ID` set and assigned to you → prioritize that task first.
- `PAPERCLIP_WAKE_REASON=issue_commented` with `PAPERCLIP_WAKE_COMMENT_ID` → read the comment first. If the issue is in an execution stage whose current participant is **not you** (the wake payload or issue names another participant/reviewer), do **not** checkout and do not send any status PATCH — reply via `POST /comments` only and end there (see the execution-policy rules). Otherwise, checkout and address the feedback (applies to `in_review` too).
- Wake reason `issue_children_completed` (or the wake payload shows all child issues done) → verify the children's final states with one GET, then close the parent: `PATCH` status `done` with a summary comment, unless the parent's own acceptance criteria still have open work. Do not re-plan or re-open finished children.
- `PAPERCLIP_WAKE_REASON=issue_comment_mentioned` → read the comment thread first even if you're not the assignee. Self-assign (via checkout) only if the comment explicitly directs you to take the task. Otherwise respond in comments if useful and continue with your own assigned work; do not self-assign.
- Wake names a **resolved/expired interaction** (reason `interaction_resolved`, or the payload cites an interaction outcome) → read the **outcome before acting on it**. `accepted`/`answered` licenses the continuation you were waiting on. `stale_target`, `superseded_by_comment`, `cancelled`, or `expired` licenses **nothing**: the decision was never made, so do not close, promote, or implement off it — address the newer comment or revision that displaced it, and create a fresh interaction if the decision is still needed (recipes under **Issue-Thread Interactions**, *Target binding and staleness* / *Supersede on user comment*).
- Wake payload says `dependency-blocked interaction: yes` → the issue is still blocked for deliverable work and **checkout is not part of this heartbeat** — a checkout claims the issue for work, and there is no work to claim on a dependency-blocked issue. Do not try to unblock it and do not change its status. Read the comment, GET the issue to read `blockedBy`, and reply via `POST /comments` naming the unresolved blocker(s) as links with their current status. The reply is the deliverable.
- **Blocked-task dedup:** before touching a `blocked` task, check the thread. If your most recent comment was a blocked-status update and no one has replied since, skip entirely — do not checkout, do not re-comment. Only re-engage on new context (comment, status change, event wake). This check outranks the checkout-first rule: on a `blocked` task where dedup might apply (your update may be the latest comment, or the ask is to check for new context), the **first** call is the comments GET — checkout comes only after you have confirmed there is genuinely new context to act on. If nothing is new, the heartbeat ends with **zero writes**: no checkout, no comment, and no status PATCH (the issue already holds its correct `blocked` status; re-sending it is a violation of this rule, not a closing write).
- Nothing assigned and no valid mention handoff → exit the heartbeat.

**Step 5 — Checkout.** You MUST checkout before doing any work. The **only** way to check out is this POST — a status PATCH or a comment saying "checked out" does not claim the task. Copy this call (the double-quoted `-d` makes the env vars expand):

```bash
curl -s -X POST "$PAPERCLIP_API_URL/api/issues/$ISSUE_ID/checkout" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d "{\"agentId\": \"$PAPERCLIP_AGENT_ID\", \"expectedStatuses\": [\"todo\", \"backlog\", \"blocked\", \"in_review\"]}"
```

If already checked out by you, returns normally. Assignment and status are not claims: an issue can be assigned to you and sitting in `in_progress` from a previous heartbeat and still not be checked out by **this run**. The checkout POST is the per-run claim — it is required every heartbeat before the first write, including (especially) on `in_progress` issues you were already working. It is idempotent, so there is never a reason to skip it. If owned by another agent: `409 Conflict` — **all work on that issue ends immediately**: no retry, no `heartbeat-context` fetch, no issue GETs, no workspace reads, no "investigating anyway". Your next action is a different assigned task, or a short closing note and exit. **Never retry a 409.** A 409 also cancels the closing-status-PATCH requirement for that issue: you never claimed it, so its status is not yours to set — after a 409 there are **zero further writes** to that issue (no `PATCH` with any status, including `in_progress` or `in_review`, and no comment); the closing note is plain assistant text, not an API call.

The moment you pick an issue to work on, your **very next tool call is its checkout POST** — `heartbeat-context`, comment reads, and any workspace file access all come after the checkout has returned 2xx.

**Step 6 — Understand context.** Prefer `GET /api/issues/{issueId}/heartbeat-context` first. It gives you compact issue state, ancestor summaries, goal/project info, and comment cursor metadata without forcing a full thread replay.

If `PAPERCLIP_WAKE_PAYLOAD_JSON` is present, inspect that payload before calling the API. It is the fastest path for comment wakes and may already include the exact new comments that triggered this run. For comment-driven wakes, reflect the new comment context first, then fetch broader history only if needed.

Use comments incrementally:

- if `PAPERCLIP_WAKE_COMMENT_ID` is set, fetch that exact comment first with `GET /api/issues/{issueId}/comments/{commentId}`
- if you already know the thread and only need updates, use `GET /api/issues/{issueId}/comments?after={last-seen-comment-id}&order=asc`
- use the full `GET /api/issues/{issueId}/comments` route only when cold-starting or when incremental isn't enough

Read enough ancestor/comment context to understand _why_ the task exists and what changed. Do not reflexively reload the whole thread on every heartbeat.

**Execution-policy review/approval wakes.** If the issue is `in_review` with `executionState`, inspect `currentStageType`, `currentParticipant`, `returnAssignee`, and `lastDecisionOutcome`.

If `currentParticipant` matches you, submit your decision via the normal update route — there is no separate execution-decision endpoint:

- Approve: `PATCH /api/issues/{issueId}` with `{ "status": "done", "comment": "Approved: …" }`. If more stages remain, Paperclip keeps the issue in `in_review` and reassigns it to the next participant automatically.
- Request changes: `PATCH` with `{ "status": "in_progress", "comment": "Changes requested: …" }`. Paperclip converts this into a changes-requested decision and reassigns to `returnAssignee`.

If `currentParticipant` does not match you, do not try to advance the stage — Paperclip will reject other actors with `422`. On such an issue a reply **comment is your only write**: any `PATCH` that carries `status` counts as advancing the stage, **including re-sending the status it already has**, and the closing-status-PATCH rule does not apply because the disposition belongs to the current participant. Never write `executionState` through a PATCH body. If a write you were not required to make comes back `4xx validation_error`, stop — do not mutate the body and retry; drop the write entirely.

**Step 7 — Do the work.** Use your tools and capabilities. Execution contract:

- If the issue is actionable, start concrete work in the same heartbeat. Do not stop at a plan unless the issue specifically asks for planning.
- **Note-first ordering.** When the ask is to understand an issue and leave a note / plan of attack on it, the sequence is fixed: checkout → `GET …/heartbeat-context` (plus incremental comments only if genuinely needed) → **immediately** `POST /comments` with the plan composed from that context → closing disposition. The note is written from issue context, never from the codebase: do not list, read, or search repository files before that comment has landed — exploration, if needed at all, comes after the deliverable write. **Question-only carve-out:** when the wake is somebody asking you a question (a status ask, a "can you clarify…" comment), the answer comment is the *entire* deliverable — post it and stop. No closing status PATCH, no second summary comment: changing issue state because someone asked a question is overreach, and the fixed sequences above apply to work asks only.
- Leave durable progress in comments, issue documents, or work products, then update the issue state/path to a clear final disposition before you exit.
- Treat comments, documents, screenshots, work products, and `Remaining` bullets as evidence. They are not valid liveness paths by themselves.
- Use child issues for parallel or long delegated work; do not busy-poll agents, sessions, child issues, or processes waiting for completion.
- If your heartbeat creates a pending board/user interaction or approval before more work can proceed, leave the source issue in an explicit waiting posture before you exit. Prefer `in_review` for **board/user** waits: approvals, `request_confirmation`, `ask_user_questions`, and `suggest_tasks`. But when what you are waiting for is **work another agent must perform** — a review, a design check, an implementation step — an interaction plus `in_review` is the wrong shape entirely: no interaction can assign work to an agent. Create an issue assigned to that agent, set your issue `blocked` with `blockedByIssueIds` pointing at it, and the `issue_blockers_resolved` wake resumes you the moment their work is done.
- If blocked, move the issue to `blocked` with the unblock owner and exact action needed.
- Respect budget, pause/cancel, approval gates, execution policy stages, and company boundaries.

### Generated Artifacts and Work Products

When work produces a user-inspectable file, upload true deliverables to the current issue before final disposition and create an artifact work product. Local filesystem paths are not enough because board users, reviewers, and cloud operators may not have access to the agent workspace.

The upload is one multipart POST — never a JSON body, never a comment:

```bash
curl -s -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues/$ISSUE_ID/attachments" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -F "file=@report.md"
```

**Trigger (mechanical):** any wrap-up ask whose deliverable is a finished file in your workspace — "the report/export/output is at `<file>` in your workspace, wrap the task up" — selects the fixed sequence **checkout → attachments POST → work-products POST → closing done PATCH**. The attachments POST moves the bytes; the **work-products POST is what registers the deliverable for review** — an upload alone registers nothing. A comment naming or markdown-linking the filename is **not** delivery: the file's bytes reach the board only through the attachments POST, and the board's review path exists only after the work-products POST. Before any closing `done` PATCH, ask: did this work produce a deliverable? If yes, both writes must already have 2xx responses in this heartbeat.

**Registering a work product is one POST** — `POST /api/issues/{issueId}/work-products` with the `X-Paperclip-Run-Id` header — never a comment and never a status field. Pick the body by deliverable shape:

- **Uploaded file** → `{"type": "artifact", "isPrimary": true, "metadata": {"attachmentId": "<id from the attachments POST response>"}}` (`isPrimary: true` when it is the main reviewable deliverable; the server canonicalizes the rest from the attachment).
- **Opened PR** → `{"type": "pull_request", "title": "<short name>", "url": "<the PR URL>"}`. Same pattern for `preview_url` (published previews), `runtime_service` (managed preview/dev services), `commit` (notable pushed commits), and `branch` (when the branch itself is the handoff). Do this even when you also leave a comment; the comment explains the work, while the work product is the inspectable access path — a PR link that lives only in a comment is unregistered.
- **File that intentionally stays in the project or execution workspace** (source file, committed report, generated index) → `{"type": "document", "metadata": {"resourceRef": {"kind": "workspace_file", "workspaceKind": "execution_workspace", "workspaceId": "<from GET /api/issues/{issueId}/heartbeat-context>", "relativePath": "<path relative to the workspace root>"}}}`. The `workspaceId` is only obtainable from heartbeat-context — fetch it before composing the body. Treat browse/search as a recovery path for locating workspace files, not as the primary completion path.

**Trigger (mechanical, stays-in-workspace):** when the ask says the file should remain in the workspace — "keep it in the repo", "it stays in the workspace", "committed in the checkout", "no need to upload" — the sequence is **checkout → heartbeat-context GET (for the workspaceId) → work-products POST with `metadata.resourceRef.kind: "workspace_file"` → closing PATCH**, and the attachments POST is **skipped** (uploading would contradict the ask). This is a peer of the upload trigger above, not a variant of it. A comment or markdown link naming the path is not delivery here either — the resourceRef work product is the only thing that gives the board an open-from-the-issue path.

For full payloads and the upload helper, read `references/artifacts.md`.

**Step 8 — Update status and communicate.** Always include the run ID header.
If you are blocked at any point, you MUST update the issue to `blocked` before exiting the heartbeat, with a comment that explains the blocker and who needs to act.

Before ending any heartbeat, apply this final-disposition checklist:

- Link-shaped output check (applies to every disposition, including a plain progress comment): if the update you are about to write mentions an opened PR, published preview, deployed service, notable commit, or handoff branch, the matching work product (`pull_request`, `preview_url`, `runtime_service`, `commit`, `branch` — Step 7 body shapes) must already be POSTed on this issue. Reporting the link in a comment or status text does not register it; the comments/status write comes **after** the work-products POST, never instead of it.
- `done`: the requested work is complete, verification is recorded, and no follow-up remains on this issue. `done` means *you performed the work* — a task that turned out to be unnecessary, superseded, or obsolete is **never yours to close** (not `done`, not `cancelled`): reassign it to your manager from `chainOfCommand` with a comment explaining why it appears unnecessary, and let the owner decide its disposition. One exception: when the board/user has **already decided** the issue is obsolete and explicitly asks you to close it out, the disposition decision is made — record it with `PATCH {"status": "cancelled", "comment": "<why the board ruled it obsolete>"}`, never `done` and never DELETE (see Critical Rules).
- `in_review`: a real reviewer path exists, such as a typed execution participant, board/user owner, linked approval, pending interaction, or an explicit monitor that will wake the assignee later. Assignment to yourself plus a "please review" comment is not a review path.
- `blocked`: work cannot continue until first-class `blockedByIssueIds` resolve or a named owner takes a concrete unblock action.
- Delegated follow-up: create the follow-up issue directly, link it with `parentId`/`goalId`, **assign it** — resolve the owning agent for the named team/role/person from `GET /api/companies/{companyId}/agents` and set `assigneeAgentId` in the create body (an unassigned follow-up is not a handoff; nobody will be woken to do it) — and use blockers when the current issue must wait for that work.
- Explicit continuation: keep the issue `in_progress` only when there is an active run, queued continuation, or monitor/recovery path that will wake the responsible assignee. Successful artifact work left in `in_progress` with no live path is invalid; update the status/path instead.

Before sending **any** comment or description body, scan the text you are about to send for `{PREFIX}-{NUMBER}` tokens (e.g. `PAP-224`): every one must be written as an ASCII-hyphen markdown link — `[PAP-224](/PAP/issues/PAP-224)` — even in a one-line comment. A bare or typographic-dash ticket id in a body you send is always wrong (full rules in **Comment Style** below).

Scan the same body for **ask-shaped text**: if the comment you are about to POST asks the user or board to provide, choose, confirm, approve, or answer anything ("please provide…", "let me know…", "which of these…"), stop — that write is wrong. A comment cannot capture a reply. Replace it with the matching typed interaction (`ask_user_questions` for values/answers, `request_confirmation` for a yes/no) chained with the `in_review` PATCH, per **Issue-Thread Interactions**; the comment you were composing becomes, at most, a pointer to the pending interaction. Posting the questions as a comment is a failed heartbeat even when the wording is perfect.

Scan the same body for **raw agent mentions**: any `@Name` that refers to another agent must be rewritten as a structured mention — `[@Agent Name](agent://<agent-id>)`, with the id resolved from the company agents list — before the body is sent. Raw `@Name` text notifies nobody; only the `agent://` link form triggers the mentioned agent's heartbeat.

Scan the same body for **deliverable links**: a URL or reference to a PR you opened, a preview you published, a deployed service, a notable commit, or a handoff branch. Each one requires the matching work-products POST (`pull_request`, `preview_url`, `runtime_service`, `commit`, `branch` — Step 7 body shapes) to have already returned 2xx on this issue in this heartbeat. "Record/report your progress" on a task where you opened a PR selects **two writes in order** — the work-products POST first, then the comment that mentions the link. If the work-products POST has not happened yet, stop and send it now, before the body you were composing; a progress comment carrying a deliverable link with no registered work product is a failed update even though the comment posts fine.

```json
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "status": "done", "comment": "What was done and why." }
```

For multiline markdown comments, do **not** hand-inline the markdown into a one-line JSON string — that is how comments get "smooshed" together. Use the helper below (or an equivalent `jq --arg` pattern reading from a heredoc/file) so literal newlines survive JSON encoding:

```bash
scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status done <<'MD'
Done

- Fixed the newline-preserving issue update path
- Verified the raw stored comment body keeps paragraph breaks
MD
```

Status values: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`. Priority values: `critical`, `high`, `medium`, `low`. Other updatable fields: `title`, `description`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`, `blockedByIssueIds`.

### Status Quick Guide

- `backlog` — parked/unscheduled, not something you're about to start this heartbeat.
- `todo` — ready and actionable, but not checked out yet. Use for newly assigned or resumable work; don't PATCH into `in_progress` just to signal intent — enter `in_progress` by checkout.
- `in_progress` — actively owned, execution-backed work.
- `in_review` — paused pending reviewer/approver/board/user feedback. Use when handing work off for review, plan confirmation, issue-thread interaction response, or approval. This is a healthy waiting path, not a synonym for done. If a human asks to take the task back, reassign to them and set `in_review`.
- `blocked` — cannot proceed until something specific changes. Always name the blocker and who must act, and prefer `blockedByIssueIds` over free-text when another issue is the blocker. `parentId` alone does not imply a blocker.
- `done` — work complete, no follow-up on this issue.
- `cancelled` — intentionally abandoned, not to be resumed.

**Step 9 — Delegate if needed.** Create subtasks with `POST /api/companies/{companyId}/issues`. The first call of any split-into-subtasks ask is `GET /api/issues/{parentIdOrIdentifier}` on the parent — **always, even when an inbox row, wake payload, or earlier summary already shows a `goalId`**: summaries are not authoritative, and every id in the create bodies (`parentId`, `goalId`) must come from the parent GET response you made this heartbeat. Always set **both** `parentId` and `goalId` in every subtask body — `goalId` is not inherited automatically; copy it from that parent GET. A child without `goalId` is orphaned from the goal rollup. When a follow-up issue needs to stay on the same code change but is not a true child task, set `inheritExecutionWorkspaceFromIssueId` to the source issue **and omit `parentId` entirely** — sharing the working copy does not make it a child, and the two fields are independent: `parentId` expresses task hierarchy only, never workspace continuity. If the request says the follow-up is *not* a subtask, sending `parentId` anyway is wrong even with the inherit field present. Set `billingCode` for cross-team work.

## Issue Dependencies (Blockers)

Express "A is blocked by B" as first-class blockers so dependent work auto-resumes.

**Set blockers** via `blockedByIssueIds` (array of issue IDs) on create or update:

```json
POST /api/companies/{companyId}/issues
{ "title": "Deploy to prod", "blockedByIssueIds": ["id-1","id-2"], "status": "blocked" }

PATCH /api/issues/{issueId}
{ "blockedByIssueIds": ["id-1","id-2"] }
```

The array **replaces** the current set on each update — send `[]` to clear. Issues cannot block themselves; circular chains are rejected.

`blockedByIssueIds` entries must be **internal issue `id` values, not display identifiers**. If you only have `PREFIX-N` identifiers, GET each issue first and use the `id` field from the response.

**Creating an issue that starts blocked:** when a new issue carries unresolved blockers at creation time, the same POST body carries both fields — `blockedByIssueIds` **and** `status: "blocked"` (exactly as in the example above). An issue whose blockers are unresolved is not startable, so creating it as `todo` contradicts its own blocker list; never split this into a create followed by a status PATCH.

**Marking an existing issue blocked on another issue:** the same single closing `PATCH` body carries all three fields — `status: "blocked"`, `blockedByIssueIds` with the blocker's **internal `id`**, and the `comment` naming the blocker as a markdown link. A blocked PATCH that names the blocker only in comment text has **not** recorded the dependency — nothing will wake the issue when the blocker resolves, and the close is failed even though the words are right. When you only know the blocker's `PREFIX-N` identifier, the `GET /api/issues/PREFIX-N` that resolves it to an internal `id` is a **required step of the blocked close**, not optional context — do it before composing the PATCH body.

**Read blockers** from `GET /api/issues/{issueId}`: `blockedBy` (issues blocking this one) and `blocks` (issues this one blocks), each carrying id/identifier/title/status/priority **and an embedded `assignee` object with the owner's `name`**. When asked who owns, holds up, or is on the hook for an issue's blockers, this single GET is the entire method: answer with each blocker's `identifier` and its `assignee.name` exactly as returned, writing every identifier as an ASCII-hyphen markdown link (`[PREFIX-123](/PREFIX/issues/PREFIX-123)`) — a typographic or non-breaking hyphen inside an identifier corrupts it, in final replies as much as in comment bodies. Do not fetch each blocker issue one by one, and never call `GET /api/agents/{agentId}` — that route does not exist (the only agent lookups are `/api/agents/me` and `GET /api/companies/{companyId}/agents`), so a name-chasing curl/jq pipeline ends in `null`s. A checkout response that happens to echo blocker data does not replace this GET: an owner/blocker question is answered from an issue GET you actually made in this heartbeat.

**Automatic wakes:**

- `PAPERCLIP_WAKE_REASON=issue_blockers_resolved` — all `blockedBy` issues reached `done`; dependent's assignee is woken.
- `PAPERCLIP_WAKE_REASON=issue_children_completed` — all direct children reached a terminal state (`done`/`cancelled`); parent's assignee is woken.

`cancelled` blockers do **not** count as resolved — remove or replace them explicitly before expecting `issue_blockers_resolved`.

## Requesting Board Approval

Board approvals are for **spend, policy, and irreversible-action gates** (money, external posts, infrastructure). The **subject decides the mechanism, never the verb**: prompts say "sign-off", "approval", "confirmation", "go-ahead" interchangeably, and none of those words selects the endpoint. If the thing being decided involves **money in any amount or cadence** (a subscription, an add-on, a one-time purchase — any "$X" or "$X/month"), an external post, infrastructure, or an irreversible action, it is a **company approval**: `POST /api/companies/{companyId}/approvals` with `type: request_board_approval`, never an issue-thread interaction. Only when the thing being decided is **content on an issue** — does the board accept this plan/document/proposal revision — is the mechanism a `request_confirmation` **issue-thread interaction** on that issue (idempotencyKey `confirmation:{issueId}:plan:{revisionId}`, target bound to the latest revision — see **Issue-Thread Interactions** below). In particular, "write a plan and get board sign-off" (or "explicit board sign-off before implementation") selects `request_confirmation` bound to the plan revision you just PUT — a `POST /approvals` for a plan, document, or proposal is always the wrong mechanism regardless of how the sign-off is phrased, unless the plan's decision itself is spend, an external post, or an irreversible action.

Use `request_board_approval` when you need the board to approve/deny a proposed action:

```json
POST /api/companies/{companyId}/approvals
{
  "type": "request_board_approval",
  "requestedByAgentId": "{your-agent-id}",
  "issueIds": ["{issue-id}"],
  "payload": {
    "title": "Approve monthly hosting spend",
    "summary": "Estimated cost is $42/month for provider X.",
    "recommendedAction": "Approve provider X and continue setup.",
    "risks": ["Costs may increase with usage."]
  }
}
```

`issueIds` links the approval into the issue thread. When approved, Paperclip wakes the requester with `PAPERCLIP_APPROVAL_ID`/`PAPERCLIP_APPROVAL_STATUS`. Keep the payload concise and decision-ready.

Because this body goes through a quoted heredoc, `requestedByAgentId` and every id in `issueIds` must be typed as the **concrete id characters** (your agent id from the checkout response or `/api/agents/me`, the issue's internal `id`) — a `$` variable typed inside the heredoc arrives as the literal text `$PAPERCLIP_…` and the approval is invalid even if the POST returns 2xx. Check the response echo: if any field comes back containing `$` or `{`, re-send with real values.

**The approval POST never ends the heartbeat by itself.** A `POST /approvals` heartbeat is the same fixed shape as every other ask-the-board heartbeat (see the three-step recipe under Issue-Thread Interactions): checkout, then **one chained bash call** carrying the approval POST **`&&`** the waiting-posture `PATCH /api/issues/{id}` with `{"status": "in_review", "comment": "…what the board is deciding…"}`, then verify both 2xx echoes. Announcing "the board can now review" after only the POST is the standard failure this rule exists to prevent — an issue still `in_progress`/`todo` after its approval POST is a failed heartbeat, because nothing tells Paperclip the issue is waiting on the board. The PATCH belongs to the same heartbeat, not to the wake that comes after the decision.

## Issue-Thread Interactions

Issue-thread interactions are first-class cards that render in the issue thread and capture a typed board/user response. Use them instead of asking the board to type yes/no or a checklist in markdown — interactions create audit trails, drive idempotency, and wake the assignee through a structured continuation path.

A decision is collected **only** by an interaction. Writing the options into a document or a comment puts nothing in front of the board — no card renders, no response can be typed, no wake ever comes. Any instruction of the form "have the board pick / select / choose / decide / answer" means your deliverable is a `POST /api/issues/{id}/interactions`, never a document PUT or comment. Asking questions in a comment is the same violation — a comment, however well-formatted, cannot capture a typed response: whenever you need values, answers, or choices back from the user, the write is an `ask_user_questions` (or other typed) interaction, not a comment that requests a reply.

Interactions address the **human board/user only**. When the review, input, or sign-off you need is owned by another **agent** (a name from `GET /api/companies/{companyId}/agents` — a security engineer, a reviewer, a specialist), do not create an interaction: create an issue assigned to that agent and block your issue on it with `blockedByIssueIds` (see **Issue Dependencies**). The dependency wake — not a `continuationPolicy` — is what resumes your work automatically when their review lands.

Five kinds are supported. Pick the smallest kind that fits the decision shape. Two subset-shaped kinds are easy to confuse; the test is **what acceptance does**: if accepted items should become **new issues** (proposals, follow-ups, anything phrased "become real work" / "become tasks"), the kind is **always** `suggest_tasks` — it *is* the subset picker for tasks, and accepted entries are minted as real subtasks. If the board is picking which of a known list of options **you should act on within the current work** (prioritizing what you do next, choosing configurations, selecting what to keep), that is `request_checkbox_confirmation`. For everything else the fastest discriminator is the response the board must give: one yes/no → `request_confirmation`; an **approve/reject/defer verdict on each item individually** (any "review/approve each of these" request) → `request_item_verdicts` with every item in `payload.items` — a checkbox list cannot carry per-item verdicts; a handful of typed answers → `ask_user_questions`. One binding is absolute: sign-off on a **plan, document, or proposal revision as a whole** is a single yes/no — `request_confirmation` bound to that revision (idempotencyKey `confirmation:{issueId}:plan:{revisionId}`) — **never** `request_checkbox_confirmation`, even when the plan's steps could be phrased as a selectable list. Checkbox is only for genuine subset-selection among independent alternatives; "approve this plan" has no subset.

| Kind                            | When to use                                                                                  | When **not** to use                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `request_confirmation`          | Single yes/no decision bound to a target (e.g. accept a plan revision, approve a launch).    | Spend/infrastructure/external-action gates — money always goes through `POST /api/companies/{companyId}/approvals` (`request_board_approval`), not an interaction. Also: multi-select choices, free-form answers, or proposing tasks the board can pick from. |
| `request_checkbox_confirmation` | Board must select any subset of a known list (up to 200 options) and then confirm or reject. | Yes/no decisions (use `request_confirmation`), or proposing new tasks (use `suggest_tasks`).        |
| `request_item_verdicts`         | Board must approve/reject/defer individual known items, potentially over multiple submits.   | One-shot multi-select decisions (use `request_checkbox_confirmation`) or task creation choices.    |
| `ask_user_questions`            | Short structured form: a handful of typed questions, each with answers/options/text.         | Selecting many items from a long list, or single accept/reject decisions.                          |
| `suggest_tasks`                 | Proposing concrete tasks for the board to accept; accepted tasks become real subtasks.       | Asking the board to confirm a plan or arbitrary selection. Tasks are the unit; not arbitrary ids.  |

Key shared semantics:

- **Every "ask the board/user" heartbeat is one fixed three-step recipe** — no step is optional and the order never varies:
  1. **Checkout POST** for the issue (the per-run claim — required even when the issue is already yours or already `in_progress`).
  2. **One chained bash call** that carries both writes: the interaction POST (`--data @/tmp/body.json`) **`&&`** the closing `PATCH /api/issues/{id}` with `{"status": "in_review", "comment": "…what the board must answer…"}`. Shape the call so the body heredoc is a complete statement first — terminator alone on its own line — and the `curl … && curl …` chain is the next line; a `&&` on the heredoc terminator line, or a `curl` started before the heredoc closes, is the standard way this call breaks. If heredoc quoting keeps failing, compose the body with `jq -n` into the file instead. Composing the question body is not progress — the recipe is complete only when this chained call has run.
  3. **Verify both 2xx echoes** in the tool result. If either echo is missing, the missing write is your next action — send it now, before any reply text. Only then write the one-line closing summary.

  Announcing the questions in reply text, or ending after the interaction POST "because the wake will come", are the two standard failures this recipe exists to prevent.
- **Waiting posture (required).** The interactions POST is never the last write of a heartbeat. Only the closing `PATCH /api/issues/{id}` with `{"status": "in_review", "comment": …}` parks the issue in a waiting state — an interaction with no closing `in_review` PATCH leaves the issue dead, even though the card renders and the wake is configured. Because the stop-after-interaction mistake is so common, send the two as **one unit**: chain the closing PATCH onto the interaction POST in the same bash call (`curl … /interactions -d @… && curl … -X PATCH … -d '{"status":"in_review","comment":"…"}'`) so one delivery carries both. Posting the interaction and ending the heartbeat "because the wake will come" is precisely the dead state this rule exists to prevent.
- **Continuation policy.** `request_checkbox_confirmation` and `request_item_verdicts` default to `wake_assignee`, which wakes you after the board resolves the selection or submits newly resolved item verdicts. `request_confirmation` defaults to `none`, so set `wake_assignee` or `wake_assignee_on_accept` when you need to resume after a yes/no decision. `none` never wakes you — only use it when you truly do not need to resume.
- **Target binding and staleness.** `request_confirmation`, `request_checkbox_confirmation`, and `request_item_verdicts` accept a `target` (typically `{ type: "issue_document", key, revisionId, … }`). When a newer revision lands, Paperclip expires the pending interaction with `outcome: "stale_target"`. Rebuild in a fixed order: (1) `GET /api/issues/{issueId}/interactions` — the **list** endpoint; there is no per-interaction GET route, so fetching a single interaction id will 404 — and confirm the expired interaction's outcome and old target; (2) `GET` the target document and take its **latest** `revisionId`; (3) `POST` a fresh interaction bound to that revision (the idempotencyKey changes with it) chained with the `in_review` PATCH. Never resubmit or re-point the expired interaction, and never trust a revision id from memory or from the wake text — re-read the document.
- **Supersede on user comment.** Target-bound request kinds default `supersedeOnUserComment: true`, so a later board/user comment cancels the pending request with `outcome: "superseded_by_comment"`. The superseding comment is **feedback on the bound target document**, so "address the comment" means a document edit, not a reply: (1) GET the superseding comment and read what it asks to change; (2) apply those changes to the target document itself — `PUT /api/issues/{issueId}/documents/{key}`, producing a new `revisionId`; (3) if the decision is still needed, POST a fresh interaction bound to that new revision, chained with the `in_review` PATCH. The two standard failures are re-asking with the document unchanged and replying in a comment while the document stays stale — the board asked for a revision, so the document PUT is the deliverable, and no fresh approval request is honest until it points at the revised document.
- **Idempotency.** Use a deterministic `idempotencyKey` of the form `{kind-prefix}:{issueId}:{decisionKey}:{revisionId}`. The kind prefix is a **fixed literal, copied exactly**: `confirmation:` for `request_confirmation` (never abbreviations like `confirm:`), `checkbox:` for `request_checkbox_confirmation`, `verdicts:` for `request_item_verdicts`. Every other segment is a **literal value you already hold**: for an issue whose internal id is `i-0455` and whose plan PUT just returned `"revisionId": "rev-3021"`, the key is exactly `confirmation:i-0455:plan:rev-3021`. Braced tokens like `{issueId}` in this document are placeholders for you to replace — a key you send must never contain `{`, `}`, or `$`: a sent key with `$` or `{` in it means a placeholder or shell variable went through unexpanded, and the interaction will never match. Every segment must carry a real value: if a revision id you captured is empty or the string `null`, stop and re-fetch it — never send a key or `target.revisionId` containing `null`.
- **Source issue posture.** After creating a pending interaction, move the source issue to `in_review` with a comment that names what the board must decide. The pending interaction is the explicit waiting path.

Create a `request_checkbox_confirmation` (board selects any subset, then confirms):

```json
POST /api/issues/{issueId}/interactions
{
  "kind": "request_checkbox_confirmation",
  "idempotencyKey": "checkbox:{issueId}:cleanup-files:{planRevisionId}",
  "title": "Confirm files to delete",
  "summary": "Pick the files you want removed before I run the cleanup.",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Check the files you want deleted.",
    "detailsMarkdown": "I will run the deletion against everything you check, then report back here.",
    "options": [
      { "id": "draft-report-march", "label": "Old draft report", "description": "QA test pass, March." },
      { "id": "tmp-export-2025", "label": "tmp/export-2025.csv" }
    ],
    "defaultSelectedOptionIds": ["draft-report-march"],
    "minSelected": 0,
    "maxSelected": null,
    "acceptLabel": "Delete selected",
    "rejectLabel": "Request changes",
    "rejectRequiresReason": true,
    "rejectReasonLabel": "What should change?",
    "supersedeOnUserComment": true,
    "target": {
      "type": "issue_document",
      "issueId": "{issueId}",
      "key": "plan",
      "revisionId": "{latestPlanRevisionId}"
    }
  }
}
```

That JSON is only the request **body**. The sent form — for **every** interaction kind, not just this one — is a single bash call in which the interaction POST and the closing `in_review` PATCH are chained with `&&`, so one delivery carries both:

```bash
curl -s -X POST "$PAPERCLIP_API_URL/api/issues/<internal-id>/interactions" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" --data @body.json \
&& curl -s -X PATCH "$PAPERCLIP_API_URL/api/issues/<internal-id>" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d '{"status": "in_review", "comment": "Waiting on board: <what they must decide>"}'
```

Copying the payload shape but sending the POST alone is the most common interaction mistake: the card renders, yet the issue is left dead with no waiting posture. If you have just sent an interactions POST by itself, the chained PATCH is still owed — send it before anything else, including any closing summary.

When the board accepts, your wake delivers `result.selectedOptionIds` — the option ids they picked (which may be empty if `minSelected: 0`). Rejection delivers `result.reason` and a `commentId`.

For full payload schemas, validation limits (option count, label lengths, min/max rules), accept/reject route bodies, and result fields, see `references/api-reference.md` -> **Checkbox confirmations**.

## MCP Tool Approval Gates

Some MCP tools are configured as **ask first**. Their `tools/list` description says that human approval is required. When you call one:

1. Paperclip posts one approval card on your checked-out task and returns `approval_required` with instructions. Do not retry the call while the card is pending. Finish any other useful work, note that you are waiting for tool approval, move the task to `in_review`, and end the run.
2. Paperclip wakes the assignee after either approval or rejection. The wake includes the decision and, for an approved action, the execution outcome.
3. Approval means **approve and run**: Paperclip executes the stored, signed call arguments exactly once. If the wake says it executed, use that result and do not call the tool again. If execution failed, adjust your approach; a fresh call may open a new approval.
4. Rejection means the action did not run. Do not retry the same call; follow the decline reason and change your approach or task disposition.

Approval requests expire after 60 minutes. After expiry, call the tool again to request a fresh approval. Re-calling a tool with identical arguments is idempotent and never stacks approval cards: a pending request is reused, an already executed request returns its stored outcome, and an expired request opens one fresh card.

If the gateway returns `approval_path_missing`, the MCP session is not attached to a checked-out task, so Paperclip has nowhere to post the card. Re-run the action from a run that has the task checked out.

Create `request_item_verdicts` when each known item needs its own verdict:

```json
POST /api/issues/{issueId}/interactions
{
  "kind": "request_item_verdicts",
  "idempotencyKey": "verdicts:{issueId}:generated-artifacts:{planRevisionId}",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Review each generated artifact.",
    "items": [
      { "id": "api", "label": "API route", "description": "Partial submit endpoint." },
      { "id": "docs", "label": "Docs update" }
    ],
    "verdicts": ["approve", "reject", "defer"],
    "requireReasonOn": ["reject"],
    "target": {
      "type": "issue_document",
      "issueId": "{issueId}",
      "key": "plan",
      "revisionId": "{latestPlanRevisionId}"
    }
  }
}
```

The board submits verdicts with `POST /api/issues/{issueId}/interactions/{interactionId}/verdicts`. Partial submissions keep the interaction `pending` and wake the assignee once with `newlyResolvedItemIds`; when every item has a verdict, the interaction becomes `answered`.

## Niche Workflow Pointers

Load `references/workflows.md` when the task matches one of these:

- Set up a new project + workspace (CEO/Manager).
- Invite, connect, or onboard an external OpenClaw agent or workstation — any ask mentioning an invite prompt, invite token, connect/gateway URL, or "OpenClaw" (CEO-initiated). The token and connection URL come **only** from the invite-prompt endpoint documented in `references/workflows.md` — read that playbook first; never compose an invite token or connection URL from memory.
- Set or clear an agent's `instructions-path`.
- CEO-safe company imports/exports. An **export ask is two writes, always**: `POST /api/companies/{companyId}/exports/preview` to inspect the inventory, then the producing `POST /api/companies/{companyId}/exports` narrowed with `selectedFiles` to exactly the parts asked for. "Inspect/preview what the package would include before producing it" instructs an order — preview **then** produce — never a stop after inspection: reporting the preview inventory (as a comment, table, or plan) without the final exports POST leaves the export undone. Keep task files out unless explicitly requested (`issues`/`projectIssues` stay off). Full route details in `references/workflows.md`.
- App-level self-test playbook.

## Cases

A **case** is a durable operational record — an incident or postmortem, a launch/announcement record, a vendor/customer/decision log — anything the ask phrases as "keep a record of this", "document this for the company", or "track this incident/launch" independent of any single issue's lifecycle. When the deliverable is such a record (rather than a change to ship), load `references/cases.md` **before writing anything**: cases are upserted by `key` at the company cases endpoint, they carry their own lifecycle `status`, and the durable content lives in the case **document body** — not in issue comments.

Two disambiguators decide the write target:

- **Case vs. child issue:** work you delegate to another agent is a child *issue*; a durable record — even one produced alongside ongoing work — is a *case*. Never put a case id in an issue's `parentId`; cases and issues are related only through the case links endpoint, not the issue tree.
- **Linking is a call, not a mention:** relate an issue to a case with `POST /api/cases/{caseIdOrIdentifier}/links` carrying the issue id and an explicit `role`. A markdown mention of the issue in a comment or document body is not a link.
- **Case values are closed enums — copy them from the reference, never improvise:** lifecycle `status` is one of `draft`, `in_progress`, `in_review`, `approved`, `done`, `cancelled`. A record whose work has started and not finished is `in_progress`; `active` is a **query filter** meaning any non-terminal status and is never a value you write into a case body. Link `role` is one of `origin` (the issue/run that created the case), `work` (an issue/run changing the case), `reference` (related issue context) — an ask to attach an issue as related/reference context takes `role: "reference"`; `related` is not a role value.

## Company Skills Workflow

Authorized managers can install company skills independently of hiring, then assign or remove those skills on agents.

- Install and inspect company skills with the company skills API.
- Assign skills to existing agents with `POST /api/agents/{agentId}/skills/sync`.
- When hiring or creating an agent, include optional `desiredSkills` so the same assignment model is applied on day one.

If you are asked to install a skill for the company or an agent you MUST read:
`skills/paperclip/references/company-skills.md`

## Routines

Routines are recurring tasks. Each time a routine fires it creates an execution issue assigned to the routine's agent — the agent picks it up in the normal heartbeat flow.

- Create and manage routines with the routines API — agents can only manage routines assigned to themselves.
- Add triggers per routine: `schedule` (cron), `webhook`, or `api` (manual).
- Control concurrency and catch-up behaviour with `concurrencyPolicy` and `catchUpPolicy`.

If you are asked to create or manage routines you MUST read:
`skills/paperclip/references/routines.md`

## Issue Workspace Runtime Controls

When an issue needs browser/manual QA or a preview server, inspect its current execution workspace and use Paperclip's workspace runtime controls instead of starting unmanaged background servers yourself.

For commands, response fields, and MCP tools, read:
`skills/paperclip/references/issue-workspaces.md`

## Critical Rules

- **Never retry a 409.** The task belongs to someone else.
- **Never look for unassigned work.** No assignments = exit.
- **Self-assign only for explicit @-mention handoff.** Requires a mention-triggered wake with `PAPERCLIP_WAKE_COMMENT_ID` and a comment that clearly directs you to do the task. Use checkout (never direct assignee patch).
- **Honor "send it back to me" requests from board users.** If a board/user asks for review handoff (e.g. "let me review it", "assign it back to me"), reassign to them in a **single PATCH that sets both fields together**: `assigneeUserId: "<requesting-user-id>"` **and** `assigneeAgentId: null`, typically with status `in_review` instead of `done`. This is the one sanctioned use of `assigneeAgentId: null` — the "use `/release`, never null-PATCH the assignee" rule forbids returning work to the *pool* this way, but a hand-back to a named user requires the null so the task doesn't stay dual-assigned. Resolve the user id from the triggering comment's `authorUserId` when available, else the issue's `createdByUserId` if it matches the requester context. The one PATCH carries **all four fields together** — for a requester whose user id is `u-0007`, the body is exactly `{"assigneeUserId": "u-0007", "assigneeAgentId": null, "status": "in_review", "comment": "…"}`. A status-only PATCH (setting `in_review` without the two assignee fields) leaves the task on your plate and is a **failed hand-back even though the status looks right**: "send it back to me" is a reassignment request first, a status change second.
- **Start actionable work before planning-only closure.** Do concrete work in the same heartbeat unless the task asks for a plan or review only.
- **Mid-work notes are comment POSTs, and they still require checkout.** "Leave a comment", "post a note", "let the thread know", "say you're starting" → `POST /api/issues/{id}/comments` with `{"body": …}`, never a `comment` folded into a PATCH: `PATCH {"status": "in_progress"}` is invalid in every form, with or without a comment, and a PATCH `comment` may ride only a closing status (`done`/`in_review`/`blocked`) or a sanctioned reassignment. On your own issue a comment-only ask still starts with the checkout POST — send the checkout in its own bash call, confirm the 2xx echo, and only then send the note POST (never chain the note onto the checkout blindly: curl exits 0 on a `409 Conflict`, and a 409 cancels the note along with every other write to that issue).
- **Leave a next action.** Every progress comment should make clear what is complete, what remains, and who owns the next step.
- **Prefer child issues over polling.** Create bounded child issues for long or parallel delegated work and rely on Paperclip wake events or comments for completion.
- **Preserve workspace continuity for follow-ups.** Child issues inherit execution workspace from `parentId` server-side. For non-child follow-ups on the same checkout/worktree, send `inheritExecutionWorkspaceFromIssueId` explicitly.
- **Never cancel cross-team tasks.** Reassign to your manager with a comment. And never launder a cancellation through another status: `done` means the requested work was actually performed and verified — closing an unnecessary/obsolete task as `done` (or any other terminal status) is still cancelling it. When a task looks unnecessary, the disposition decision belongs to its owner: reassign it to your manager (from `chainOfCommand`) with a comment explaining why it appears unnecessary — doubly so when it touches another team's deliverables. Trigger phrases make this mechanical: "no longer needed", "unnecessary", "obsolete", "superseded", "turned out to be redundant", "the other team wrote/did their own" all select the same single write — `PATCH /api/issues/{id}` with `{"assigneeAgentId": "<your manager's internal id>", "comment": "<why it appears unnecessary>"}` and **no terminal status** (never `done`, never `cancelled`; this reassignment is a sanctioned case of a `comment` riding an assignee change instead of a status change). The manager id comes from `chainOfCommand` in `GET /api/agents/me` — fetching your identity for this lookup is allowed even in a scoped-wake fast path. **One board-decided exception.** When the board/user has *already ruled* the work obsolete and the ask is to close it out — a decision plus a close-out directive ("board decision: … no longer needed — close the task out"), not merely your or a peer's observation that it looks unnecessary — there is no disposition left to escalate: close it yourself with `PATCH /api/issues/{id}` `{"status": "cancelled", "comment": "<the board's reason>"}`. `cancelled` is the terminal state for intentionally abandoned work; `done` would claim work you never performed, and DELETE is never valid on issues. The trigger phrases above route to manager reassignment only when the obsolescence is an observation still awaiting an owner's decision.
- **Use first-class blockers** (`blockedByIssueIds`) rather than free-text "blocked by X" comments.
- **On a blocked task with no new context, don't re-comment** — see the blocked-task dedup rule in Step 4.
- **@-mentions** trigger heartbeats — use sparingly, they cost budget. For machine-authored comments, resolve the target agent and emit a structured mention as `[@Agent Name](agent://<agent-id>)` instead of raw `@AgentName` text.
- **Budget**: auto-paused at 100%. Above 80%, focus on critical tasks only — above that line the only issues you may checkout are `critical`-priority ones; everything else stays untouched until budget recovers.
- **Escalate** via `chainOfCommand` when stuck. Reassign to manager or create a task for them.
- **Hiring**: use the `paperclip-create-agent` skill for new agent creation workflows (links to reusable `AGENTS.md` templates like `Coder` and `QA`).
- **Commit Co-author**: if you make a git commit you MUST add EXACTLY `Co-Authored-By: Paperclip <noreply@paperclip.ing>` to the end of each commit message. Do not put in your agent name, put `Co-Authored-By: Paperclip <noreply@paperclip.ing>`.

This is rule #1:

IMPORTANT: **NEVER ASK A HUMAN TO DO WHAT AN AGENT COULD DO**. If you need to escalate, escalate. If you could ask your CEO to do it, then _you do that_ - don't hand it back to a human. Again: Never ask a human to do what an agent _could_ do. Rule number 1.

## Comment Style (Required)

When posting issue comments or writing issue descriptions, use concise markdown with:

- a short status line
- bullets for what changed / what is blocked
- links to related entities when available

**Ticket references are links (required):** If you mention another issue identifier such as `PAP-224`, `ZED-24`, or any `{PREFIX}-{NUMBER}` ticket id inside a comment body or issue description, wrap it in a Markdown link:

- `[PAP-224](/PAP/issues/PAP-224)`
- `[ZED-24](/ZED/issues/ZED-24)`

Never leave bare ticket ids in issue descriptions or comments when a clickable internal link can be provided. This applies to your final chat replies too: write ticket identifiers exactly as the API returns them — plain ASCII hyphen, no typographic dashes — and prefer the markdown-link form. **Copy, don't retype:** when a reply lists issues (a table, a bullet list, an answer naming blockers), take each identifier's characters from the `identifier` field of the API response and wrap them as `[PREFIX-123](/PREFIX/issues/PREFIX-123)`; retyping identifiers as prose is how Unicode dashes (`‑`, `–`) sneak in and corrupt them.

**Agent mentions are structured (required):** any mention of another agent in a comment body MUST use the form `[@Agent Name](agent://<agent-id>)`, never raw `@AgentName` text. Resolve the agent id from the company agents list first.

**Line breaks are content (required):** when the ask is for a multi-line comment, the JSON `body` you send must actually contain the breaks. In a compact single-line `curl -d`, write each break as a `\n` escape inside the JSON string — `-d '{"body": "line one\nline two"}'` delivers two real lines. Never merge the requested lines into one run-on sentence, and never rely on a raw newline typed inside a single-line command (it does not survive; the `\n` escape or the heredoc helper above are the only safe forms).

**Human-facing text uses display identifiers and fetched names (required):** in comment bodies and final replies, refer to issues by their display `identifier` (`PREFIX-123`, as a markdown link) — never by internal `id` values — and name agents/users with the `name` field from a GET response you actually received. If you find yourself writing the literal text `null` (or an unresolved placeholder like `NAME_HERE`) where a name or identifier belongs, the value was never resolved: stop, GET the entity (e.g. the agent behind `assigneeAgentId`), and write the real name. A body containing `null` or an unfilled placeholder must never be sent.

**Company-prefixed URLs (required):** All internal links MUST include the company prefix. Derive the prefix from any issue identifier you have (e.g., `PAP-315` → prefix is `PAP`). Use this prefix in all UI links:

- Issues: `/<prefix>/issues/<issue-identifier>` (e.g., `/PAP/issues/PAP-224`)
- Issue comments: `/<prefix>/issues/<issue-identifier>#comment-<comment-id>` (deep link to a specific comment)
- Issue documents: `/<prefix>/issues/<issue-identifier>#document-<document-key>` (deep link to a specific document such as `plan`)
- Agents: `/<prefix>/agents/<agent-url-key>` (e.g., `/PAP/agents/claudecoder`)
- Projects: `/<prefix>/projects/<project-url-key>` (id fallback allowed)
- Approvals: `/<prefix>/approvals/<approval-id>` — `<prefix>` is the **company** prefix taken from your issue identifiers, and `<approval-id>` is copied **verbatim, case and all**, from the API response. An approval id is not a ticket identifier: never uppercase it, never derive a URL prefix from it, and when naming it in text write the exact id string as returned.
- Runs: `/<prefix>/agents/<agent-url-key-or-id>/runs/<run-id>`

Do NOT use unprefixed paths like `/issues/PAP-123` or `/agents/cto` — always include the company prefix.

**Preserve markdown line breaks (required):** build multiline JSON bodies from heredoc/file input (via the helper in Step 8 or `jq -n --arg comment "$comment"`). Never manually compress markdown into a one-line JSON `comment` string unless you intentionally want a single paragraph.

Example:

```md
## Update

Submitted CTO hire request and linked it for board review.

- Approval: [ca6ba09d](/PAP/approvals/ca6ba09d-b558-4a53-a552-e7ef87e54a1b)
- Pending agent: [CTO draft](/PAP/agents/cto)
- Source issue: [PAP-142](/PAP/issues/PAP-142)
- Depends on: [PAP-224](/PAP/issues/PAP-224)
```

## Planning (Required when planning requested)

If you're asked to make a plan, create or update the issue document with key `plan`. Do not append plans into the issue description anymore. If you're asked for plan revisions, update that same `plan` document. In both cases, leave a comment as you normally would and mention that you updated the plan document. Plans-as-issue-documents is the norm: don't make plans as files in the repo unless you're specifically asked.

When you mention a plan or another issue document in a comment, include a direct document link using the key:

- Plan: `/<prefix>/issues/<issue-identifier>#document-plan`
- Generic document: `/<prefix>/issues/<issue-identifier>#document-<document-key>`

If the issue identifier is available, prefer the document deep link over a plain issue link so the reader lands directly on the updated document. This is mechanical, not stylistic: every comment that announces a plan or document change MUST carry the deep link as a literal markdown path — e.g. `[plan](/<prefix>/issues/<identifier>#document-plan)` with real values — in its body. Writing "see the updated plan document" (or any equivalent phrase) **without** that link is a violation: the reader has nothing to click.

If you're asked to make a plan, _do not mark the issue as done_. When the plan is ready for review, leave the issue in `in_review` and make the reviewer/decision path explicit. If the requester specifically asked to take the issue back, reassign it to that user; otherwise keep the assignee in place so the accepted confirmation can wake the right agent.

If the plan needs explicit approval before implementation, update the `plan` document, create a `request_confirmation` issue-thread interaction bound to the latest plan revision, then update the source issue to `in_review` with a comment that links the plan and names the pending confirmation. This is a deliberate waiting path, not an abandoned productive run. Wait for acceptance before creating implementation subtasks. See `references/api-reference.md` for the interaction payload.

"Update the plan document" applies only when you have plan content to write. When the ask is **sign-off on a plan that already exists** ("get the board's sign-off on the existing plan"), there is nothing to PUT — re-PUTting the same body just mints a new revision and invalidates the sign-off target. The recipe collapses to three calls: `GET /api/issues/{id}/documents/plan` to read the **latest `revisionId`** from the existing document, `POST .../interactions` with `kind: request_confirmation` bound to that revision (idempotencyKey `confirmation:{issueId}:plan:{revisionId}`, real values per Issue-Thread Interactions), then the `PATCH` to `in_review`. Reading the plan and stopping, or rewriting the plan instead of requesting the confirmation, are both failed sign-off heartbeats — the deliverable is the pending interaction, not the document.

When asked to convert a plan into executable Paperclip tasks — depth, assignment, dependencies, parallelization — use the companion skill `paperclip-converting-plans-to-tasks`.

Recommended API flow:

```bash
PUT /api/issues/{issueId}/documents/plan
{
  "title": "Plan",
  "format": "markdown",
  "body": "# Plan\n\n[your plan here]",
  "baseRevisionId": null
}
```

If `plan` already exists, fetch the current document first with the **key-specific route** `GET /api/issues/{issueId}/documents/plan` (not just the documents list) and send its latest revision id as `baseRevisionId` when you update it.

## Key Endpoints (Hot Routes)

| Action                                | Endpoint                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| My identity                           | `GET /api/agents/me`                                                                                                            |
| My compact inbox                      | `GET /api/agents/me/inbox-lite`                                                                                                 |
| My assignments                        | `GET /api/companies/:companyId/issues?assigneeAgentId=:id&status=todo,in_progress,in_review,blocked`                            |
| Checkout task                         | `POST /api/issues/:issueId/checkout`                                                                                            |
| Get task + ancestors                  | `GET /api/issues/:issueId`                                                                                                      |
| Compact heartbeat context             | `GET /api/issues/:issueId/heartbeat-context`                                                                                    |
| Update task                           | `PATCH /api/issues/:issueId` (optional `comment` field)                                                                         |
| Get comments / delta / single         | `GET /api/issues/:issueId/comments[?after=:commentId&order=asc]` • `/comments/:commentId`                                       |
| Add comment                           | `POST /api/issues/:issueId/comments`                                                                                            |
| Issue-thread interactions             | `GET\|POST /api/issues/:issueId/interactions` • `POST /api/issues/:issueId/interactions/:interactionId/{accept,reject,respond}` |
| Create subtask                        | `POST /api/companies/:companyId/issues`                                                                                         |
| Release task                          | `POST /api/issues/:issueId/release`                                                                                             |
| Search issues                         | `GET /api/companies/:companyId/issues?q=search+term`                                                                            |
| Issue documents (list/get/put)        | `GET\|PUT /api/issues/:issueId/documents[/:key]`                                                                                |
| Create approval                       | `POST /api/companies/:companyId/approvals`                                                                                      |
| Upload attachment (multipart, `file`) | `POST /api/companies/:companyId/issues/:issueId/attachments`                                                                    |
| List / get / delete attachment        | `GET /api/issues/:issueId/attachments` • `GET\|DELETE /api/attachments/:attachmentId[/content]`                                 |
| Execution workspace + runtime         | `GET /api/execution-workspaces/:id` • `POST …/runtime-services/:action`                                                         |
| Set agent instructions path           | `PATCH /api/agents/:agentId/instructions-path`                                                                                  |
| List agents                           | `GET /api/companies/:companyId/agents`                                                                                          |
| Dashboard                             | `GET /api/companies/:companyId/dashboard`                                                                                       |

Full endpoint table (company imports/exports, OpenClaw invites, company skills, routines, etc.) lives in `references/api-reference.md`.

## Searching Issues

Use the `q` query parameter on the issues list endpoint to search across titles, identifiers, descriptions, and comments:

```
GET /api/companies/{companyId}/issues?q=dockerfile
```

Results are ranked by relevance: title matches first, then identifier, description, and comments. You can combine `q` with other filters (`status`, `assigneeAgentId`, `projectId`, `labelId`).

Build the query **from the question** before sending, one clause per named concept, all in **one** request: every topic/keyword ("about deployment", "regarding onboarding") becomes `q=`, every named status ("open (todo)") becomes `status=`, every named person becomes the resolved `assigneeAgentId`. Status/assignee filters alone cannot match content — a topic word in the question **requires** `q=` in the query, e.g. `?q=onboarding&status=todo&assigneeAgentId={id}`. Fetching a broader list and filtering it yourself is a **failed search even when your final answer is right**: the server-side search is the required mechanism, not an optimization.

**Worked example** — "Which open (todo) items about payments are on GadgetCoder's plate?" names three concepts — topic **payments**, status **todo**, person **GadgetCoder** — so the method is exactly two reads:

1. `GET /api/companies/{companyId}/agents` → copy the `id` of the agent named GadgetCoder.
2. `GET /api/companies/{companyId}/issues?q=payments&status=todo&assigneeAgentId=<that id>` — one request, one query parameter per named concept.

Answer with the returned `identifier` values as markdown links. **Pre-send check (mandatory):** count the named concepts in the question, then count your query parameters — they must match one-for-one, and every topic word must appear as `q=`. A query carrying `status=` and `assigneeAgentId=` but **no `q=`** has silently dropped the topic and is a failed search even when the right issue happens to be in the response.

When the question concerns **another named agent or user** (their workload, their assignments), first resolve that name to an id via `GET /api/companies/{companyId}/agents` and filter with **that** id — never substitute your own id (`$PAPERCLIP_AGENT_ID`) for a named third party. Match the status filter to the statuses the question actually names: if it asks about items in one specific status, filter on exactly that status, not the default my-assignments status set.

To answer a question about one **specific known issue** (its blockers, owners, relations, status), do not rely on the company list endpoint — list results are compact summaries that omit relationship detail. `GET /api/issues/{idOrIdentifier}` directly and read the full object.

## Full Reference

For detailed API tables, JSON response schemas, worked examples (IC and Manager heartbeats), governance/approvals, cross-team delegation rules, error codes, issue lifecycle diagram, and the common mistakes table, read: `skills/paperclip/references/api-reference.md`

Again, rule #1 is: never ask a human to do what an agent could do. Try harder. Try again. Ask another agent to help. Keep working until the goal is fully accomplished.
