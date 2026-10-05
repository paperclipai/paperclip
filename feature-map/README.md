# Paperclip feature map

Start here when reproducing a user-facing bug, verifying a change, or deciding
which surfaces a fix must cover. Each recipe describes what a person can do,
where they can do it, the expected result, and the evidence needed to verify it.
Product behavior is still governed by [the implementation spec](../doc/SPEC-implementation.md).

## Features

| Feature | Use it to verify |
| --- | --- |
| [Questions and approvals](./questions-and-approvals.md) | Answering questions, reviewing plans, board approvals, and app-tool reviews across task, chat, and decision surfaces. |
| [Steering and queued messages](./steering.md) | Follow-ups during execution, queue edits, steering, interruption, and pause/resume. |
| [Connection setup](./connection-setup.md) | Catalog, link, task-request, and chat-channel setup; account access; interrupted setup and reconnection. |
| [Recovery](./recovery.md) | Understanding why work stopped, restoring a valid path, and recognizing when retry is unsafe or unavailable. |

These four recipes are the **seed scope**, checked against source on 2026-10-05.
They are verification instructions, not a claim that every journey passed a live
test. A referenced component test proves that component; a scripted provider
proves the integration with that fixture. Neither proves a real provider login
or a model's behavior. Record executed results separately from this map.

## Before driving a journey

1. Use this checkout's [isolated test drive](../doc/DEVELOPING.md#one-command-isolated-manual-test-drive)
   for manual product checks. It creates a temporary instance and prints its URL
   and data directory. Do not guess that a server on port 3100 belongs to you.
2. Record the commit, URL, company, login role, relevant experimental settings,
   adapter, runtime mode, and live versus simulated dependencies. Use disposable
   tasks and provider resources. A fresh test drive creates a company and CEO,
   but no task or first run.
3. Use the current navigation and company prefix. Paths in recipes omit that
   prefix. Record whether the streamlined or production shell is selected;
   Agent Chat, chat connectors, and the combined Inbox/Tasks view have separate
   gates. A hidden surface is an unmet prerequisite, not a successful test.
4. Run the smallest relevant test first. Vitest commands below run from the
   repository root after installing dependencies. Playwright recipes use their
   named configuration and its isolated environment, not an unrelated running
   instance. Reserve expensive runner/provider tests for the behavior at issue.
5. Exercise the actual user action, inspect its result, reload, and verify the
   persisted state or continuation. Use read-only API checks to corroborate UI
   evidence; creating state through the API does not prove the creation UI.

For agent-driven acceptance work, the existing
[dev-workspace run/verify skill](../.agents/skills/paperclip-dev-workspace-run-verify-fix/SKILL.md)
and [evaluation skill](../.agents/skills/paperclip-evals/SKILL.md) describe runtime
ownership and evidence handling. Reuse them; this map introduces no environment
launcher, credentials, scheduled job, or second test framework.

## Evidence contract

Report each entry point as **passed**, **failed**, **blocked** (with its missing
prerequisite), or **not run**. Include the feature filename and entry-point ID,
commit/environment, user action, expected and observed result, command/exit code,
and evidence links. Screenshots or traces should show both the action and the
discriminating result. Include task/run/request IDs when relevant, without secrets.

A fix is verified across its affected surfaces only when each has evidence or
an explicit reason it does not apply. Shared code alone does not prove parity.
Keep product regressions visible; do not change the recipe to bless a failure.
For Paperclip-assigned work, attach evidence through the
[artifact workflow](../doc/AGENT-ARTIFACTS.md).

## Not yet mapped

[The UI coverage inventory](./coverage.json) accounts for every non-test TSX
module under `ui/src/pages`, including supporting panels, legacy variants, and
labs. Entries are grouped by product area, with exact paths, linked recipes,
and a remaining gap. **Partial** means only the linked journeys are mapped.
**Unmapped** means there is no recipe yet. Neither is a runtime health verdict.

The main backlog is onboarding and login; company, agent, project, and goal
management; task creation/search/list views; documents and artifacts; skills
and teams; budgets and activity; routines and pipelines; workspace management;
secrets, plugins, gateways, profiles, and instance administration. Chat setup
is seeded, but provider-by-provider messaging and attachment behavior is not.

The page inventory is deliberately conservative: it includes helpers and unused
legacy modules rather than inferring reachability. It does **not** enumerate
every route, button, component, CLI command, API endpoint, provider, or harness
capability. CLI setup/administration and complete harness capability matrices
remain unmapped. New entry points inside an existing file still require review.

## Keeping the map current

```sh
pnpm check:feature-map
node --test .github/scripts/tests/feature-map.test.mjs
```

The checker uses only Node's standard library. The second command also runs in
the existing PR workflow's quality-script test glob, including UI-only and
documentation PRs. It checks:

- Every feature recipe is linked from this index, with no stale feature links.
- Recipes contain a description and the four sections below, in order.
- Stable entry-point IDs have matching driving recipes, automated evidence
  descriptions, and manual instructions or explicit gaps.
- Local Markdown links and repository test references exist.
- Every page module has exactly one inventory entry; removed paths, missing
  recipes, empty gap explanations, and unclassified new files fail.

When a PR changes a journey, update its entry points, recipe, and coverage gaps
in that PR. When it adds a page module, either map it or add an explicit gap to
the inventory. The gate checks structure and references; reviewers must still
check that the described behavior and tests match. No scheduled upkeep is enabled.

Each recipe starts with an H1 and a user-visible description, then exactly:

1. **Sub-features** — stable backticked IDs and observable behavior/states.
2. **How to get to it (user POV)** — one H3 backticked entry-point ID per surface.
3. **Driving it** — starts with `Preconditions:`; repeat each entry-point H3,
   with `Automated:` and `Manual:` paragraphs. Name test scope and gaps honestly.
4. **Gotchas** — misleading look-alikes, feature gates, and invalid evidence.

The format is inspired by
[Omnigent's feature map](https://github.com/omnigent-ai/omnigent/tree/91acfbbb59f6fc210ff95a9e9428aadd62e06582/feature-map).
Paperclip's recipes and checks follow its own task model and test infrastructure.
