<!-- GENERATED FILE — DO NOT EDIT. Run pnpm generate:capability-inventory. -->

# Capability Capability Contract

This generated contract is a self-contained derivative of the Paperclip skill, its seven references, the Paperclip Evals corpus, and the legacy MCP tool surface. It does not import or contact the Paperclip control plane.

The skill/reference inventory and eval cases are the only normative behavior sources. Paperclip does not use the legacy MCP calls as a production capability surface; all MCP names below are traceability aliases folded into normative eval rows. Their disposition, grants, assertions, and evidence contract are inherited from the target row rather than classified independently.

## Baseline Counts

- Skill/reference headings: 166
- Eval cases: 106 across 16 groups
- Total normative rows: 272
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
| skill:skills/paperclip/SKILL.md:authentication:20 | control_plane_owned | skills/paperclip/SKILL.md:20 |
| skill:skills/paperclip/SKILL.md:conversation-tasks:32 | optional_agent_tool | skills/paperclip/SKILL.md:32 |
| skill:skills/paperclip/SKILL.md:server-verified-external-chat-turns:54 | control_plane_owned | skills/paperclip/SKILL.md:54 |
| skill:skills/paperclip/SKILL.md:the-heartbeat-procedure:94 | optional_agent_tool | skills/paperclip/SKILL.md:94 |
| skill:skills/paperclip/SKILL.md:generated-artifacts-and-work-products:206 | always_agent_tool | skills/paperclip/SKILL.md:206 |
| skill:skills/paperclip/SKILL.md:status-quick-guide:254 | control_plane_owned | skills/paperclip/SKILL.md:254 |
| skill:skills/paperclip/SKILL.md:monitors-and-watchers-say-only-what-you-actually-scheduled:264 | optional_agent_tool | skills/paperclip/SKILL.md:264 |
| skill:skills/paperclip/SKILL.md:delegating-review-tasks:285 | always_agent_tool | skills/paperclip/SKILL.md:285 |
| skill:skills/paperclip/SKILL.md:managing-a-user-s-inbox:296 | control_plane_owned | skills/paperclip/SKILL.md:296 |
| skill:skills/paperclip/SKILL.md:issue-dependencies-blockers:304 | control_plane_owned | skills/paperclip/SKILL.md:304 |
| skill:skills/paperclip/SKILL.md:requesting-board-approval:329 | optional_agent_tool | skills/paperclip/SKILL.md:329 |
| skill:skills/paperclip/SKILL.md:issue-thread-interactions:350 | optional_agent_tool | skills/paperclip/SKILL.md:350 |
| skill:skills/paperclip/SKILL.md:standalone-decisions:380 | optional_agent_tool | skills/paperclip/SKILL.md:380 |
| skill:skills/paperclip/SKILL.md:mcp-tool-approval-gates:484 | optional_agent_tool | skills/paperclip/SKILL.md:484 |
| skill:skills/paperclip/SKILL.md:niche-workflow-pointers:526 | optional_agent_tool | skills/paperclip/SKILL.md:526 |
| skill:skills/paperclip/SKILL.md:cases:536 | optional_agent_tool | skills/paperclip/SKILL.md:536 |
| skill:skills/paperclip/SKILL.md:company-skills-workflow:541 | optional_agent_tool | skills/paperclip/SKILL.md:541 |
| skill:skills/paperclip/SKILL.md:routines:552 | optional_agent_tool | skills/paperclip/SKILL.md:552 |
| skill:skills/paperclip/SKILL.md:task-files-and-workspace-choices:563 | optional_agent_tool | skills/paperclip/SKILL.md:563 |
| skill:skills/paperclip/SKILL.md:issue-workspace-runtime-controls:571 | optional_agent_tool | skills/paperclip/SKILL.md:571 |
| skill:skills/paperclip/SKILL.md:proposing-credentials-safely:578 | optional_agent_tool | skills/paperclip/SKILL.md:578 |
| skill:skills/paperclip/SKILL.md:reading-granted-secrets:585 | optional_agent_tool | skills/paperclip/SKILL.md:585 |
| skill:skills/paperclip/SKILL.md:critical-rules:611 | optional_agent_tool | skills/paperclip/SKILL.md:611 |
| skill:skills/paperclip/SKILL.md:comment-style-required:632 | always_agent_tool | skills/paperclip/SKILL.md:632 |
| skill:skills/paperclip/SKILL.md:update:668 | optional_agent_tool | skills/paperclip/SKILL.md:668 |
| skill:skills/paperclip/SKILL.md:task-documents-and-deliverables:678 | always_agent_tool | skills/paperclip/SKILL.md:678 |
| skill:skills/paperclip/SKILL.md:planning-required-when-planning-requested:692 | optional_agent_tool | skills/paperclip/SKILL.md:692 |
| skill:skills/paperclip/SKILL.md:key-endpoints-hot-routes:723 | optional_agent_tool | skills/paperclip/SKILL.md:723 |
| skill:skills/paperclip/SKILL.md:searching-issues:753 | optional_agent_tool | skills/paperclip/SKILL.md:753 |
| skill:skills/paperclip/SKILL.md:full-reference:763 | optional_agent_tool | skills/paperclip/SKILL.md:763 |
| skill:skills/paperclip/SKILL.md:conversational-confirmation-answers:767 | always_agent_tool | skills/paperclip/SKILL.md:767 |
| skill:skills/paperclip/SKILL.md:incidental-feedback:784 | optional_agent_tool | skills/paperclip/SKILL.md:784 |
| skill:skills/paperclip/references/api-reference.md:paperclip-api-reference:1 | optional_agent_tool | skills/paperclip/references/api-reference.md:1 |
| skill:skills/paperclip/references/api-reference.md:response-schemas:9 | optional_agent_tool | skills/paperclip/references/api-reference.md:9 |
| skill:skills/paperclip/references/api-reference.md:agent-record-get-api-agents-me-or-get-api-agents-agentid:11 | optional_agent_tool | skills/paperclip/references/api-reference.md:11 |
| skill:skills/paperclip/references/api-reference.md:company-portability:44 | optional_agent_tool | skills/paperclip/references/api-reference.md:44 |
| skill:skills/paperclip/references/api-reference.md:issue-with-ancestors-get-api-issues-issueid:116 | optional_agent_tool | skills/paperclip/references/api-reference.md:116 |
| skill:skills/paperclip/references/api-reference.md:issue-update-response-patch-api-issues-issueid:202 | optional_agent_tool | skills/paperclip/references/api-reference.md:202 |
| skill:skills/paperclip/references/api-reference.md:blocker-diagnostics-get-api-issues-issueid-diagnostics-blockers:244 | control_plane_owned | skills/paperclip/references/api-reference.md:244 |
| skill:skills/paperclip/references/api-reference.md:wake-diagnostics-get-api-issues-issueid-diagnostics-wakes:283 | control_plane_owned | skills/paperclip/references/api-reference.md:283 |
| skill:skills/paperclip/references/api-reference.md:subtree-diagnostics-get-api-issues-issueid-diagnostics-subtree:327 | optional_agent_tool | skills/paperclip/references/api-reference.md:327 |
| skill:skills/paperclip/references/api-reference.md:execution-policy-fields-on-an-issue:375 | optional_agent_tool | skills/paperclip/references/api-reference.md:375 |
| skill:skills/paperclip/references/api-reference.md:cross-agent-review-gates:427 | always_agent_tool | skills/paperclip/references/api-reference.md:427 |
| skill:skills/paperclip/references/api-reference.md:worked-example-ic-heartbeat:462 | optional_agent_tool | skills/paperclip/references/api-reference.md:462 |
| skill:skills/paperclip/references/api-reference.md:1-identity-skip-if-already-in-context:467 | control_plane_owned | skills/paperclip/references/api-reference.md:467 |
| skill:skills/paperclip/references/api-reference.md:2-check-inbox:471 | control_plane_owned | skills/paperclip/references/api-reference.md:471 |
| skill:skills/paperclip/references/api-reference.md:3-already-have-issue-101-inprogress-highest-priority-continue-it:478 | optional_agent_tool | skills/paperclip/references/api-reference.md:478 |
| skill:skills/paperclip/references/api-reference.md:4-do-the-actual-work-write-code-run-tests:485 | optional_agent_tool | skills/paperclip/references/api-reference.md:485 |
| skill:skills/paperclip/references/api-reference.md:5-work-is-done-update-status-and-comment-in-one-call:487 | always_agent_tool | skills/paperclip/references/api-reference.md:487 |
| skill:skills/paperclip/references/api-reference.md:6-still-have-time-checkout-the-next-task:491 | control_plane_owned | skills/paperclip/references/api-reference.md:491 |
| skill:skills/paperclip/references/api-reference.md:7-made-partial-progress-not-done-yet-comment-and-exit:498 | always_agent_tool | skills/paperclip/references/api-reference.md:498 |
| skill:skills/paperclip/references/api-reference.md:worked-example-report-a-board-user-s-mine-inbox:503 | control_plane_owned | skills/paperclip/references/api-reference.md:503 |
| skill:skills/paperclip/references/api-reference.md:board-user-created-the-requesting-issue:508 | optional_agent_tool | skills/paperclip/references/api-reference.md:508 |
| skill:skills/paperclip/references/api-reference.md:fetch-the-board-user-s-mine-inbox-issues:512 | control_plane_owned | skills/paperclip/references/api-reference.md:512 |
| skill:skills/paperclip/references/api-reference.md:summarize-it-back-to-the-board-in-a-comment-or-document:526 | always_agent_tool | skills/paperclip/references/api-reference.md:526 |
| skill:skills/paperclip/references/api-reference.md:worked-example-archive-a-resolved-inbox-item:531 | control_plane_owned | skills/paperclip/references/api-reference.md:531 |
| skill:skills/paperclip/references/api-reference.md:the-responsible-user-s-id-is-resolved-from-the-authenticated-agent-run:536 | optional_agent_tool | skills/paperclip/references/api-reference.md:536 |
| skill:skills/paperclip/references/api-reference.md:reverse-the-archive-if-it-was-premature-or-no-longer-desired:545 | optional_agent_tool | skills/paperclip/references/api-reference.md:545 |
| skill:skills/paperclip/references/api-reference.md:worked-example-reviewer-approver-heartbeat:555 | always_agent_tool | skills/paperclip/references/api-reference.md:555 |
| skill:skills/paperclip/references/api-reference.md:worked-example-manager-heartbeat:594 | optional_agent_tool | skills/paperclip/references/api-reference.md:594 |
| skill:skills/paperclip/references/api-reference.md:1-identity-skip-if-already-in-context:597 | control_plane_owned | skills/paperclip/references/api-reference.md:597 |
| skill:skills/paperclip/references/api-reference.md:2-check-team-status:601 | optional_agent_tool | skills/paperclip/references/api-reference.md:601 |
| skill:skills/paperclip/references/api-reference.md:3-agent-42-is-blocked-read-comments:608 | control_plane_owned | skills/paperclip/references/api-reference.md:608 |
| skill:skills/paperclip/references/api-reference.md:4-unblock-reassign-and-comment:612 | control_plane_owned | skills/paperclip/references/api-reference.md:612 |
| skill:skills/paperclip/references/api-reference.md:5-check-own-assignments:616 | optional_agent_tool | skills/paperclip/references/api-reference.md:616 |
| skill:skills/paperclip/references/api-reference.md:6-create-subtasks-and-delegate:623 | optional_agent_tool | skills/paperclip/references/api-reference.md:623 |
| skill:skills/paperclip/references/api-reference.md:load-tests-depend-on-caching-layer-being-done-first-paperclip-will-auto-wake-agent-55-when-the-blocker-resolves:629 | control_plane_owned | skills/paperclip/references/api-reference.md:629 |
| skill:skills/paperclip/references/api-reference.md:7-dashboard-for-health-check:634 | optional_agent_tool | skills/paperclip/references/api-reference.md:634 |
| skill:skills/paperclip/references/api-reference.md:comments-and-mentions:640 | always_agent_tool | skills/paperclip/references/api-reference.md:640 |
| skill:skills/paperclip/references/api-reference.md:update:647 | optional_agent_tool | skills/paperclip/references/api-reference.md:647 |
| skill:skills/paperclip/references/api-reference.md:cross-team-work-and-delegation:669 | optional_agent_tool | skills/paperclip/references/api-reference.md:669 |
| skill:skills/paperclip/references/api-reference.md:receiving-cross-team-work:673 | optional_agent_tool | skills/paperclip/references/api-reference.md:673 |
| skill:skills/paperclip/references/api-reference.md:questions-and-dependencies:683 | always_agent_tool | skills/paperclip/references/api-reference.md:683 |
| skill:skills/paperclip/references/api-reference.md:company-context:695 | optional_agent_tool | skills/paperclip/references/api-reference.md:695 |
| skill:skills/paperclip/references/api-reference.md:company-branding-ceo-board:707 | optional_agent_tool | skills/paperclip/references/api-reference.md:707 |
| skill:skills/paperclip/references/api-reference.md:openclaw-invite-prompt-ceo:727 | optional_agent_tool | skills/paperclip/references/api-reference.md:727 |
| skill:skills/paperclip/references/api-reference.md:setting-agent-instructions-path:746 | optional_agent_tool | skills/paperclip/references/api-reference.md:746 |
| skill:skills/paperclip/references/api-reference.md:project-setup-create-workspace:779 | optional_agent_tool | skills/paperclip/references/api-reference.md:779 |
| skill:skills/paperclip/references/api-reference.md:option-a-one-call-create-with-workspace:803 | optional_agent_tool | skills/paperclip/references/api-reference.md:803 |
| skill:skills/paperclip/references/api-reference.md:option-b-two-calls-project-first-then-workspace:822 | optional_agent_tool | skills/paperclip/references/api-reference.md:822 |
| skill:skills/paperclip/references/api-reference.md:governance-and-approvals:851 | optional_agent_tool | skills/paperclip/references/api-reference.md:851 |
| skill:skills/paperclip/references/api-reference.md:requesting-a-hire-management-only:855 | optional_agent_tool | skills/paperclip/references/api-reference.md:855 |
| skill:skills/paperclip/references/api-reference.md:ceo-strategy-approval:920 | optional_agent_tool | skills/paperclip/references/api-reference.md:920 |
| skill:skills/paperclip/references/api-reference.md:questions-and-waiting-for-human-input:929 | always_agent_tool | skills/paperclip/references/api-reference.md:929 |
| skill:skills/paperclip/references/api-reference.md:issue-thread-confirmations:1033 | always_agent_tool | skills/paperclip/references/api-reference.md:1033 |
| skill:skills/paperclip/references/api-reference.md:conversational-confirmation-answers:1091 | always_agent_tool | skills/paperclip/references/api-reference.md:1091 |
| skill:skills/paperclip/references/api-reference.md:checkbox-confirmations:1097 | always_agent_tool | skills/paperclip/references/api-reference.md:1097 |
| skill:skills/paperclip/references/api-reference.md:item-verdict-requests:1212 | optional_agent_tool | skills/paperclip/references/api-reference.md:1212 |
| skill:skills/paperclip/references/api-reference.md:checking-approval-status:1322 | optional_agent_tool | skills/paperclip/references/api-reference.md:1322 |
| skill:skills/paperclip/references/api-reference.md:approval-follow-up-requesting-agent:1328 | always_agent_tool | skills/paperclip/references/api-reference.md:1328 |
| skill:skills/paperclip/references/api-reference.md:issue-lifecycle:1346 | always_agent_tool | skills/paperclip/references/api-reference.md:1346 |
| skill:skills/paperclip/references/api-reference.md:error-handling:1378 | control_plane_owned | skills/paperclip/references/api-reference.md:1378 |
| skill:skills/paperclip/references/api-reference.md:full-api-reference:1392 | optional_agent_tool | skills/paperclip/references/api-reference.md:1392 |
| skill:skills/paperclip/references/api-reference.md:agents:1394 | optional_agent_tool | skills/paperclip/references/api-reference.md:1394 |
| skill:skills/paperclip/references/api-reference.md:issues-tasks:1415 | optional_agent_tool | skills/paperclip/references/api-reference.md:1415 |
| skill:skills/paperclip/references/api-reference.md:companies-projects-goals:1456 | optional_agent_tool | skills/paperclip/references/api-reference.md:1456 |
| skill:skills/paperclip/references/api-reference.md:routines:1480 | optional_agent_tool | skills/paperclip/references/api-reference.md:1480 |
| skill:skills/paperclip/references/api-reference.md:approvals-costs-activity-dashboard:1496 | optional_agent_tool | skills/paperclip/references/api-reference.md:1496 |
| skill:skills/paperclip/references/api-reference.md:secrets:1518 | optional_agent_tool | skills/paperclip/references/api-reference.md:1518 |
| skill:skills/paperclip/references/api-reference.md:agent-secret-proposals:1531 | optional_agent_tool | skills/paperclip/references/api-reference.md:1531 |
| skill:skills/paperclip/references/api-reference.md:agent-secret-access:1631 | optional_agent_tool | skills/paperclip/references/api-reference.md:1631 |
| skill:skills/paperclip/references/api-reference.md:common-mistakes:1671 | optional_agent_tool | skills/paperclip/references/api-reference.md:1671 |
| skill:skills/paperclip/references/artifacts.md:generated-artifacts-and-work-products:1 | always_agent_tool | skills/paperclip/references/artifacts.md:1 |
| skill:skills/paperclip/references/artifacts.md:workspace-only-file-references:15 | optional_agent_tool | skills/paperclip/references/artifacts.md:15 |
| skill:skills/paperclip/references/cases.md:cases:1 | optional_agent_tool | skills/paperclip/references/cases.md:1 |
| skill:skills/paperclip/references/cases.md:core-model:43 | optional_agent_tool | skills/paperclip/references/cases.md:43 |
| skill:skills/paperclip/references/cases.md:upsert-semantics:62 | optional_agent_tool | skills/paperclip/references/cases.md:62 |
| skill:skills/paperclip/references/cases.md:start-and-hand-off-work:100 | optional_agent_tool | skills/paperclip/references/cases.md:100 |
| skill:skills/paperclip/references/cases.md:example-factory-instructions:249 | optional_agent_tool | skills/paperclip/references/cases.md:249 |
| skill:skills/paperclip/references/cases.md:read-and-search:272 | optional_agent_tool | skills/paperclip/references/cases.md:272 |
| skill:skills/paperclip/references/cases.md:task-documents-and-legacy-case-documents:355 | always_agent_tool | skills/paperclip/references/cases.md:355 |
| skill:skills/paperclip/references/cases.md:fields:389 | optional_agent_tool | skills/paperclip/references/cases.md:389 |
| skill:skills/paperclip/references/cases.md:issue-links:422 | optional_agent_tool | skills/paperclip/references/cases.md:422 |
| skill:skills/paperclip/references/cases.md:child-cases:447 | optional_agent_tool | skills/paperclip/references/cases.md:447 |
| skill:skills/paperclip/references/cases.md:attachments:466 | optional_agent_tool | skills/paperclip/references/cases.md:466 |
| skill:skills/paperclip/references/cases.md:lifecycle:479 | optional_agent_tool | skills/paperclip/references/cases.md:479 |
| skill:skills/paperclip/references/cases.md:worked-blog-post-example:493 | optional_agent_tool | skills/paperclip/references/cases.md:493 |
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
| skill:skills/paperclip/references/issue-documents.md:issue-documents-through-the-api:1 | always_agent_tool | skills/paperclip/references/issue-documents.md:1 |
| skill:skills/paperclip/references/issue-documents.md:create-a-document:8 | always_agent_tool | skills/paperclip/references/issue-documents.md:8 |
| skill:skills/paperclip/references/issue-documents.md:update-or-resolve-an-unclear-write:49 | optional_agent_tool | skills/paperclip/references/issue-documents.md:49 |
| skill:skills/paperclip/references/issue-workspaces.md:issue-workspace-runtime-controls:1 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:1 |
| skill:skills/paperclip/references/issue-workspaces.md:discover-the-workspace:5 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:5 |
| skill:skills/paperclip/references/issue-workspaces.md:choose-files-and-repositories:23 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:23 |
| skill:skills/paperclip/references/issue-workspaces.md:control-services:37 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:37 |
| skill:skills/paperclip/references/issue-workspaces.md:start-all-configured-services-waits-for-configured-readiness-checks:42 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:42 |
| skill:skills/paperclip/references/issue-workspaces.md:restart-all-configured-services:50 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:50 |
| skill:skills/paperclip/references/issue-workspaces.md:stop-all-running-services:58 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:58 |
| skill:skills/paperclip/references/issue-workspaces.md:read-the-url:77 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:77 |
| skill:skills/paperclip/references/issue-workspaces.md:mcp-tools:86 | optional_agent_tool | skills/paperclip/references/issue-workspaces.md:86 |
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
