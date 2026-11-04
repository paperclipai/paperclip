# Cloud runtime configuration

Cloud-managed servers store nonsecret startup and application choices in the
private `instance_settings` singleton `cloud-runtime-config:v1`. The row contains
`version: 1`, an increasing `revision`, and a strict allowlist of configuration
fields. It is separate from the normal instance settings row and is not exposed
by the instance settings API.

The canonical managed-instance predicate applies: a nonblank Cloud tenant token
or the presence of `PAPERCLIP_MANAGED_CONFIG`, including a blank value, selects
this configuration path. Invalid managed feature documents still retain their
existing validation at application startup.

## Startup and authority

1. The hosting environment supplies `DATABASE_URL` and, if needed,
   `DATABASE_MIGRATION_URL`. Cloud requires a PostgreSQL URL and never falls back
   to embedded PostgreSQL. Credentials, trust keys, provider configuration and
   deployment wiring needed before the database connection remain supplied by
   the environment or the existing secret system. This phase parses only the
   database connection record and requires the stable environment encryption
   master key. Runtime mode, host binding and authentication
   checks wait until the saved snapshot has loaded.
2. After schema migration and database connection, startup reads the private
   runtime configuration row. An existing invalid row or a database error stops
   startup. Neither condition selects a legacy file or an old process snapshot.
3. If no row exists, startup imports the legacy config once. It uses
   `PAPERCLIP_CONFIG` when supplied, otherwise the instance home config path.
   It does not search working-directory ancestors. A truly absent file saves
   an authoritative `config: null` marker. This retains the existing dynamic
   environment/image defaults, including authentication and secret strictness.
   The marker never enables a later file fallback. A present malformed, linked, nonregular, or oversized file
   stops initialization. Reads and stored snapshots are limited to 64 KiB.
4. The seed uses an insert that does not replace an existing row. Concurrent
   initializers read the committed winner. Later starts do not inspect the
   legacy file, even when it is absent, corrupt, or changed.
5. Startup publishes a detached configuration snapshot, restores the signed
   Cloud runtime identity, then initializes telemetry, secret-provider defaults,
   authentication and application services. A saved telemetry opt-out therefore
   takes effect before a telemetry client can be created.

Managed Cloud always requires a stable environment master key, including when
an external default secrets provider is selected. Internal local-encrypted
credential paths still need that key.

Managed Cloud validates effective S3 storage after publishing the canonical
snapshot, before signing-key initialization, telemetry, authentication or app
construction. Cloud requires S3 and a nonblank bucket; an authoritative absent
configuration needs explicit environment storage settings. Raw saved snapshots
cannot obtain a bucket from a schema default. Every legacy Cloud file must name its
bucket before its one-time import, even if its saved provider is local disk and
an environment bucket is present. Omission or blank values fail before seeding;
The effective storage candidate is validated before seeding, so a rejected
legacy file leaves no canonical row and can be corrected before retry.
Environment overlays are not saved as operator choices. Correct that file before
import, or use the existing absent-file/null-snapshot environment-only setup.
Ordinary self-hosted file defaults remain unchanged.
Already-canonical nonblank values, including `paperclip`, remain authoritative.
Prior normalization cannot reliably distinguish an operator's deliberate name
from a historical default, so this release does not invent retrospective
provenance or replace those saved values.

Existing operator environment overlays keep precedence over saved values.
Reading an overlaid value does not save it back to the database. Credentials and
connection URLs are never copied into this JSONB row.

Cloud does not load instance or working-directory `.env` files and does not run
legacy worktree configuration repair. The hosting system must supply those
bootstrap variables directly. In particular, a database connection kept only
in `.env` cannot bootstrap this path. Self-hosted configuration and dotenv
behavior remain unchanged.

## Field ownership

The table lists every field consumed from the existing config file and the
remaining known schema fields. Environment-only `Config` fields, such as
heartbeat maintenance flags and feedback-export credentials, retain their
existing environment sources and are not frozen into the saved snapshot.

| Config file fields | Cloud owner |
| --- | --- |
| `server.deploymentMode`, `exposure`, `bind`, `customBindHost`, `host`, `port`, `allowedHostnames`, `serveUi` | Saved runtime configuration, with existing environment overlays. |
| `auth.baseUrlMode`, `publicBaseUrl`, `disableSignUp` | Saved runtime configuration, with environment overlays and the signed Cloud identity restoration. Saved URLs cannot contain userinfo, query parameters, or fragments. |
| `database.backup.enabled`, `intervalMinutes`, `retentionDays`, `dir` | Saved runtime configuration, with existing backup environment overlays. |
| `database.mode`, `connectionString` | Cloud bootstrap requires the environment `DATABASE_URL`. The legacy URL is never saved. |
| `database.embeddedPostgresDataDir`, `embeddedPostgresPort` | Local embedded-database settings. Cloud does not use embedded PostgreSQL or these paths. |
| `storage.provider`, `localDisk.baseDir`, `s3.bucket`, `s3.region`, `s3.endpoint`, `s3.prefix`, `s3.forcePathStyle` | Saved runtime configuration, with existing environment overlays. Saved endpoints cannot contain userinfo, query parameters, or fragments. |
| `secrets.provider`, `strictMode`, `localEncrypted.keyFilePath` | Saved nonsecret provider choice and locator, with existing environment overlays. No key bytes are imported or saved. |
| `telemetry.enabled` | Saved choice, passed to the existing telemetry initialization and opt-out policy before client creation. |
| `llm.provider` | Saved provider metadata. |
| `llm.apiKey` | Never saved. The existing OpenAI model-discovery consumer uses `OPENAI_API_KEY` first. A legacy OpenAI key requires that environment credential before import, or startup stops. Claude key metadata has no server consumer. |
| `logging.mode`, `logDir`, `updates.checkEnabled` | Nonsecret legacy/CLI metadata is preserved. Server logging continues to use its existing environment configuration. |
| `$meta` | CLI file-write metadata is not application authority. The compatibility view synthesizes valid metadata. |
| Unknown extension keys | No server config consumer exists. They are excluded from the strict saved allowlist, including any unknown credential fields. |

A saved path is a locator. This change does not make local storage objects,
backup bytes, logging files, or secret-key bytes durable. Their storage owners
and existing environment/secret mechanisms retain responsibility for those
bytes. Restart tests prove configuration restoration under a different home;
they do not prove durable file, secret, or backup storage.

The decision signing service still uses `PAPERCLIP_DECISION_SIGNING_SECRET` when
supplied and otherwise reads or creates its instance key file. Managed Cloud
performs that step after effective storage validation; self-hosted startup keeps
its pre-connection ordering. The local encrypted secret provider still uses its environment key
or existing key-file mechanism. Those byte-storage fallbacks are outside this
configuration migration. Qualification must account for them separately; this
PR does not establish file-free secret storage on Cloud.

## Internal update and migration interface

`cloudRuntimeConfigService(db)` provides `inspectStored(handle?)`,
`seedIfAbsent(config, handle?)`, and `replace(config, expectedRevision, handle?)`.
Each method accepts a database or transaction handle. A migration can compose a
config seed, related settings and a receipt in one transaction.

Replacement validates the same allowlist, locks the singleton row, checks the
expected revision, and increases it. A stale revision fails. There is no new
public configuration endpoint or settings UI. Startup consumers use a snapshot;
a saved replacement takes effect on the next initialization/restart.

`readLegacyCloudRuntimeConfig(env?)` returns the validated nonsecret candidate
without writing it. `initializeCloudRuntimeConfig` performs the standalone
one-time seed and publishes its committed snapshot. Integrated migration
receipts and deployed Cloud qualification are separate consumers of this
interface.

## Verification

`server/src/__tests__/cloud-runtime-config.test.ts` exercises real PostgreSQL
clients, concurrent writes, transaction rollback, changed homes, a fresh Node
process, environment precedence, secret exclusion, invalid data and database
failure. It uses embedded PostgreSQL by default. A dedicated disposable database
can be selected with `PAPERCLIP_RUNTIME_CONFIG_TEST_DATABASE_URL` when the host
cannot start embedded PostgreSQL. That database must be reserved for this test.
The test applies the current schema before use.

The startup orchestration controls in
`server-startup-feedback-export.test.ts` hold configuration initialization and
verify that telemetry, authentication and app construction wait for it. These
local controls do not claim a live Cloud rollout.
