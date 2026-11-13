# Google Workspace service consent

New Workspace setup uses one account connection and three service groups:
Gmail, Drive (including Docs, Sheets, and Slides), and Calendar. Every group
starts enabled with read and write access. The picker can disable groups or
choose read-only access. Chat, Contacts/directory, and cross-service search are
not offered. Existing individual-service connections remain compatible.

`GoogleWorkspaceServicesDialog` is shared by Apps and task-hosted setup.
It appears before creating an OAuth draft or starting reconnect. Cancel does
not create a connection. Reconnect reads the current subject's grant and
restores its saved request; failure to load never substitutes broader defaults.
Account-page reconnect calls without a new selection also restore the exact
subject's saved request on the server. Missing request/grant evidence blocks
reconnect until a service choice is supplied; new-account defaults never replace it.
The same service fields appear in Storybook's **Google Workspace → Service
consent preview → Production picker**. Storybook callbacks do not grant access.

The `workspaceServices` input accepts only nonempty combinations of `gmail`,
`drive`, and `calendar`, each `read` or `write`. The server derives exact scopes
from the shared closed registry. Default write access requests nine scopes.
Drive file creation is limited to app-opened/app-created files; Docs, Sheets,
and Slides have their respective editor scopes. Gmail uses `gmail.compose`
for draft creation; Google permits sending under that scope, but Paperclip's
closed tool allowlist still excludes sending.

Both customer OAuth and managed Cloud OAuth bind the request to durable OAuth
state. The broker must support nonempty `workspace.all` scope subsets, preserve
them in the provider URL and encrypted claim binding, and reject unknown scopes.
Other managed profiles retain their exact-set contract. Ship that broker change
before updating tenant apps; an older broker rejects narrowed requests safely.

Only provider-reported consent enables tools. Callback and refresh cap effective
permissions to the saved request, including read-only implications of broader
Google grants. Accumulated grants cannot enable unselected services or writes.
Credential ownership, agent installations, action policies, company boundaries,
and single-use state remain under their existing enforcement paths.

Production readiness additionally requires the intended OAuth client and
`workspace.all` profile to be enabled on the target broker, a deployed app and
broker with matching contracts, and live reviewer-path verification. Passing
Storybook or fixture-backed OAuth tests does not establish Google verification
approval, production deployment, or a successful live grant.
