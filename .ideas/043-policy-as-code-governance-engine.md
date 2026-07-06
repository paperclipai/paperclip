# 043 — Policy-as-Code Governance Engine

## Suggestion

Paperclip's governance is powerful but **scattered**: trust presets
(`trust-preset-resolver.ts`), agent permissions (`agent-permissions.ts`), issue/workspace
execution policy (`issue-execution-policy.ts`, `execution-workspace-policy.ts`,
`execution-policy-bootstrap.ts`), execution allowlists (`execution-allowlist.ts`), and budget
policies all enforce rules, each in its own silo with its own model. An operator who wants to
express a simple company-wide rule — "no agent may spend over $50 on a single issue without human
approval," "probation agents can't touch production workspaces," "no destructive actions on
weekends," "any agent emailing a customer needs review" — has nowhere to write it. The rules
exist in code and config fragments, not as something the operator can author, read, and audit in
one place.

Add a **policy-as-code engine**: a single declarative layer where operators define company
governance rules as readable conditions → actions, evaluated consistently across the events the
silos already guard.

## How it could be achieved

1. **Unified policy model.** A rule = `when <condition> then <effect>`, where conditions read
   existing context (agent, trust stage, issue, workspace, spend, action type, time, target) and
   effects are the actions the system already supports: allow, deny, require-approval, throttle,
   notify, log. Store rules per company; version and audit them (idea 023).
2. **One evaluation seam.** Introduce a policy-decision call at the existing enforcement choke
   points (run admission, tool/command authorization, workspace access, spend checks) that
   consults the rule set — rather than each silo hard-coding its own logic. The silos become
   *enforcers* of a central *decision*.
3. **Readable authoring.** A guided rule builder plus a text/DSL form (YAML-ish) so non-engineers
   can express policy and engineers can diff it in git. Ship a starter library of common rules.
4. **Dry-run & simulation.** Evaluate a proposed rule against recent history ("this would have
   blocked 4 actions last week") before activating — reuses the Dry-Run philosophy (idea 004) and
   prevents footguns where a rule silently freezes the company.
5. **Explainable decisions.** Every allow/deny records *which rule* fired and why, surfaced in the
   audit log (idea 023) and on the affected action, so governance is legible rather than magic.

## Perceived complexity

**Medium–High.** Individually the effects already exist; the hard part is the *unification* —
introducing a clean policy-decision seam without destabilizing the several enforcement paths that
currently work independently, and designing a condition/effect model expressive enough to be
useful but bounded enough to stay safe and analyzable. Backward compatibility matters: existing
trust presets and permissions should map onto the new engine as default rules, not be replaced
wholesale. Start with an *advisory* evaluation that logs what it *would* decide alongside the
current logic, validate it matches, then let it take over enforcement incrementally.
