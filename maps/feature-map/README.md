# Paperclip feature map

Start here when reproducing a user-facing bug, verifying a change, or deciding
which surfaces a fix must cover. Each recipe describes what a person can do,
where they can do it, the expected result, and the evidence needed to verify it.
Product behavior is still governed by [the implementation spec](../../doc/SPEC-implementation.md).

The sibling [agent access map](../agent-access-map/README.md) records APIs,
agent entry points and permission boundaries for the same capability IDs.
Follow the [shared map contract](../README.md) when maintaining either map.

## Browse features

Open the [published Storybook guide](https://d1p6rlowie26tp.cloudfront.net/storybook/branches/master/?path=/story/overview-storybook-guide--coverage-guide)
for the assembled feature and capability index. The Markdown recipes in this
directory are the authored source. Each has a same-named agent-access companion.

Run `node scripts/storybook-catalog.mjs` to generate local navigation in
`maps/generated/feature-map.md`, `maps/generated/agent-access-map.md`, and the
Storybook guide. A new recipe is discovered automatically; do not register it in
this README or maintain counts here.

## Before driving a journey

1. Use this checkout's [isolated test drive](../../doc/DEVELOPING.md#one-command-isolated-manual-test-drive)
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

For agent-driven acceptance work, start with the
[Paperclip verification skill](../../.agents/skills/verify-paperclip/SKILL.md) for an
isolated launch, ownership/readiness checks, browser driving, evidence, and cleanup.
It uses this directory as its feature map. The existing
[dev-workspace run/verify skill](../../.agents/skills/paperclip-dev-workspace-run-verify-fix/SKILL.md)
and [evaluation skill](../../.agents/skills/paperclip-evals/SKILL.md) describe runtime
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
[artifact workflow](../../doc/AGENT-ARTIFACTS.md).

## Inventory and remaining depth

The generated `maps/generated/coverage.json` lists the current non-test TSX page
modules and the recipes that directly reference each one. An unreferenced module
is a documentation candidate, not proof that its feature is absent or untested.
Remaining workflow limits live in each recipe. Inventory and example associations
describe documentation scope, not runtime health.

## Maintaining the reference

The map documents user journeys. It does not execute them automatically;
generated inventories record documentation scope rather than live test health.

When maintaining a recipe, compare its entry points and expected results with
the current source. Check that linked tests still exercise the stated behavior
and that local references still exist. Keep the same-named agent access companion
and stable sub-feature IDs aligned when behavior or access changes. Source-only
access inventory remains distinct from live verification. Run
`node scripts/check-maps.mjs` after map edits for structural/reference checks;
follow the shared contract for the source and behavioral checks it cannot perform.

Each recipe starts with a small frontmatter navigation record, then an H1:

```markdown
---
navigation: {"section":"Tasks and conversations","sectionOrder":20,"order":10}
---
```

The H1 supplies the feature title, and the first paragraph supplies its summary.
Orders are local to the section; leave gaps for additions. Equal orders use the
stable filename as a tie-breaker. Keep a section's name/order consistent across
its recipes. A new feature or capability needs only its recipe and companion.

Optional `### Storybook verification` guidance lives inside the recipe's Gotchas
section. Each level-four heading contains a backtick-quoted capability key and
has `Scope` (`ui`, `cli`, or `browser`),
`Storybook`, `Production`, and `Sources` fields. These are verification instructions
and intentional scope limits, not run results or a required story for every API.
The generated gap report combines this guidance with current story associations.

After frontmatter, each recipe starts with an H1 and a user-visible description, then exactly:

1. **Sub-features** — stable backticked IDs and observable behavior/states.
2. **How to get to it (user POV)** — one H3 backticked entry-point ID per surface.
3. **Driving it with <harness>** — starts with `Preconditions:`; repeat each entry-point H3,
   with `Automated:` and `Manual:` paragraphs. Name test scope and gaps honestly.
4. **Gotchas** — misleading look-alikes, feature gates, and invalid evidence.

New or updated entries follow
[Poteto's feature-map examples](../../.agents/skills/create-verification-skill/references/feature-map-example).
Existing entries with a `Driving it` heading can adopt the named harness when
their recipes are updated. The original format was inspired by
[Omnigent's feature map](https://github.com/omnigent-ai/omnigent/tree/91acfbbb59f6fc210ff95a9e9428aadd62e06582/feature-map).
Paperclip's recipes and checks follow its own task model and test infrastructure.
