# Paperclip — Product Definition

Reusable workflows stay inside the Cases experiment. A workflow is a company-shared
name and Markdown prompt; a case may adopt, leave and revisit workflows without
changing its primary task. The task's workflow document is the effective copy,
so shared edits affect future adoptions and explicit refreshes. Existing handoffs
record workflow/phase movement and document revisions, including names as they
were at the time. Authoring starts with agents/APIs; the case UI reads current
workflow information and history.

## What It Is

Paperclip is the control plane for autonomous AI companies. One instance of Paperclip can run multiple companies. A **company** is a first-order object.

## Core Concepts

### Company

A company has:

- A **goal** — the reason it exists ("Create the #1 AI note-taking app that does $1M MRR within 3 months")
- **Employees** — every employee is an AI agent
- **Org structure** — who reports to whom
- **Revenue & expenses** — tracked at the company level
- **Task hierarchy** — all work traces back to the company goal

### Employees & Agents

Every employee is an agent. When you create a company, you start by defining the CEO, then build out from there.

Each employee has:

- **Adapter type + config** — how this agent runs and what defines its identity/behavior. This is adapter-specific (e.g., an OpenClaw agent might use SOUL.md and HEARTBEAT.md files; a Claude Code agent might use CLAUDE.md; a bare script might use CLI args). Paperclip doesn't prescribe the format — the adapter does.
- **Role & reporting** — their title, who they report to, who reports to them
- **Capabilities description** — a short paragraph on what this agent does and when they're relevant (helps other agents discover who can help with what)

Example: A CEO agent's adapter config tells it to "review what your executives are doing, check company metrics, reprioritize if needed, assign new strategic initiatives" on each heartbeat. An engineer's config tells it to "check assigned tasks, pick the highest priority, and work it."

Then you define who reports to the CEO: a CTO managing programmers, a CMO managing the marketing team, and so on. Every agent in the tree gets their own adapter configuration.

Each person also has a personal primary agent per company. Their first human-created
agent becomes primary automatically; they can choose another from its profile.
An existing primary is replaced only after confirmation. The crown appears on the
profile and roster, while the primary stays first in the Agents sidebar without a
sidebar crown. Stars remain independent. Task drafts, explicit assignments, and
recent choices take precedence over the primary; Chat similarly reopens a valid
recent conversation before falling back to the primary. Opening Chat does not
start execution. This preference does not change the org chart or permissions.

### Agent Execution

Agents have an **Advanced** tab for editing their settings across all configuration tabs
as a versioned YAML document. Instructions, skills, tools, channels, trust,
secret operations, API keys, and revision restore use their existing domain APIs.
It edits the same configuration as the regular settings pages, validates before saving, preserves masked secrets, and rejects
stale edits. See [Agent configuration YAML](agent-configuration-yaml.md).

Existing Claude, Codex, and Grok Build agents can upgrade from the legacy runner on their
Harness / Runtime page when Paperclip Runner is the qualified default for their
environment. One action saves pending edits and translates compatible settings
while keeping the harness, selected model, account bindings, instructions, and
history. Unsupported settings produce an actionable error without changing the
saved agent. Future runs start fresh sessions.

Qualifying an existing agent's sandbox for that upgrade uses the same agent
configuration permission as saving the upgrade. The server checks the saved
computer and its company binding. Company owners do not need instance-admin
access for this step; general instance environment management remains restricted.

Paperclip supports several ways to run an agent's heartbeat:

1. **Local CLI/session adapters** — Paperclip starts or resumes local coding-tool sessions such as Claude Code, Codex, Gemini, OpenCode, Pi, and Cursor, then tracks the run.
2. **Run a command** — Paperclip kicks off a process (shell command, Python script, etc.) and tracks it. The heartbeat is "execute this and monitor it."
3. **Fire and forget a request** — Paperclip sends a webhook/API call to an externally running agent. The heartbeat is "notify this agent to wake up." OpenClaw-style hooks work this way.
4. **External adapter plugins** — Paperclip loads adapter packages through the plugin/adapter flow so self-hosted installs can add runtimes without hardcoding them in core.

Agent runs can use project and execution workspaces, managed runtime services such as preview/dev servers, adapter-specific session state, and HTTP/webhook-style execution. We provide sensible defaults, but the adapter is still the boundary: if a runtime can be invoked, observed, and authorized, Paperclip can coordinate it.

### Task Management

Task management is hierarchical. At any moment, every piece of work must trace back to the company's top-level goal through a chain of parent tasks:

```
I am researching the Facebook ads Granola uses (current task)
  because → I need to create Facebook ads for our software (parent)
    because → I need to grow new signups by 100 users (parent)
      because → I need to get revenue to $2,000 this week (parent)
        because → ...
          because → We're building the #1 AI note-taking app to $1M MRR in 3 months
```

Tasks have parentage. Every task exists in service of a parent task, all the way up to the company goal. This is what keeps autonomous agents aligned — they can always answer "why am I doing this?"

The current issue model includes stable issue identifiers, parent/sub-issues, blockers, a single assignee, comments, issue documents, attachments and work products, and review/approval handoffs. That structure keeps work inspectable by both the board and agents while still allowing agents to decompose work into smaller tasks.

Automatic monitor checks pause when a task is blocked. A person can use Check now
to request one check of a retained monitor through normal execution admission.
Dependencies, recovery, pause, budgets and ownership still apply. Provider-usage
recovery stays paused until the task resumes. A check that
cannot start reports that result instead of claiming it was queued.

The experimental Cases feature also supports persistent work records and
prompt-driven agent handoffs. Native case creation requires kickoff and creates
one primary task; later handoffs move that same task
between agents with a phase and instructions. The case retains facts, document references,
and history while normal task assignments form each agent's queue. Task sessions,
workspaces, private access, review rules, and human intervention remain part of
the ordinary execution model. Ordinary task completion leaves case status unchanged.
An explicit handoff to `done` closes the case when primary-task completion is
accepted through the existing gates; review and human waits keep it open.

Native agents can create, read and update case facts through dedicated tools.
Creation always includes a kickoff and either `workflowId` or explicit `workflow_document_text`.
The latter becomes the primary task's Markdown `workflow` document, describing
phase owners, routing, evidence and completion rules. Agents read it before
choosing their next step. Recommended authoring includes both a Mermaid
`stateDiagram-v2` map and prose explaining each transition's conditions, evidence,
destination agent, human waits and correction limits. Transitions remain advisory. Initial documents belong to
the first task and are saved before its agent wakes; the case displays documents
from its primary and accessible linked tasks without copying them. Agents use
ordinary task document tools; historical case-owned documents remain readable.
Each phase receives its current handoff instructions;
compatible resumed sessions receive changed facts without repeating unchanged
case contents. Agents can read current persisted data whenever they need it.

Case pages are a lightweight read-only view: search or filter the list, open a
record, read its findings and documents, and follow its current task and handoff
history. Agents and APIs author the records; the pages have no editing controls.

When a task is assigned to the current human, the message composer defaults to
the latest agent that assigned it to them. If no assignment is available, it uses
the latest other commenter, or leaves the recipient empty. A manual recipient
choice stays selected while task data refreshes.

### Task collection creation filters

Tasks and project lists hide agent-created and system-created tasks by default.
The Filters menu's **show agent-created tasks** checkbox includes routine runs,
recovery/watchdog tasks, chat-channel tasks, and other automation. Channel tasks
remain bot-created for this filter even when a human starts the conversation. The choice is saved per company
and collection; Clear filters restores the hidden default. Nested lists preserve
ancestors and expandable subtasks as context without promoting unrelated automated
work to independent results. Agent profiles, routine histories, and task-detail
subtasks retain their full history.

Mine contains personal work. Channel tasks, routine tasks, and agent-created tasks
stay outside Mine by default. This includes routines that a person starts manually.
Linked accounts, creator IDs, responsible-user IDs, synchronized provider comments,
and read markers do not establish participation in automatic work. Direct board or
human API comments, human assignment, and deliberate user mutations do establish
participation. Open requests addressed to the person also admit the task until
resolution. Ordinary human-created tasks keep their creator's participation.
These rules apply to existing tasks, Mine, unread counts, badges, and task toasts.
Approvals retain their existing recipient and permission rules.

An advisory PR review does not require human completion approval because its
rating is low, CI is pending or failing, or the PR is unmerged. After publication,
the bot may stay in review with an authorized provider-event wait or a saved
monitor. Neither wait enrolls a person in Mine. Human requests are for concrete
dependencies of the assigned review, such as missing repository access.
A later published review with no human dependency withdraws the same bot's
earlier completion request for a published review when its result commits and
independent gates are clear. Finish-report validation is read-only. Independent approval gates
and requests without that review evidence remain unchanged.

New inbound comments retain their provider in `metadata.sourceChannel`. Historical
imports use inbound message links or the stored provider-sender metadata. These
checks preserve direct board comments on channel tasks. If both historical
records are absent, the comment remains unclassified and keeps its previous
behavior. A task origin alone cannot prove the source of an old comment.

Inbox discovery searches and Blocked hide unrelated automatic tasks unless the
checkbox is checked. The checkbox does not subscribe a person to automatic work.
Source feeds and project task lists retain their existing access rules.

### Company Skills and Policy

Company skills are shared operating capabilities, not privileged objects by default. Every authenticated agent in a company can create, import, install, edit, update, test, reset, and remove that company's skills unless the company has configured an explicit restriction.

The governing rule is: **skill permissions are opt-in restrictions, not opt-in capabilities**. Missing skill grants never create a denial in an otherwise unconfigured company, and ordinary skill work does not require board confirmation, a draft-only workflow, or an activation approval.

Core Paperclip owns the skill runtime, company-boundary enforcement, policy evaluation contract, API denials, validation, path containment, secret redaction, and activity logging. Those safety invariants cannot be disabled by policy. Open-by-default skill work never authorizes arbitrary host-path reads, unsafe executable content, or policy edits: local imports and scans must stay within Paperclip-known workspace or managed-skill roots, remote sources must resolve to validated immutable content, and platform safety denials must stay distinct from optional administrative restrictions. Paperclip EE may provide detailed administration for per-agent, per-role, per-action, per-source, and protected-skill rules, but EE is not required to use skills and is not an enforcement boundary. Without EE, companies remain open by default and any already-configured restrictions continue to be enforced by core.

GitHub repositories attached to new projects automatically become skill sources.
Paperclip imports their skills and checks the configured branch every five minutes,
using the setup person's authorized GitHub connection. New skills import automatically
unless excluded. Existing projects can adopt their repositories from Skills → Sources;
existing manually imported sources preserve their selections and gain automatic updates.
Refresh remains available, and operators can pause automatic updates.
Independent skill sources have a searchable branch picker with the repository's
default branch marked. People can also enter a branch name that is not listed.
Saving checks GitHub access and the selected ref before changing tracking; failed
saves keep the selection and installed content. Project refs remain owned by project
configuration so changing a source cannot redirect another project's tracking.
If a repository exceeds the supported package size, Paperclip first packages its
skill folders and referenced repository files, preserving their original paths.
Missing references are advisory: a valid selected skill can still be imported.
Unavailable files are listed, and existing installed dependencies are retained
when a bounded refresh cannot preserve them. File limits and content validation
still apply; importing never executes repository code.
Authored and unproven legacy versions retain an independent recovery copy. Unused Git
packages with an exact restore recipe may expire; later use requires access to that
original repository and commit.
External package storage keeps repository contents out of the control-plane database;
per-turn checks reuse verified local files while rechecking current skill access.
See [automatic storage and recovery](skill-package-storage.md).

Project-derived skills inherit current project access. Access through any originating
project is sufficient, including the responsible-user restrictions on agent execution.
Existing explicit company imports retain their visibility. Editable copies inherit
project restrictions; private content cannot be published or exported implicitly.
Detachment retains installed content and access provenance. Deleting its last project
never makes a skill company-visible.

Task and routine skill mentions remain stable references to the latest installed version.
Each execution records the immutable versions it uses; resuming keeps those versions,
while a new execution resolves latest again. Upstream failures and removals preserve
installed snapshots. GitHub refresh does not delay task execution.

Old, unused skill-version disk caches expire automatically while current and in-use
versions remain. Saved database snapshots rebuild an expired copy on demand, including
when its upstream repository is unavailable. Recovery data has separate retention.

Disconnecting removes a repository from Sources after an explicit choice: keep
independent editable copies in My Skills, or delete its imported skills. Kept
copies and derived forks retain their project access restrictions. Copies preserve
agent assignments; skills used by agents must be detached before deletion.

An explicit restricted policy may deny selected operations or switch to a default-deny preset with explicit allow rules. Core exposes a stable versioned policy API so EE and other administrative clients configure and simulate the same evaluator used by skill mutation routes. Core Skill Studio only needs to perform normal skill work, explain an explicit denial, and point administrators to EE when its richer policy UI is available; it must not recreate a partial enterprise permission editor.

## Principles

1. **Unopinionated about how you run your agents.** Your agents could be OpenClaw bots, Python scripts, Node scripts, Claude Code sessions, Codex instances — we don't care. Paperclip defines the control plane for communication and provides utility infrastructure for heartbeats. It does not mandate an agent runtime.

2. **Company is the unit of organization.** Everything lives under a company. One Paperclip instance, many companies.

3. **Adapter config defines the agent.** Every agent has an adapter type and configuration that controls its identity and behavior. The minimum contract is just "be callable."

4. **All work traces to the goal.** Hierarchical task management means nothing exists in isolation. If you can't explain why a task matters to the company goal, it shouldn't exist.

5. **Control plane, not execution plane.** Paperclip orchestrates. Agents run wherever they run and phone home.

## User Flow (Dream Scenario)

1. Open Paperclip, create a new company
2. Define the company's goal: "Create the #1 AI note-taking app, $1M MRR in 3 months"
3. Create the CEO
   - Choose an adapter (e.g., process adapter for Claude Code, HTTP adapter for OpenClaw)
   - Configure the adapter (agent identity, loop behavior, execution settings)
   - CEO proposes strategic breakdown → board approves
4. Define the CEO's reports: CTO, CMO, CFO, etc.
   - Each gets their own adapter config and role definition
5. Define their reports: engineers under CTO, marketers under CMO, etc.
6. Set budgets, define initial strategic tasks
7. Hit go — agents start their heartbeats and the company runs

## Guidelines

There are two runtime modes Paperclip must support:

- `local_trusted` (default): single-user local trusted deployment with no login friction
- `authenticated`: login-required mode that supports both private-network and public deployment exposure policies

Canonical mode design and command expectations live in `doc/DEPLOYMENT-MODES.md`.

## Further Detail

See [SPEC.md](./SPEC.md) for the full technical specification and [TASKS.md](./TASKS.md) for the task management data model.

---

Paperclip’s core identity is a **control plane for autonomous AI companies**, centered on **companies, org charts, goals, issues/comments, heartbeats, budgets, approvals, and board governance**. The public docs are also explicit about the current boundaries: **tasks/comments are the built-in communication model**, Paperclip is **not a chatbot**, and it is **not a code review tool**. The roadmap already points toward **easier onboarding, cloud agents, easier agent configuration, plugins, better docs, and ClipMart/ClipHub-style reusable companies/templates**.

## What Paperclip should do vs. not do

**Do**

- Stay **board-level and company-level**. Users should manage goals, orgs, budgets, approvals, and outputs.
- Make the first five minutes feel magical: install, answer a few questions, see a CEO do something real.
- Keep work anchored to **issues/comments/projects/goals**, even if the surface feels conversational.
- Treat **agency / internal team / startup** as the same underlying abstraction with different templates and labels.
- Make outputs first-class: files, docs, reports, previews, links, screenshots.
- Provide **hooks into engineering workflows**: worktrees, preview servers, PR links, external review tools.
- Use **plugins** for edge cases like rich chat, knowledge bases, doc editors, custom tracing.

**Do not**

- Do not make the core product a general chat app. The current product definition is explicitly task/comment-centric and “not a chatbot,” and that boundary is valuable.
- Do not build a complete Jira/GitHub replacement. The repo/docs already position Paperclip as organization orchestration, not focused on pull-request review.
- Do not build enterprise-grade RBAC first. Paperclip now has authenticated mode, company memberships, instance roles, and permission grants, but fine-grained enterprise governance should remain secondary to the core company control plane.
- Do not interpret agent-profile privacy flags as project/issue privacy. Work remains company-open by default, while explicitly private issues and projects use their own task ACLs.
- Do not lead with raw bash logs and transcripts. Default view should be human-readable intent/progress, with raw detail beneath.
- Do not force users to understand provider/API-key plumbing unless absolutely necessary. There are active onboarding/auth issues already; friction here is clearly real.

## Specific design goals

1. **Time-to-first-success under 5 minutes**
   A fresh user should go from install to “my CEO completed a first task” in one sitting.

2. **Board-level abstraction always wins**
   The default UI should answer: what is the company doing, who is doing it, why does it matter, what did it cost, and what needs my approval.

3. **Conversation stays attached to work objects**
   “Chat with CEO” should still resolve to strategy threads, decisions, tasks, or approvals.

4. **Progressive disclosure**
   Top layer: human-readable summary. Middle layer: checklist/steps/artifacts. Bottom layer: raw logs/tool calls/transcript.

5. **Output-first**
   Work is not done until the user can see the result: file, document, preview link, screenshot, plan, or PR.

6. **Execution visibility without log worship**
   Active runs, recovery issues, blockers, and work products should be first-class surfaces. Raw transcripts are available when needed, but they are not the primary product surface.

7. **Local-first, cloud-ready**
   The mental model should not change between local solo use and shared/private or public/cloud deployment.

8. **Safe autonomy**
   Auto mode is allowed; hidden token burn is not.

9. **Thin core, rich edges**
   Put optional chat, knowledge, and special surfaces into plugins/extensions rather than bloating the control plane.

### Experimental iMessage Photon channel

A Photon Cloud project can represent one agent through the existing
experimental channel subsystem. DMs and explicitly enabled groups create or
continue task-bound conversations. Linked sender identity is the default;
telephone numbers, email addresses, names, and group membership do not grant
Paperclip authority. Photos/files and ordinary questions/confirmations use the
existing attachment, interaction, continuation, and publication contracts.
Pause and Disconnect govern runtime behavior independently of the UI gate.
Local Mac access, unsolicited conversations, and SMS/RCS
fallback are excluded. Live qualification is required before release readiness.
Pro shared allocation supports DMs only, with sender enrollment in Photon and
separate identity linking in Paperclip. Shared channels reserve one project, not
a pool phone number; group admission and publication are disabled. Dedicated
allocation retains one selected number and individually enabled groups.

See [iMessage Photon](connections/IMESSAGE-PHOTON.md) for the implementation
contract, setup, recovery, boundaries, and qualification status.
### Experimental persistent agent conversations

Agent Chat is an opt-in core task presentation (`enableAgentChat`, off by default). Each person has one persistent task-backed conversation per agent and company, with ordinary company task visibility. The shared task composer, transcript, tools, files, and document panel remain the interaction surface. Agents clarify goals and hand substantial execution to linked, assigned tasks; a reply ends a turn without completing the conversation. `/new` starts fresh provider context in the same conversation while preserving visible history and artifacts. Healthy idle conversations wait for a message and do not count as unfinished execution work. See `doc/plans/2026-09-10-agent-chat.md` for the implementation contract.

### Agent chat project handoff (2026-09-11)

Chat supports research and full plan drafting/revision in its existing plan document. On handoff, each ordinary assigned task receives the relevant plan in its own `plan` document, committed with task creation before execution is scheduled. The source plan remains in the conversation. Plan acceptance hands off execution; it never switches the conversation into implementation.

Chat instructions require selecting a suitable project, reusing an existing one where appropriate. The project requirement is prompt-only; ordinary projectless tasks remain supported. New parent relationships beneath conversation tasks are rejected by task services, including direct API creation and reparenting. Existing children remain readable/editable and can be moved elsewhere. The Subtasks panel is unchanged.

The `create_project` runtime tool uses the normal project API with durable idempotency. `list_projects` and `list_project_repositories` support selection. Multiple `repositoryIds` select authorized catalog entries; multiple HTTPS GitHub `repositoryUrls` register existing repositories absent from the catalog. IDs and URLs may be combined, but cannot accompany an explicit `workspace`. URLs do not create repositories on GitHub or grant credentials. Execution uses normal repository access rules. Repository IDs are revalidated against the authenticated run's responsible user and connection grants. Agents should consider proper available repositories, clarify material ambiguity, and use repository-free projects when appropriate for non-code work.

Confirmed project creation appears as a durable card in the shared task transcript, including selected repository links. Tasks are linked inline. Failed creation never produces a success card. Tool evals cover planning/handoff, project/repository selection, retries, permission and mode denials, and ordinary delegation regressions using the production chat directive.

### In-app announcements

An optional announcement card shares product news with board users on opening
or returning to Paperclip. Dismissals persist per user across companies and
browsers within an instance. Operators can disable fetching independently of
telemetry. See [Announcements](ANNOUNCEMENTS.md).

### Agent chat discovery

With Agent Chat enabled, Chat is the first row of the Work section and opens a
secondary sidebar beside the primary nav. It lists every agent you can chat
with: the open conversation first, then your other conversations by recent
activity, then the rest of the roster alphabetically. Terminated agents and
agents you have left are omitted unless you have history with them. Search
filters by name, title, or role; **+** starts or reopens a conversation.
Selecting an agent opens their persistent conversation; it does not reset history
or create a task until the existing first-write flow requires one.

Beside a conversation, the side panel opens on the agent's tasks: one card per
task the agent created, was assigned, commented on, or acted on, newest first,
with the task list's filters and a sort control. The agent's artifacts are a
second card stack available from the panel's **+** menu. Both open in a new tab
so the conversation stays open.

### Combined Inbox + Task List

An opt-in experimental setting (`enableCombinedInboxTasks`, off by default)
folds Inbox into Tasks. The Inbox nav row goes away and its unread badge moves
to Tasks. A Views menu on the task list covers the inbox views (Mine, Unread,
Blocked, Recent, Everything) and the task-status views (All, Active, Backlog,
Done). Bare `/issues` opens the last-used view, defaulting to Mine; links that
carry a task filter open All. Old `/inbox` links redirect to the matching view.

### CSV file previews

Task attachment and workspace file tabs render CSV files as tables by default.
The first record supplies column headers. Row numbers, row and column counts,
and sticky headers help operators scan exports. Rendered and raw view icons
remain next to download; raw view preserves the original source. The table
shows up to 500 data rows and 100 columns, with a notice when the preview is
limited. Download retains the complete file.

### Filesystem access boundary (2026-10-20)

Filesystem isolation belongs to the OS, execution environment, and storage layout.
Paperclip authorizes the current task/run, company, explicitly selected configuration,
execution policy, and repository credentials. It does not infer file permissions from
other tasks or agents that previously used the same directory, overlapping roots,
symlink aliases, or shared Git storage. Existing files under an authorized task root
may be read subject to OS access and API path containment.

Private task records, comments, attachments, run logs, full workspace metadata, and
operation logs retain their app authorization. Workspace `_issuePrivacySources` and
operation privacy metadata protect app-record disclosure; they do not grant or deny
filesystem execution or task-bound file browsing. Current trust and sandbox policy,
publication receipts, binding checks, and lifecycle locks remain authoritative.

## Agent connection administration (2026-10-13)

Standard agents can configure connections through the same domain APIs used by the app, bounded by their grants and their responsible user's current authority. Fresh standard agents for default Operators can manage app/tool connections, chat/email channels, AI accounts and pools, profiles and gateways without additional grants. Existing grants are not backfilled; explicit restrictions persist. Gateway administration retains the responsible human's administrative permission and does not grant agents blanket `tools:admin`.

The agent performs authorized setup, reuses saved accounts and drafts, and hands off only required human authentication, consent, credential entry or identity confirmation. Saved handoffs resume through existing task continuation after current authority is rechecked. Management, tool execution and approval remain separate. Private accounts, host commands and stored credentials retain their boundaries; agent-issued gateway clients preserve issuer and responsible-user restrictions at use time.

Authorized policy administration includes user-requested changes that loosen the acting agent’s own tool controls. These writes remain bounded by management grants, resource scope and the responsible user’s current authority; they do not need an additional approval solely because the agent is a target. Subsequent tool calls obey the resulting policy. Agents cannot approve their own governed action requests or edit their own principal permission grants.

The implementation, operation inventory, permission matrix and fixture qualification are recorded in [Agent API parity for connection configuration](plans/2026-10-13-connection-api-parity.md). Provider fixtures establish API behavior; they do not constitute live provider setup or an empirical agent-success claim.
