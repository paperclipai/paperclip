# Selective upstream resync for the agentic execution control plane

Date: 2026-08-29
Status: planned — product decisions are required per capability before porting

## Baseline

- Fork development line: `origin/dev` at `e487e1797`
- Fresh upstream master inspection: `a20a4944e`
- Shared merge base: `a8d118a77`
- Divergence: 813 fork-only commits and 369 upstream-only commits
- Existing detailed plan: [production upstream resync plan](../../docs/plans/2026-08-08-prod-upstream-resync-plan.md)

A wholesale merge is unsafe. The fork has intentional organization/RBAC, provider-credential/quota, browser, image-generation, and adapter behavior that must survive.

## Port candidates

| Priority | Upstream change | Why it matters | Integration rule |
| --- | --- | --- | --- |
| P0 | `5a1ce7aed` build revision stamping | makes staging/prod verification trustworthy | expose the stamped revision through health and release checks |
| P1 | `d9449e636` provider login during onboarding | reduces credential setup friction | adapt to the fork's credential vault; do not bypass secret redaction |
| P1 | `67f9867bc` durable question-answer delivery | preserves human decisions and acceptance gates | reconcile with existing interaction/approval ownership |
| P1 | `0fa318b8d` Markdown work products in document review | makes agent outputs inspectable | keep attachment/artifact durability contract |
| P1 | `243430f76` + `d2b9765cc` skill library/runtime | reusable agent-factory capabilities | preserve company scope and source safety rules |
| P1 | `f572e0867` stranded-task recovery guard | avoids silent work stealing | reconcile with fork ownership/recovery semantics |
| P1 | `b90da4d11` + `877490936` session continuity | keeps context across comments/handoffs | preserve adapter-specific session isolation |
| P2 | Runner/PRP series (`b76e36d6c`, `23048f121`, `42b8f7ab2`) | strategic execution-lane architecture | investigate behind an adapter/transport boundary; no direct merge |

## Explicitly do not port blindly

- `4d82f5eae` global company-to-organization copy rename: upstream has no equivalent nested organization model; it would make this fork's real hierarchy less clear.
- Upstream connections v3/secret-proposals as a replacement for the fork's credential rotation, quota cache, failover, and usage attribution.
- Upstream authorization changes without adapting the fork's organization/RBAC/visibility contract.
- The software-delivery-only AI-factory pipeline; retain only work-type-agnostic anti-self-certification ideas if they fit the cases/work-product model.

## Delivery sequence

1. Freeze the fork-specific keep list and add contract tests.
2. Port revision stamping and release verification first.
3. Port one capability at a time into an isolated worktree; run targeted tests and browser smoke.
4. Reconcile authorization, credentials, and coordination semantics with an explicit product decision before merging overlapping code.
5. Deploy to staging only after the exact candidate is reproducible; production remains separately authorized.

## Acceptance criteria

- Each selected commit has a written keep/adapt/reject decision and an owner.
- No upstream port removes organization/company boundaries or credential failover behavior.
- The candidate passes typecheck, targeted tests, build, and staging browser smoke.
- The merge report lists conflicts resolved semantically, not merely mechanically.
