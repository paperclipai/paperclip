# Project repository proposal

Review under **Proposals → Project repos** in Storybook. These story-only
components do not change the production new-project dialog, configuration,
API, or database.

- New project follows the supplied layout: “Create project” heading, close on
  the right, no expand control, an outlined folder beside the left-aligned,
  initially focused “Project name” placeholder, and “Source repos · optional.”
  There is no breadcrumb, description, status, goal, due date, or text URL field.
- The modal bounds its height to the dynamic viewport. Its title/name and
  Cancel/Create actions stay visible while the source repo region scrolls.
  The searchable dropdown has a separate scroll area bounded by Radix's
  available viewport height, including when it opens above its trigger.
- Repo selection uses the existing SearchableSelect, searching accessible
  personal/company connections, provider-ID deduplication, and repeatable
  add/remove. Fixtures contain 63 unique accessible repos, one duplicate repo,
  and an inaccessible personal connection. Selected repos leave the picker.
- GitHub setup uses the actual ConnectionSetupFlow. The story intercepts
  “Continue to GitHub” and simulates a successful return without starting OAuth.
  The project name and selected repos survive connect/cancel.
- Configuration now previews the whole Onboarding configuration tab, based on
  https://bull.staging.paperclip.app/BUL/projects/onboarding/configuration.
  It includes navigation, breadcrumbs, project title/star, tabs, the actual
  ProjectProperties general fields/environment editor/danger zone, and the
  proposed repo editor above environment variables. Status and Goals are
  omitted, Created is the last row after the danger zone, and the Overview
  tab is removed. Updated remains below environment variables. The sidebar is a reference
  shell; its links open staging in a separate tab. Non-configuration tabs are
  explicitly outside this proposal. Field edits and saves stay in memory.
- A temporary, story-only portal adapter reorders the repo/metadata sections and hides
  the omitted fields in ProjectProperties because that production component has no composition slot.
  It fails visibly if the expected section cannot be found. After approval,
  replace this adapter with a production composition boundary.
- Existing text URLs remain editable beside selected GitHub repos in the
  configuration stories. There is no new manual URL entry point in creation.

## Review coverage

Both groups include forty-selected-repo, mobile, and short-viewport stories.
Creation also includes mobile/short searchable picker stories. The short mobile
viewport is 390 × 420, useful for reduced screen space such as a visible keyboard;
this does not emulate a native keyboard. Loading, failure/retry, no accessible
repos, no matches, personal-only, multiple-connection, and legacy states remain.

## Implementation follow-up, after review

The prototype stores an array of repository identities (provider ID, full name,
canonical URL, connection provenance), not a single URL. This is a UI fixture,
not a proposed final API. Reconcile the existing project workspace/codebase
model with multiple repositories, preserve legacy URLs, and enforce company
and current-user access on the server before aggregation. Do not infer runtime
credential choice from the first connection in the list. Production GitHub
return handling also needs integration after design approval.
