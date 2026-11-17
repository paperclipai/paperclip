# Project repository skills

Open **Agents and reusable capabilities → Skills and Skill Studio → Project repository skills** in Storybook.

- **01 Components**: legacy adoption, progress, connection errors, private access,
  automatic-update preference and manual refresh controls.
- **02 Journeys**: production project creation, Sources, library and routine pages
  in the production app shell. Create a project with `acme/team-skills`, then
  navigate to Skills → Sources. Legacy adoption starts before import. Background
  update introduces skills without a click. Retry the failed refresh, pause updates,
  inspect the private/shared source and try the mobile and light-theme variants.
  **Existing source, more projects** reproduces a saved source with additional
  project imports available in its More menu. The source row shows no project names.
  Connection repair chooses an existing authorized account without changing skill
  selections. Also inspect removed skills, invalid upstream content, two private
  projects and the large-list story.
- **03 Branch selection components** and **04 Branch selection journeys**: shared
  production branch selector and Sources dialog. Choose a new branch, search the fetched
  list, or type an unlisted branch name and select **Use “name”**. The repository's
  default branch is marked. Loading or a failed list request does not prevent
  entering a name. Try retry, an empty list, many branches, and mobile/light views.
  In **Validation failure**, enter `feature/missing`, save, then choose `master`.
  The selected value stays visible after an error; existing installed skills remain.
  Provider responses are simulated at the production API boundary. Also try
  concurrent-update recovery and branch repair with the selected GitHub connection.
  Active project refs remain managed through project configuration.

All GitHub, import, scheduled update and routine execution responses are scoped
in-memory fixtures, reset between stories. They do not prove live synchronization,
credential refresh or model execution. Production acceptance evidence is recorded
in `doc/plans/2026-10-12-project-repository-skills.md`.

Browser checks: `tests/storybook-visual/project-repository-skills.spec.ts`.
Branch selection checks: `tests/storybook-visual/skill-source-branch-selection.spec.ts`.
