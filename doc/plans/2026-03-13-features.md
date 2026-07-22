# Feature specs

## 1) Guided onboarding + first-job magic

The repo already has `onboard`, `doctor`, `run`, deployment modes, and even agent-oriented onboarding text/skills endpoints, but there are also current onboarding/auth validation issues and an open “onboard failed” report. That means this is not just polish; it is product-critical. ([GitHub][1])

### Product decision

Replace “configuration-first onboarding” with **interview-first onboarding**.

### What we want

- Ask 3–4 questions up front, not 20 settings.
- Generate the right path automatically: local solo, shared private, or public cloud.
- Detect what agent/runtime environment already exists.
- Make it normal to have Claude/OpenClaw/Codex help complete setup.
- End onboarding with a **real first task**, not a blank dashboard.

### What we do not want

- Provider jargon before value.
- “Go find an API key” as the default first instruction.
- A successful install that still leaves users unsure what to do next.

### Proposed UX

On first run, show an interview:

```ts
type OnboardingProfile = {
  useCase: "startup" | "agency" | "internal_team";
  companySource: "new" | "existing";
  deployMode: "local_solo" | "shared_private" | "shared_public";
  autonomyMode: "hands_on" | "hybrid" | "full_auto";
  primaryRuntime: "claude_code" | "codex" | "openclaw" | "other";
};
```

Questions:

1. What are you building?
2. Is this a new company, an existing company, or a service/agency team?
3. Are you working solo on one machine, sharing privately with a team, or deploying publicly?
4. Do you want full auto, hybrid, or tight manual control?

Then Paperclip should:

- detect installed CLIs/providers/subscriptions
- recommend the matching deployment/auth mode
- generate a local `onboarding.txt` / LLM handoff prompt
- offer a button: **“Open this in Claude / copy setup prompt”**
- create starter objects:

  - company
  - company goal
  - CEO
  - founding engineer or equivalent first report
  - first suggested task

### Backend / API

- Add `GET /api/onboarding/recommendation`
- Add `GET /api/onboarding/llm-handoff.txt`
- Reuse existing invite/onboarding/skills patterns for local-first bootstrap
- Persist onboarding answers into instance config for later defaults

### Acceptance criteria

- Fresh install with a supported local runtime completes without manual JSON/env editing.
- User sees first live agent action before leaving onboarding.
- A blank dashboard is no longer the default post-install state.
- If a required dependency is missing, the error is prescriptive and fixable from the UI/CLI.

### Non-goals

- Account creation
- enterprise SSO
- perfect provider auto-detection for every runtime

---

## 2) Board command surface, not generic chat

There is a real tension here: the transcript says users want “chat with my CEO,” while the public product definition says Paperclip is **not a chatbot** and V1 communication is **tasks + comments only**. At the same time, the repo is already exploring plugin infrastructure and even a chat plugin via plugin SSE streaming. The clean resolution is: **make the core surface conversational, but keep the data model task/thread-centric; reserve full chat as an optional plugin**. ([GitHub][2])

### Product decision

Build a **Command Composer** backed by issues/comments/approvals, not a separate chat subsystem.

### What we want

- “Talk to the CEO” feeling for the user.
- Every conversation ends up attached to a real company object.
- Strategy discussion can produce issues, artifacts, and approvals.

### What we do not want

- A blank “chat with AI” home screen disconnected from the org.
- Yet another agent-chat product.

### Proposed UX

Add a global composer with modes:

```ts
type ComposerMode = "ask" | "task" | "decision";
type ThreadScope = "company" | "project" | "issue" | "agent";
```

Examples:

- On dashboard: “Ask the CEO for a hiring plan” → creates a `strategy` issue/thread scoped to the company.
- On agent page: “Tell the designer to make this cleaner” → appends an instruction comment to an issue or spawns a new delegated task.
- On approval page: “Why are you asking to hire?” → appends a board comment to the approval context.

Add issue kinds:

```ts
type IssueKind = "task" | "strategy" | "question" | "decision";
```

### Backend / data model

Prefer extending existing `issues` rather than creating `chats`:

- `issues.kind`
- `issues.scope`
- optional `issues.target_agent_id`
- comment metadata: `comment.intent = hint | correction | board_question | board_decision`

### Acceptance criteria

- A user can “ask CEO” from the dashboard and receive a response in a company-scoped thread.
- From that thread, the user can create/approve tasks with one click.
- No separate chat database is required for v1 of this feature.

### Non-goals

- consumer chat UX
- model marketplace
- general-purpose assistant unrelated to company context

---

## 3) Live org visibility + explainability layer

The core product promise is already visibility and governance, but right now the transcript makes clear that the UI is still too close to raw agent execution. The repo already has org charts, activity, heartbeat runs, costs, and agent detail surfaces; the missing piece is the explanatory layer above them. ([GitHub][1])

### Product decision

Default the UI to **human-readable operational summaries**, with raw logs one layer down.

### What we want

- At company level: “who is active, what are they doing, what is moving between teams”
- At agent level: “what is the plan, what step is complete, what outputs were produced”
- At run level: “summary first, transcript second”

### Proposed UX

Company page:

- org chart with live active-state indicators
- delegation animation between nodes when work moves
- current open priorities
- pending approvals
- burn / budget warning strip

Agent page:

- status card
- current issue
- plan checklist
- latest artifact(s)
- summary of last run
- expandable raw trace/logs

Run page:

- **Summary**
- **Steps**
- **Raw transcript / tool calls**

### Backend / API

Generate a run view model from current run/activity data:

```ts
type RunSummary = {
  runId: string;
  headline: string;
  objective: string | null;
  currentStep: string | null;
  completedSteps: string[];
  delegatedTo: { agentId: string; issueId?: string }[];
  artifactIds: string[];
  warnings: string[];
};
```

Phase 1 can derive this server-side from existing run logs/comments. Persist only if needed later.

### Acceptance criteria

- Board can tell what is happening without reading shell commands.
- Raw logs are still accessible, but not the default surface.
- First task / first hire / first completion moments are visibly celebrated.

### Non-goals

- overdesigned animation system
- perfect semantic summarization before core data quality exists

---

## 4) Artifact system: attachments, file browser, previews

This gap is already showing up in the repo. Storage is present, attachment endpoints exist, but current issues show that attachments are still effectively image-centric and comment attachment rendering is incomplete. At the same time, your transcript wants plans, docs, files, and generated web pages surfaced cleanly. ([GitHub][4])

### Product decision

Introduce a first-class **Artifact** model that unifies:

- uploaded/generated files
- workspace files of interest
- preview URLs
- generated docs/reports

### What we want

- Plans, specs, CSVs, markdown, PDFs, logs, JSON, HTML outputs
- easy discoverability from the issue/run/company pages
- a lightweight file browser for project workspaces
- preview links for generated websites/apps

### What we do not want

- forcing agents to paste everything inline into comments
- HTML stuffed into comment bodies as a workaround
- a full web IDE

### Phase 1: fix the obvious gaps

- Accept non-image MIME types for issue attachments
- Attach files to comments correctly
- Show file metadata + download/open on issue page

### Phase 2: introduce artifacts

```ts
type ArtifactKind = "attachment" | "workspace_file" | "preview" | "report_link";

interface Artifact {
  id: string;
  companyId: string;
  issueId?: string;
  runId?: string;
  agentId?: string;
  kind: ArtifactKind;
  title: string;
  mimeType?: string;
  filename?: string;
  sizeBytes?: number;
  storageKind: "local_disk" | "s3" | "external_url";
  contentPath?: string;
  previewUrl?: string;
  metadata: Record<string, unknown>;
}
```

### UX

Issue page gets a **Deliverables** section:

- Files
- Reports
- Preview links
- Latest generated artifact highlighted at top

Project page gets a **Files** tab:

- folder tree
- recent changes
- “Open produced files” shortcut

### Preview handling

For HTML/static outputs:

- local deploy → open local preview URL
- shared/public deploy → host via configured preview service or static storage
- preview URL is registered back onto the issue as an artifact

### Acceptance criteria

- Agents can attach `.md`, `.txt`, `.json`, `.csv`, `.pdf`, and `.html`.
- Users can open/download them from the issue page.
- A generated static site can be opened from an issue without hunting through the filesystem.

### Non-goals

- browser IDE
- collaborative docs editor
- full object-storage admin UI

---

## 5) Shared/cloud deployment + cloud runtimes

The repo already has a clear deployment story in docs: `local_trusted`, `authenticated/private`, and `authenticated/public`, plus Tailscale guidance. The roadmap explicitly calls out cloud agents like Cursor / e2b. That means the next step is not inventing a deployment model; it is making the shared/cloud path canonical and production-usable. ([GitHub][5])

### Product decision

Make **shared/private deploy** and **public/cloud deploy** first-class supported modes, and add **remote runtime drivers** for cloud-executed agents.

### What we want

- one instance a team can actually share
- local-first path that upgrades to private/public without a mental model change
- remote agent execution for non-local runtimes

### Proposed architecture

Separate **control plane** from **execution runtime** more explicitly:

```ts
type RuntimeDriver = "local_process" | "remote_sandbox" | "webhook";

interface ExecutionHandle {
  externalRunId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  previewUrl?: string;
  logsUrl?: string;
}
```

First remote driver: `remote_sandbox` for e2b-style execution.

### Deliverables

- canonical deploy recipes:

  - local solo
  - shared private (Tailscale/private auth)
  - public cloud (managed Postgres + object storage + public URL)

- runtime health page
- adapter/runtime capability matrix
- one official reference deployment path

### UX

New “Deployment” settings page:

- instance mode
- auth/exposure
- storage/database status
- runtime drivers configured
- health and reachability checks

### Acceptance criteria

- Two humans can log into one authenticated/private instance and use it concurrently.
- A public deployment can run agents via at least one remote runtime.
- `doctor` catches missing public/private config and gives concrete fixes.

### Non-goals

- fully managed Paperclip SaaS
- every possible cloud provider in v1

---

## 6) Multi-human collaboration (minimal, not enterprise RBAC)

This is the biggest deliberate departure from the current V1 spec. Publicly, V1 still says “single human board operator” and puts role-based human granularity out of scope. But the transcript is right that shared use is necessary if Paperclip is going to be real for teams. The key is to do a **minimal collaboration model**, not a giant permission system. ([GitHub][2])

### Product decision

Ship **coarse multi-user company memberships**, not fine-grained enterprise RBAC.

### Proposed roles

```ts
type CompanyRole = "owner" | "admin" | "operator" | "viewer";
```

- **owner**: instance/company ownership, user invites, config
- **admin**: manage org, agents, budgets, approvals
- **operator**: create/update issues, interact with agents, view artifacts
- **viewer**: read-only

### Data model

```ts
interface CompanyMembership {
  userId: string;
  companyId: string;
  role: CompanyRole;
  invitedByUserId: string;
  createdAt: string;
}
```

Stretch goal later:

- optional project/team scoping

### What we want

- shared dashboard for real teams
- user attribution in activity log
- simple invite flow
- company-level isolation preserved

### What we do not want

- per-field ACLs
- SCIM/SSO/enterprise admin consoles
- ten permission toggles per page

### Acceptance criteria

- Team of 3 can use one shared Paperclip instance.
- Every user action is attributed correctly in activity.
- Company membership boundaries are enforced.
- Viewer cannot mutate; operator/admin can.

### Non-goals

- enterprise RBAC
- cross-company matrix permissions
- multi-board governance logic in first cut

---

## 7) Auto mode + interrupt/resume

This is a product behavior issue, not a UI nicety. If agents cannot keep working or accept course correction without restarting, the autonomy model feels fake.

### Product decision

Make auto mode and mid-run interruption first-class runtime semantics.

### What we want

- Auto mode that continues until blocked by approvals, budgets, or explicit pause.
- Mid-run “you missed this” correction without losing session continuity.
- Clear state when an agent is waiting, blocked, or paused.

### Proposed state model

```ts
type RunState =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";
```

Add board interjections as resumable input events:

```ts
interface RunMessage {
  runId: string;
  authorUserId: string;
  mode: "hint" | "correction" | "hard_override";
  body: string;
  resumeCurrentSession: boolean;
}
```

### UX

Buttons on active run:

- Pause
- Resume
- Interrupt
- Abort
- Restart from scratch

Interrupt opens a small composer that explicitly says:

- continue current session
- or restart run

### Acceptance criteria

- A board comment can resume an active session instead of spawning a fresh one.
- Session ID remains stable for “continue” path.
- UI clearly distinguishes blocked vs. waiting vs. paused.

### Non-goals

- simultaneous multi-user live editing of the same run transcript
- perfect conversational UX before runtime semantics are fixed

---

## 8) Cost safety + heartbeat/runtime hardening

This is probably the most important immediate workstream. The transcript says token burn is the highest pain, and the repo currently has active issues around budget enforcement evidence, onboarding/auth validation, and circuit-breaker style waste prevention. Public docs already promise hard budgets, and the issue tracker is pointing at the missing operational protections. ([GitHub][6])

### Product decision

Treat this as a **P0 runtime contract**, not a nice-to-have.

### Part A: deterministic wake gating

Do cheap, explicit work detection before invoking an LLM.

```ts
type WakeReason =
  | "new_assignment"
  | "new_comment"
  | "mention"
  | "approval_resolved"
  | "scheduled_scan"
  | "manual";
```

Rules:

- if no new actionable input exists, do not call the model
- scheduled scan should be a cheap policy check first, not a full reasoning pass

### Part B: budget contract

Keep the existing public promise, but make it undeniable:

- warning at 80%
- auto-pause at 100%
- visible audit trail
- explicit board override to continue

### Part C: circuit breaker

Add per-agent runtime guards:

```ts
interface CircuitBreakerConfig {
  enabled: boolean;
  maxConsecutiveNoProgress: number;
  maxConsecutiveFailures: number;
  tokenVelocityMultiplier: number;
}
```

Trip when:

- no issue/status/comment progress for N runs
- N failures in a row
- token spike vs rolling average

### Part D: refactor heartbeat service

Split current orchestration into modules:

- wake detector
- checkout/lock manager
- adapter runner
- session manager
- cost recorder
- breaker evaluator
- event streamer

### Part E: regression suite

Mandatory automated proofs for:

- onboarding/auth matrix
- 80/100 budget behavior
- no cross-company auth leakage
- no-spurious-wake idle behavior
- active-run resume/interruption
- remote runtime smoke

### Acceptance criteria

- Idle org with no new work does not generate model calls from heartbeat scans.
- 80% shows warning only.
- 100% pauses the agent and blocks continued execution until override.
- Circuit breaker pause is visible in audit/activity.
- Runtime modules have explicit contracts and are testable independently.

### Non-goals

- perfect autonomous optimization
- eliminating all wasted calls in every adapter/provider

---

## 9) Project workspaces, previews, and PR handoff — without becoming GitHub

This is the right way to resolve the code-workflow debate. The repo already has worktree-local instances, project `workspaceStrategy.provisionCommand`, and an RFC for adapter-level git worktree isolation. That is the correct architectural direction: **project execution policies and workspace isolation**, not built-in PR review. ([GitHub][7])

### Product decision

Paperclip should manage the **issue → workspace → preview/PR → review handoff** lifecycle, but leave diffs/review/merge to external tools.

### Proposed config

Prefer repo-local project config:

```yaml
# .paperclip/project.yml
execution:
  workspaceStrategy: shared | worktree | ephemeral_container
  deliveryMode: artifact | preview | pull_request
  provisionCommand: "pnpm install"
  teardownCommand: "pnpm clean"
  preview:
    command: "pnpm dev --port $PAPERCLIP_PREVIEW_PORT"
    healthPath: "/"
    ttlMinutes: 120
  vcs:
    provider: github
    repo: owner/repo
    prPerIssue: true
    baseBranch: main
```

### Rules

- For non-code projects: `deliveryMode=artifact`
- For UI/app work: `deliveryMode=preview`
- For git-backed engineering projects: `deliveryMode=pull_request`
- For git-backed projects with `prPerIssue=true`, one issue maps to one isolated branch/worktree

### UX

Issue page shows:

- workspace link/status
- preview URL if available
- PR URL if created
- “Reopen preview” button with TTL
- lifecycle:

  - `todo`
  - `in_progress`
  - `in_review`
  - `done`

### What we want

- safe parallel agent work on one repo
- previewable output
- external PR review
- project-defined hooks, not hardcoded assumptions

### What we do not want

- built-in diff viewer
- merge queue
- Jira clone
- mandatory PRs for non-code work

### Acceptance criteria

- Multiple engineer agents can work concurrently without workspace contamination.
- When a project is in PR mode, the issue contains branch/worktree/preview/PR metadata.
- Preview can be reopened on demand until TTL expires.

### Non-goals

- replacing GitHub/GitLab
- universal preview hosting for every framework on day one

---

## 10) Plugin system as the escape hatch

The roadmap already includes plugins, GitHub discussions are active around it, and there is an open issue proposing an SSE bridge specifically to enable streaming plugin UIs such as chat, logs, and monitors. This is exactly the right place for optional surfaces. ([GitHub][1])

### Product decision

Keep the control-plane core thin; put optional high-variance experiences into plugins.

### First-party plugin targets

- Chat
- Knowledge base / RAG
- Log tail / live build output
- Custom tracing or queues
- Doc editor / proposal builder

### Plugin manifest

```ts
interface PluginManifest {
  id: string;
  version: string;
  requestedPermissions: (
    | "read_company"
    | "read_issue"
    | "write_issue_comment"
    | "create_issue"
    | "stream_ui"
  )[];
  surfaces: ("company_home" | "issue_panel" | "agent_panel" | "sidebar")[];
  workerEntry: string;
  uiEntry: string;
}
```

### Platform requirements

- host ↔ worker action bridge
- SSE/UI streaming
- company-scoped auth
- permission declaration
- surface slots in UI

### Acceptance criteria

- A plugin can stream events to UI in real time.
- A chat plugin can converse without requiring chat to become the core Paperclip product.
- Plugin permissions are company-scoped and auditable.

### Non-goals

- plugins mutating core schema directly
- arbitrary privileged code execution without explicit permissions

---

## Priority order I would use

Given the repo state and the transcript, I would sequence it like this:

**P0**

1. Cost safety + heartbeat hardening
2. Guided onboarding + first-job magic
3. Shared/cloud deployment foundation
4. Artifact phase 1: non-image attachments + deliverables surfacing

**P1** 5. Board command surface 6. Visibility/explainability layer 7. Auto mode + interrupt/resume 8. Minimal multi-user collaboration

**P2** 9. Project workspace / preview / PR lifecycle 10. Plugin system + optional chat plugin 11. Template/preset expansion for startup vs agency vs internal-team onboarding

Why this order: the current repo is already getting pressure on onboarding failures, auth/onboarding validation, budget enforcement, and wasted token burn. If those are shaky, everything else feels impressive but unsafe. ([GitHub][3])

## Bottom line

The best synthesis is:

- **Keep** Paperclip as the board-level control plane.
- **Do not** make chat, code review, or workflow-building the core identity.
- **Do** make the product feel conversational, visible, output-oriented, and shared.
- **Do** make coding workflows an integration surface via workspaces/previews/PR links.
- **Use plugins** for richer edges like chat and knowledge.

That keeps the repo’s current product direction intact while solving almost every pain surfaced in the transcript.

### Key references

- README / positioning / roadmap / product boundaries. ([GitHub][1])
- Product definition. ([GitHub][8])
- V1 implementation spec and explicit non-goals. ([GitHub][2])
- Core concepts and architecture. ([GitHub][9])
- Deployment modes / Tailscale / local-to-cloud path. ([GitHub][5])
- Developing guide: worktree-local instances, provision hooks, onboarding endpoints. ([GitHub][7])
- Current issue pressure: onboarding failure, auth/onboarding validation, budget enforcement, circuit breaker, attachment gaps, plugin chat. ([GitHub][3])

[1]: https://github.com/paperclipai/paperclip "https://github.com/paperclipai/paperclip"
[2]: https://github.com/paperclipai/paperclip/blob/master/doc/SPEC-implementation.md "https://github.com/paperclipai/paperclip/blob/master/doc/SPEC-implementation.md"
[3]: https://github.com/paperclipai/paperclip/issues/704 "https://github.com/paperclipai/paperclip/issues/704"
[4]: https://github.com/paperclipai/paperclip/blob/master/docs/deploy/tailscale-private-access.md "https://github.com/paperclipai/paperclip/blob/master/docs/deploy/tailscale-private-access.md"
[5]: https://github.com/paperclipai/paperclip/blob/master/docs/deploy/deployment-modes.md "https://github.com/paperclipai/paperclip/blob/master/docs/deploy/deployment-modes.md"
[6]: https://github.com/paperclipai/paperclip/issues/692 "https://github.com/paperclipai/paperclip/issues/692"
[7]: https://github.com/paperclipai/paperclip/blob/master/doc/DEVELOPING.md "https://github.com/paperclipai/paperclip/blob/master/doc/DEVELOPING.md"
[8]: https://github.com/paperclipai/paperclip/blob/master/doc/PRODUCT.md "https://github.com/paperclipai/paperclip/blob/master/doc/PRODUCT.md"
[9]: https://github.com/paperclipai/paperclip/blob/master/docs/start/core-concepts.md "https://github.com/paperclipai/paperclip/blob/master/docs/start/core-concepts.md"
