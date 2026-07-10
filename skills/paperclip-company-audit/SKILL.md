---
name: paperclip-company-audit
description: >
  Audit whether a Paperclip company is structurally capable of running as a 24/7
  AI factory. Use when asked to audit a company, assess factory readiness, review
  org/skill/QA/delegation health, or diagnose why a company keeps producing
  wrong-problem or reworked output. Produces a factory readiness report with
  scored gaps and remediation recommendations. Do NOT use for auditing a single
  issue or a single agent — this is a whole-company structural review.
---

# Paperclip Company Audit

You are grading one question: **can this company operate continuously without a human manually preserving context across every handoff?**

Use the Paperclip API (see the `paperclip` skill for auth and endpoints) to inspect the company, then produce the readiness report below. Be evidence-based: every gap you report must cite the agent, skill, or issue that demonstrates it. Sample real issues — especially recently completed and reworked ones — rather than trusting configuration alone.

## What to inspect

- `GET /api/companies/{companyId}/agents` — roster, roles, adapter state
- `GET /api/companies/{companyId}/skills` — installed skills, source badges, compatibility
- `GET /api/agents/{agentId}/skills` — per-agent skill assignment
- Recent issues (`GET /api/companies/{companyId}/issues?...` plus `GET /api/issues/{issueId}` for sampled children), including `done`, `blocked`, and `in_review` — inspect child `executionContract` fields and QA comments
- Recent heartbeat/wakeup telemetry — compare requested, available, and prepared skills; count repeated skipped wakes by issue/reason rather than treating them as harmless noise
- Routines and triggers — flag enabled triggers or active routines owned by terminated/uninvokable agents, and distinguish recurring work from watchdogs that should be bounded issue monitors
- Agent `AGENTS.md`/instructions where accessible

## Audit areas

### 1. Role coverage

Manager/CEO present? Executors for the company's actual work types? QA assigned and distinct from the executor? Recovery/ops ownership for blocked or dead work? Escalation path to board/user?

### 2. Skill coverage and health

Root (bundled) Paperclip skills present and synced? Company skills exist for recurring domain work? Any skill malformed (bad frontmatter, missing name/description), assigned but unavailable, unassigned where needed, duplicated, or contradicting root invariants?

Do not infer assignment health from the company skill catalog. Compare each live agent's desired skills with runtime telemetry. A desired count that drops to zero after an adapter/config revision, or company skills that are available but never requested/prepared, is a critical persistence gap.

### 3. Handoff quality

Sample recent child execution lanes: do issue details contain a hidden `executionContract`? Is the contract schema current (`schemaVersion`, `contractType`, `taskType`, `core`, optional `extensions`)? Are source-of-truth links present and reachable? Non-goals and must-not-change constraints explicit? Did executors block on missing context, or guess?

Legacy fallback: older issues may have a `## Execution Contract` JSON block in the description. Treat that as backward-compatible evidence only. New delegations should use the hidden `executionContract` field; description-only contracts are a remediation gap.

Sample agent-to-agent progress comments that contain `Next owner:`. A healthy company uses first-class handoffs: the named owner resolves to one live agent, the issue assignee/status changes, and a `next_owner_handoff` wake exists. Prose-only "Next owner" text that leaves the issue assigned to the old agent is a structural orchestration gap.

### 4. QA quality

Do QA comments reference the contract's acceptance checks? Is evidence linked? Any passes where output plausibly solved a different problem than the objective? Does QA ever fail work (a QA lane that never fails anything is a gap, not a strength)?

Count issue execution decisions and registered work products/documents for sampled contracted work. A rich contract with no machine-visible review decision or required output is stored context, not enforced QA.

### 5. Recovery quality

Are blocked issues monitored and escalated, or do they rot? Dead/paused assignees detected? Repeated failure patterns visible across issues? Group skipped wake requests by issue and reason; repeated `issue_dependencies_blocked` wakes indicate a recovery hot loop, not healthy liveness. Verify scheduled issue monitors are treated as active waiting paths and that bounded blocked monitors can fire without reopening deliverable work.

Build a capability/access matrix for sampled dispatches: required adapter/runtime, desired company skill, MCP/credential, environment, and actual assignee. Repeatedly dispatching to an owner that cannot reach the required system is an orchestration failure even if another executive agent happens to have access.

Check lifecycle cleanup: terminated agents must not own active routines or enabled triggers. A recurring health/watchdog routine that creates a fresh board issue every tick should be replaced by a bounded monitor on the existing issue unless each occurrence is genuinely new work.

### 6. Governance quality

Universal rules living in agent prompts instead of skills? Company instructions contradicting root skills? Prompt bloat that should be moved into skills? Incidents that recurred without producing a skill/prompt improvement?

## Report format

Post the report as an issue document (key `audit`) on the requesting issue, with a summary comment. Structure:

```json
{
  "factory_readiness_score": 0,
  "critical_gaps": [],
  "high_risk_gaps": [],
  "recommended_skill_changes": [{ "skill": "", "change": "" }],
  "recommended_agent_changes": [{ "agent": "", "change": "" }],
  "recommended_root_skill_changes": [{ "skill": "", "change": "" }],
  "immediate_blockers_to_24_7_operation": []
}
```

Scoring: start at 100 and deduct — critical gap (context can be lost silently, QA cannot catch wrong-problem work, no recovery path): −15 each; high-risk gap: −8; moderate: −3. Floor at 0. Below 50 means the company needs human supervision on every delegation; say so plainly.

Follow each JSON report with a prose section explaining the top three gaps with cited evidence and the single highest-leverage fix.

`recommended_root_skill_changes` are requests to the Paperclip instance owner — root skills cannot be edited from inside a company. Route them per `skills/paperclip/references/governance.md`.

## Rules

- Evidence or it didn't happen: cite issue identifiers, agent names, skill keys.
- Quantify board rescue: cite manual reassignments, status reopens, blocker edits, and repeated follow-up comments needed to obtain the intended result. That is factory toil, not proof the workflow worked.
- Audit the practice, not just the config: a skill being installed says nothing about whether agents follow it — read real issues.
- Do not fix things during the audit. Report; recommend; let remediation be delegated as separate contracted lanes.
- If asked to audit on a recurring basis, set up a routine (see the `paperclip` skill's routines reference).
