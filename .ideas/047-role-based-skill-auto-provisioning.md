# 047 — Role-Based Skill Auto-Provisioning

## Suggestion

Paperclip already has most of the wiring to connect roles to skills, but nothing closes the
loop. Skills declare `recommendedForRoles` (`skills-catalog.ts`, `company-skill` validator), and
the teams catalog declares `requiredSkills` per team (`CatalogTeamSkillRequirement`,
`catalogTeamSkillRequirementSchema`). Yet skills are still **installed and assigned manually** —
when an operator hires an engineer agent, nothing automatically equips it with the engineering
skills its role implies, and nothing keeps that set in sync as role requirements evolve. The
result: agents are under-equipped by default (you forgot to add the skill), inconsistently
equipped across a team, and drift out of date when a role's required skills change.

Add **role-based skill auto-provisioning**: define the skills a job/role requires once, and have
Paperclip automatically equip (and update) agents based on the role they hold.

## How it could be achieved

1. **Role → skill bundles as the source of truth.** Promote the existing signals into an explicit
   mapping: a role/job has a set of required + recommended skills, seeded from
   `recommendedForRoles` and the teams catalog's `requiredSkills`. Operators edit the bundle, not
   each agent.
2. **Provision on hire / role change.** Hook the hire flow (`hire-hook.ts`) and any role-change
   mutation: when an agent enters a role, auto-install its required skills into the company (if
   absent) and bind them to the agent — reusing the existing `company-skills.ts` install path and
   `installedHash` so it's idempotent.
3. **Keep in sync (reconciler).** When a role bundle changes, reconcile every agent in that role —
   add newly-required skills, flag now-removed ones — on a routine (`routines.ts`). Roles stay
   authoritative; agents converge to them, like desired-state config.
4. **Required vs recommended.** Required skills install automatically; recommended ones are
   *suggested* to the operator (or the managing agent) rather than forced — preserving operator
   control while removing the manual toil.
5. **Respect governance.** Auto-provisioning honors trust stage (idea 009) and source trust
   (`source-trust.ts`) — a probationary or low-trust agent might get a restricted bundle, and
   untrusted skills still require approval before install.

## Perceived complexity

**Low–Medium.** The role-skill metadata, the install path, and the hire hook all already exist —
this is mainly an explicit role→bundle model plus provisioning-on-hire and a reconciler, with no
new execution machinery. The care points are idempotency (don't re-install or thrash on every
heartbeat — `installedHash` helps), the desired-state reconcile semantics (what to do with skills
an operator added manually that the bundle doesn't include — treat as additive, don't auto-
remove), and keeping it auditable. Pairs naturally with skill effectiveness analytics (idea 046),
which tells you *which* skills belong in a role's bundle in the first place, and is a building
block for competency-gated job postings (idea 048).
