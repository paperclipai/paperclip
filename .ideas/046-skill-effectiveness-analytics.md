# 046 — Skill Effectiveness Analytics

## Suggestion

Paperclip has a skills layer — a catalog with role recommendations
(`skills-catalog.ts` exposes `recommendedForRoles`) and per-company installs with usage tracking
(`company-skills.ts` has `installCount`, `CompanySkillUsageAgent`, `installedHash`). So the system
already knows *which* skills exist, who installed them, and roughly that they're used. What it
**doesn't** know is whether a skill actually **helps**: does an agent equipped with a given skill
produce better outcomes — higher approval rate, less rework, lower cost, faster completion — than
without it? Skill selection today is based on static role hints and install counts (popularity),
not evidence of impact. Operators add skills hopefully and prune them never.

Add **skill effectiveness analytics**: link skill usage to work outcomes so operators (and
auto-assignment) can tell which skills earn their keep and recommend skills based on *results*,
not just role labels.

## How it could be achieved

1. **Attribute outcomes to skill usage.** Usage is already tracked per agent; join it to the
   outcome signals that exist — approvals/rejections (`approvals.ts`), rework, cost/tokens
   (`cost_events`), completion time. For runs where a skill was invoked, compare outcome
   distributions vs comparable runs without it.
2. **Effectiveness scorecard.** Per skill (optionally per role/work-type): usage frequency,
   approval-rate delta, rework delta, cost delta. Surface "this skill correlates with +18% approval
   on `code-review` tasks" — and the opposite, "installed, never meaningfully used."
3. **Evidence-based recommendation.** Upgrade `recommendedForRoles` from static metadata to a
   data-driven suggestion: recommend skills that demonstrably help agents doing similar work, and
   flag installed-but-dead skills for pruning. Feeds capability-based assignment (idea 025).
4. **Guard against false causation.** Correlation isn't proof; offer an optional controlled check
   via the A/B bake-off harness (idea 032) — same tasks with/without the skill — for skills the
   operator wants to validate rigorously.
5. **Lifecycle hygiene.** Flag skills whose effectiveness drops after a version change, tying into
   plugin health (idea 045) when the skill ships via a plugin.

## Perceived complexity

**Low–Medium.** Skill usage tracking and the outcome signals both already exist; this is primarily
a join + analytics + presentation layer, with no execution-engine changes. The real subtlety is
statistical honesty — small samples and confounds make naive "skill X → better outcomes" claims
misleading — so the scorecard should show confidence/sample size and lean on the A/B harness for
anything high-stakes. Ship descriptive analytics (usage × outcomes) first; evidence-based
recommendation and causal validation are natural follow-ons.
