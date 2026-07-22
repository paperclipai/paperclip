# Agent Management Follow-up Plan (CEO Patch + Config Rollback + Issue↔Approval Linking)

Status: Proposed  
Date: 2026-02-19  
Context: Follow-up from run `faeab00e-7857-4acc-b2b2-86f6d078adb4`

## 1. Investigation Findings

## 1.1 Why CEO PATCH failed

Root cause is explicit route logic:

- `server/src/routes/agents.ts` currently blocks any agent patching another agent:
  - `if (req.actor.type === "agent" && req.actor.agentId !== id) { ... "Agent can only modify itself" }`

So even though the CEO has hire permission, the route still enforces old self-only patch behavior.

## 1.2 Why comment quality felt wrong

- `skills/paperclip/SKILL.md` and `skills/paperclip/references/api-reference.md` do not currently require markdown formatting quality for status comments (links, structure, readable updates).
- Agents therefore produce plain prose comments with raw IDs, not linked entities.

## 1.3 Issue↔Approval linkage gap

- There is no direct DB relation between issues and approvals today.
- Approval payloads may include contextual IDs, but this is not canonical linkage.
- UI pages cannot reliably cross-link issue/approval without manual copy-paste IDs.

## 1.4 Config rollback gap

- Agent config updates currently overwrite state with no dedicated revision history table.
- There is activity logging, but no first-class config version ledger or rollback endpoint.

## 2. Product/Behavior Changes

## 2.1 Allow CEO to patch other same-company agents

Target behavior:

- Board: full patch rights.
- CEO: can patch agents in same company.
- Other agents: self-only patch unless explicitly granted future permission.

Note:

- Keep company boundary checks strict.
- Keep privileged fields separately governed.

## 2.2 Add first-class agent configuration revision log + rollback

Every config-affecting mutation must create a revision record with:

- before snapshot
- after snapshot
- actor info (user/agent)
- optional reason/comment
- source run ID (if available)

Rollback must be one API call that restores a prior revision atomically.

## 2.3 Enforce markdown and links for issue comments in skills

Skill guidance should require:

- short markdown structure (`Summary`, `Actions`, `Next`)
- links to created/updated entities when relevant
- avoid raw IDs without links

## 2.4 Add explicit Issue↔Approval linkage (many-to-many)

Implement canonical join model so one issue can link many approvals and one approval can link many issues.

## 3. Data Model Plan

## 3.1 New table: `agent_config_revisions`

Columns:

- `id` uuid pk
- `company_id` uuid fk
- `agent_id` uuid fk
- `revision_number` int (monotonic per agent)
- `reason` text null
- `changed_by_agent_id` uuid null
- `changed_by_user_id` text null
- `run_id` uuid null
- `before_snapshot` jsonb not null
- `after_snapshot` jsonb not null
- timestamps

Indexes:

- `(company_id, agent_id, revision_number desc)`
- `(agent_id, created_at desc)`

## 3.2 New table: `issue_approvals`

Columns:

- `id` uuid pk
- `company_id` uuid fk
- `issue_id` uuid fk
- `approval_id` uuid fk
- `relationship` text default `context`
- `linked_by_agent_id` uuid null
- `linked_by_user_id` text null
- timestamps

Constraints:

- unique `(company_id, issue_id, approval_id)`

Indexes:

- `(company_id, issue_id)`
- `(company_id, approval_id)`

## 4. API Plan

## 4.1 Agent PATCH authz fix

Update `PATCH /api/agents/:id` authz matrix:

- board: allow
- agent role `ceo` in same company: allow
- otherwise: self only

## 4.2 Separate privileged patch fields

Protect these from generic PATCH by non-board/non-ceo:

- `permissions`
- `status` transitions outside allowed scope

(Continue using dedicated permission route for permission edits.)

## 4.3 Config revision APIs

Add:

- `GET /api/agents/:id/config-revisions`
- `GET /api/agents/:id/config-revisions/:revisionId`
- `POST /api/agents/:id/config-revisions/:revisionId/rollback`

Behavior:

- rollback writes a new revision entry (does not mutate history)
- rollback response includes resulting active config

## 4.4 Issue↔Approval link APIs

Add:

- `GET /api/issues/:id/approvals`
- `POST /api/issues/:id/approvals` (link existing approval)
- `DELETE /api/issues/:id/approvals/:approvalId`
- `GET /api/approvals/:id/issues`

## 4.5 Auto-link on approval creation

Extend create payloads to optionally include issue context:

- `POST /api/companies/:companyId/approvals` supports `issueId` or `issueIds`
- `POST /api/companies/:companyId/agent-hires` supports `sourceIssueId` or `sourceIssueIds`

Server behavior:

- create approval first
- insert link rows in `issue_approvals`

## 5. UI Plan

## 5.1 Agent page

Add configuration history panel on `AgentDetail`:

- revision list
- diff preview
- rollback button with confirmation

## 5.2 Approval page and Issue page cross-links

- On approval detail: show linked issues with links
- On issue detail: show linked approvals with links
- link/unlink actions in board context

## 5.3 Better comment UX cues

No hard editor enforcement initially; update helper text and templates to encourage linked markdown updates.

## 6. Skill Updates

## 6.1 `skills/paperclip/SKILL.md`

Add comment standard:

- Use markdown sections
- Include links for related entities:
  - approval: `/approvals/{id}`
  - agent: `/agents/{id}`
  - issue: `/issues/{id}`

## 6.2 `skills/paperclip-create-agent/SKILL.md`

Require:

- include `sourceIssueId` when hire is created from an issue
- comment back to issue with markdown + links to approval and pending agent

## 7. Implementation Phases

## Phase A: Authz + safety hardening

- Fix CEO patch authz in agent route
- Restrict privileged generic patch fields
- Add tests for authz matrix

## Phase B: Config revision ledger

- Add `agent_config_revisions`
- Write-on-change for all relevant agent mutations
- rollback endpoints + tests

## Phase C: Issue↔Approval linking

- Add `issue_approvals`
- add link APIs + auto-link behavior
- update approvals/issues UI cross-links

## Phase D: Skill guidance

- update skills for markdown/link expectations and sourceIssue linking

## 8. Acceptance Criteria

- CEO can patch CTO (same company) successfully.
- Every config change creates a retrievable revision.
- Rollback restores prior config in one action and creates a new revision record.
- Issue and approval pages show stable bidirectional links from canonical DB relation.
- Agent comments in hiring workflow use markdown and include entity links.

## 9. Risks and Mitigations

- Risk: permission escalation via generic PATCH.
  - Mitigation: isolate privileged fields and validate actor scope.
- Risk: rollback corruption.
  - Mitigation: snapshot-before/snapshot-after + transaction + tests.
- Risk: ambiguous linking semantics.
  - Mitigation: explicit join table + unique constraints + typed relationship field.
