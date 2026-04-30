# Phase 52: Supporting Surfaces and Identity Regression Gate - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-30
**Phase:** 52-supporting-surfaces-and-identity-regression-gate
**Areas discussed:** Supporting surface placement, card evidence model, data/API shape, product copy and visual treatment, identity regression gate, verification
**Mode:** auto

---

## Supporting Surface Placement

| Option | Description | Selected |
|--------|-------------|----------|
| Board-side evidence rail/drawer | Keep daily work as primary and place Jarvis/wiki/graph/economy as compact supporting context beside cards/board. | ✓ |
| Separate support dashboard | Add a new page or large cockpit for all support signals. | |
| Embed full existing panels | Drop full graph/wiki/economy/quality panels directly into daily work. | |

**Auto choice:** Board-side evidence rail/drawer.
**Notes:** This follows Phase 49-51 decisions that `daily-work` is the primary work route and Phase 52 should support the board instead of competing with it.

---

## Card Evidence Model

| Option | Description | Selected |
|--------|-------------|----------|
| Four compact evidence categories | `Jarvis 추천`, `지식 근거`, `그래프 연결`, `경제 근거`, with top evidence and deeper links. | ✓ |
| One generic activity feed | Mix all support signals chronologically. | |
| Deep graph-first view | Make graph visualization the default support experience. | |

**Auto choice:** Four compact evidence categories.
**Notes:** This keeps recommendations and citations contextual and scannable while preserving deeper pages for analysis.

---

## Data/API Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Compose existing APIs first | Use current Jarvis, daily wiki, graph, economy, and board metadata APIs; add a narrow aggregator only if necessary. | ✓ |
| New support-surface read model first | Build a fresh server-side support evidence aggregate before UI work. | |
| UI-only static summaries | Render support headings without real evidence integration. | |

**Auto choice:** Compose existing APIs first.
**Notes:** The repo already has task advice, daily wiki, graph, economy, and board metadata contracts. A new read model should be justified by consistency or query ownership, not assumed up front.

---

## Product Copy And Visual Treatment

| Option | Description | Selected |
|--------|-------------|----------|
| Korean compact operations UI | Localize support labels and keep evidence dense, secondary, and board-friendly. | ✓ |
| Reuse English-heavy existing panels as-is | Keep labels like `Task Mesh`, `Loading graph...`, `Quality Score`, and `Shadow Mode`. | |
| Marketing-style support section | Add large explanatory panels describing features. | |

**Auto choice:** Korean compact operations UI.
**Notes:** Phase 52 is the identity hardening finish. Existing panels can be reused as implementation references, but product-facing daily support copy must be Korean-first.

---

## Identity Regression Gate

| Option | Description | Selected |
|--------|-------------|----------|
| Focused product-facing gate | Script/test scans visible UI paths for legacy names and English defaults with explicit internal allowlists. | ✓ |
| Whole-repo string ban | Fail on every Paperclip/internal term anywhere in the monorepo. | |
| Manual rg checklist | Ask future agents to remember ad hoc searches. | |

**Auto choice:** Focused product-facing gate.
**Notes:** Whole-repo scanning would be noisy because internal package names, adapters, plugin SDK, MCP, and developer docs legitimately retain Paperclip naming.

---

## Verification

| Option | Description | Selected |
|--------|-------------|----------|
| Focused UI + script tests + typecheck | Test support evidence behavior, identity gate behavior, and run typecheck. | ✓ |
| Full Playwright/e2e by default | Run browser suite as the default verification. | |
| No new gate test | Rely on existing copy tests only. | |

**Auto choice:** Focused UI + script tests + typecheck.
**Notes:** This matches repo instructions: do not run e2e by default, and full `pnpm test` may timeout on this Windows host.

---

## the agent's Discretion

- Exact evidence rail/drawer layout.
- Whether evidence components live inside `Rt2DailyBoard` or are composed from `DailyWorkPage`.
- Exact identity gate allowlist format and product-facing path set.

## Deferred Ideas

- Full repo/package rebrand away from `@paperclipai/*`.
- New large support dashboard separate from daily work.
- Jarvis autonomous apply without approval.
