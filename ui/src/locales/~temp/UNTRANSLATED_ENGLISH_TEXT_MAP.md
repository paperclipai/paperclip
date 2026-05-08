# Untranslated English Text Map

Tracks hardcoded English strings discovered in QA scans. Append-only — do not remove rows; mark resolved strings in a follow-up pass.

Columns:
- **File** — source file (relative to `ui/src/`)
- **Line** — approximate line number in file at scan time
- **String** — the hardcoded literal (or template description)
- **Namespaces missing from** — i18n namespace the key should be added to

---

## 2026-05-08 — ZAI-172 upstream sync batch (ZAI-173 scan)

| File | Line | String | Namespaces missing from |
|---|---|---|---|
| components/ActivityRow.tsx | 51 | `"System"` | activity |
| components/ActivityRow.tsx | 51 | `"Board"` | activity |
| components/ActivityRow.tsx | 51 | `"Unknown"` | activity |
| components/IssueAssignedBacklogNotice.tsx | 23 | `"the assignee"` | issues |
| components/IssueAssignedBacklogNotice.tsx | 35 | `"Parked"` | issues |
| components/IssueAssignedBacklogNotice.tsx | 36 | `"will not be woken until status changes to"` | issues |
| components/IssueAssignedBacklogNotice.tsx | 37 | `"todo"` | issues |
| components/IssueAssignedBacklogNotice.tsx | 38 | `"in_progress"` | issues |
| components/IssueAssignedBacklogNotice.tsx | 42 | `"Comments still wake the assignee for questions or triage. Leave this parked only if the work is intentionally on hold."` | issues |
| components/IssueAssignedBacklogNotice.tsx | 55 | `"Resuming…"` | issues |
| components/IssueAssignedBacklogNotice.tsx | 55 | `"Resume now"` | issues |
| components/IssueBlockedNotice.tsx | 25 | `"the linked issue"` | issues |
| components/IssueBlockedNotice.tsx | 25 | `"the linked issues"` | issues |
| components/IssueBlockedNotice.tsx | 98 | `"This issue still needs a next step."` | issues |
| components/IssueBlockedNotice.tsx | 100 | `"A run finished successfully, but this issue is still open in"` | issues |
| components/IssueBlockedNotice.tsx | 104 | `"with no clear owner for the next action."` | issues |
| components/IssueBlockedNotice.tsx | 107 | `"Mark it done or cancelled."` | issues |
| components/IssueBlockedNotice.tsx | 108 | `"Send it for review or ask for input."` | issues |
| components/IssueBlockedNotice.tsx | 109 | `"Mark it blocked with a blocker owner."` | issues |
| components/IssueBlockedNotice.tsx | 110 | `"Delegate follow-up work or queue a continuation."` | issues |
| components/IssueBlockedNotice.tsx | 118 | `"run "` (prefix before run ID) | issues |
| components/IssueBlockedNotice.tsx | 126 | `"Corrective wake queued for "` | issues |
| components/IssueBlockedNotice.tsx | 131 | `"Detected progress: "` | issues |
| components/IssueBlockedNotice.tsx | 145 | `"Work on this issue is blocked by {label}..."` | issues |
| components/IssueBlockedNotice.tsx | 148 | `"Work on this issue is blocked until it is moved back to todo."` | issues |
| components/IssueBlockedNotice.tsx | 157 | `"Stalled in review"` | issues |
| components/IssueBlockedNotice.tsx | 164 | `"Ultimately waiting on"` | issues |
| components/IssueBlockedNotice.tsx | 176 | `"Blocked by parked work"` | issues |
| components/IssueChatThread.tsx | 758 | `"ran N command(s)"` (template literal) | issues |
| components/IssueChatThread.tsx | 759 | `"called N tool(s)"` (template literal) | issues |
| components/IssueChatThread.tsx | 818 | `"Working"` | issues |
| components/IssueChatThread.tsx | 821 | `"Worked"` | issues |
| components/IssueChatThread.tsx | 819 | `"for {elapsed}"` (template literal) | issues |
| components/IssueChatThread.tsx | 1096 | `"Input"` | issues |
| components/IssueChatThread.tsx | 1121 | `"Result"` | issues |
| components/IssueChatThread.tsx | 1253 | `"⏸ Deferred wake"` | issues |
| components/IssueChatThread.tsx | 1253 | `"Queued"` | issues |
| components/IssueChatThread.tsx | 1279 | `"Follow-up"` (user message header badge) | issues |
| components/IssueChatThread.tsx | 1410 | `"Stop run"` | issues |
| components/IssueChatThread.tsx | 1411 | `"Stopping..."` | issues |
| components/IssueChatThread.tsx | 1420 | `"Agent"` (AvatarFallback) | issues |
| components/IssueChatThread.tsx | 1503 | `"Follow-up"` (assistant message header badge) | issues |
| components/IssueChatThread.tsx | 1510 | `"Running"` | issues |
| components/IssueChatThread.tsx | 1550 | `"Copy message"` (title prop) | issues |
| components/IssueChatThread.tsx | 1551 | `"Copy message"` (aria-label prop) | issues |
| components/IssueChatThread.tsx | 1900 | `"updated this task"` | issues |
| components/IssueChatThread.tsx | 1915 | `"Hide confirmation"` | issues |
| components/IssueChatThread.tsx | 1915 | `"Expired confirmation"` | issues |
| components/IssueChatThread.tsx | 2164 | `"requested follow-up"` | issues |
| components/IssueChatThread.tsx | 2164 | `"updated this task"` (event row) | issues |
| components/IssueChatThread.tsx | 2177 | `"Status"` (status change row label) | issues |
| components/IssueChatThread.tsx | 2188 | `"Assignee"` (assignee change row label) | issues |
| components/IssueChatThread.tsx | 2249 | `"run"` (run timeline row) | issues |
| components/IssueMonitorActivityCard.tsx | 40 | `"Monitor scheduled"` | issues |
| components/IssueMonitorActivityCard.tsx | 42 | `"Next check "` (prefix before date) | issues |
| components/IssueMonitorActivityCard.tsx | 53 | `"Attempt "` (prefix before count) | issues |
| components/IssueMonitorActivityCard.tsx | 65 | `"Checking..."` | issues |
| components/IssueMonitorActivityCard.tsx | 65 | `"Check now"` | issues |
| components/IssueProperties.tsx | 77 | `"Copied!"` | issues |
| components/IssueProperties.tsx | 77 | `"Click to copy"` | issues |
| components/IssueProperties.tsx | 249 | `"Remove {issueLabel} as blocker"` (aria-label) | issues |
| components/IssueProperties.tsx | 269 | `"Issue {issueLabel}: {issue.title}"` (aria-label) | issues |
| components/IssueProperties.tsx | 295 | `"Remove blocker?"` (Dialog title) | issues |
| components/IssueProperties.tsx | 296 | `"Remove {confirmLabel} as a blocker for this issue."` | issues |
| components/IssueProperties.tsx | 303 | `"Cancel"` | issues |
| components/IssueProperties.tsx | 305 | `"Remove blocker"` | issues |
| components/IssueProperties.tsx | 484 | `"None"` (project name fallback) | issues |
| components/IssueProperties.tsx | 659 | `"Cheap model"` (aria-label) | issues |
| components/IssueProperties.tsx | 659 | `"Primary model"` (aria-label) | issues |
| components/IssueProperties.tsx | 659 | `"Model lane"` (aria-label) | issues |
| components/IssueProperties.tsx | 665 | `"Primary"` | issues |
| components/IssueProperties.tsx | 665 | `"Cheap"` | issues |
| components/IssueProperties.tsx | 665 | `"Custom"` | issues |
| components/IssueProperties.tsx | 714 | `"Default model"` | issues |
| components/IssueProperties.tsx | 714 | `"Search models..."` | issues |
| components/IssueProperties.tsx | 714 | `"No models found."` | issues |
| components/IssueProperties.tsx | 723 | `"Thinking effort"` | issues |
| components/IssueProperties.tsx | 741 | `"Enable Chrome (--chrome)"` | issues |
| components/IssueProperties.tsx | 755 | `"Clear adapter options"` | issues |
| components/IssueProperties.tsx | 1111 | `"What should the agent re-check?"` (placeholder) | issues |
| components/IssueProperties.tsx | 1120 | `"External service"` (placeholder) | issues |
| components/IssueProperties.tsx | 1131 | `"Schedule"` | issues |
| components/IssueProperties.tsx | 1131 | `"Clear"` | issues |
| components/IssueProperties.tsx | 1732 | `"Assignee"` (PropertyRow label) | issues |
| components/IssueProperties.tsx | 1732 | `"Status"` (PropertyRow label) | issues |
| components/IssueProperties.tsx | 1732 | `"Priority"` (PropertyRow label) | issues |
| components/IssueProperties.tsx | 1732 | `"Labels"` (PropertyRow label) | issues |
| components/IssueProperties.tsx | 1903 | `"Add sub-issue"` | issues |
| components/IssueRow.tsx | 75 | `"Productivity review: "` (title prop prefix) | issues |
| components/IssueRow.tsx | 77 | `"Productivity review open"` (aria-label) | issues |
| components/IssueRow.tsx | 93 | `"Planning"` | issues |
| components/IssueRow.tsx | 99 | `"Blocked by parked work — at least one assigned blocker is in backlog..."` (title prop) | issues |
| components/IssueRow.tsx | 103 | `"Blocked by parked work"` | issues |
| components/IssueRow.tsx | 195 | `"Mark as read"` (aria-label) | issues |
| components/IssueRow.tsx | 221 | `"Dismiss from inbox"` (aria-label) | issues |
| components/IssueScheduledRetryCard.tsx | 50 | `"Continuation scheduled"` | issues |
| components/IssueScheduledRetryCard.tsx | 50 | `"Retry scheduled"` | issues |
| components/IssueScheduledRetryCard.tsx | 51 | `"Automatic continuation"` | issues |
| components/IssueScheduledRetryCard.tsx | 51 | `"Automatic retry"` | issues |
| components/IssueScheduledRetryCard.tsx | 53 | `"due now"` | issues |
| components/IssueScheduledRetryCard.tsx | 57 | `"pending schedule"` | issues |
| components/IssueScheduledRetryCard.tsx | 63 | `"Pulls continuation forward immediately"` | issues |
| components/IssueScheduledRetryCard.tsx | 63 | `"Pulls retry forward immediately"` | issues |
| components/IssueScheduledRetryCard.tsx | 82 | `"Attempt "` (prefix) | issues |
| components/IssueScheduledRetryCard.tsx | 95 | `"Replaces run"` | issues |
| components/IssueScheduledRetryCard.tsx | 108 | `"Last attempt failed: {error}. Paperclip will retry automatically."` | issues |
| components/IssueScheduledRetryCard.tsx | 131 | `"Retrying…"` | issues |
| components/IssueScheduledRetryCard.tsx | 131 | `"Already promoted"` | issues |
| components/IssueScheduledRetryCard.tsx | 131 | `"Promoted"` | issues |
| components/IssueScheduledRetryCard.tsx | 131 | `"Retry now"` | issues |
| components/IssueScheduledRetryCard.tsx | 149 | `"Promoting scheduled retry"` | issues |
| components/IssueScheduledRetryCard.tsx | 149 | `"Already promoted — run starting"` | issues |
| components/IssueScheduledRetryCard.tsx | 149 | `"Promoted — run starting"` | issues |
| components/IssueScheduledRetryCard.tsx | 181 | `"Couldn't retry now"` | issues |
| components/IssueScheduledRetryCard.tsx | 185 | `"Try again"` | issues |
| components/IssuesList.tsx | 91 | `"Backlog"` (group header) | issues |
| components/IssuesList.tsx | 92 | `"Todo"` (group header) | issues |
| components/IssuesList.tsx | 93 | `"In progress"` (group header) | issues |
| components/IssuesList.tsx | 94 | `"In review"` (group header) | issues |
| components/IssuesList.tsx | 95 | `"Done"` (group header) | issues |
| components/IssuesList.tsx | 96 | `"Blocked"` (group header) | issues |
| components/IssuesList.tsx | 99 | `"Cancelled"` (group header) | issues |
| components/IssuesList.tsx | 483 | `"done"` (progress summary) | issues |
| components/IssuesList.tsx | 484 | `"in progress"` (progress summary) | issues |
| components/IssuesList.tsx | 485 | `"blocked"` (progress summary) | issues |
| components/IssuesList.tsx | 486 | `"tokens"` (progress summary) | issues |
| components/IssuesList.tsx | 487 | `"runtime"` (progress summary) | issues |
| components/IssuesList.tsx | 488 | `"runs"` (progress summary) | issues |
| components/IssuesList.tsx | 507 | `"sub-issues"` (progress summary) | issues |
| components/IssuesList.tsx | 533 | `"Next up"` | issues |
| components/IssuesList.tsx | 536 | `"Waiting on blockers"` | issues |
| components/IssuesList.tsx | 540 | `"No active sub-issues"` | issues |
| components/IssuesList.tsx | 547 | `"All sub-issues done"` | issues |
| components/IssuesList.tsx | 554 | `"No actionable sub-issues"` | issues |
| components/IssuesList.tsx | 1237 | `"Create {label}"` (template literal) | issues |
| components/IssuesList.tsx | 1238 | `"New {label}"` (template literal) | issues |
| components/IssuesList.tsx | 1299 | `"List view"` (title prop) | issues |
| components/IssuesList.tsx | 1310 | `"Board view"` (title prop) | issues |
| components/IssuesList.tsx | 1320 | `"Disable parent-child nesting"` | issues |
| components/IssuesList.tsx | 1321 | `"Enable parent-child nesting"` | issues |
| components/IssuesList.tsx | 1332 | `"Choose which issue columns stay visible"` | issues |
| components/IssuesList.tsx | 1447 | `"No issues match the current filters or search."` | issues |
| components/IssuesList.tsx | 1823 | `"Loading more issues..."` | issues |
| components/IssuesList.tsx | 1825 | `"Rendering N of M issues"` (template literal) | issues |
| components/IssuesList.tsx | 1827 | `"Scroll to load more issues"` | issues |
| components/NewIssueDialog.tsx | 222 | `"Parked — assignee will not be woken"` | issues |
| components/NewIssueDialog.tsx | 228 | `"Executable — assignee will be woken"` | issues |
| components/NewIssueDialog.tsx | 248 | `"Project default"` (workspace mode) | issues |
| components/NewIssueDialog.tsx | 248 | `"New isolated workspace"` | issues |
| components/NewIssueDialog.tsx | 248 | `"Reuse existing workspace"` | issues |
| components/NewIssueDialog.tsx | 316 | `"Issue title"` (placeholder) | issues |
| components/NewIssueDialog.tsx | 386 | `"Add description..."` (placeholder) | issues |
| components/NewIssueDialog.tsx | 1292 | `"New sub-issue"` | issues |
| components/NewIssueDialog.tsx | 1292 | `"New issue"` | issues |
| components/NewIssueDialog.tsx | 1334 | `"For"` | issues |
| components/NewIssueDialog.tsx | 1343 | `"Assignee"` | issues |
| components/NewIssueDialog.tsx | 1343 | `"No assignee"` | issues |
| components/NewIssueDialog.tsx | 1343 | `"Search assignees..."` | issues |
| components/NewIssueDialog.tsx | 1343 | `"No assignees found."` | issues |
| components/NewIssueDialog.tsx | 1390 | `"in"` (label) | issues |
| components/NewIssueDialog.tsx | 1392 | `"Search projects..."` | issues |
| components/NewIssueDialog.tsx | 1392 | `"No projects found."` | issues |
| components/NewIssueDialog.tsx | 1439 | `"Add reviewer or approver"` | issues |
| components/NewIssueDialog.tsx | 1456 | `"Reviewer"` | issues |
| components/NewIssueDialog.tsx | 1456 | `"Approver"` | issues |
| components/NewIssueDialog.tsx | 1574 | `"Sub-issue of"` | issues |
| components/NewIssueDialog.tsx | 1589 | `"Execution workspace"` | issues |
| components/NewIssueDialog.tsx | 1615 | `"Choose an existing workspace"` | issues |
| components/NewIssueDialog.tsx | 1696 | `"Default model"` | issues |
| components/NewIssueDialog.tsx | 1696 | `"Search models..."` | issues |
| components/NewIssueDialog.tsx | 1696 | `"No models found."` | issues |
| components/NewIssueDialog.tsx | 1723 | `"Thinking effort"` | issues |
| components/NewIssueDialog.tsx | 1728 | `"Enable Chrome (--chrome)"` | issues |
| components/NewIssueDialog.tsx | 1975 | `"Start date"` | issues |
| components/NewIssueDialog.tsx | 1983 | `"Due date"` | issues |
| components/NewIssueDialog.tsx | 2008 | `"Discard Draft"` | issues |
| components/NewIssueDialog.tsx | 2030 | `"Creating..."` | issues |
| components/NewIssueDialog.tsx | 2030 | `"Create Sub-Issue"` | issues |
| components/NewIssueDialog.tsx | 2030 | `"Create Issue"` | issues |
| pages/CompanySkills.tsx | 422 | `"No skills match this filter."` | company |
| pages/CompanySkills.tsx | 547 | `"Select a skill to inspect its files."` | company |
| pages/CompanySkills.tsx | 587 | `"Removing..."` | company |
| pages/CompanySkills.tsx | 587 | `"Remove"` | company |
| pages/CompanySkills.tsx | 594 | `"Stop editing"` | company |
| pages/CompanySkills.tsx | 594 | `"Edit"` | company |
| pages/CompanySkills.tsx | 638 | `"Check for updates"` | company |
| pages/CompanySkills.tsx | 638 | `"Install update"` | company |
| pages/CompanySkills.tsx | 638 | `"Up to date"` | company |
| pages/CompanySkills.tsx | 672 | `"Editable"` | company |
| pages/CompanySkills.tsx | 672 | `"Read only"` | company |
| pages/CompanySkills.tsx | 679 | `"No agents attached"` | company |
| pages/CompanySkills.tsx | 712 | `"View"` | company |
| pages/CompanySkills.tsx | 712 | `"Code"` | company |
| pages/CompanySkills.tsx | 726 | `"Cancel"` | company |
| pages/CompanySkills.tsx | 726 | `"Saving..."` | company |
| pages/CompanySkills.tsx | 726 | `"Save"` | company |
| pages/CompanySkills.tsx | 744 | `"Select a file to inspect."` | company |
| pages/CompanySkills.tsx | 1100 | `"Remove skill"` (Dialog title) | company |
| pages/CompanySkills.tsx | 1192 | `"Skills"` (h1) | company |
| pages/CompanySkills.tsx | 1219 | `"Filter skills"` (placeholder) | company |
| pages/CompanySkills.tsx | 1227 | `"Paste path, GitHub URL, or skills.sh command"` (placeholder) | company |
| pages/CompanySkills.tsx | 1237 | `"Add"` | company |
| pages/CompanySkills.tsx | 1296 | `"Removing..."` | company |
| pages/CompanySkills.tsx | 1296 | `"Remove skill"` (button) | company |
| pages/IssueDetail.tsx | 439 | `"Routine"` (skeleton header) | issues |
| pages/IssueDetail.tsx | 452 | `"No project"` (skeleton header) | issues |
| pages/IssueDetail.tsx | 1059 | `"This issue"` (cost summary) | issues |
| pages/IssueDetail.tsx | 1067 | `"Tokens {formatted} (in …, out …)"` | issues |
| pages/IssueDetail.tsx | 1075 | `"Runtime "` (prefix) | issues |
| pages/IssueDetail.tsx | 1076 | `"(N run(s))"` (template literal) | issues |
| pages/IssueDetail.tsx | 1080 | `"No direct cost data."` | issues |
| pages/IssueDetail.tsx | 1085 | `"Including sub-issues {cost}"` | issues |
| pages/IssueDetail.tsx | 1105 | `"N issue(s)"` (template literal) | issues |
| pages/IssueDetail.tsx | 2981 | `"Pause and stop work"` | issues |
| pages/IssueDetail.tsx | 2983 | `"Cancel N issues"` (template literal) | issues |
| pages/IssueDetail.tsx | 2985 | `"Restore N issues"` (template literal) | issues |
| pages/IssueDetail.tsx | 3097 | `"Issue execution is held until resume. Human comments can still wake the assignee for triage."` | issues |
| pages/IssueDetail.tsx | 3098 | `"Root and descendant execution is held until resume. Human comments can still wake assignees for triage."` | issues |
| pages/IssueDetail.tsx | 3102 | `"1 issue held"` | issues |
| pages/IssueDetail.tsx | 3103 | `"N descendant(s) held"` (template literal) | issues |
| pages/IssueDetail.tsx | 3128 | `"View affected (N)"` (template literal) | issues |
| pages/IssueDetail.tsx | 3149 | `"This issue is paused by ancestor "` | issues |
| pages/IssueDetail.tsx | 3221 | `"No project"` (live header) | issues |
| pages/Routines.tsx | 493 | `"Routines"` (h1) | routines |
| pages/Routines.tsx | 494 | `"Recurring work definitions that materialize into auditable execution issues."` | routines |
| pages/Routines.tsx | 501 | `"Create routine"` | routines |
| pages/Routines.tsx | 511 | `"Routines"` (tab label) | routines |
| pages/Routines.tsx | 511 | `"Recent Runs"` (tab label) | routines |
| pages/Routines.tsx | 518 | `"N routine(s)"` (template literal) | routines |
| pages/Routines.tsx | 623 | `"New routine"` (dialog header) | routines |
| pages/Routines.tsx | 648 | `"Routine title"` (placeholder) | routines |
| pages/Routines.tsx | 681 | `"For"` | routines |
| pages/Routines.tsx | 727 | `"in"` | routines |
| pages/Routines.tsx | 779 | `"Add instructions..."` (placeholder) | routines |
| pages/Routines.tsx | 793 | `"Advanced delivery settings"` | routines |
| pages/Routines.tsx | 800 | `"Concurrency"` | routines |
| pages/Routines.tsx | 818 | `"Catch-up"` | routines |
| pages/Routines.tsx | 852 | `"Creating..."` | routines |
| pages/Routines.tsx | 852 | `"Create routine"` | routines |
| pages/Routines.tsx | 877 | `"No routines yet."` | routines |

---

## 2026-05-08 — ZAI-127 upstream sync (ZAI-128 QA scan)

| File | Line | String | Namespaces missing from |
|---|---|---|---|
| components/CommentThread.tsx | 277 | `"Copied"` | comments |
| components/CommentThread.tsx | 277 | `"Copy failed"` | comments |
| components/CommentThread.tsx | 277 | `"Copy"` | comments |
| components/CommentThread.tsx | 291 | `"Copy comment as markdown"` | comments |
| components/CommentThread.tsx | 374 | `"Queued"` | comments |
| components/CommentThread.tsx | 379 | `"Follow-up"` | comments |
| components/CommentThread.tsx | 399 | `"Queueing..."` | comments |
| components/CommentThread.tsx | 399 | `"Sending..."` | comments |
| components/CommentThread.tsx | 512 | `"Status"` | comments |
| components/CommentThread.tsx | 527 | `"Assignee"` | comments |
| components/CommentThread.tsx | 631 | `"run"` | comments |
| components/CommentThread.tsx | 653 | `"Environment"` | comments |
| components/CommentThread.tsx | 659 | `"Provider"` | comments |
| components/CommentThread.tsx | 664 | `"Lease"` | comments |
| components/CommentThread.tsx | 678 | `"Failure: "` | comments |
| components/CommentThread.tsx | 956 | `"Queued Comments ({count})"` | comments |
| components/CommentThread.tsx | 966 | `"Interrupting..."` | comments |
| components/CommentThread.tsx | 966 | `"Interrupt"` | comments |
| components/CommentThread.tsx | 996 | `"Leave a comment..."` | comments |
| components/CommentThread.tsx | 1017 | `"Attach image"` | comments |
| components/CommentThread.tsx | 1027 | `"Assignee"` | comments |
| components/CommentThread.tsx | 1028 | `"No assignee"` | comments |
| components/CommentThread.tsx | 1029 | `"Search assignees..."` | comments |
| components/CommentThread.tsx | 1030 | `"No assignees found."` | comments |
| components/CommentThread.tsx | 1034 | `"Assignee"` | comments |
| components/CommentThread.tsx | 1062 | `"Posting..."` | comments |
| components/CommentThread.tsx | 1062 | `"Comment"` | comments |
| components/IssueProperties.tsx | 170 | `"Remove {issueLabel} as blocker"` | issues |
| components/IssueProperties.tsx | 190 | `"Issue {issueLabel}: {issue.title}"` | issues |
| components/IssueProperties.tsx | 205 | `"Issue {issueLabel}: {issue.title}"` | issues |
| components/IssueProperties.tsx | 216 | `"Remove blocker?"` | issues |
| components/IssueProperties.tsx | 218 | `"Remove {confirmLabel} as a blocker for this issue."` | issues |
| components/IssueProperties.tsx | 223 | `"Cancel"` | issues |
| components/IssueProperties.tsx | 226 | `"Remove blocker"` | issues |
| components/IssueProperties.tsx | 745 | `"Add label"` | issues |
| components/IssueProperties.tsx | 756 | `"Search labels..."` | issues |
| components/IssueProperties.tsx | 795 | `"New label"` | issues |
| components/IssueProperties.tsx | 811 | `"Creating…"` | issues |
| components/IssueProperties.tsx | 811 | `"Create label"` | issues |
| components/IssueProperties.tsx | 827 | `"Unassigned"` | issues |
| components/IssueProperties.tsx | 833 | `"No assignee"` | issues |
| components/IssueProperties.tsx | 839 | `"Assign to me"` | issues |
| components/IssueProperties.tsx | 848 | `"Assign to {creatorUserLabel}"` | issues |
| components/IssueProperties.tsx | 848 | `"Assign to requester"` | issues |
| context/LiveUpdatesProvider.tsx | 85 | `"System"` | issues |
| context/LiveUpdatesProvider.tsx | 87 | `"Board"` | issues |
| context/LiveUpdatesProvider.tsx | 89 | `"Someone"` | issues |
| context/LiveUpdatesProvider.tsx | 456 | `"{actor} created {issue.ref}"` | issues |
| context/LiveUpdatesProvider.tsx | 459 | `"View {issue.ref}"` | issues |
| context/LiveUpdatesProvider.tsx | 478 | `"{actor} updated {issue.ref}"` | issues |
| context/LiveUpdatesProvider.tsx | 481 | `"View {issue.ref}"` | issues |
| context/LiveUpdatesProvider.tsx | 492 | `"reopened from {reopenedFrom}"` | issues |
| context/LiveUpdatesProvider.tsx | 493 | `"reopened"` | issues |
| context/LiveUpdatesProvider.tsx | 497 | `"{actor} reopened and commented on {issue.ref}"` | issues |
| context/LiveUpdatesProvider.tsx | 499 | `"{actor} commented and updated {issue.ref}"` | issues |
| context/LiveUpdatesProvider.tsx | 500 | `"{actor} commented on {issue.ref}"` | issues |
| context/LiveUpdatesProvider.tsx | 514 | `"View {issue.ref}"` | issues |
| context/LiveUpdatesProvider.tsx | 531 | `"Agent"` | issues |
| context/LiveUpdatesProvider.tsx | 532 | `"Someone"` | issues |
| context/LiveUpdatesProvider.tsx | 534 | `"{label} wants to join"` | issues |
| context/LiveUpdatesProvider.tsx | 535 | `"A new join request is waiting for approval."` | issues |
| context/LiveUpdatesProvider.tsx | 537 | `"View inbox"` | issues |
| context/LiveUpdatesProvider.tsx | 556 | `"{name} started"` | issues |
| context/LiveUpdatesProvider.tsx | 557 | `"{name} errored"` | issues |
| context/LiveUpdatesProvider.tsx | 567 | `"View agent"` | issues |
| context/LiveUpdatesProvider.tsx | 586 | `"succeeded"` | issues |
| context/LiveUpdatesProvider.tsx | 587 | `"failed"` | issues |
| context/LiveUpdatesProvider.tsx | 588 | `"timed out"` | issues |
| context/LiveUpdatesProvider.tsx | 589 | `"cancelled"` | issues |
| context/LiveUpdatesProvider.tsx | 590 | `"{name} run {statusLabel}"` | issues |
| context/LiveUpdatesProvider.tsx | 596 | `"Trigger: {triggerDetail}"` | issues |
| context/LiveUpdatesProvider.tsx | 604 | `"View run"` | issues |
| pages/IssueDetail.tsx | 524 | `"Back to inbox"` | issues |
| pages/IssueDetail.tsx | 536 | `"Archive from inbox"` | issues |
| pages/IssueDetail.tsx | 544 | `"More actions"` | issues |
| pages/IssueDetail.tsx | 3067 | `"This issue is hidden"` | issues |
| pages/IssueDetail.tsx | 3076 | `"Paused by board."` | issues |
| pages/IssueDetail.tsx | 3076 | `"Subtree pause is active."` | issues |
| pages/IssueDetail.tsx | 3080 | `"Issue execution is held until resume. Human comments can still wake the assignee for triage."` | issues |
| pages/IssueDetail.tsx | 3081 | `"Root and descendant execution is held until resume. Human comments can still wake assignees for triage."` | issues |
| pages/IssueDetail.tsx | 3086 | `"1 issue held"` | issues |
| pages/IssueDetail.tsx | 3087 | `"{heldDescendantCount} descendant(s) held"` | issues |
| pages/IssueDetail.tsx | 3100 | `"Resume work"` | issues |
| pages/IssueDetail.tsx | 3100 | `"Resume subtree"` | issues |
| pages/IssueDetail.tsx | 3111 | `"View affected ({count})"` | issues |
| pages/IssueDetail.tsx | 3124 | `"Cancel subtree..."` | issues |
| pages/IssueDetail.tsx | 3132 | `"This issue is paused by ancestor … Resume from the root issue to deliver deferred work."` | issues |
| pages/IssueDetail.tsx | 3420 | `"Add a description..."` | issues |
| pages/IssueDetail.tsx | 3622 | `"Delete attachment"` | issues |
| pages/IssueDetail.tsx | 3651 | `"Delete attachment"` | issues |
