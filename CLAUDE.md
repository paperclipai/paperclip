# ValAdrien OS

## Design System
Always read **DESIGN.md** (repo root) before making any visual or UI decision.
All fonts, colors, spacing, status semantics, and the signature components (agent
face, heartbeat spine, cost tape, thinking cursor) are defined there. The system is
**dark-first**; color means a state, never decoration. Do not deviate without
explicit owner approval. In QA/review, flag any UI that doesn't match DESIGN.md.

## Skill routing (engineering oversight)
When the situation matches, invoke the skill via the Skill tool. All names below are REAL
installed skills (user-level eng-overseer overlay + gstack).

- Design a new system from requirements → **/system-design**
- Review / lock / diagnose an existing architecture → **/architecture**
- Live incident / outage / RED audit → **/incident-response** (security → also **/cso**)
- Plain bug / root cause (no live impact) → **/investigate**
- Review a diff/PR → **/code-review** (pre-landing → **/review**; cleanup-only → **/simplify**)
- Independent / adversarial second opinion → **/codex**
- Test coverage & strategy → **/testing-strategy** (run+fix → **/qa**; report-only → **/qa-only**)
- Visual / design QA against DESIGN.md → **/design-review**
- Pre-deploy readiness gate → **/deploy-checklist** (then **/ship** → **/land-and-deploy** to execute)
- Docs after a change → **/document-release** (from scratch → **/document-generate**)
- Tech-debt assessment & paydown → **/tech-debt**
- Weekly retro / what shipped → **/retro**

The overlay agent is `eng-overseer` (user-level, runs on the subscription). The six skills
above (system-design, architecture, incident-response, testing-strategy, deploy-checklist,
tech-debt) live in `~/.claude/skills/` so they're available on every tenant, not just this repo.
