# Repository providers

Project repository discovery combines the registered provider catalogs while
preserving their connection counts, failures and provider-qualified repository
identities. Each provider must apply its own company, installation and grant
checks before returning a repository. A failed provider request must not become
a successful empty catalog.

To add a repository provider:

1. Add its connector and authentication following `CONNECTOR-PLAYBOOK.md`.
2. Implement authorized repository discovery and register it in
   `listProjectRepositories` in `server/src/services/tool-access.ts`. Discovery
   returns `ProjectRepositoryOptions`; keep provider IDs stable and qualified.
3. Register the display name, icon and connector service slug in
   `ui/src/components/repository-providers.tsx`. The project repository picker
   uses the entry for its buttons and opens the shared connection setup flow.
4. Implement and verify provider-specific project authorization, Git credential
   handling and workspace checkout. Catalog registration alone does not grant
   execution access or add support for a new Git host.
5. Test discovery, denied and revoked grants, project selection, checkout and
   connection setup, including preservation of existing provider behavior.

GitHub retains its legacy unqualified repository IDs. New providers must use
their provider-qualified IDs so identities from different providers cannot
collide.
