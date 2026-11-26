# Project repository proposal

Review under **Proposals → Project repos** in Storybook. The repository editor is shared with production. Stories use local
fixtures for review; production screens use authenticated API requests.

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
- The full configuration story composes ProjectProperties directly through its
  repositories slot. No DOM manipulation or duplicated configuration page is used.
- Existing text URLs remain editable beside selected GitHub repos in the
  configuration stories. There is no new manual URL entry point in creation.

## Review coverage

Both groups include forty-selected-repo, mobile, and short-viewport stories.
Creation also includes mobile/short searchable picker stories. The short mobile
viewport is 390 × 420, useful for reduced screen space such as a visible keyboard;
this does not emulate a native keyboard. Loading, failure/retry, no accessible
repos, no matches, personal-only, multiple-connection, and legacy states remain.

## Production contract

Projects persist selected GitHub identities in project workspaces using
`metadata.githubRepositoryId`. Each selection has its own workspace; the first
is the default execution workspace. Legacy `repoUrl` and local workspaces remain
supported. Runtime credentials still come from the existing run identity resolver;
a selection does not grant agents additional GitHub access.

The company repository endpoint includes only the current user's personal grants
and organization grants whose audience includes that user. It refreshes GitHub
installation metadata, supports PAT pagination, deduplicates provider IDs, and
reports partial failures. Creation validates all selections before saving the
project and repositories in one transaction. Configuration retains inaccessible
existing selections until explicitly removed and leaves legacy workspaces intact.
