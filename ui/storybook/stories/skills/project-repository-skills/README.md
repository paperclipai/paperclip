# Project repository skills

Open **Agents and reusable capabilities → Skills and Skill Studio → Project repository skills** in Storybook.

- **01 Components**: legacy adoption, progress, connection errors, private access,
  automatic-update preference and manual refresh controls.
- **02 Journeys**: production project creation, Sources, library and routine pages
  in the production app shell. Create a project with `acme/team-skills`, then
  navigate to Skills → Sources. Legacy adoption starts before import. Background
  update introduces skills without a click. Retry the failed refresh, pause updates,
  inspect the private/shared source and try the mobile and light-theme variants.
  Connection repair chooses an existing authorized account without changing skill
  selections. Also inspect removed skills, invalid upstream content, two private
  projects and the large-list story.

All GitHub, import, scheduled update and routine execution responses are scoped
in-memory fixtures, reset between stories. They do not prove live synchronization,
credential refresh or model execution. Production acceptance evidence is recorded
in `doc/plans/2026-10-12-project-repository-skills.md`.

Browser checks: `tests/storybook-visual/project-repository-skills.spec.ts`.
