# TSMC-20358 — Tier-1 QA rubric skill binding (Child C)

**Date:** 2026-08-07  
**Parent:** TSMC-20243  
**Policy:** TSKB0404, TSKB0055, TSKB0055 Gate G8, VA1  
**Gate A:** TSMC-20243 family only (no parallel bind card).  
**Gate B:** TSKB0404 + implementation-brief-v1 Child C + TSKB0055.

## Decision / status

**Done (source).** Product QA runs are instructed to load the three existing free skills via platform mint + heartbeat task-markdown injection. No new paid tools. VA1 not weakened.

## Skills (already in company inventory + deploy tree)

| Slug | Canonical key | Deploy path |
|---|---|---|
| `ship-it-qa-checklist` | `paperclipai/paperclip/ship-it-qa-checklist` | `$PAPERCLIP_DEPLOY_ROOT/skills/ship-it-qa-checklist` |
| `video-assembly-pipeline` | `paperclipai/paperclip/video-assembly-pipeline` | `$PAPERCLIP_DEPLOY_ROOT/skills/video-assembly-pipeline` |
| `never-again-gates` | `paperclipai/paperclip/never-again-gates` | `$PAPERCLIP_DEPLOY_ROOT/skills/never-again-gates` |

Company skill-policy (live readback 2026-08-07): `defaultEffect: allow`, revision 1, only deny rule is `skills.remove`/`skills.reset` for all agents. **No deny on these three skills.** Not fleet-default skill-pack attach.

## Binding surfaces (cited)

1. **Mint stamp (code)**  
   `server/src/services/two-tier-qa-routing.ts`  
   - `TIER1_PRODUCT_QA_RUBRIC_SKILL_SLUGS` / `TIER1_PRODUCT_QA_RUBRIC_SKILL_KEYS`  
   - `buildTwoTierQaRubricBinding()` / `buildTwoTierQaMeta()`  
   - `applyTwoTierQaMintOverrides` stamps `assigneeAdapterOverrides.twoTierQa.requiredSkills` + `requiredSkillKeys` + `visualTruthTextOnlyIsDefect: true`  
   - Wired at issue create via `server/src/services/issues.ts` (Child A path)

2. **Run context + prompt (code)**  
   `server/src/services/heartbeat.ts`  
   - On product-QA assignee runs: `context.twoTierQa` includes the same required skill lists  
   - Appends `buildTwoTierQaRubricPromptDirective` into `paperclipTaskMarkdown` / compact (idempotent) so the assignee is **instructed to load** the three skills before disposition

3. **Escalate comment**  
   `buildTwoTierQaEscalateSystemComment` lists required rubric skills and reaffirms VA1 visual-truth floor

4. **Company skill policy**  
   `GET /api/companies/{id}/skill-policy` → open default allow; skills remain usable

5. **CTO instruction surface (pre-existing, partial)**  
   CTO egress matrix names `ship-it-qa-checklist` for Auditor-Codex QA passes  
   (`agents/3733fb01-…/instructions/AGENTS.md` work-class matrix)

## Agent desiredSkills (supplementary — not fleet-default)

Live inventory (2026-08-07): only **Engineer-Hermes** has non-empty `adapterConfig.paperclipSkillSync.desiredSkills`, and it already includes `paperclipai/paperclip/ship-it-qa-checklist` but **not** assembly/never-again.

Engineer-Hermes lacks `agents:configure` / `agents:suggest-changes`, so this lane cannot `POST /api/agents/:id/skills/sync` for Auditor-Codex / Engineer-Codex / Designer-Media.

**DEVIATION (documented, not silent):** primary binding for Child C is the **mint + heartbeat prompt surface** (above), not fleet-wide `desiredSkills` skill-pack attach. Optional follow-up for CTO/GLaD0S (agents:configure) to merge desiredSkills on product-QA assignees — payload in `desiredSkills-apply-payload.json`.

## VA1 — no weakening

- `visualTruthTextOnlyIsDefect: true` stamped on every twoTierQa meta blob  
- Prompt directive: "text-only visual QA of frames remains a defect"  
- `classifyTwoTierQa` still forces `modelProfile: strong` for visual-truth / look-at-a-frame titles (unchanged unit tests)

## Verification

```text
npx vitest run server/src/services/two-tier-qa-routing.test.ts
# 15 passed (includes TSMC-20358 rubric stamp + prompt directive + VA1 floor)
```

Skills present on served deploy tree (do not reinstall): confirmed under `$PAPERCLIP_DEPLOY_ROOT/skills/{ship-it-qa-checklist,video-assembly-pipeline,never-again-gates}`.

## Remaining (out of Child C code scope)

- Source branch `feat/tsmc-20345-two-tier-qa` still needs land/promote (TSMC-20359 / TSMC-20360) before served `:3100` runs the new binding  
- Optional CTO skill-sync desiredSkills merge for Auditor-Codex + engineer lanes (payload file)
