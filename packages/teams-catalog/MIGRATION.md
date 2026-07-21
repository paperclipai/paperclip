# Teams Catalog Migration Notes

This document records the migration state of the initial bundled and optional teams shipped in `@paperclipai/teams-catalog`. It exists so future contributors know what was intentionally deferred, what is safe to delete from legacy sources, and which compatibility tests must land before the legacy onboarding assets can be removed.

The approved plan for this package lives at [PAP-10206 plan document](/PAP/issues/PAP-10206#document-plan).

## Status

| Source | Status |
| --- | --- |
| `server/src/onboarding-assets/ceo/` | **Keep as-is.** Drives current onboarding default agent creation. Will be removed only when onboarding switches to the teams-catalog service (post-Phase E/G). |
| `server/src/onboarding-assets/default/` | **Keep as-is.** Generic `AGENTS.md` fallback used outside the catalog path. |
| `skills/paperclip-create-agent/references/agents/coder.md` | **Migrated content** into `bundled/software-development/product-engineering/agents/senior-coder/AGENTS.md` (collaboration/handoffs/safety sections collapsed for catalog brevity). Keep the template as a reference for ad-hoc hiring until onboarding switches. |
| `skills/paperclip-create-agent/references/agents/qa.md` | **Migrated content** into both `bundled/company-defaults/core-exec-team/agents/qa/AGENTS.md` and `bundled/software-development/product-engineering/agents/qa/AGENTS.md`. Keep the template. |
| `skills/paperclip-create-agent/references/agents/uxdesigner.md` | **Migrated content** into `bundled/product/product-design/agents/ux-designer/AGENTS.md`. Lens dictionary intentionally trimmed in the catalog copy — the template stays authoritative for ad-hoc hiring. |
| `skills/paperclip-create-agent/references/agents/securityengineer.md` | **Not migrated.** No `SecurityEngineer` team ships in Phase H — see deferred entries below. |

## Bundled entries shipped in Phase H

- `paperclipai/bundled/company-defaults/core-exec-team` — defaults: CEO, CTO, QA, starter project, recurring CEO heartbeat task. `defaultInstall: true`. This is the smallest team that mirrors the historical CEO onboarding flow while staying inside catalog rules.
- `paperclipai/bundled/software-development/product-engineering` — optional engineering pod: CTO, Senior Coder, QA, weekly engineering sync routine.
- `paperclipai/bundled/product/product-design` — single-designer product design team with `wireframe`, `design-critique`, and weekly design review routine.

## Optional entries shipped in Phase H

- `paperclipai/optional/content/content-machine` — vendored local `content-calendar` skill, single content lead, recurring weekly content review. Kept from Phase B as the canonical fixture for local-skill resolution.

## Intentionally deferred

The plan in [PAP-10206](/PAP/issues/PAP-10206#document-plan) lists additional recommended entry classes that are **not** part of the Phase H catalog. They wait on:

- `optional/ops/cloud-operations` — needs a `CloudOpsEngineer` role template under `skills/paperclip-create-agent/references/agents/` first, plus an explicit security review of the deployment/secrets routines it implies. Defer until a follow-up curation pass.
- `optional/research/benchmark-quality` — needs a benchmark/evals/forensics role template and concrete starter routines from a real benchmark engagement. Defer until that engagement exists.
- `optional/quality/security-review` — could wrap the existing `securityengineer.md` template, but the plan's Phase D security review of external-source handling has to land before bundling a security-focused team with default skill imports. Defer until Phase D is complete.
- Adapter overrides per agent — intentionally omitted from frontmatter so the import preview lets operators choose `claude_local`, `codex_local`, etc. at install time. Lock these only when onboarding adopts the catalog and needs a deterministic default.
- Rich persona files (`SOUL.md`, `HEARTBEAT.md`, `TOOLS.md` siblings) — collapsed into a single `AGENTS.md` per agent for Phase H. Move to `references/` files if the importer learns to surface them as agent reference attachments without changing trust level.
- Bundled executable scripts (for example, prebuilt installer hooks) — explicitly out of scope. The `shipped-catalog.test.ts` enforces `markdown_only` / `assets` trust for every shipped team until Phase D security review covers script-bearing entries.

## Compatibility tests required before deleting legacy sources

Before removing `server/src/onboarding-assets/ceo/` or the `skills/paperclip-create-agent/references/agents/*.md` templates, the following tests should be in place. None are written yet — they are tracked here so a future remove-legacy issue does not skip them:

1. **Onboarding parity test** — a server-level integration test that runs the current onboarding flow on a fresh company and verifies the resulting agent/project/task tree is byte-equivalent (modulo timestamps and ids) to a `paperclipai/bundled/company-defaults/core-exec-team` install via the catalog service.
2. **Slug stability test** — covers that the agent slugs `ceo`, `cto`, `qa` keep stable values when reparenting under an existing target manager, so downstream UI links don't churn.
3. **Skill resolution drift test** — fails if a bundled team's `requiredSkills` references a catalog skill key that no longer exists in the latest `@paperclipai/skills-catalog` manifest.
4. **Adapter default fallback test** — confirms that imported agents with no explicit `adapterType` pick up the same adapter the legacy onboarding path used.
5. **Routine import compatibility test** — recurring `TASK.md` entries (`first-heartbeat`, `weekly-engineering-sync`, `weekly-design-review`, `weekly-content-review`) must still be imported with timer heartbeats disabled, matching current portability behavior.

## Coordination

- Packaging-level changes (adding new manifest fields, changing the validation rules, or extending the import service) belong to the coding owner of [PAP-10236](/PAP/issues/PAP-10236) and the integration service in [PAP-10238](/PAP/issues/PAP-10238).
- Content-only updates (new bundled or optional teams, copy edits, skill requirement tweaks) can land directly in this package after `pnpm --filter @paperclipai/teams-catalog validate` and `pnpm --filter @paperclipai/teams-catalog test` both pass.
- Removing any file under `server/src/onboarding-assets/` requires the compatibility tests above to land first and is gated by the onboarding-service switchover task tracked under the same parent goal.
