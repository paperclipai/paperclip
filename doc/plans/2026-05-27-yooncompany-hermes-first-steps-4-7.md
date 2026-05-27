# YoonCompany Hermes-First Steps 4-7 Plan - 2026-05-27

## Status

- Status: proposal-only planning document.
- Risk level: L1.
- Persistent Hermes/Paperclip config changes executed: none.
- DB writes executed: none.
- Git commit/push/PR/merge executed: none.

This document covers steps 4-7 from the Hermes-first redesign sequence:

4. Hermes profile design
5. Paperclip-Hermes mapping
6. Approval-gated Hermes capability enablement
7. UI advanced work reorder

## Step 4: Hermes Profile Design

Hermes should become the runtime center through profiles. Profiles are not cosmetic labels; each profile has its own Hermes home, config, env, SOUL, memory, sessions, skills, cron jobs, and state.

### Proposed profile roster

| Profile | Purpose | Default toolsets | Mutates repo? | Paperclip role |
| --- | --- | --- | --- | --- |
| `yoon-orchestrator` | Routes work, decomposes tasks, owns Hermes Kanban | `kanban,memory,skills,session_search,web,browser` | No | Orchestrator |
| `yoon-research` | Public research, market scans, source summaries | `web,browser,memory,skills,session_search` | No | Research |
| `yoon-docs` | Internal docs, handoffs, summaries, procedure drafts | `file,memory,skills,session_search` | Proposal only at first | Docs |
| `yoon-business` | Business division planning and KPI work | `web,browser,memory,skills,session_search` | No | Business |
| `yoon-startup` | Everyone's Startup division planning | `web,browser,memory,skills,session_search` | No | Startup |
| `yoon-academy` | Academy/Tinker operations | `web,browser,memory,skills,session_search` | No | Academy Ops |
| `yoon-media` | YouTube/content production pipeline planning | `kanban,web,browser,memory,skills,session_search` | No | Media Ops |
| `yoon-tincolive` | TincoLive product/development planning | `kanban,web,browser,memory,skills,session_search` | No | Product Ops |
| `yoon-codex-bridge` | Creates/audits Paperclip issues for Codex implementation | `kanban,web,memory,skills,session_search` | No | Dev Bridge |

### Orchestrator rule

The orchestrator does not directly edit product repos in phase 1. It decomposes work, creates Hermes Kanban tasks, and asks Paperclip/Codex for implementation when repo mutation is needed.

Safe flow:

```text
yoon-orchestrator
-> Hermes Kanban child tasks for research/docs/business/media
-> Paperclip issue for Codex when code changes are required
-> Codex implements and reports evidence
-> yoon-orchestrator reads result and continues
```

### Profile creation requirements

Creating these profiles is L3 because it changes persistent Hermes state. Before execution, an approval must specify:

- exact profile names
- HERMES_HOME/profile paths
- default model/provider
- toolsets per profile
- whether each profile has write-capable tools
- rollback plan
- verification command

No profile creation should occur from this document alone.

## Step 5: Paperclip-Hermes Mapping

Paperclip and Hermes should not compete for the same meaning.

### Object ownership

| Object | Owner | Purpose |
| --- | --- | --- |
| Paperclip company | Paperclip | Business/account boundary |
| Paperclip issue | Paperclip | Governance, assignment, approval, audit |
| Paperclip approval | Paperclip | Human gate for L3/L4 |
| Hermes profile | Hermes | Agent identity/runtime/memory |
| Hermes Kanban board | Hermes | Durable multi-profile work queue |
| Hermes Kanban task | Hermes | Actual subtask/handoff object |
| Codex run | Paperclip/Codex | Repo implementation and verification evidence |

### Required cross-link fields

Every cross-system handoff should include these fields in comments or metadata before any schema work:

```yaml
paperclip_issue_id:
paperclip_issue_identifier:
paperclip_approval_id: none
hermes_board:
hermes_task_id:
hermes_profile:
codex_agent_id:
codex_run_id:
risk_level:
dangerous_actions_executed:
verification:
```

### Phase 1 storage rule

Do not add DB schema yet. Start with structured markdown blocks in:

- Paperclip issue body
- Paperclip issue comments
- Hermes Kanban task body
- Hermes Kanban completion summaries

Schema/indexing can come after the format proves useful.

### Mapping examples

Research task:

```text
Paperclip issue YOO-101
-> Hermes board yooncompany
-> Hermes task hk_abc123 assigned to yoon-research
-> Completion summary linked back to YOO-101
```

Code task:

```text
Hermes task hk_devplan_001
-> Paperclip issue YOO-120 assigned to Codex Lead Engineer
-> Codex run cr_123
-> Codex completion comment contains verification
-> Hermes orchestrator reads YOO-120 result
```

## Step 6: Approval-Gated Hermes Capability Enablement

Actual capability enablement is L3 and must not be performed without Paperclip approval.

### First approval package

Title:

```text
Approve Hermes-first phase 1 persistent configuration
```

Requested action:

```text
Create Hermes orchestrator profile proposal and update Paperclip display/config only for read-only visibility. Do not enable autonomous heartbeat or repo-writing Hermes behavior yet.
```

Exact targets:

```text
Hermes profiles: yoon-orchestrator, yoon-research, yoon-docs
Paperclip agent: add or reconfigure a Hermes Orchestrator display agent
Paperclip UI: read-only status/links only
```

Allowed changes if approved:

- create profile directories
- write profile SOUL/config templates
- add Paperclip agent record or update a non-running draft agent
- keep heartbeat disabled
- keep repo write prohibited
- keep Paperclip issues as execution gates

Explicitly not allowed:

- no deploy
- no push/merge/PR publish
- no email/send/external publish
- no autonomous heartbeat
- no DB direct writes outside approved Paperclip API calls
- no repo write permission for Hermes
- no cost-changing external service activation

Verification plan:

```powershell
C:\yooncompany\bin\hermes.exe profile list
C:\yooncompany\bin\hermes.exe profile show yoon-orchestrator
C:\yooncompany\bin\hermes.exe tools list
Invoke-RestMethod http://127.0.0.1:3100/api/companies/a01eddd0-d750-43ea-8858-d1cb087c4de2/agents
```

Rollback:

- remove or archive newly created Hermes profiles
- restore previous Paperclip agent config from captured JSON
- leave existing `Hermes Research Worker` untouched until orchestrator is verified

### Toolset enablement ladder

Do not enable everything at once. Use this order:

1. `persistSession` for orchestrator profile
2. `file` for approved local docs/workspace inspection
3. `browser` for authenticated/public UI inspection
4. `mcp` only after explicit MCP server allowlist
5. `delegation` for short synchronous subagent work
6. `kanban` for durable multi-profile routing
7. heartbeat/cron only after rollback and stop controls are visible

## Step 7: UI Advanced Work Reorder

The previous UI plan was useful but in the wrong order. It should now be reordered around Hermes-first visibility.

### New UI order

1. Hermes-first status block in the global panel.
2. Hermes runtime page or dashboard section:
   - Hermes version
   - adapter version
   - Paperclip toolsets
   - missing orchestration toolsets
   - `persistSession`
   - `--yolo`
   - profile/HERMES_HOME path
3. Hermes profile roster:
   - profile name
   - role/description
   - enabled toolsets
   - memory/skills/session state
4. Hermes Kanban read-only view:
   - boards
   - task counts
   - running/blocked/done
   - assignee profile
5. Paperclip issue <-> Hermes task cross-links.
6. Then resume Koreanization of remaining body text.
7. Then improve global question panel v2 as Hermes-first intake:
   - route to orchestrator, research, docs, or Codex bridge
   - default backlog draft
   - no direct execution
8. Then screen context auto-attach:
   - route/title/entity id first
   - screenshot later after secret redaction design

### What changed in the implementation slices

The existing global question panel and dashboard now include read-only Hermes status blocks based on current Paperclip agent config. They surface:

- current Hermes role/title
- configured Paperclip toolsets
- missing core orchestration toolsets
- session persistence state
- `--yolo` and `canCreateAgents` safety signals
- warning that current state is closer to a restricted research worker than an orchestrator

This is intentionally read-only. It does not mutate Hermes or Paperclip agent config.

Additional follow-up applied:

- shared the Hermes status calculation in `ui/src/lib/yooncompany-hermes-status.ts`
- added `YoonCompanyHermesStatusPanel` to the main dashboard
- changed the global question panel default target from Codex-first to Hermes orchestration-first
- added explicit read-only warnings for adapter-managed `--yolo`, duplicate `--yolo` risk, and `--max-turns` still living in raw `extraArgs`
- added a dashboard approval package preview for phase 1 profile/toolset/Kanban enablement, including target profiles and actions blocked until approval
- added a global question panel action that opens the phase 1 Hermes approval package as a Paperclip issue draft, with no assignee and no execution
- added a dashboard profile roster preview for the planned Hermes profiles across phase 1 and later business/startup/academy/media/TincoLive divisions
- added a dashboard Hermes Kanban read-only preview and Paperclip/Hermes cross-link template, with no board/task creation and no DB schema change
- added visible current-screen context preview to the global question panel so users can see what will be auto-attached to Hermes/Codex issue drafts
- upgraded `hermes-paperclip-adapter` to `0.3.0` in server/ui package files and lockfile
- did not create Hermes profiles, enable Hermes Kanban, enable heartbeat, or write Paperclip DB state

## Next Safe Command

The next implementation command should be:

```text
6002로 Hermes profile/toolset/Kanban 활성화 승인 패키지를 Paperclip approval 이슈로 만들고, 승인 전에는 실제 Hermes/Paperclip 설정을 변경하지 마라.
```

Do not ask for direct profile creation until the approval package is accepted.
