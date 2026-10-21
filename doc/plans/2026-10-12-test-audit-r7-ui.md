# Test audit, Round 7 UI — preservation report

This UI batch removes **364 net test lines and one registered invocation** from three files. It changes **zero production lines**. Of the 364 lines, 320 come from helper cleanup and 44 from retiring the duplicate after its fixture/assertion migration. The helper cleanup reduces maintenance code; it makes no wall-time or CI-speed claim. The one retired invocation avoids one duplicate rendered roster scenario.

The branch starts at pinned parent `e868e6645ce0d598d756d3458f0b3d71afd6db4a`, the head of [Round 6, PR #16047](https://github.com/paperclipai/paperclip/pull/16047). It follows OpenClaw's [test-audit skill](https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md) and [campaign process](https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/CAMPAIGN.md). All ten Round 6 test files were excluded. Prior cleanup remains in the parent history.

## Scope and cost

| File | Net test lines removed | Source helper calls expanded | Registered invocations removed |
|---|---:|---:|---:|
| `ui/src/pages/InviteLanding.test.tsx` | 132 | 18 | 0 |
| `ui/src/pages/Agents.test.tsx` | 136 | 16 | 1 |
| `ui/src/components/Layout.test.tsx` | 96 | 26 | 0 |
| Total | 364 | 60 | 1 |

Each helper contains one synchronous `root.render` statement. It creates the same complete JSX subtree on each call. The invitation helper also creates a fresh initial-route array. Helpers accept the existing root and query client. They create no root or query client, add no await, and contain no assertion. The roster helper retains QueryClientProvider → ToastProvider → Agents. The distinct table render of production and streamlined AgentList remains inline. Every original outer `act`, flush, timer, input, assertion, cleanup and provider order remains, outside the single declared migration below.

The audit read the actual invitation, roster and shell owners, their App routes, production-shell/roster counterparts, current tests and source history. It inspected analogous invitation-access, shell-route, company-selection, sidebar, plugin-overlay and roster surfaces. Permission gates, membership/account cache checks, keyboard/hover controls, accessibility, pending state and routing cases retain their own registrations.

## Exact retirement and keeper

Retired: Agents `uses the built-in agents route segment as the built-in filter`.

Keeper: Agents `shows and filters built-in agents when the experimental flag is enabled`.

Both cases came from commit `8b6a06ee254` and use `/agents/builtin`, the enabled built-in flag, and the same built-in and regular agent/org rows. The keeper now copies the retired case's exact setup, including the populated BuiltInAgentState.agent pointing to the same built-in object as the agent list. It also carries the retired `1 agent` assertion. Its original checks remain: company-scoped built-in API request, Built-in tab text, included built-in name, excluded regular name, absent old badge, and no redirect to the all-agents route.

The former keeper's null nested agent fixture does not supply a separate ready/list behavior: the actual roster uses entry.agentId and entry.status on that path. The setup modal is not mounted for a ready entry. Copying the retired populated fixture preserves the stronger keeper's observations while retaining every retired observation. Other built-in enable/disable and production-versus-streamlined registrations remain.

No other case retires. In particular, invitation error presentation remains distinct from its accessibility guard and membership/cache timing cases. Layout route variants retain all original parameter rows and loop iterations. Roster environment-loading, single-environment, disabled-feature and fallback-provider cases remain separate.

## Complete-file evidence

| Run | Complete files | Passed cases | Failures | Skips |
|---|---:|---:|---:|---:|
| Original changed owners | 3 | 71 | 0 | 0 |
| Original owner siblings | 8 | 79 | 0 | 0 |
| Candidate changed owners | 3 | 70 | 0 | 0 |
| Final candidate owners and siblings | 11 | 149 | 0 | 0 |

The original total is 150, compared with candidate 149. These are actual Vitest registrations, including table rows. The sixty helper counts are source call expansions, not retired executions. Complete-file runs have no name filter. Separate name-filtered mutation controls intentionally select one keeper and do not count their unselected cases as complete-suite proof.

Commands run from `ui/` use `pnpm exec vitest run` followed by the complete file paths. Changed-owner paths are `src/pages/InviteLanding.test.tsx`, `src/pages/Agents.test.tsx` and `src/components/Layout.test.tsx`. Siblings are SidebarAgents, ActiveAgentsPanel, access/InvitesSection, useCompanyInviteAccess, shell-navigation, company-selection, PluginAppShellOverlays and SidebarShell.

Dependencies were installed offline with the frozen lockfile in this checkout. Initial dependency-link exploration and two startup-error attempts were discarded; none counts as baseline proof. Accepted runs use this checkout's workspace packages.

## Expansion and intended regressions

The verifier expands the actual helper bodies at all sixty call sites, then compares complete original and candidate ASTs. They match outside removal of the named duplicate, its exact setup migration, and insertion of its count assertion into the keeper. Location/comment/raw-format metadata and whitespace-only JSX text are ignored; executable values and statement order are retained. Root/client argument names are checked at each call. Independent review also checks lexical binding, provider nesting and fresh JSX/route values; AST substitution alone does not establish binding correctness.

All three positive keeper controls passed. All deliberate production regressions failed at the intended retained assertion:

| Mutation | Intended failing keeper observation |
|---|---|
| Return all agents from the built-in filter | Migrated `1 agent` count guard. |
| Omit actual invite auth aria-invalid state | Email input's fixed `aria-invalid === "true"` guard. |
| Bypass the settings sidebar branch | Visible Company settings sidebar guard. |

These failures are direct assertions, not timeout/setup/worker errors. Each owner was restored byte for byte and checked against the pinned Git source. The final diff has no production changes. Mutation controls use fixed literal expected values from the original tests; helpers supply no oracle.

## Provenance and limits

[Controls JSON](2026-10-12-test-audit-r7-ui-controls.json) records exact original/candidate source hashes, all sixty expansion counts, the retirement map, decisions for all 71 original owner registrations, complete-file results, intended failures, raw-run digests, and source-restoration receipts. Raw expansion scripts and logs were temporary audit packets. Digests identify them but do not preserve their full payloads.

The required token gate and diff whitespace check passed. Workspace typecheck/build, broad default tests and latest-head CI/Greptile status belong in the PR so this preservation report does not confuse focused proof with whole-workspace success. No tests, workflow, dependency, production, retry, timeout or skip policy was weakened to make checks pass.

## Integration with current master

During replay after #16047 landed, the retired Priority-filter case had gained
three assertions for the agent-created-task checkbox. Those assertions moved
to the retained same-input grid/render case, which already enables that filter.
The label and initial unchecked state remain covered; no new contract is removed.
Fresh PR CI validates the integrated source. Historical controls above remain
evidence for their recorded revisions.
