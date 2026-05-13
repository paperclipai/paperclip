# Vault Secret Provider (OpenBao / HashiCorp Vault)

Operational contract for the `vault` secret provider. The provider speaks the
Vault HTTP API and works against both OpenBao (MPL-2.0 Linux Foundation fork)
and HashiCorp Vault (BUSL-1.1). The Paperclip helm chart bundles OpenBao by
default; operators with an existing Vault deployment use the same provider
and point at their endpoint.

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
- Local development: `VAULT_TOKEN` env or `~/.vault-token` file.
- An orchestrator secret store that boots the server with `VAULT_TOKEN`.

Do not paste Vault tokens, AppRole role/secret-ids, or any other credential
into the board UI or vault config. The API rejects credential-shaped fields.

## Deployment Config

Required environment variables when the deployment default provider is
`vault`:

```sh
PAPERCLIP_SECRETS_PROVIDER=vault
PAPERCLIP_SECRETS_VAULT_ADDR=http://openbao.paperclip.svc:8200
PAPERCLIP_SECRETS_VAULT_AUTH_METHOD=kubernetes
PAPERCLIP_SECRETS_VAULT_K8S_ROLE=paperclip-server
```

Optional environment variables:

```sh
PAPERCLIP_SECRETS_VAULT_NAMESPACE=                      # Vault Enterprise only
PAPERCLIP_SECRETS_VAULT_KV_MOUNT=secret
PAPERCLIP_SECRETS_VAULT_KV_PATH_PREFIX=paperclip
PAPERCLIP_SECRETS_VAULT_VERSION_RETENTION=10
PAPERCLIP_SECRETS_VAULT_SA_TOKEN_PATH=/var/run/secrets/kubernetes.io/serviceaccount/token
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

## Required Vault Policy

```hcl
path "<mount>/data/<prefix>/*"     { capabilities = ["create","read","update","delete"] }
path "<mount>/delete/<prefix>/*"   { capabilities = ["update"] }
path "<mount>/undelete/<prefix>/*" { capabilities = ["update"] }
path "<mount>/metadata/<prefix>/*" { capabilities = ["read","list","update","delete"] }

# External references read-only
path "<mount>/data/+/*"            { capabilities = ["read"] }
```

The default policy intentionally omits `destroy`. Hard-destroy is only
reachable through `paperclipai secrets doctor --destroy <id> --confirm`,
which requires a separately-attached emergency policy.

## Helm Chart (OpenBao Bundled)

The Paperclip helm chart bundles OpenBao via dependency and pre-configures
the Kubernetes auth method, the policy above, and the KV mount through a
post-install Job. See `docs/deploy/secrets.md` for chart values, unseal
options, and operator runbooks.

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

- **Token rotation:** the provider renews the Vault token proactively at
  70% of TTL and re-logs-in on 403. Operators do not rotate tokens
  manually; rotation happens automatically.
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
