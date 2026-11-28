<!-- GENERATED FILE — DO NOT EDIT. Run pnpm generate:capability-inventory. -->

# Capability Capability Contract

This generated contract is a self-contained derivative of the Paperclip skill, its seven references, the Paperclip Evals corpus, and the legacy MCP tool surface. It does not import or contact the Paperclip control plane.

The skill/reference inventory and eval cases are the only normative behavior sources. Paperclip does not use the legacy MCP calls as a production capability surface; all MCP names below are traceability aliases folded into normative eval rows. Their disposition, grants, assertions, and evidence contract are inherited from the target row rather than classified independently.

## Baseline Counts

- Skill/reference headings: 176
- Eval cases: 106 across 16 groups
- Total normative rows: 282
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
| skill:skills/paperclip/SKILL.md:offer-a-routine-after-recurring-work:252 | optional_agent_tool | skills/paperclip/SKILL.md:252 |
| skill:skills/paperclip/SKILL.md:areas-and-responsibilities:275 | optional_agent_tool | skills/paperclip/SKILL.md:275 |
| skill:skills/paperclip/SKILL.md:propose-a-bar-in-a-bar-conversation:294 | optional_agent_tool | skills/paperclip/SKILL.md:294 |
| skill:skills/paperclip/SKILL.md:propose-an-automation-in-an-automation-conversation:298 | optional_agent_tool | skills/paperclip/SKILL.md:298 |
| skill:skills/paperclip/SKILL.md:write-a-responsibility-s-status:302 | optional_agent_tool | skills/paperclip/SKILL.md:302 |
| skill:skills/paperclip/SKILL.md:status-quick-guide:308 | control_plane_owned | skills/paperclip/SKILL.md:308 |
| skill:skills/paperclip/SKILL.md:monitors-and-watchers-say-only-what-you-actually-scheduled:318 | optional_agent_tool | skills/paperclip/SKILL.md:318 |
| skill:skills/paperclip/SKILL.md:delegating-review-tasks:339 | always_agent_tool | skills/paperclip/SKILL.md:339 |
| skill:skills/paperclip/SKILL.md:managing-a-user-s-inbox:350 | control_plane_owned | skills/paperclip/SKILL.md:350 |
| skill:skills/paperclip/SKILL.md:issue-dependencies-blockers:358 | control_plane_owned | skills/paperclip/SKILL.md:358 |
| skill:skills/paperclip/SKILL.md:requesting-board-approval:383 | optional_agent_tool | skills/paperclip/SKILL.md:383 |
| skill:skills/paperclip/SKILL.md:issue-thread-interactions:404 | optional_agent_tool | skills/paperclip/SKILL.md:404 |
| skill:skills/paperclip/SKILL.md:standalone-decisions:434 | optional_agent_tool | skills/paperclip/SKILL.md:434 |
| skill:skills/paperclip/SKILL.md:mcp-tool-approval-gates:538 | optional_agent_tool | skills/paperclip/SKILL.md:538 |
| skill:skills/paperclip/SKILL.md:niche-workflow-pointers:580 | optional_agent_tool | skills/paperclip/SKILL.md:580 |
| skill:skills/paperclip/SKILL.md:cases:590 | optional_agent_tool | skills/paperclip/SKILL.md:590 |
| skill:skills/paperclip/SKILL.md:company-skills-workflow:595 | optional_agent_tool | skills/paperclip/SKILL.md:595 |
| skill:skills/paperclip/SKILL.md:routines:606 | optional_agent_tool | skills/paperclip/SKILL.md:606 |
| skill:skills/paperclip/SKILL.md:task-files-and-workspace-choices:618 | optional_agent_tool | skills/paperclip/SKILL.md:618 |
| skill:skills/paperclip/SKILL.md:issue-workspace-runtime-controls:626 | optional_agent_tool | skills/paperclip/SKILL.md:626 |
| skill:skills/paperclip/SKILL.md:proposing-credentials-safely:633 | optional_agent_tool | skills/paperclip/SKILL.md:633 |
| skill:skills/paperclip/SKILL.md:reading-granted-secrets:640 | optional_agent_tool | skills/paperclip/SKILL.md:640 |
| skill:skills/paperclip/SKILL.md:critical-rules:666 | optional_agent_tool | skills/paperclip/SKILL.md:666 |
| skill:skills/paperclip/SKILL.md:comment-style-required:687 | always_agent_tool | skills/paperclip/SKILL.md:687 |
| skill:skills/paperclip/SKILL.md:update:723 | optional_agent_tool | skills/paperclip/SKILL.md:723 |
| skill:skills/paperclip/SKILL.md:task-documents-and-deliverables:733 | always_agent_tool | skills/paperclip/SKILL.md:733 |
| skill:skills/paperclip/SKILL.md:planning-required-when-planning-requested:747 | optional_agent_tool | skills/paperclip/SKILL.md:747 |
| skill:skills/paperclip/SKILL.md:key-endpoints-hot-routes:778 | optional_agent_tool | skills/paperclip/SKILL.md:778 |
| skill:skills/paperclip/SKILL.md:searching-issues:808 | optional_agent_tool | skills/paperclip/SKILL.md:808 |
| skill:skills/paperclip/SKILL.md:full-reference:818 | optional_agent_tool | skills/paperclip/SKILL.md:818 |
| skill:skills/paperclip/SKILL.md:conversational-confirmation-answers:822 | always_agent_tool | skills/paperclip/SKILL.md:822 |
| skill:skills/paperclip/SKILL.md:incidental-feedback:839 | optional_agent_tool | skills/paperclip/SKILL.md:839 |
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
| skill:skills/paperclip/references/api-reference.md:worked-example-ic-heartbeat:460 | optional_agent_tool | skills/paperclip/references/api-reference.md:460 |
| skill:skills/paperclip/references/api-reference.md:1-identity-skip-if-already-in-context:465 | control_plane_owned | skills/paperclip/references/api-reference.md:465 |
| skill:skills/paperclip/references/api-reference.md:2-check-inbox:469 | control_plane_owned | skills/paperclip/references/api-reference.md:469 |
| skill:skills/paperclip/references/api-reference.md:3-already-have-issue-101-inprogress-highest-priority-continue-it:476 | optional_agent_tool | skills/paperclip/references/api-reference.md:476 |
| skill:skills/paperclip/references/api-reference.md:4-do-the-actual-work-write-code-run-tests:483 | optional_agent_tool | skills/paperclip/references/api-reference.md:483 |
| skill:skills/paperclip/references/api-reference.md:5-work-is-done-update-status-and-comment-in-one-call:485 | always_agent_tool | skills/paperclip/references/api-reference.md:485 |
| skill:skills/paperclip/references/api-reference.md:6-still-have-time-checkout-the-next-task:489 | control_plane_owned | skills/paperclip/references/api-reference.md:489 |
| skill:skills/paperclip/references/api-reference.md:7-made-partial-progress-not-done-yet-comment-and-exit:496 | always_agent_tool | skills/paperclip/references/api-reference.md:496 |
| skill:skills/paperclip/references/api-reference.md:worked-example-report-a-board-user-s-mine-inbox:501 | control_plane_owned | skills/paperclip/references/api-reference.md:501 |
| skill:skills/paperclip/references/api-reference.md:board-user-created-the-requesting-issue:506 | optional_agent_tool | skills/paperclip/references/api-reference.md:506 |
| skill:skills/paperclip/references/api-reference.md:fetch-the-board-user-s-mine-inbox-issues:510 | control_plane_owned | skills/paperclip/references/api-reference.md:510 |
| skill:skills/paperclip/references/api-reference.md:summarize-it-back-to-the-board-in-a-comment-or-document:524 | always_agent_tool | skills/paperclip/references/api-reference.md:524 |
| skill:skills/paperclip/references/api-reference.md:worked-example-archive-a-resolved-inbox-item:529 | control_plane_owned | skills/paperclip/references/api-reference.md:529 |
| skill:skills/paperclip/references/api-reference.md:the-responsible-user-s-id-is-resolved-from-the-authenticated-agent-run:534 | optional_agent_tool | skills/paperclip/references/api-reference.md:534 |
| skill:skills/paperclip/references/api-reference.md:reverse-the-archive-if-it-was-premature-or-no-longer-desired:543 | optional_agent_tool | skills/paperclip/references/api-reference.md:543 |
| skill:skills/paperclip/references/api-reference.md:worked-example-reviewer-approver-heartbeat:553 | always_agent_tool | skills/paperclip/references/api-reference.md:553 |
| skill:skills/paperclip/references/api-reference.md:worked-example-manager-heartbeat:592 | optional_agent_tool | skills/paperclip/references/api-reference.md:592 |
| skill:skills/paperclip/references/api-reference.md:1-identity-skip-if-already-in-context:595 | control_plane_owned | skills/paperclip/references/api-reference.md:595 |
| skill:skills/paperclip/references/api-reference.md:2-check-team-status:599 | optional_agent_tool | skills/paperclip/references/api-reference.md:599 |
| skill:skills/paperclip/references/api-reference.md:3-agent-42-is-blocked-read-comments:606 | control_plane_owned | skills/paperclip/references/api-reference.md:606 |
| skill:skills/paperclip/references/api-reference.md:4-unblock-reassign-and-comment:610 | control_plane_owned | skills/paperclip/references/api-reference.md:610 |
| skill:skills/paperclip/references/api-reference.md:5-check-own-assignments:614 | optional_agent_tool | skills/paperclip/references/api-reference.md:614 |
| skill:skills/paperclip/references/api-reference.md:6-task-creation-with-an-optional-parent-and-assignee:621 | optional_agent_tool | skills/paperclip/references/api-reference.md:621 |
| skill:skills/paperclip/references/api-reference.md:load-tests-depend-on-caching-layer-being-done-first-paperclip-will-auto-wake-agent-55-when-the-blocker-resolves:627 | control_plane_owned | skills/paperclip/references/api-reference.md:627 |
| skill:skills/paperclip/references/api-reference.md:7-dashboard-for-health-check:632 | optional_agent_tool | skills/paperclip/references/api-reference.md:632 |
| skill:skills/paperclip/references/api-reference.md:comments-and-mentions:638 | always_agent_tool | skills/paperclip/references/api-reference.md:638 |
| skill:skills/paperclip/references/api-reference.md:update:645 | optional_agent_tool | skills/paperclip/references/api-reference.md:645 |
| skill:skills/paperclip/references/api-reference.md:cross-team-work-and-delegation:667 | optional_agent_tool | skills/paperclip/references/api-reference.md:667 |
| skill:skills/paperclip/references/api-reference.md:receiving-cross-team-work:671 | optional_agent_tool | skills/paperclip/references/api-reference.md:671 |
| skill:skills/paperclip/references/api-reference.md:questions-and-dependencies:681 | always_agent_tool | skills/paperclip/references/api-reference.md:681 |
| skill:skills/paperclip/references/api-reference.md:company-context:693 | optional_agent_tool | skills/paperclip/references/api-reference.md:693 |
| skill:skills/paperclip/references/api-reference.md:company-branding-ceo-board:705 | optional_agent_tool | skills/paperclip/references/api-reference.md:705 |
| skill:skills/paperclip/references/api-reference.md:openclaw-invite-prompt-ceo:725 | optional_agent_tool | skills/paperclip/references/api-reference.md:725 |
| skill:skills/paperclip/references/api-reference.md:setting-agent-instructions-path:744 | optional_agent_tool | skills/paperclip/references/api-reference.md:744 |
| skill:skills/paperclip/references/api-reference.md:project-setup-create-workspace:777 | optional_agent_tool | skills/paperclip/references/api-reference.md:777 |
| skill:skills/paperclip/references/api-reference.md:option-a-one-call-create-with-workspace:801 | optional_agent_tool | skills/paperclip/references/api-reference.md:801 |
| skill:skills/paperclip/references/api-reference.md:option-b-two-calls-project-first-then-workspace:820 | optional_agent_tool | skills/paperclip/references/api-reference.md:820 |
| skill:skills/paperclip/references/api-reference.md:governance-and-approvals:849 | optional_agent_tool | skills/paperclip/references/api-reference.md:849 |
| skill:skills/paperclip/references/api-reference.md:requesting-a-hire-management-only:853 | optional_agent_tool | skills/paperclip/references/api-reference.md:853 |
| skill:skills/paperclip/references/api-reference.md:ceo-strategy-approval:918 | optional_agent_tool | skills/paperclip/references/api-reference.md:918 |
| skill:skills/paperclip/references/api-reference.md:questions-and-waiting-for-human-input:927 | always_agent_tool | skills/paperclip/references/api-reference.md:927 |
| skill:skills/paperclip/references/api-reference.md:issue-thread-confirmations:1031 | always_agent_tool | skills/paperclip/references/api-reference.md:1031 |
| skill:skills/paperclip/references/api-reference.md:conversational-confirmation-answers:1102 | always_agent_tool | skills/paperclip/references/api-reference.md:1102 |
| skill:skills/paperclip/references/api-reference.md:checkbox-confirmations:1108 | always_agent_tool | skills/paperclip/references/api-reference.md:1108 |
| skill:skills/paperclip/references/api-reference.md:item-verdict-requests:1223 | optional_agent_tool | skills/paperclip/references/api-reference.md:1223 |
| skill:skills/paperclip/references/api-reference.md:checking-approval-status:1333 | optional_agent_tool | skills/paperclip/references/api-reference.md:1333 |
| skill:skills/paperclip/references/api-reference.md:approval-follow-up-requesting-agent:1339 | always_agent_tool | skills/paperclip/references/api-reference.md:1339 |
| skill:skills/paperclip/references/api-reference.md:issue-lifecycle:1357 | always_agent_tool | skills/paperclip/references/api-reference.md:1357 |
| skill:skills/paperclip/references/api-reference.md:error-handling:1389 | control_plane_owned | skills/paperclip/references/api-reference.md:1389 |
| skill:skills/paperclip/references/api-reference.md:full-api-reference:1403 | optional_agent_tool | skills/paperclip/references/api-reference.md:1403 |
| skill:skills/paperclip/references/api-reference.md:agents:1405 | optional_agent_tool | skills/paperclip/references/api-reference.md:1405 |
| skill:skills/paperclip/references/api-reference.md:issues-tasks:1426 | optional_agent_tool | skills/paperclip/references/api-reference.md:1426 |
| skill:skills/paperclip/references/api-reference.md:companies-projects-goals:1467 | optional_agent_tool | skills/paperclip/references/api-reference.md:1467 |
| skill:skills/paperclip/references/api-reference.md:routines:1491 | optional_agent_tool | skills/paperclip/references/api-reference.md:1491 |
| skill:skills/paperclip/references/api-reference.md:areas-and-responsibilities:1515 | optional_agent_tool | skills/paperclip/references/api-reference.md:1515 |
| skill:skills/paperclip/references/api-reference.md:responsibility-bars:1536 | optional_agent_tool | skills/paperclip/references/api-reference.md:1536 |
| skill:skills/paperclip/references/api-reference.md:automation-conversations-and-standing-checks:1559 | optional_agent_tool | skills/paperclip/references/api-reference.md:1559 |
| skill:skills/paperclip/references/api-reference.md:dashboard-conversations:1575 | optional_agent_tool | skills/paperclip/references/api-reference.md:1575 |
| skill:skills/paperclip/references/api-reference.md:responsibility-status:1590 | optional_agent_tool | skills/paperclip/references/api-reference.md:1590 |
| skill:skills/paperclip/references/api-reference.md:approvals-costs-activity-dashboard:1606 | optional_agent_tool | skills/paperclip/references/api-reference.md:1606 |
| skill:skills/paperclip/references/api-reference.md:secrets:1628 | optional_agent_tool | skills/paperclip/references/api-reference.md:1628 |
| skill:skills/paperclip/references/api-reference.md:agent-secret-proposals:1641 | optional_agent_tool | skills/paperclip/references/api-reference.md:1641 |
| skill:skills/paperclip/references/api-reference.md:agent-secret-access:1741 | optional_agent_tool | skills/paperclip/references/api-reference.md:1741 |
| skill:skills/paperclip/references/api-reference.md:common-mistakes:1781 | optional_agent_tool | skills/paperclip/references/api-reference.md:1781 |
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
| skill:skills/paperclip/references/routines.md:lifecycle:18 | optional_agent_tool | skills/paperclip/references/routines.md:18 |
| skill:skills/paperclip/references/routines.md:creating-a-routine:29 | optional_agent_tool | skills/paperclip/references/routines.md:29 |
| skill:skills/paperclip/references/routines.md:concurrency-policies:66 | optional_agent_tool | skills/paperclip/references/routines.md:66 |
| skill:skills/paperclip/references/routines.md:catch-up-policies:78 | optional_agent_tool | skills/paperclip/references/routines.md:78 |
| skill:skills/paperclip/references/routines.md:activity-gated-scheduled-runs:89 | optional_agent_tool | skills/paperclip/references/routines.md:89 |
| skill:skills/paperclip/references/routines.md:example-skip-quiet-nights:109 | optional_agent_tool | skills/paperclip/references/routines.md:109 |
| skill:skills/paperclip/references/routines.md:adding-triggers:128 | optional_agent_tool | skills/paperclip/references/routines.md:128 |
| skill:skills/paperclip/references/routines.md:schedule-cron:138 | optional_agent_tool | skills/paperclip/references/routines.md:138 |
| skill:skills/paperclip/references/routines.md:webhook:152 | optional_agent_tool | skills/paperclip/references/routines.md:152 |
| skill:skills/paperclip/references/routines.md:api-manual-only:169 | optional_agent_tool | skills/paperclip/references/routines.md:169 |
| skill:skills/paperclip/references/routines.md:updating-and-deleting-triggers:181 | optional_agent_tool | skills/paperclip/references/routines.md:181 |
| skill:skills/paperclip/references/routines.md:manual-run:198 | optional_agent_tool | skills/paperclip/references/routines.md:198 |
| skill:skills/paperclip/references/routines.md:updating-a-routine:214 | optional_agent_tool | skills/paperclip/references/routines.md:214 |
| skill:skills/paperclip/references/routines.md:reading-routines-and-runs:225 | optional_agent_tool | skills/paperclip/references/routines.md:225 |
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
