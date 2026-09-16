# Composer Stop and task controls

The empty composer shows **Stop** while this task has a live execution and the
viewer can manage task controls. Stop creates the same manual pause hold as
**Pause work** / **Pause subtree** in the task menu. A parent pause includes its
descendants. Cancellation remains a separate menu action.

Text (after trimming) or attachments switch the button back to Send. Uploading
and failed attachments retain their existing restrictions. Keyboard submission
never invokes Stop. Queued-message editing and structured interactions keep
their existing actions, and text entered while stopping remains in the draft.

Pause dispatches without a preview dialog or reason. The button stays pending
while affected run state is checked; native cancellation must be acknowledged.
A saved hold with unconfirmed termination produces an error rather than a
success claim. The cancellation dialog requires a valid preview and excludes
terminal tasks. Resume/restore retain the optional wake-agents checkbox.

## Resume and execution recovery

Resume releases a hold. Waking agents is optional and only applies to tasks in
`todo`, `in_progress`, or `in_review`; parked and terminal tasks stay untouched.
The current execution-recovery policy requires verified outcomes before a stopped
provider can restart. If any affected task still needs that reconciliation,
Resume with wake enabled returns an inline error and preserves the pause. The
operator can release the pause without waking agents, then use the existing
execution-reconciliation flow after reviewing the stopped run. Resume does not
claim that unknown provider actions completed or were never performed.

A completed release remains successful if a best-effort wake fails. Its response
includes optional `wakeFailures`, the page reports them inline, and remaining
eligible tasks still receive their wake requests. No new endpoint is introduced.
The deterministic E2E fixtures prove interruption, then record their known lack
of external effects through the existing reconciliation API before continuing.

Embedded ACP also supports verified continuation of an interrupted local session.
The adapter must acknowledge cancellation and prove a preserved session with
settled read-only work. Stop waits for provider cleanup. Forced local termination uses the actual
child-process handle captured at spawn, including on Windows. An unavailable
handle does not authorize a signal or replay. Unknown actions remain
blocked, and task detail shows the reason even after recovery bookkeeping resolves.
A run-level Stop leaves the task unpaused; a subsequent comment can continue the
same session with the earlier queued messages. Composer Stop still creates a
pause hold. New board messages require Resume first. Both comment creation and
updates that include a comment return `409` while an effective task or ancestor
pause hold is active. Interrupted agents may still report their results. Neither path permits a fresh-session fallback
when the interrupted checkpoint cannot be restored.

The credential-free ACP regression journey uses an actual ACP child process:

```sh
pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/acp-stop-continuation.spec.ts
```

It covers the queued-follow-up sequence (queue a second request, stop, then send “go”),
same-session delivery of both messages, and an unfinished write that stops
mutating its file but retains a visible execution blocker. Unit and integration
tests additionally cover pre-start Stop, unavailable/changed sessions, rotating
scratch directories, cancellation acknowledgment, a provider that hangs during
cleanup after returning cancellation, deferred-wake adoption, and
company-scoped blocker lookup. Hosted-provider behavior is a separate smoke test.

The browser tests also require the continued provider to complete the task through
the agent API. Restoring a session must refresh its run identity, API credential,
and scratch environment. The same conversation must not reuse the stopped run's
credential. A regression test checks distinct run IDs and token hashes across the
restart without logging the credentials themselves.

Historical behavior, superseded by the composer takeover: on 2026-09-09, all three ACP browser journeys passed. A manual browser walk-through
also queued a request, used composer Stop, sent “go” while paused, and selected
Resume work. The pause stayed in place during the conversation reply. Resume
restored the same provider session, answered the pending request once, and moved
the task to Done through the current run's authenticated API call. These tests use
a deterministic ACP child process; they do not call Drive or another external app.
The manual unfinished-write check also confirmed that file size stayed unchanged
for five seconds after Interrupt. Sending “go” displayed the reconciliation reason
and did not start another provider prompt.

A separate live Claude ACP smoke test interrupted a Bash tool writing only to a
disposable local file: cancellation settled in 1,167 ms, output remained unchanged
for five seconds, and no matching tool process remained. The shell action correctly
did not receive automatic replay permission. A second live Claude check interrupted
a response with no tools, restored the exact same provider session, and received
the requested follow-up answer. These are local-provider observations, not a
latency guarantee or proof for every provider and remote sandbox.

## Quiet task feedback

The visible task/subtree does not produce duplicate state toasts. Its live
notifications are suppressed while foregrounded, including descendant runs;
unrelated and background work retains notifications. Tree-control results use
inline state, and failures stay in the composer, page, or confirmation dialog.
The amber composer takeover contains “Subtree is paused.” (or “Task is paused.”),
a short instruction to resume before sending, and Resume. It replaces input
controls in both task interfaces, cannot be dismissed, and preserves text and
attachment drafts. An inherited hold links to the ancestor task. Pending resume
keeps the takeover visible; failed resume leaves the task paused. Expected cancellation uses a muted gray disclosure with optional details.
This is recorded as a product rule in `DESIGN.md`.

The follow-up passed 213 focused tests, both isolated runner E2E journeys
(including no-toast assertions), UI typecheck/build, token gates, and Storybook
build. Paused, expanded cancellation, Stop without toasts, mobile, and light
stories were inspected in the browser.

## Storybook

Run from the worktree:

```sh
pnpm --filter @paperclipai/ui exec storybook dev -p 6016 -c storybook/.storybook --no-open
```

Open `http://localhost:6016/?path=/story/tasks-execution-controls--running-empty`.
The `Tasks / Execution Controls` stories compose the production composer and
menu/dialog controls together. They cover text switching, attachment-only,
idle, stopping, paused, errors, cancellation preview/loading, and mobile/light
presentations. The Storybook state transitions simulate requests; runner
verification belongs to the isolated browser suite below.

## Automated verification

```sh
pnpm exec vitest run --project @paperclipai/ui ui/src/components/task-chat/TaskChatComposer.test.tsx ui/src/components/TaskChatThread.test.tsx ui/src/pages/IssueDetail.test.tsx ui/src/lib/wait-for-stopped-runs.test.ts
pnpm exec vitest run --project @paperclipai/server server/src/__tests__/issue-tree-control-routes.test.ts
pnpm check:token-gates
pnpm build-storybook
pnpm -r typecheck
pnpm test:run
pnpm build
```

The component/page tests cover whitespace, attachments and upload restrictions,
permissions, keyboard submission, queue edits, duplicate clicks, draft
preservation, shared pause requests, compact cancellation, and visible errors.
Stop verification tests include continued execution, native acknowledgment,
network failures, and hung status requests. Route tests cover pause dispatch,
authorization, cancellation, and opt-in resume wakeups with terminal/company
exclusions.

## Isolated browser acceptance

Legacy process coverage needs no provider credentials:

```sh
pnpm exec playwright test --config tests/e2e/playwright-composer-stop.config.ts
```

To include native execution, build the real runner and deterministic Codex
protocol fixture from this checkout, then point the suite at their absolute
paths:

```sh
cargo build --manifest-path packages/paperclip-runner/runner/Cargo.toml --bin paperclip-runnerd --bin fake-codex-app-server
PAPERCLIP_STOP_FAKE_CODEX="$PWD/packages/paperclip-runner/runner/target/debug/fake-codex-app-server" \
PAPERCLIP_RUNNER_BINARY="$PWD/packages/paperclip-runner/runner/target/debug/paperclip-runnerd" \
pnpm exec playwright test --config tests/e2e/playwright-composer-stop.config.ts
```

The suite boots a disposable local-trusted instance on port 3199 (override with
`PAPERCLIP_E2E_PORT`). It never attaches to an existing server. Native coverage
is explicitly skipped without the fixture; it must not use a logged-in provider
as a fallback. Test companies are archived during cleanup.

For each runner, the journey starts a parent, child, and unrelated task, plus a
terminal child. It sends while running and verifies the durable queue, clicks
Stop, verifies interruption and the persisted hold, and observes three
ten-second scheduler intervals without continuation. It resumes with wakeups,
pauses from the menu, dismisses and then confirms cancellation, and verifies
terminal-task exclusions and unrelated execution.

Timing attachments distinguish click-to-request from request-to-observed-stop.
Native proof requires provider `turn/start` before the click, `turn/interrupt`
after it, and durable cancellation acknowledgment. Legacy proof checks the
actual parent and child PIDs have exited with a one-second configured grace
period. HTTP success alone is insufficient.

For a release with real providers, repeat while an actual long-running tool is
active, confirm the tool's own process/output stops, and verify a queued message
is consumed on continuation. The deterministic provider exercises the native
transport and cancellation protocol, not external provider behavior or every
tool's process cleanup. Preserve these limits in any test report.

## Recorded acceptance run (2026-09-09)

Both isolated browser journeys passed. Legacy Stop dispatched after 214 ms and
observed both runs stopped 155 ms after dispatch; native dispatched after 212 ms
and observed stop 320 ms later. These are single local observations including
browser automation overhead, not latency guarantees. Native used the real
runnerd and the repository's deterministic Codex protocol fixture. Real hosted
provider/tool cleanup remains a release acceptance check.

Repository typecheck, production build, Storybook build, token gates, targeted
UI tests, and tree-control route tests passed. The broad UI run passed 5,491
tests with one five-second timeout in an unchanged `IssuesList` test; rerunning
that file passed all 46 tests. The repository test run encountered 17 failures
in unchanged suites, all reproduced in the original checkout:

- `server/src/__tests__/workspace-runtime.test.ts`: 2 failures.
- `server/src/services/workspace-runtime-exposure.test.ts`: 7 failures.
- `server/src/__tests__/execution-workspace-runtime-control-conflict.test.ts`: 4 failures.
- `server/src/__tests__/workspace-instance-cleanup.test.ts`: 1 failure.
- `server/src/__tests__/company-skills.test.ts`: 2 failures.
- `server/src/__tests__/worktree-seed-server-spawn.test.ts`: 1 failure.

These baseline failures prevent a green repository-wide test result.
The broad run was stopped after more than 30 minutes in its serial server lane
once these failures were independently reproduced. Later full-suite groups
did not run. The full UI suite and the feature's server route suite were run
separately as described above.

The `Tasks / Composer / Paused task takeover` stories use the production composer
and cover task/subtree holds, saved drafts, resume progress/failure, and light/mobile layouts.
