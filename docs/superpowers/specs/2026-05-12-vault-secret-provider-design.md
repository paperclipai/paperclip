# Vault Secret Provider (OpenBao-Bundled) — Design Spec

Status: Draft
Date: 2026-05-12
Author: Jannes Stubbemann
Successor of: the `vault` provider stub in `server/src/secrets/external-stub-providers.ts`
Related: `doc/SECRETS-AWS-PROVIDER.md`, `docs/deploy/secrets.md`

## Summary

Paperclip's existing secret-provider surface ships three real backends and two
stubs: `local_encrypted` (default), `aws_secrets_manager` (AWS Cloud), and the
unimplemented `gcp_secret_manager` / `vault` entries marked `coming_soon`. For
self-hosted Paperclip on Kubernetes the only currently-shipping option is
`local_encrypted`, which is not appropriate for a multi-node cluster
deployment, and AWS, which is a non-starter for non-AWS clusters.

This spec promotes the `vault` stub to a fully-implemented secret provider
that talks the Vault HTTP API. The Paperclip helm chart (separate milestone)
bundles **OpenBao** as its default upstream — an MPL-2.0 Linux Foundation
fork of HashiCorp Vault that is API-compatible with the surface this provider
uses. Operators running HashiCorp Vault are supported by the same provider:
the upstream is a helm-dependency choice, not a code-path choice.

Kubernetes-native `Secret` objects are explicitly rejected as a primary
backend (see Non-Goals). They are too weak at rest by default — base64 in
etcd unless cluster admins separately configure an `EncryptionConfiguration`
with a KMS provider, and namespace read on `secrets` is a frequent
over-grant.

## Goals

- Promote `vault` from `coming_soon` to a real `SecretProviderModule`,
  shipping in-tree alongside `aws-secrets-manager-provider.ts`.
- Be a structural sibling of the AWS provider: same `SecretProviderModule`
  contract, same per-company "provider vaults" UX, same workload-identity
  bootstrap rule, same external-references support, same health-check
  surface, same audit shape.
- Work against both **OpenBao** and **HashiCorp Vault** through the Vault
  HTTP API with no upstream-specific code paths.
- Satisfy the project's local-first rule: usable without any cluster
  (`VAULT_TOKEN` against `bao server -dev` or `vault server -dev`) and
  in-cluster (Kubernetes auth method) without bifurcating the design.
- Allow the future Paperclip helm chart / operator to bundle OpenBao
  as a dependency and configure the provider out of the box.

## Non-Goals

- A `kubernetes_secret` provider that reads/writes K8s `Secret` objects as
  primary storage. K8s `Secret` resources still exist in a Paperclip
  deployment for unrelated reasons (the Paperclip server's own DB password,
  OpenBao unseal-key bootstrap, automatic ServiceAccount token mounts) —
  those are helm-chart plumbing, not Paperclip's `SecretProvider` surface.
- Vault dynamic secret engines (database, AWS STS, PKI, transit-as-a-service).
  KV v2 only at M1.
- Vault auth methods beyond `kubernetes` and `token`. No AppRole, OIDC, AWS
  IAM, JWT, LDAP at M1.
- Promoting `gcp_secret_manager` from `coming_soon`. Separate milestone.
- An External Secrets Operator (ESO) bridge provider.
- A `registerSecretProvider()` plugin SDK extension slot mirroring the
  in-flight `registerCredentialBroker()` slot. Flagged as Future Work; punted
  until there is a concrete third-party-provider request.
- Changes to the in-flight credential-broker subsystem. Credential brokers
  consume `SecretProvider`; the new provider becomes available to brokered
  runs automatically once it ships.
- The Paperclip helm chart / operator themselves. This spec covers the
  provider that those will consume. The helm chart is a separate, dependent
  milestone.

## Module Layout

```
server/src/secrets/
├── provider-registry.ts            # register vaultProvider here
├── local-encrypted-provider.ts     # unchanged
├── aws-secrets-manager-provider.ts # unchanged (reference shape)
├── vault-provider.ts               # NEW
├── external-stub-providers.ts      # remove vault stub; keep gcp_secret_manager
└── types.ts                        # unchanged
```

The `SecretProvider` shared-types enum in `@paperclipai/shared` already
contains `"vault"`. No new enum value is added; no DB migration is required.
The `vault` row simply transitions in code from "unconfigured stub" to a
real `SecretProviderModule`. The vault-config table (per-company "provider
vaults") already accepts `"vault"` and stores provider-specific JSON config —
no schema change there either.

## HTTP Client and Authentication

The provider speaks the Vault HTTP API directly using `undici` (already in
the server dependency graph). No `node-vault` dependency. The reasons:

- The KV v2 surface plus `sys/health`, `sys/capabilities-self`,
  `auth/kubernetes/login`, `auth/token/lookup-self`, and the policy/role
  bootstrap endpoints amount to well under twenty endpoints; a hand-rolled
  client is ~200 lines and is explicit about error mapping.
- Both OpenBao and Vault expose this surface identically.
- No transitive dep risk.

A single client instance per server process owns a cached Vault token plus
its lease metadata. The token is process-resident only — never persisted,
never returned from any API, redacted from wrapped errors.

### Auth detection

```
in-cluster (default):
  /var/run/secrets/kubernetes.io/serviceaccount/token exists
  AND vault config has auth.method = "kubernetes" (or unset)
  → POST /v1/auth/kubernetes/login { role, jwt }
  → cache returned token + ttl

local / non-k8s:
  VAULT_TOKEN env OR ~/.vault-token file present
  AND vault config has auth.method = "token" (or unset and no SA token)
  → use as Vault token directly

else:
  health = error
  message: "no Vault auth source detected; configure auth.method=kubernetes
            with role=<role> in cluster, or set VAULT_TOKEN locally"
```

Detection runs once at provider construction. The chosen path is reported by
`validateConfig()` and surfaced in `healthCheck()`. There is no silent
fallback between modes — the operator's intent (vault config + environment)
unambiguously determines which login flow runs.

### Token lifecycle

- Vault's `auth/kubernetes/login` response includes `lease_duration` and
  `renewable`. The client renews proactively at 70% of TTL via
  `POST /v1/auth/token/renew-self`.
- On any `403 permission_denied` from a downstream call, the client
  invalidates the cached token, re-runs login (k8s mode) or returns the
  original error (token mode — operator must fix), and retries the original
  call once. This defends against TTL drift after process suspension or
  clock skew.
- A token expiring within the next 30s is treated as already expired.

## Per-Vault Config Schema

`SecretProviderConfig.config` for `provider = "vault"`:

```ts
type VaultVaultConfig = {
  address: string;                  // required; origin-only http(s)://host[:port]
  namespace?: string;               // Vault Enterprise namespace; ignored on OpenBao
  kvMount?: string;                 // default "secret"
  kvPathPrefix?: string;            // default "paperclip"
  auth?: {
    method?: "kubernetes" | "token"; // default: "kubernetes" in-cluster, "token" locally
    role?: string;                   // required iff resolved method === "kubernetes"
    saTokenPath?: string;            // default /var/run/secrets/kubernetes.io/serviceaccount/token
  };
  versionRetention?: number;        // default 10; min 2; max 100
};
```

Defaults are resolved at provider construction in this order: explicit vault
config → deployment-level env (`PAPERCLIP_SECRETS_VAULT_*`) → static default
listed above. The auth method is resolved against the runtime environment: if
the SA token mount at `auth.saTokenPath` exists, default to `kubernetes`;
otherwise default to `token`. Operators can override either way explicitly in
vault config.

**Validation rules** (enforced in `validateConfig`):

- `address` is parsed by `URL`. Reject embedded credentials (`username` or
  `password` non-empty), non-empty `pathname` other than `/`, non-empty
  `search`, non-empty `hash`. Mirrors the existing rule for the `vault` stub
  in `docs/deploy/secrets.md`.
- `kvMount` and `kvPathPrefix` must match `^[a-zA-Z0-9._-]+$` and not begin
  with `/` or `data/`. The Vault API distinguishes mount path from KV
  internal `data/` prefix; the provider handles both.
- `auth.method = "kubernetes"` requires `role` to be a non-empty
  `^[A-Za-z0-9_-]{1,128}$` string.
- `versionRetention` between 2 and 100.
- The full credential-shaped-field denylist from the AWS provider applies,
  extended with Vault-specific names: `token`, `roleId`, `secretId`,
  `password`, `unsealKey`, `clientCert`, `privateKey`. The API/UI reject any
  submitted vault config containing these keys at validation time.

## Deployment-Level Defaults

When a secret is created without an explicit `providerConfigId`, the provider
falls back to deployment-level environment configuration (same pattern as
`PAPERCLIP_SECRETS_AWS_*`):

```sh
PAPERCLIP_SECRETS_PROVIDER=vault
PAPERCLIP_SECRETS_VAULT_ADDR=http://<release>-openbao.<ns>.svc:8200
PAPERCLIP_SECRETS_VAULT_NAMESPACE=                  # Vault Enterprise only
PAPERCLIP_SECRETS_VAULT_KV_MOUNT=secret
PAPERCLIP_SECRETS_VAULT_KV_PATH_PREFIX=paperclip
PAPERCLIP_SECRETS_VAULT_AUTH_METHOD=kubernetes
PAPERCLIP_SECRETS_VAULT_K8S_ROLE=paperclip-server
PAPERCLIP_SECRETS_VAULT_VERSION_RETENTION=10
```

For local development:

```sh
PAPERCLIP_SECRETS_PROVIDER=local_encrypted          # still the default
# When testing the vault provider locally:
VAULT_ADDR=http://127.0.0.1:8200
VAULT_TOKEN=<dev-token>
PAPERCLIP_SECRETS_VAULT_AUTH_METHOD=token
```

## KV Path Layout and Payload

One Vault KV v2 path per Paperclip secret. The naming convention parallels
the AWS provider's `paperclip/{deploymentId}/{companyId}/{secretKey}`:

```
<kvMount>/data/<kvPathPrefix>/<deploymentId>/<companyId>/<secretKey>
```

The path is constructed once at create time and stored on the secret row;
subsequent rotates/reads use the recorded path verbatim.

Payload shape:

```json
{ "data": { "value": "<plaintext>" } }
```

Single `value` key, matching the AWS provider's single-`SecretString` shape
and the existing single-value resolver expectation. Multi-key bindings are a
binding-row concern (one `EnvVarBinding` per key), not a Vault-object
concern.

## Versioning, Rotation, Retention, Delete

- `createSecret` → `POST /v1/<mount>/data/<path>` with no `options.cas`
  (first write). KV v2 returns `version=1`. The provider also writes
  `max_versions=<retention>` via
  `POST /v1/<mount>/metadata/<path>` to set Vault-side retention.
- `createVersion` (rotate) → `POST /v1/<mount>/data/<path>` with
  `options.cas = currentVersion`. A 400 with `cas mismatch` is mapped to
  `SecretProviderClientError(code: "conflict")` and surfaced through the
  existing rotate retry path in `services/secrets.ts`.
- `resolveVersion({ version })` → `GET /v1/<mount>/data/<path>?version=N`
  for a pinned version; `GET /v1/<mount>/data/<path>` for latest. The
  resolver returns the raw plaintext; injection happens at the existing
  binding-resolution boundary, unchanged.
- **Retention is Vault-enforced.** When `versionRetention` changes on the
  vault config, the provider updates `max_versions` on each Paperclip-managed
  KV metadata record opportunistically (on next read/write of that path).
  No background sweeper. KV v2 prunes oldest versions when retention is
  exceeded.
- `deleteOrArchive` → soft-delete via `DELETE /v1/<mount>/data/<path>`.
  Versions become unreadable but recoverable. **Hard-destroy is not
  exposed through the API surface.** It is available only through the
  `paperclipai secrets doctor --destroy <secret-id> --confirm` CLI path,
  which calls `POST /v1/<mount>/destroy/<path>` and requires the operator
  to type the secret id. Mirrors the AWS provider's recovery-window posture.

## External References

Provider-owned Vault paths can be linked into Paperclip without copying
plaintext. `linkExternalSecret({ externalRef })` accepts:

```
<mount>/<path>[#<dataKey>]
```

Examples:

- `secret/teams/platform/github-token` → reads `value` (default key)
- `secret/teams/platform/github-token#token` → reads the `token` key

Stored fingerprint is `sha256("<mount>/<path>#<key>:<currentVersion>")`. The
fingerprint and the reference itself are stored; the value is not copied.
Resolution does a single KV v2 read against the recorded mount/path/key and
returns the plaintext to the existing binding resolver.

External references inherit no special permissions — the Paperclip server's
Vault token must be allowed to read the linked path. The capability probe in
the health check covers `<mount>/data/<prefix>/*` (Paperclip-managed) but
not arbitrary external paths; missing capability on an external read surfaces
at resolve time as `SecretProviderClientError(code: "access_denied")`.

## Required Vault Policy

Per vault config, the operator (or the helm chart's post-install Job when
OpenBao is bundled) attaches the following policy to the role or token used
by Paperclip:

```hcl
# Paperclip-managed secrets
path "<mount>/data/<prefix>/*"     { capabilities = ["create","read","update","delete"] }
path "<mount>/delete/<prefix>/*"   { capabilities = ["update"] }
path "<mount>/undelete/<prefix>/*" { capabilities = ["update"] }
path "<mount>/metadata/<prefix>/*" { capabilities = ["read","list","update","delete"] }

# External references — read-only on anything outside Paperclip's prefix
path "<mount>/data/+/*"            { capabilities = ["read"] }
```

Notes:

- No `sys/*` permissions.
- No `destroy` capability in the default policy. The `destroy` path is only
  reachable through the `paperclipai secrets doctor` flow and requires a
  separately-attached emergency policy.
- The `<mount>/data/+/*` external-reference rule is intentionally narrow:
  `+` is single-segment, preventing accidental wildcard reads at the mount
  root. Operators who want to restrict external references further can
  override this policy in their helm values and accept that
  `linkExternalSecret` on paths outside the override will fail at resolve
  time with a clear error.

## Health Check

`POST /api/secret-provider-configs/{id}/health` runs four probes:

1. **Reachability:** `GET /v1/sys/health?standbycode=200&sealedcode=200`.
   Reports `sealed`, `standby`, `version`, `cluster_name`. A sealed Vault is
   `warning`, not `error` — the operator may be in the middle of a manual
   unseal. Unreachable is `error`.
2. **Auth:** in `kubernetes` mode, attempt login and report the role +
   token TTL. In `token` mode, call `POST /v1/auth/token/lookup-self` and
   report TTL + renewable. Failure is `error` with operator-facing guidance
   pointing at the SA token mount or `VAULT_TOKEN`.
3. **KV engine:** `GET /v1/sys/mounts/<mount>` confirming the mount exists
   and `options.version == "2"`. KV v1 mounts are rejected with a clear
   "kv v2 required" message — the provider does not silently degrade.
4. **Capabilities:** `POST /v1/sys/capabilities-self` against
   `<mount>/data/<prefix>/test`, `<mount>/metadata/<prefix>/test`,
   `<mount>/delete/<prefix>/test`, `<mount>/undelete/<prefix>/test`.
   Missing capabilities are listed by name in the warning output.

Responses never include the Vault token, lease ids, or any policy contents.
They follow the existing health-response shape used by the AWS provider.

## Helm Chart Integration (Future Milestone, Sketch)

The provider is designed against the consumer the helm chart will be. Two
deployment shapes:

### Bundled OpenBao (default)

```yaml
# values.yaml
secrets:
  default: vault
bao:
  enabled: true              # default
  server:
    ha:
      enabled: true
      replicas: 3
    auditStorage:
      enabled: true
  kubernetesAuth:
    role: paperclip-server
    policy: paperclip-default
```

Chart renders:

- OpenBao via `dependencies:` (`name: openbao`,
  `repository: https://openbao.github.io/openbao-helm`,
  `condition: bao.enabled`).
- A `post-install,post-upgrade` Job, running as a dedicated SA with
  minimum scope (`sys/auth`, `sys/mounts`, `sys/policies/acl`,
  `auth/kubernetes/role`), that idempotently:
  1. Enables the `kubernetes` auth method.
  2. Writes the `paperclip-default` policy from the spec above.
  3. Creates the `paperclip-server` Kubernetes auth role bound to the
     Paperclip server's ServiceAccount and the policy.
  4. Enables the KV v2 mount at `secret` if not present.
- Server `Deployment` env wired with the deployment-level defaults
  pointing at the bundled OpenBao service.

Unseal/auto-unseal is the operator's choice; the chart exposes
`bao.server.ha.config` for transit/awskms/gcpckms snippets. Initial
root-token bootstrap follows the standard OpenBao helm init flow,
identical to operating Vault.

### External Vault or OpenBao

```yaml
secrets:
  default: vault
bao:
  enabled: false
vault:
  external:
    address: https://vault.corp.example:8200
    kvMount: secret
    kvPathPrefix: paperclip
    auth:
      method: kubernetes
      role: paperclip-server
```

The chart only sets env on the server `Deployment`. The cluster admin has
already attached the policy to their role on their existing Vault/OpenBao.
No post-install Job runs.

### What the chart does NOT do

- Install a non-OpenBao Vault distribution. Operators who want HashiCorp
  Vault disable `bao` and run it themselves (or via the HashiCorp helm
  chart in a separate release).
- Create K8s `Secret` objects for storing Paperclip-managed values. K8s
  Secrets are used by the chart for plumbing (DB password, image pull
  secrets, OpenBao unseal bootstrap, automatic SA token mounts) — not for
  any `SecretProvider`-managed value.

## Local-First Behavior

The project's local-first rule: subsystems must work locally (in-process or
single binary) AND cloud-k8s without bifurcating the design.

The vault provider satisfies this by being selectable but not default
locally:

- `local_encrypted` remains the default deployment-level provider for local
  installs. Onboarding, single-developer workflows, and CI smoke tests do
  not require a Vault server.
- When a developer wants to exercise the vault provider locally, they run
  `bao server -dev` (or `vault server -dev`) and export `VAULT_ADDR` plus
  `VAULT_TOKEN`. The provider's `token` auth path engages.
- `pnpm paperclipai doctor` and the provider health endpoint surface the
  vault provider's status row alongside the existing AWS row. When
  unconfigured locally, the row reports
  `status=warn, message="vault provider available for external references
  only; configure VAULT_ADDR + VAULT_TOKEN to enable runtime resolution"` —
  parallel to the existing AWS-not-configured-locally warning.
- The credential-shaped-field denylist explicitly rejects pasting
  `VAULT_TOKEN` into vault config in any environment, local or otherwise.

There is no code path that exists only in the k8s deployment shape. The
same `vault-provider.ts` handles both; only auth-source detection differs.

## Custody and Threat Model

Inherits the custody contract documented in
`doc/SECRETS-AWS-PROVIDER.md` and `docs/deploy/secrets.md`. The
provider-specific consequences:

- **Bootstrap credentials live in workload identity.** In-cluster: the
  Paperclip server's ServiceAccount JWT, validated by Vault/OpenBao through
  the Kubernetes auth method's `TokenReview` call against the cluster API.
  Local: `VAULT_TOKEN` from the developer's environment. Never accepted
  into `company_secrets`; never accepted into vault config (denylist).
- **Server-side resolution.** Plaintext is read by the Paperclip server,
  injected into the consumer (agent process env, sandbox driver, SSH env,
  HTTP request) immediately before the call, and never returned to the
  board UI.
- **Per-resolution audit events** record `secretId`, `version`, `providerId`,
  `consumer`, `outcome`, plus Vault-specific non-sensitive context:
  `kvMount`, `kvPathSha256` (sha256 of the full KV path), and the resolved
  KV version. The full path is never logged.
- **Token redaction.** Any error wrapped in `SecretProviderClientError`
  scrubs the Vault token, lease ids, and KV path values before the error
  surfaces.

## Testing Strategy

### Unit tests (default `pnpm test`)

`vault-provider.test.ts` uses `undici` `MockAgent` to assert behavior
against the Vault HTTP surface:

- Config validation: address parsing, denylist, mount/prefix rules.
- Kubernetes-auth login flow: SA JWT read, `auth/kubernetes/login` request
  shape, token cache, proactive renewal threshold.
- Token-mode flow: `lookup-self`, no renewal.
- KV v2 path math: mount/prefix joining, DNS-safety not applicable (Vault
  paths permit `/`), correct `data/` vs `metadata/` vs `delete/` segment
  for each operation.
- CAS conflict on rotate → mapped to `code: "conflict"`.
- Soft-delete vs destroy: API never reaches `destroy/*`.
- External reference parsing and fingerprint shape.
- Capability probe parsing.
- Error mapping for 401/403/404/429/500/503 to
  `SecretProviderClientErrorCode` values.

### Integration tests (opt-in, `PAPERCLIP_TEST_VAULT=1`)

Runs OpenBao in `-dev` mode as a sidecar container in the test job. Asserts
end-to-end create → rotate → resolve(latest) → resolve(version) →
external-reference → retention enforcement (write more versions than
`max_versions`, confirm oldest is pruned) → soft-delete → undelete.

Gated by env var so the default `pnpm test` does not require Docker. Same
pattern as the existing AWS integration tests.

### Helm chart test (when chart milestone lands)

Out of scope for this spec, but the post-install Job's idempotency and the
policy/role bootstrap should be covered there with `helm test` against
kind.

## Rollout

- Single commit replaces the `vault` entry in `external-stub-providers.ts`
  with the new `vault-provider.ts` module and registers it in
  `provider-registry.ts`. No DB migration required.
- The provider ships with the existing per-vault status field driving
  behavior: `ready` when configured and healthy, `warning` when health
  probes fail, never `coming_soon` again.
- No feature flag at the `SecretProvider` layer. Operators flip a per-company
  vault between `ready` and `disabled` through the existing UI to control
  rollout per-company.
- The in-flight credential-broker feature flag
  (`PAPERCLIP_FEATURE_CREDENTIAL_BROKER`) is unaffected. Credential brokers
  consume `SecretProvider`; the new vault provider becomes available to
  brokered runs automatically once both ship.

## Future Work (Explicit Non-Goals for M1)

Tracked here so a future reader does not interpret their absence as
oversight:

- A `registerSecretProvider()` plugin SDK extension slot, symmetric with
  `registerCredentialBroker()`. Defer until a concrete third-party-provider
  request lands; current in-tree contract is the right shape to extract.
- Vault dynamic secret engines: database (short-lived DB creds), AWS STS,
  PKI, transit encryption-as-a-service.
- Additional auth methods: AppRole, OIDC, AWS IAM, JWT, LDAP.
- Promotion of `gcp_secret_manager` from `coming_soon` to a real
  provider — its own spec.
- An External Secrets Operator (ESO) bridge provider.
- Multi-key Vault payloads (currently the payload is `{ "value": "..." }`;
  Vault KV v2 supports arbitrary maps, but Paperclip's binding model is
  one-key-per-secret today).
- `listRemoteSecrets` for the vault provider (the optional method on
  `SecretProviderModule` that powers the "Import from Vault" UI dialog).
  The AWS provider implements it; the Vault provider does not at M1. The
  dialog already handles "not supported" gracefully by hiding the
  vault-provider import option. Adding it later requires a recursive
  `LIST /v1/<mount>/metadata/<prefix>` walk and is a small follow-up.
