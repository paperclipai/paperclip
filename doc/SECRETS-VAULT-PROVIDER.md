# Vault Secret Provider (OpenBao / HashiCorp Vault)

Operational contract for the `vault` secret provider. The provider speaks the
Vault HTTP API and works against both OpenBao (MPL-2.0 Linux Foundation fork)
and HashiCorp Vault (BUSL-1.1). The provider assumes only a reachable
KV v2 endpoint and an auth source (kubernetes token or a
`VAULT_TOKEN`/token-file); operators with an existing Vault deployment point
at their endpoint. The provider does not assume a Helm chart, a specific
unseal method, or a particular topology.

## Scope

- Hosted provider for Paperclip-managed secrets when Paperclip runs on
  Kubernetes (or any environment where Vault/OpenBao is reachable).
- Source of truth for secret values is the Vault KV v2 engine, not Postgres.
- Paperclip stores only metadata needed for ownership, bindings, version
  selection, audit, and runtime resolution.
- Provider bootstrap credentials are deployment/runtime credentials, not
  Paperclip-managed company secrets.

## Bootstrap Trust Model

Paperclip authenticates to Vault using **workload identity**. Allowed
bootstrap paths:

- In-cluster: Paperclip server pod's ServiceAccount JWT, validated by Vault
  through the Kubernetes auth method's `TokenReview` call.
- Local development: the `VAULT_TOKEN` env, or a token file (e.g. `~/.vault-token`) selected via `PAPERCLIP_SECRETS_VAULT_TOKEN_FILE`.
- An orchestrator secret store that boots the server with `VAULT_TOKEN`.

Do not paste Vault tokens, AppRole role/secret-ids, or any other credential
into the board UI or vault config. The API rejects credential-shaped fields.

## Deployment Config

The provider is **orchestrator-agnostic** — it works against any HashiCorp
Vault or OpenBao (same KV-v2 API) whether workloads run in Kubernetes, Nomad,
Docker, or as bare processes. It makes no assumption about Kubernetes
ServiceAccounts, a specific Helm chart, or Nomad Vault workload identity; those
are just common ways to reach a Vault.

Connect to a Vault. The server uses `PAPERCLIP_SECRETS_VAULT_ADDR` when set,
otherwise falls back to the standard `VAULT_ADDR` (which Nomad's Vault agent,
Docker, and most tooling already set for you):

```sh
PAPERCLIP_SECRETS_PROVIDER=vault
# Address — one of these (PAPERCLIP_* wins):
PAPERCLIP_SECRETS_VAULT_ADDR=http://vault.example.svc:8200
# ...or rely on the standard VAULT_ADDR already in the environment

# Auth — pick ONE of the three (see below):
PAPERCLIP_SECRETS_VAULT_AUTH_METHOD=kubernetes
PAPERCLIP_SECRETS_VAULT_K8S_ROLE=paperclip-server   # (a) k8s ServiceAccount
# VAULT_TOKEN=<token>                              # (b) static token via env
# PAPERCLIP_SECRETS_VAULT_TOKEN_FILE=/run/vault/token   # (c) agent-rotated token file
```

A per-vault config may also carry an `address`, but the endpoint is
**operator-pinned**: the operator-deployed address (env) always wins. A
company vault config can restate the operator address, and — only when the
operator has set neither `PAPERCLIP_SECRETS_VAULT_ADDR` nor `VAULT_ADDR` —
supply one of its own **if the operator has explicitly opted in** with
`PAPERCLIP_SECRETS_VAULT_ALLOW_CONFIG_ADDR=1`. Without that opt-in, a
per-vault address is ignored and surfaced as a config warning, so a company
writer cannot use it to redirect the deployment's Vault credential
(`VAULT_TOKEN`, the k8s SA token, or the token file) to an endpoint they
choose. A per-vault address that differs from the operator address is
ignored and surfaced as a config warning.

**Auth options (pick one):**
- **(a) Kubernetes ServiceAccount** — `auth.method = kubernetes` + `role`. The
  SA token is read from `PAPERCLIP_SECRETS_VAULT_SA_TOKEN_PATH` (default the
  in-cluster path) and re-read on rotation.
- **(b) Token via env** — the standard `VAULT_TOKEN`. Convenient for local dev
  and `docker run`.
- **(c) Token file** — `PAPERCLIP_SECRETS_VAULT_TOKEN_FILE`. The token is
  re-read on every use, so an agent (e.g. Nomad's Vault agent) can rotate it in
  place with no env change or restart.

Optional environment variables:

```sh
PAPERCLIP_SECRETS_VAULT_NAMESPACE=                      # Vault Enterprise only
PAPERCLIP_SECRETS_VAULT_KV_MOUNT=secret
PAPERCLIP_SECRETS_VAULT_KV_PATH_PREFIX=paperclip
PAPERCLIP_SECRETS_VAULT_VERSION_RETENTION=10
PAPERCLIP_SECRETS_VAULT_SA_TOKEN_PATH=/var/run/secrets/kubernetes.io/serviceaccount/token
PAPERCLIP_SECRETS_VAULT_TOKEN_FILE=                  # token-file auth (option c above)
```

Local development:

```sh
PAPERCLIP_SECRETS_PROVIDER=local_encrypted  # default stays local
# To exercise the vault provider locally:
VAULT_ADDR=http://127.0.0.1:8200
VAULT_TOKEN=<dev-root-or-period-token>
PAPERCLIP_SECRETS_VAULT_AUTH_METHOD=token
```

## KV Path and Tag Convention

```text
<kvMount>/data/<kvPathPrefix>/<deploymentId>/<companyId>/<secretKey>
```

KV payload is `{ "value": "<plaintext>" }`. KV v2's native version counter
is the version source of truth; `max_versions` (per vault config
`versionRetention`) enforces retention server-side.

## Security hardening

- **Create is idempotent under a lost response.** `createSecret` writes with
  `cas: 0` (create-only). If a response is lost and the client retries, the
  second write hits a CAS conflict, the provider re-reads the existing version
  instead of writing a second one, and the returned `version` matches what is
  actually stored. This keeps the managed write version-aligned with
  `createVersion`, which relies on `cas = next-1`. A genuine `400` from
  create (the entry was not actually written) is rethrown, not swallowed.
- **No path traversal in managed paths.** The KV path is
  `<kvPathPrefix>/<deploymentId>/<companyId>/<secretKey>`. `secretKey` is
  restricted to `[A-Za-z0-9_.-]`, and `buildManagedKvPath` rejects any `.` or
  `..` segment, so a key named `..` cannot collapse the path out of the
  managed prefix. `kvPathPrefix` is likewise rejected when it starts or ends
  with `/`, contains `//`, or has a `.`/`..` segment.
- **`createVersion` rotates managed references only.** When reusing a stored
  `externalRef` to rotate in place, the provider verifies the reference stays in
  `kvMount` under `kvPathPrefix`. An `external_reference` secret (whose value
  lives on an external path) is rejected here rather than rotated with the
  provider token — those route through `linkExternalSecret` / `updateExternalSecretValue`.
- **`saTokenPath` is operator-pinned like the address.** The `saTokenPath`
  (the file read and sent as the kubernetes login JWT) is an
  information-disclosure primitive: an operator may pin it via
  `PAPERCLIP_SECRETS_VAULT_SA_TOKEN_PATH`, but a per-vault company config may
  only set a custom path when the operator has set no pin **and** has opted
  in with `PAPERCLIP_SECRETS_VAULT_ALLOW_CONFIG_ADDR=1` (the same flag that
  gates the address). Without the opt-in a config `saTokenPath` is ignored
  and surfaced as a warning, defaulting to the in-cluster path; a value
  differing from an operator pin is overridden and warned.
- **Network/timeout failures are typed.** `HttpVaultGateway` wraps connect
  and `AbortSignal.timeout` failures in a `SecretProviderClientError` with
  `code: provider_unavailable`, so a hung or unreachable Vault surfaces as a
  provider-unavailable error (and drives the same retry/health logic as a
  `5xx`) rather than an opaque fetch rejection.

## Required Vault Policy

```hcl
path "<mount>/data/<prefix>/*"     { capabilities = ["create","read","update","delete"] }
path "<mount>/delete/<prefix>/*"   { capabilities = ["update"] }
path "<mount>/undelete/<prefix>/*" { capabilities = ["update"] }
path "<mount>/metadata/<prefix>/*" { capabilities = ["read","list","update","delete"] }

# External references read-only
path "<mount>/data/+/*"            { capabilities = ["read"] }
```

The default policy intentionally omits `destroy`. Hard-destroy (which
overwrites previous KV versions instead of retaining them) is only reachable
by explicitly granting the `destroy` capability on the managed prefix, which
the default policy does not — so a separate, separately-attached emergency
policy is required to perform a hard-destroy.

## OpenBao / Vault

Paperclip speaks to any Vault-compatible KV v2 endpoint (HashiCorp Vault or
OpenBao). The provider does not assume a Helm chart, a specific unseal
method, or a particular topology: bring your own Vault/OpenBao, point
`PAPERCLIP_SECRETS_VAULT_ADDR` (or `VAULT_ADDR`) at it, and attach the policy
and KV mount above. See `docs/deploy/secrets.md` for the full operator
runbook (unseal, backup, incident response).

## Health Checks

`POST /api/secret-provider-configs/{id}/health` runs four probes:

1. **Reachability** — `GET /v1/sys/health`; reports sealed/standby/version.
2. **Auth** — k8s login (returns role + token TTL) or `lookup-self` (token
   mode).
3. **KV engine** — `GET /v1/sys/mounts/<mount>`; confirms `options.version
   == "2"`. KV v1 is rejected with a clear message.
4. **Capabilities** — `POST /v1/sys/capabilities-self` against the managed
   prefix; lists missing capabilities by name.

Responses never include the Vault token, lease ids, or policy contents.

## Backup, Rotation, Incident Runbooks

- **Token rotation (k8s auth only):** in `kubernetes` auth mode the provider
  renews the login token proactively at 70% of its TTL and re-logs-in on a
  403, re-reading the projected SA token file on each login so on-disk SA
  token rotation is picked up automatically. In token-file mode
  (`PAPERCLIP_SECRETS_VAULT_TOKEN_FILE`) the file is re-read on every
  operation, so an orchestrator (e.g. a Nomad Vault agent) rotates the token
  in place with no restart. In plain `VAULT_TOKEN` env mode the token is used
  as-is; rotate it by updating the env or switching to a token file.
- **Unseal:** an unsealed Vault returns `sealed=true` from `sys/health` and
  the provider health check reports `warning`. Restart unseals via the
  configured auto-unseal mechanism (transit/awskms/gcpckms/...), or perform
  a manual unseal per the OpenBao/Vault operator docs.
- **Backup:** Vault/OpenBao manages its own storage backend (Raft, Consul,
  etc.). Paperclip's database does not contain plaintext values from this
  provider. Restore both consistently.
- **Incident — leaked Vault token:** revoke the token in Vault
  (`vault token revoke`), confirm the next `acquire()` re-logs-in, and
  audit `sys/audit` logs for the leaked token's footprint.
