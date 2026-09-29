# Native deployment declarations

Managed services can start Paperclip with a versioned descriptor and a native
resource manifest. The launcher applies the manifest before constructing the
application or opening its listener. This supports unattended authenticated
startup with public signup disabled.

```sh
node server/dist/deployment-entry.js /absolute/deployment.json serve
node server/dist/deployment-entry.js /absolute/deployment.json plan
node server/dist/deployment-entry.js /absolute/deployment.json check
node server/dist/deployment-entry.js /absolute/deployment.json apply
```

`serve` is the default. `plan` and `check` require a reachable, migrated database
and use a read-only transaction. They do not create users, initialize a database,
migrate, or publish files. `check` exits with `0` when converged, `2` when changes
are needed, and `1` on failure. `apply` is offline: it refuses while a managed
controller or another apply holds the database lease.

## Descriptor and credentials

The descriptor references a regular Paperclip application config and an optional
manifest. For example:

```json
{
  "version": 1,
  "home": "/var/lib/paperclip-operations",
  "instance": "operations",
  "executionProfile": "trusted-local",
  "configFile": "/etc/paperclip/operations/config.json",
  "manifestFile": "/etc/paperclip/operations/manifest.json",
  "serverCredentials": {
    "auth": "/run/credentials/paperclip/auth",
    "database": "/run/credentials/paperclip/database-url",
    "migration": "/run/credentials/paperclip/migration-url",
    "encryption": "/run/credentials/paperclip/encryption"
  },
  "credentialFiles": { "gateway": "/run/credentials/paperclip/gateway" },
  "bootstrap": {
    "email": "operator@example.invalid",
    "name": "Operator",
    "passwordFile": "/run/credentials/paperclip/initial-password"
  }
}
```

The application config selects `database.mode: "postgres"` and authenticated
private mode with `auth.disableSignUp: true` and an explicit public base URL.
Database URL files contain URLs for the same database; the migration URL may
use a separate schema-owner role. The launcher ignores ambient configuration
overrides and dotenv files. Unknown application config fields fail validation.

Credential files must be absolute, regular, nonempty, outside the Nix store,
and unreadable by other users. Mode `0600` is suitable; a restricted group is
also supported. Signing secrets require at least 32 characters. Server signing
and database credentials stay in process memory. Child environments do not
inherit them. Same-UID processes can still access that UID's files; this is not
a worker sandbox.

Embedded PostgreSQL additionally requires an `embedded` object with `user`,
`database`, and `passwordFile`. The password must contain at least 16 characters.
Managed startup refuses occupied or mismatched ports rather than selecting new
ports. External or module-managed PostgreSQL is the initial staging target.

The bootstrap creates the first account and administrator role in one
transaction through the native authentication implementation. It creates no
session. Reapply preserves the account and password. It refuses to adopt a
non-admin account or replace another administrator. Its temporary signup-enabled
auth handler is process-local and never registered on the listener.

When a company is first created or explicitly adopted, reconciliation adds an
active owner membership for the bootstrap operator if no membership exists.
Existing membership roles and statuses are preserved. Later reconciliation does
not restore a removed membership; company access remains application-managed.

`remote-only` is reserved and refuses every command before credentials, adapter
loading, or database changes. The supported profile is `trusted-local`.

## Native resource manifest

```json
{
  "version": 1,
  "owner": "operations",
  "companies": { "example": { "fields": { "name": "Example", "budgetMonthlyCents": 1000 } } },
  "projects": { "health": { "company": "example", "fields": { "name": "Health checks" } } },
  "agents": {
    "worker": {
      "company": "example",
      "fields": {
        "name": "Worker",
        "adapterType": "hermes_gateway",
        "adapterConfig": { "apiBaseUrl": "https://worker.example.invalid" },
        "budgetMonthlyCents": 500
      },
      "credentials": { "apiKey": "gateway" }
    }
  }
}
```

The executable contract is `packages/shared/src/deployment-manifest.ts`. It
reuses native validators. Supported declaration adapters are `hermes_gateway`,
`process`, and `http`; `server/src/deployment/adapter-config.ts` defines their
allowed fields. Worker credentials are native encrypted secret references.
Manifest fields must contain nonsecret values.

Identity is `owner + kind + key`, independent of display names. Existing
resources need explicit `adopt` UUIDs. Cross-company references, duplicate
ownership, manager cycles, and adoption of plugin/bundled resources fail.
The database fixes the instance and declaration owner. An owner change requires
an explicit handoff rather than silently abandoning prior resources.

`projectWorkspaces.<key>` refers to a declared `project` key and inherits its
company. Each project with declared workspaces needs exactly one explicit
primary. Bindings use `workspace/<key>`. Workspace adoption must match both
project and company, and changing a primary requires ownership of the previous
primary. A declaration creates native records; it does not clone repositories or
grant worker filesystem access. Non-null `defaultProjectWorkspaceId` and
`environmentId` in execution policies are rejected; use the project primary.

Omitted owned fields relinquish ownership without clearing stored values.
Explicit `null` clears nullable fields. Workspace `runtimeConfig` owns the
native `metadata` field and replaces it with declared metadata plus normalized
runtime configuration. Declare metadata to preserve it during adoption.

Database guards reject ordinary edits to owned fields and credentials.
Operational pauses, spending, and run history remain mutable. Reapply does not
resume paused work. Removing declarations retains history: agents, companies,
and routines pause; schedules and secrets disable; task-bridge keys revoke.
Workspace removal is rejected until an explicit ownership handoff exists.
Task-bridge rotation requires a new declaration key and token. Existing active
routine schedules require explicit schedule adoption to avoid duplicates.

## Startup, publication, and recovery

The controller reserves a database connection for its full lifetime. Managed
startup checks migration hashes before applying migrations, then bootstraps and
reconciles transactionally. Failure stops startup before the application listener
or dispatch services. Unexpected lease loss terminates the controller or apply.

Bindings publish after database commit to
`<home>/instances/<instance>/deployment-bindings.json`, mode `0600`, by file sync,
rename, and directory sync. Publication failure prevents startup. Retry uses the
same database identities and republishes the file. Native runtime adoption still
binds its authenticated listener before orphan recovery, after these managed
startup prerequisites finish.

Every reconciliation checks the configured encryption key against existing
local encrypted material without recording secret-access timestamps. Preserve
that key, runtime credentials, storage, and the migration journal in backups.
Application generation rollback is not database rollback.

Migration `0289_messy_vivisector` follows the selected upstream history. Older
fork-only `0284_bizarre_mastermind` / `0285_deployment_workspaces` databases are
not upgrade-qualified; unknown hashes fail closed. Use a separate verified
migration or restore procedure. Fresh disposable staging does not prove
retained-data production recovery.

## Verification

Focused tests live in `server/src/deployment/`,
`packages/db/src/deployment-ownership.test.ts`, and
`packages/shared/src/deployment-manifest.test.ts`. They exercise actual
PostgreSQL, the real launcher, authenticated API calls, a fake HTTP gateway,
ownership/adoption, no-op reapply, failure rollback, lease loss, and logical
backup/restore. They do not qualify a real Hermes worker, worker confinement,
remote-only execution, or fresh-host disaster recovery.
