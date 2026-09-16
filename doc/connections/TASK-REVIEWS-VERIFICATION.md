# Connection review verification — 2026-09-08

Implementation workspace: `/Users/dotta/paperclipai/branches/codex/reviews-in-task`.
Branch: `codex/reviews-in-task`, rebased on `master` at `8f099c3f8`.
The original verification below predates that rebase; final checks are recorded in the PR.

## Acceptance status

The deterministic integration paths demonstrate both synchronization directions
and scripted-agent continuation. A real native Codex approval and continuation
also passed in the local test drive, as recorded below. Live Notion and the
remaining real model-runner journeys are **untested dependencies**. The PR records
the final repository and CI check results.

## Inspect the UI

Storybook is running from this worktree on port 6018:

- [Interactive task](http://localhost:6018/?path=/story/chat-comments-connection-reviews--interactive-task)
- [All card states](http://localhost:6018/?path=/story/chat-comments-connection-reviews--all-states)
- [Connections queue](http://localhost:6018/?path=/story/chat-comments-connection-reviews--connections-queue)
- [Narrow layout](http://localhost:6018/?path=/story/chat-comments-connection-reviews--narrow)

Manual browser inspection covered light/dark presentation, the split approval
menu, keyboard approval, and dismissal/reopening. The final card shows only the app
icon, request description, and decision controls. Optional labels and details were
removed. Narrow controls fit without horizontal clipping.
The fixture queue can be resolved interactively to inspect its empty state.

## Deterministic browser journeys

Each journey creates a company, agent, and custom MCP connection in an isolated
embedded database. Ask first is configured through the permissions UI. The provider
returns fixture page names; **these are not real Notion pages**.

| Journey | Observed provider calls | Verified outcome |
| --- | ---: | --- |
| Approve in task | 1 | Stored call executes; resumed task posts Roadmap/Meeting notes; Connections pending item clears |
| Decline in Connections | 0 | One-click decline; open task updates; resumed agent reports decline |
| Always allow | 2 | Initial approved call and a later call with changed arguments; later task has no review |
| Provider failure | 1 | Human approval remains recorded; task shows execution failure and resumed agent reports it |
| Restart while waiting | 1 | Pending request survives actual server restart; approval executes once and task returns page results |

All journeys also exercise takeover dismissal/reopening, an ordinary comment while
pending, reload, and cross-tab synchronization. Review creation performs zero
provider calls. Traces and screenshots accompany each case.

[Open the evidence gallery](http://127.0.0.1:6020/) or the
[Playwright report](http://127.0.0.1:6020/report/). The final run passed all five
journeys in 1.4 minutes and released its port after teardown.

The local evidence directory is `.paperclip-runtime/reviews-evidence/`. It contains
the Playwright report, traces/screenshots, focused/full-check logs, baseline logs,
and `final-journey-identifiers.json` with request, invocation, interaction, and run IDs
from the passing port-3226 run. The report's attachments also contain
company/task/agent IDs and provider counts for its own run.

## Automated checks

- 384 focused gateway, policy/service, native bridge, and card/queue tests pass.
- 177 additional interaction route/service and policy tests pass.
- 18 startup tests pass after updating their app mocks with recovery services.
- 19 runner-catalog tests pass; the opt-in suite defines 16 local cells.
- Added scope/repair regressions pass: another agent/project still asks, explicit
  denial and changed definitions remain effective, concurrent approval executes
  once, multiple outcomes share one durable wake, and interrupted execution is
  never replayed.
- Repository `pnpm -r typecheck` and `pnpm build` pass.
- Runner harness TypeScript, token gates, migration safety, and Storybook build pass.
- `pnpm test:run` was run, but the repository-wide result is not green. Feature
  failures found in the initial run were corrected and their suites rerun above.
  Thirteen unrelated failures were reproduced at the same unchanged master commit:
  two workspace-runtime tests, four workspace-repair/control tests, three runtime
  exposure tests, two company-skill path tests, one instance-cleanup path test,
  and one worktree-seed spawn test.
  The initial general-server lane ended with 5,968 passed, 39 failed, and 31
  skipped tests across 498 files. Twenty failures were feature changes corrected
  and verified in focused reruns; six were transient file-resource/runtime-port
  failures that passed on rerun. The thirteen remaining failures reproduce on
  master. The fail-fast runner did not reach later workspace/serialized lanes.
  A complete green repository run is still required before PR-ready handoff.

## Live provider dependencies

The normal runner command was attempted with the opt-in flag and stopped with
`Missing runner E2E credentials: OPENAI_API_KEY, ANTHROPIC_API_KEY`.

The normal `test-drive --harness codex` command was also attempted from this
worktree. It bootstrapped a fresh isolated instance and reached startup recovery on
127.0.0.1:3105, then shut down with `No credential found. Set OPENAI_API_KEY`.
No Notion OAuth connection or real Notion page read was performed. The native Codex approval journey subsequently passed using existing local
ChatGPT authentication, as recorded below. Native ACPX Claude, legacy Codex CLI,
and legacy Claude CLI journeys remain unverified. The scripted process-adapter/browser evidence must not substitute for
those 16 acceptance cells or the four-profile real Notion exercise.

Provide the normal runner/test-drive credential setup and Notion account access
to complete those journeys. Secrets should remain in the normal local environment
or credential store, not in this report or chat.

## Final simplified UI verification

Before the master rebase, 155 component tests and all five browser journeys passed.
The final UI checks include the split approval menu, keyboard selection of Always
allow, and one-click decline. Evidence is in `.paperclip-runtime/reviews-evidence/minimal/`.
The browser run took 2.7 minutes; its restarted server required explicit process
cleanup after the tests completed. Live provider and model-runner dependencies
remain separate from this deterministic evidence.

## Native Codex approval and continuation

A real native Paperclip Runner agent used `gpt-5.6-sol` with existing local
ChatGPT authentication. Its initial run discovered the installed MCP fixture
action, called it with `query: "10 most recent pages"`, and yielded to a pending
server-owned review. The operator approved in the browser. The server executed
the stored request and delivered its result to a new native run.

- Source run: `106278a4-5411-41ba-b2a4-c150cdf7760d`.
- Action request: `7da846da-496f-4e6a-a151-0252e10f989c`.
- Continuation run: `18e11fe1-bd6a-4034-996e-e635d6cd57a6`.
- Final task status: `done`.
- Agent response: “The most recent fixture pages are **Roadmap**, **Meeting notes**,
  and **Product research**.”

The success card keeps the raw tool result collapsed. Expanding it displays
formatted JSON. The latest five-journey browser suite passed in 1.7 minutes and
checks separate source/reply run IDs, readable output, and result expansion.
This is real Codex execution against a local fixture, not live Notion evidence.
