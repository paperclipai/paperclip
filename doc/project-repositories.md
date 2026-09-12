# Project source repositories

The Create project dialog accepts a name and optional GitHub repository selections.
It uses the same `RepositoryEditor` as project Configuration. Description remains
editable in Configuration. Status, goal links, and target dates remain supported by
the API but are omitted from creation; Status and Goals are omitted from Configuration.
Old Overview URLs and saved Overview preferences redirect to Configuration.

## API and persistence

- `GET /api/companies/:companyId/project-repositories` returns `repositories`,
  `connectionCount`, and `failedConnectionCount`. Repository IDs are GitHub's stable
  numeric IDs represented as strings. Results are deduplicated across accessible
  grants and sorted by full name. Connection labels are display provenance only.
- `POST /api/companies/:companyId/projects` accepts optional `repositoryIds`.
  The server resolves new selections through the caller's authorized GitHub grants
  before creating the project and all repository workspaces in a transaction.
  The existing `workspace` input remains supported; it cannot be combined with
  `repositoryIds`.
- `PUT /api/projects/:id/repositories` accepts the selected `repositoryIds` array.
  Accessible retained IDs refresh their canonical name and URL after renames or
  transfers; unavailable retained IDs keep their saved metadata.
  Replacement is transactional. Existing selections may be retained or removed even
  if their GitHub connection becomes unavailable. New identities require current
  access. Legacy URL workspaces are preserved, and matching legacy URLs are adopted
  without creating a duplicate workspace. Local/remote workspace locations survive
  detaching their repository.

No schema migration is required. Selected repositories are normal project workspaces
with `metadata.githubRepositoryId`. Existing manual `repoUrl` workspaces remain
editable through Configuration and the workspace API. One workspace remains primary;
additional repositories do not change the existing runtime workspace-selection or
responsible-user credential rules. A repository selection never delegates credentials.

## Discovery and setup

The server checks company membership, grant ownership/status, and organization-grant
audiences before loading provider metadata. Connection managers receive no bypass to
another person's personal repositories. Managed GitHub grants refresh installation
access; PAT connections use paginated `/user/repos`. Provider failures are reported
without exposing provider error bodies or credential material. Successful connections
remain selectable when another connection fails.

`ConnectionSetupFlow` owns provider setup in both Apps and project dialogs. Task
intents retain their existing callback protocol. Standalone dialogs verify the saved
connection through the API after the sign-in popup returns to the instance. Project
name and repository drafts stay mounted across setup and cancellation.

## UI review and verification

`Proposals/Project repos` contains the reviewed states, including loading, failure,
empty search, disconnected GitHub, multiple repos, legacy URLs, forty selections,
mobile, and short viewports. The configuration story composes the production page
properties through an explicit repositories slot. Story setup and saves use fixtures.

- Shared visual control: `ui/src/components/RepositoryEditor.tsx`.
- Data and error handling: `ProjectRepositoryInput.tsx`.
- Configuration persistence and legacy editing: `ProjectRepositories.tsx` and
  `LegacyProjectRepository.tsx`.
- Production dialog: `NewProjectDialog.tsx`.
- Server tests: `project-repositories.test.ts` and
  `project-repositories-persistence.test.ts`.
- Browser acceptance: `tests/e2e/project-repositories.spec.ts`.

The browser suite uses a real temporary server and database. It verifies creation,
forty persisted repos, mobile scrolling, removal/save/reload, legacy URL editing,
and rejection without a partial project. Provider discovery is simulated in the
picker rejection test. GitHub network and popup behavior use deterministic fixtures
in integration/component tests; the suite does not authorize a real GitHub account.
