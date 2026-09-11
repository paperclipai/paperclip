<!-- GENERATED FILE — DO NOT EDIT. Run pnpm generate:capability-inventory. -->

# Capability Capability Contract

This generated contract is a self-contained derivative of the Paperclip skill, its seven references, the Paperclip Evals corpus, and the legacy MCP tool surface. It does not import or contact the Paperclip control plane.

The skill/reference inventory and eval cases are the only normative behavior sources. Paperclip does not use the legacy MCP calls as a production capability surface; all MCP names below are traceability aliases folded into normative eval rows. Their disposition, grants, assertions, and evidence contract are inherited from the target row rather than classified independently.

## Baseline Counts

- Skill/reference headings: 154
- Eval cases: 106 across 16 groups
- Total normative rows: 260
- Legacy MCP aliases folded into normative rows: 42

| Eval group | Cases |
| --- | ---: |
| hb | 5 |
| co | 6 |
| st | 8 |
| cm | 6 |
| se | 4 |
| su | 4 |
| bl | 5 |
| dp | 3 |
| ix | 9 |
| ap | 6 |
| ar | 4 |
| er | 9 |
| rf | 22 |
| mh | 4 |
| rs | 3 |
| wk | 8 |

## Regeneration

- `pnpm --dir packages/paperclip-runner generate:capability-inventory` imports the canonical baselines and rewrites every generated file.
- `pnpm --dir packages/paperclip-runner check:capability-inventory` validates counts, uniqueness, normative dispositions, one-to-one MCP folds, required fields, and generated-file drift without requiring the external eval repository.

## Skill / Reference Rows

| Capability | Primary disposition | Source anchor |
| --- | --- | --- |
| skill:skills/paperclip/SKILL.md:paperclip-skill:10 | optional_agent_tool | skills/paperclip/SKILL.md:10 |
| skill:skills/paperclip/SKILL.md:terminology:14 | optional_agent_tool | skills/paperclip/SKILL.md:14 |
| skill:skills/paperclip/SKILL.md:authentication:18 | control_plane_owned | skills/paperclip/SKILL.md:18 |
| skill:skills/paperclip/SKILL.md:conversation-tasks:30 | optional_agent_tool | skills/paperclip/SKILL.md:30 |
| skill:skills/paperclip/SKILL.md:server-verified-external-chat-turns:47 | control_plane_owned | skills/paperclip/SKILL.md:47 |
| skill:skills/paperclip/SKILL.md:the-heartbeat-procedure:87 | optional_agent_tool | skills/paperclip/SKILL.md:87 |
| skill:skills/paperclip/SKILL.md:generated-artifacts-and-work-products:159 | always_agent_tool | skills/paperclip/SKILL.md:159 |
| skill:skills/paperclip/SKILL.md:status-quick-guide:207 | control_plane_owned | skills/paperclip/SKILL.md:207 |
| skill:skills/paperclip/SKILL.md:monitors-and-watchers-say-only-what-you-actually-scheduled:217 | optional_agent_tool | skills/paperclip/SKILL.md:217 |
| skill:skills/paperclip/SKILL.md:delegating-review-tasks:230 | always_agent_tool | skills/paperclip/SKILL.md:230 |
| skill:skills/paperclip/SKILL.md:managing-a-user-s-inbox:241 | control_plane_owned | skills/paperclip/SKILL.md:241 |
| skill:skills/paperclip/SKILL.md:issue-dependencies-blockers:249 | control_plane_owned | skills/paperclip/SKILL.md:249 |
| skill:skills/paperclip/SKILL.md:requesting-board-approval:274 | optional_agent_tool | skills/paperclip/SKILL.md:274 |
| skill:skills/paperclip/SKILL.md:issue-thread-interactions:295 | optional_agent_tool | skills/paperclip/SKILL.md:295 |
| skill:skills/paperclip/SKILL.md:standalone-decisions:324 | optional_agent_tool | skills/paperclip/SKILL.md:324 |
| skill:skills/paperclip/SKILL.md:mcp-tool-approval-gates:428 | optional_agent_tool | skills/paperclip/SKILL.md:428 |
| skill:skills/paperclip/SKILL.md:niche-workflow-pointers:470 | optional_agent_tool | skills/paperclip/SKILL.md:470 |
| skill:skills/paperclip/SKILL.md:cases:480 | optional_agent_tool | skills/paperclip/SKILL.md:480 |
| skill:skills/paperclip/SKILL.md:company-skills-workflow:485 | optional_agent_tool | skills/paperclip/SKILL.md:485 |
| skill:skills/paperclip/SKILL.md:routines:496 | optional_agent_tool | skills/paperclip/SKILL.md:496 |
| skill:skills/paperclip/SKILL.md:issue-workspace-runtime-controls:507 | optional_agent_tool | skills/paperclip/SKILL.md:507 |
| skill:skills/paperclip/SKILL.md:proposing-credentials-safely:514 | optional_agent_tool | skills/paperclip/SKILL.md:514 |
| skill:skills/paperclip/SKILL.md:reading-granted-secrets:521 | optional_agent_tool | skills/paperclip/SKILL.md:521 |
| skill:skills/paperclip/SKILL.md:critical-rules:547 | optional_agent_tool | skills/paperclip/SKILL.md:547 |
| skill:skills/paperclip/SKILL.md:comment-style-required:571 | always_agent_tool | skills/paperclip/SKILL.md:571 |
| skill:skills/paperclip/SKILL.md:update:603 | optional_agent_tool | skills/paperclip/SKILL.md:603 |
| skill:skills/paperclip/SKILL.md:planning-required-when-planning-requested:613 | optional_agent_tool | skills/paperclip/SKILL.md:613 |
| skill:skills/paperclip/SKILL.md:key-endpoints-hot-routes:646 | optional_agent_tool | skills/paperclip/SKILL.md:646 |
| skill:skills/paperclip/SKILL.md:searching-issues:675 | optional_agent_tool | skills/paperclip/SKILL.md:675 |
| skill:skills/paperclip/SKILL.md:full-reference:685 | optional_agent_tool | skills/paperclip/SKILL.md:685 |
| skill:skills/paperclip/references/artifacts.md:generated-artifacts-and-work-products:1 | always_agent_tool | skills/paperclip/references/artifacts.md:1 |
| skill:skills/paperclip/references/artifacts.md:workspace-only-file-references:15 | optional_agent_tool | skills/paperclip/references/artifacts.md:15 |
| skill:skills/paperclip/references/cases.md:cases:1 | optional_agent_tool | skills/paperclip/references/cases.md:1 |
| skill:skills/paperclip/references/cases.md:core-model:12 | optional_agent_tool | skills/paperclip/references/cases.md:12 |
| skill:skills/paperclip/references/cases.md:upsert-semantics:29 | optional_agent_tool | skills/paperclip/references/cases.md:29 |
| skill:skills/paperclip/references/cases.md:read-and-search:67 | optional_agent_tool | skills/paperclip/references/cases.md:67 |
| skill:skills/paperclip/references/cases.md:documents:90 | always_agent_tool | skills/paperclip/references/cases.md:90 |
| skill:skills/paperclip/references/cases.md:fields:118 | optional_agent_tool | skills/paperclip/references/cases.md:118 |
| skill:skills/paperclip/references/cases.md:issue-links:151 | optional_agent_tool | skills/paperclip/references/cases.md:151 |
| skill:skills/paperclip/references/cases.md:child-cases:176 | optional_agent_tool | skills/paperclip/references/cases.md:176 |
| skill:skills/paperclip/references/cases.md:attachments:195 | optional_agent_tool | skills/paperclip/references/cases.md:195 |
| skill:skills/paperclip/references/cases.md:lifecycle:208 | optional_agent_tool | skills/paperclip/references/cases.md:208 |
| skill:skills/paperclip/references/cases.md:worked-blog-post-example:222 | optional_agent_tool | skills/paperclip/references/cases.md:222 |
| skill:skills/paperclip/references/company-skills.md:company-skills-workflow:1 | optional_agent_tool | skills/paperclip/references/company-skills.md:1 |
| skill:skills/paperclip/references/company-skills.md:what-exists:5 | optional_agent_tool | skills/paperclip/references/company-skills.md:5 |
| skill:skills/paperclip/references/company-skills.md:permission-model:22 | optional_agent_tool | skills/paperclip/references/company-skills.md:22 |
| skill:skills/paperclip/references/company-skills.md:core-endpoints:29 | optional_agent_tool | skills/paperclip/references/company-skills.md:29 |
| skill:skills/paperclip/references/company-skills.md:install-a-skill-into-the-company:65 | optional_agent_tool | skills/paperclip/references/company-skills.md:65 |
| skill:skills/paperclip/references/company-skills.md:app-shipped-catalog:75 | optional_agent_tool | skills/paperclip/references/company-skills.md:75 |
| skill:skills/paperclip/references/company-skills.md:external-source-import:101 | optional_agent_tool | skills/paperclip/references/company-skills.md:101 |
| skill:skills/paperclip/references/company-skills.md:source-types-in-order-of-preference:105 | optional_agent_tool | skills/paperclip/references/company-skills.md:105 |
| skill:skills/paperclip/references/company-skills.md:example-skills-sh-import-preferred:116 | optional_agent_tool | skills/paperclip/references/company-skills.md:116 |
| skill:skills/paperclip/references/company-skills.md:example-github-import:138 | optional_agent_tool | skills/paperclip/references/company-skills.md:138 |
| skill:skills/paperclip/references/company-skills.md:inspect-what-was-installed:164 | optional_agent_tool | skills/paperclip/references/company-skills.md:164 |
| skill:skills/paperclip/references/company-skills.md:assign-skills-to-an-existing-agent:181 | optional_agent_tool | skills/paperclip/references/company-skills.md:181 |
| skill:skills/paperclip/references/company-skills.md:include-skills-during-hire-or-create:216 | optional_agent_tool | skills/paperclip/references/company-skills.md:216 |
| skill:skills/paperclip/references/company-skills.md:notes:256 | optional_agent_tool | skills/paperclip/references/company-skills.md:256 |
| skill:skills/paperclip/references/issue-workspaces.md:issue-workspace-runtime-controls:1 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:1 |
| skill:skills/paperclip/references/issue-workspaces.md:discover-the-workspace:5 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:5 |
| skill:skills/paperclip/references/issue-workspaces.md:control-services:23 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:23 |
| skill:skills/paperclip/references/issue-workspaces.md:start-all-configured-services-waits-for-configured-readiness-checks:28 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:28 |
| skill:skills/paperclip/references/issue-workspaces.md:restart-all-configured-services:36 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:36 |
| skill:skills/paperclip/references/issue-workspaces.md:stop-all-running-services:44 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:44 |
| skill:skills/paperclip/references/issue-workspaces.md:read-the-url:63 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:63 |
| skill:skills/paperclip/references/issue-workspaces.md:mcp-tools:72 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:72 |
| skill:skills/paperclip/references/routines.md:paperclip-routines:1 | optional_agent_tool | skills/paperclip/references/routines.md:1 |
| skill:skills/paperclip/references/routines.md:lifecycle:16 | optional_agent_tool | skills/paperclip/references/routines.md:16 |
| skill:skills/paperclip/references/routines.md:creating-a-routine:27 | optional_agent_tool | skills/paperclip/references/routines.md:27 |
| skill:skills/paperclip/references/routines.md:concurrency-policies:64 | optional_agent_tool | skills/paperclip/references/routines.md:64 |
| skill:skills/paperclip/references/routines.md:catch-up-policies:76 | optional_agent_tool | skills/paperclip/references/routines.md:76 |
| skill:skills/paperclip/references/routines.md:activity-gated-scheduled-runs:87 | optional_agent_tool | skills/paperclip/references/routines.md:87 |
| skill:skills/paperclip/references/routines.md:example-skip-quiet-nights:107 | optional_agent_tool | skills/paperclip/references/routines.md:107 |
| skill:skills/paperclip/references/routines.md:adding-triggers:126 | optional_agent_tool | skills/paperclip/references/routines.md:126 |
| skill:skills/paperclip/references/routines.md:schedule-cron:136 | optional_agent_tool | skills/paperclip/references/routines.md:136 |
| skill:skills/paperclip/references/routines.md:webhook:150 | optional_agent_tool | skills/paperclip/references/routines.md:150 |
| skill:skills/paperclip/references/routines.md:api-manual-only:167 | optional_agent_tool | skills/paperclip/references/routines.md:167 |
| skill:skills/paperclip/references/routines.md:updating-and-deleting-triggers:179 | optional_agent_tool | skills/paperclip/references/routines.md:179 |
| skill:skills/paperclip/references/routines.md:manual-run:196 | optional_agent_tool | skills/paperclip/references/routines.md:196 |
| skill:skills/paperclip/references/routines.md:updating-a-routine:212 | optional_agent_tool | skills/paperclip/references/routines.md:212 |
| skill:skills/paperclip/references/routines.md:reading-routines-and-runs:223 | optional_agent_tool | skills/paperclip/references/routines.md:223 |
| skill:skills/paperclip/references/workflows.md:paperclip-workflow-playbooks:1 | optional_agent_tool | skills/paperclip/references/workflows.md:1 |
| skill:skills/paperclip/references/workflows.md:project-setup-ceo-manager:7 | optional_agent_tool | skills/paperclip/references/workflows.md:7 |
| skill:skills/paperclip/references/workflows.md:openclaw-invite-ceo:22 | optional_agent_tool | skills/paperclip/references/workflows.md:22 |
| skill:skills/paperclip/references/workflows.md:setting-agent-instructions-path:50 | optional_agent_tool | skills/paperclip/references/workflows.md:50 |
| skill:skills/paperclip/references/workflows.md:company-import-export:79 | optional_agent_tool | skills/paperclip/references/workflows.md:79 |
| skill:skills/paperclip/references/workflows.md:self-test-playbook-app-level:106 | optional_agent_tool | skills/paperclip/references/workflows.md:106 |
| skill:skills/paperclip/references/api-reference.md:paperclip-api-reference:1 | optional_agent_tool | skills/paperclip/references/api-reference.md:1 |
| skill:skills/paperclip/references/api-reference.md:response-schemas:7 | optional_agent_tool | skills/paperclip/references/api-reference.md:7 |
| skill:skills/paperclip/references/api-reference.md:agent-record-get-api-agents-me-or-get-api-agents-agentid:9 | optional_agent_tool | skills/paperclip/references/api-reference.md:9 |
| skill:skills/paperclip/references/api-reference.md:company-portability:42 | optional_agent_tool | skills/paperclip/references/api-reference.md:42 |
| skill:skills/paperclip/references/api-reference.md:issue-with-ancestors-get-api-issues-issueid:108 | optional_agent_tool | skills/paperclip/references/api-reference.md:108 |
| skill:skills/paperclip/references/api-reference.md:issue-update-response-patch-api-issues-issueid:194 | optional_agent_tool | skills/paperclip/references/api-reference.md:194 |
| skill:skills/paperclip/references/api-reference.md:blocker-diagnostics-get-api-issues-issueid-diagnostics-blockers:236 | control_plane_owned | skills/paperclip/references/api-reference.md:236 |
| skill:skills/paperclip/references/api-reference.md:wake-diagnostics-get-api-issues-issueid-diagnostics-wakes:275 | control_plane_owned | skills/paperclip/references/api-reference.md:275 |
| skill:skills/paperclip/references/api-reference.md:subtree-diagnostics-get-api-issues-issueid-diagnostics-subtree:319 | optional_agent_tool | skills/paperclip/references/api-reference.md:319 |
| skill:skills/paperclip/references/api-reference.md:execution-policy-fields-on-an-issue:367 | optional_agent_tool | skills/paperclip/references/api-reference.md:367 |
| skill:skills/paperclip/references/api-reference.md:cross-agent-review-gates:419 | always_agent_tool | skills/paperclip/references/api-reference.md:419 |
| skill:skills/paperclip/references/api-reference.md:worked-example-ic-heartbeat:452 | optional_agent_tool | skills/paperclip/references/api-reference.md:452 |
| skill:skills/paperclip/references/api-reference.md:1-identity-skip-if-already-in-context:457 | control_plane_owned | skills/paperclip/references/api-reference.md:457 |
| skill:skills/paperclip/references/api-reference.md:2-check-inbox:461 | control_plane_owned | skills/paperclip/references/api-reference.md:461 |
| skill:skills/paperclip/references/api-reference.md:3-already-have-issue-101-inprogress-highest-priority-continue-it:468 | optional_agent_tool | skills/paperclip/references/api-reference.md:468 |
| skill:skills/paperclip/references/api-reference.md:4-do-the-actual-work-write-code-run-tests:475 | optional_agent_tool | skills/paperclip/references/api-reference.md:475 |
| skill:skills/paperclip/references/api-reference.md:5-work-is-done-update-status-and-comment-in-one-call:477 | always_agent_tool | skills/paperclip/references/api-reference.md:477 |
| skill:skills/paperclip/references/api-reference.md:6-still-have-time-checkout-the-next-task:481 | control_plane_owned | skills/paperclip/references/api-reference.md:481 |
| skill:skills/paperclip/references/api-reference.md:7-made-partial-progress-not-done-yet-comment-and-exit:488 | always_agent_tool | skills/paperclip/references/api-reference.md:488 |
| skill:skills/paperclip/references/api-reference.md:worked-example-report-a-board-user-s-mine-inbox:493 | control_plane_owned | skills/paperclip/references/api-reference.md:493 |
| skill:skills/paperclip/references/api-reference.md:board-user-created-the-requesting-issue:498 | optional_agent_tool | skills/paperclip/references/api-reference.md:498 |
| skill:skills/paperclip/references/api-reference.md:fetch-the-board-user-s-mine-inbox-issues:502 | control_plane_owned | skills/paperclip/references/api-reference.md:502 |
| skill:skills/paperclip/references/api-reference.md:summarize-it-back-to-the-board-in-a-comment-or-document:516 | always_agent_tool | skills/paperclip/references/api-reference.md:516 |
| skill:skills/paperclip/references/api-reference.md:worked-example-archive-a-resolved-inbox-item:521 | control_plane_owned | skills/paperclip/references/api-reference.md:521 |
| skill:skills/paperclip/references/api-reference.md:the-responsible-user-s-id-is-resolved-from-the-authenticated-agent-run:526 | optional_agent_tool | skills/paperclip/references/api-reference.md:526 |
| skill:skills/paperclip/references/api-reference.md:reverse-the-archive-if-it-was-premature-or-no-longer-desired:535 | optional_agent_tool | skills/paperclip/references/api-reference.md:535 |
| skill:skills/paperclip/references/api-reference.md:worked-example-reviewer-approver-heartbeat:545 | always_agent_tool | skills/paperclip/references/api-reference.md:545 |
| skill:skills/paperclip/references/api-reference.md:worked-example-manager-heartbeat:584 | optional_agent_tool | skills/paperclip/references/api-reference.md:584 |
| skill:skills/paperclip/references/api-reference.md:1-identity-skip-if-already-in-context:587 | control_plane_owned | skills/paperclip/references/api-reference.md:587 |
| skill:skills/paperclip/references/api-reference.md:2-check-team-status:591 | optional_agent_tool | skills/paperclip/references/api-reference.md:591 |
| skill:skills/paperclip/references/api-reference.md:3-agent-42-is-blocked-read-comments:598 | control_plane_owned | skills/paperclip/references/api-reference.md:598 |
| skill:skills/paperclip/references/api-reference.md:4-unblock-reassign-and-comment:602 | control_plane_owned | skills/paperclip/references/api-reference.md:602 |
| skill:skills/paperclip/references/api-reference.md:5-check-own-assignments:606 | optional_agent_tool | skills/paperclip/references/api-reference.md:606 |
| skill:skills/paperclip/references/api-reference.md:6-create-subtasks-and-delegate:613 | optional_agent_tool | skills/paperclip/references/api-reference.md:613 |
| skill:skills/paperclip/references/api-reference.md:load-tests-depend-on-caching-layer-being-done-first-paperclip-will-auto-wake-agent-55-when-the-blocker-resolves:619 | control_plane_owned | skills/paperclip/references/api-reference.md:619 |
| skill:skills/paperclip/references/api-reference.md:7-dashboard-for-health-check:624 | optional_agent_tool | skills/paperclip/references/api-reference.md:624 |
| skill:skills/paperclip/references/api-reference.md:comments-and-mentions:630 | always_agent_tool | skills/paperclip/references/api-reference.md:630 |
| skill:skills/paperclip/references/api-reference.md:update:637 | optional_agent_tool | skills/paperclip/references/api-reference.md:637 |
| skill:skills/paperclip/references/api-reference.md:cross-team-work-and-delegation:675 | optional_agent_tool | skills/paperclip/references/api-reference.md:675 |
| skill:skills/paperclip/references/api-reference.md:receiving-cross-team-work:679 | optional_agent_tool | skills/paperclip/references/api-reference.md:679 |
| skill:skills/paperclip/references/api-reference.md:escalation:689 | optional_agent_tool | skills/paperclip/references/api-reference.md:689 |
| skill:skills/paperclip/references/api-reference.md:company-context:699 | optional_agent_tool | skills/paperclip/references/api-reference.md:699 |
| skill:skills/paperclip/references/api-reference.md:company-branding-ceo-board:711 | optional_agent_tool | skills/paperclip/references/api-reference.md:711 |
| skill:skills/paperclip/references/api-reference.md:openclaw-invite-prompt-ceo:731 | optional_agent_tool | skills/paperclip/references/api-reference.md:731 |
| skill:skills/paperclip/references/api-reference.md:setting-agent-instructions-path:750 | optional_agent_tool | skills/paperclip/references/api-reference.md:750 |
| skill:skills/paperclip/references/api-reference.md:project-setup-create-workspace:783 | optional_agent_tool | skills/paperclip/references/api-reference.md:783 |
| skill:skills/paperclip/references/api-reference.md:option-a-one-call-create-with-workspace:807 | optional_agent_tool | skills/paperclip/references/api-reference.md:807 |
| skill:skills/paperclip/references/api-reference.md:option-b-two-calls-project-first-then-workspace:826 | optional_agent_tool | skills/paperclip/references/api-reference.md:826 |
| skill:skills/paperclip/references/api-reference.md:governance-and-approvals:855 | optional_agent_tool | skills/paperclip/references/api-reference.md:855 |
| skill:skills/paperclip/references/api-reference.md:requesting-a-hire-management-only:859 | optional_agent_tool | skills/paperclip/references/api-reference.md:859 |
| skill:skills/paperclip/references/api-reference.md:ceo-strategy-approval:879 | optional_agent_tool | skills/paperclip/references/api-reference.md:879 |
| skill:skills/paperclip/references/api-reference.md:issue-thread-confirmations:888 | always_agent_tool | skills/paperclip/references/api-reference.md:888 |
| skill:skills/paperclip/references/api-reference.md:checkbox-confirmations:946 | always_agent_tool | skills/paperclip/references/api-reference.md:946 |
| skill:skills/paperclip/references/api-reference.md:item-verdict-requests:1061 | optional_agent_tool | skills/paperclip/references/api-reference.md:1061 |
| skill:skills/paperclip/references/api-reference.md:checking-approval-status:1171 | optional_agent_tool | skills/paperclip/references/api-reference.md:1171 |
| skill:skills/paperclip/references/api-reference.md:approval-follow-up-requesting-agent:1177 | always_agent_tool | skills/paperclip/references/api-reference.md:1177 |
| skill:skills/paperclip/references/api-reference.md:issue-lifecycle:1195 | always_agent_tool | skills/paperclip/references/api-reference.md:1195 |
| skill:skills/paperclip/references/api-reference.md:error-handling:1225 | control_plane_owned | skills/paperclip/references/api-reference.md:1225 |
| skill:skills/paperclip/references/api-reference.md:full-api-reference:1239 | optional_agent_tool | skills/paperclip/references/api-reference.md:1239 |
| skill:skills/paperclip/references/api-reference.md:agents:1241 | optional_agent_tool | skills/paperclip/references/api-reference.md:1241 |
| skill:skills/paperclip/references/api-reference.md:issues-tasks:1262 | optional_agent_tool | skills/paperclip/references/api-reference.md:1262 |
| skill:skills/paperclip/references/api-reference.md:companies-projects-goals:1302 | optional_agent_tool | skills/paperclip/references/api-reference.md:1302 |
| skill:skills/paperclip/references/api-reference.md:routines:1326 | optional_agent_tool | skills/paperclip/references/api-reference.md:1326 |
| skill:skills/paperclip/references/api-reference.md:approvals-costs-activity-dashboard:1342 | optional_agent_tool | skills/paperclip/references/api-reference.md:1342 |
| skill:skills/paperclip/references/api-reference.md:secrets:1364 | optional_agent_tool | skills/paperclip/references/api-reference.md:1364 |
| skill:skills/paperclip/references/api-reference.md:agent-secret-proposals:1377 | optional_agent_tool | skills/paperclip/references/api-reference.md:1377 |
| skill:skills/paperclip/references/api-reference.md:agent-secret-access:1477 | optional_agent_tool | skills/paperclip/references/api-reference.md:1477 |
| skill:skills/paperclip/references/api-reference.md:common-mistakes:1517 | optional_agent_tool | skills/paperclip/references/api-reference.md:1517 |

## Legacy MCP Alias Index

This is a compatibility/traceability index, not a tool catalog. “Inherited disposition” is shown only to make the normative target easy to audit.

| Legacy MCP name | Folded into normative row | Inherited disposition | Source anchor |
| --- | --- | --- | --- |
| paperclipMe | eval:hb-inbox-lite-01 | control_plane_owned | packages/mcp-server/src/tools.ts:290 |
| paperclipInboxLite | eval:hb-inbox-lite-01 | control_plane_owned | packages/mcp-server/src/tools.ts:296 |
| paperclipListAgents | eval:rf-api-mgr-heartbeat-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:302 |
| paperclipListSkills | eval:rf-cskill-audit-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:308 |
| paperclipGetAgent | eval:rf-api-mgr-heartbeat-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:314 |
| paperclipListIssues | eval:se-q-filters-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:323 |
| paperclipGetIssue | eval:se-get-issue-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:338 |
| paperclipGetHeartbeatContext | eval:hb-context-01 | control_plane_owned | packages/mcp-server/src/tools.ts:344 |
| paperclipListComments | eval:se-get-issue-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:353 |
| paperclipGetComment | eval:hb-wake-comment-01 | control_plane_owned | packages/mcp-server/src/tools.ts:366 |
| paperclipListIssueApprovals | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:373 |
| paperclipListDocuments | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:379 |
| paperclipGetDocument | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:385 |
| paperclipListDocumentRevisions | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:392 |
| paperclipListProjects | eval:rf-wf-project-setup-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:402 |
| paperclipGetProject | eval:rf-wf-project-setup-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:408 |
| paperclipGetIssueWorkspaceRuntime | eval:rf-iws-start-url-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:417 |
| paperclipControlIssueWorkspaceServices | eval:rf-iws-start-url-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:423 |
| paperclipWaitForIssueWorkspaceService | eval:rf-iws-target-restart-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:440 |
| paperclipListGoals | eval:su-parent-goal-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:466 |
| paperclipGetGoal | eval:su-parent-goal-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:472 |
| paperclipListApprovals | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:478 |
| paperclipCreateApproval | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:487 |
| paperclipGetApproval | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:496 |
| paperclipGetApprovalIssues | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:502 |
| paperclipListApprovalComments | eval:ap-approval-deny-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:508 |
| paperclipCreateIssue | eval:su-parent-goal-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:514 |
| paperclipUpdateIssue | eval:st-done-comment-01 | always_agent_tool | packages/mcp-server/src/tools.ts:521 |
| paperclipCheckoutIssue | eval:co-body-contract-01 | control_plane_owned | packages/mcp-server/src/tools.ts:528 |
| paperclipReleaseIssue | eval:er-release-01 | control_plane_owned | packages/mcp-server/src/tools.ts:540 |
| paperclipAddComment | eval:cm-multiline-01 | always_agent_tool | packages/mcp-server/src/tools.ts:546 |
| paperclipSuggestTasks | eval:ix-suggest-tasks-01 | always_agent_tool | packages/mcp-server/src/tools.ts:553 |
| paperclipAskUserQuestions | eval:ix-questions-01 | always_agent_tool | packages/mcp-server/src/tools.ts:565 |
| paperclipRequestConfirmation | eval:ix-confirmation-plan-01 | always_agent_tool | packages/mcp-server/src/tools.ts:577 |
| paperclipRequestCheckboxConfirmation | eval:ix-checkbox-01 | always_agent_tool | packages/mcp-server/src/tools.ts:589 |
| paperclipUpsertIssueDocument | eval:dp-plan-doc-01 | always_agent_tool | packages/mcp-server/src/tools.ts:601 |
| paperclipRestoreIssueDocumentRevision | eval:dp-base-revision-01 | always_agent_tool | packages/mcp-server/src/tools.ts:612 |
| paperclipLinkIssueApproval | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:627 |
| paperclipUnlinkIssueApproval | eval:ap-board-approval-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:636 |
| paperclipApprovalDecision | eval:ap-approval-wake-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:646 |
| paperclipAddApprovalComment | eval:ap-approval-deny-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:668 |
| paperclipApiRequest | eval:rf-api-404-report-01 | optional_agent_tool | packages/mcp-server/src/tools.ts:677 |
