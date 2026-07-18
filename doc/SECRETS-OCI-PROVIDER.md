# OCI Vault Provider

Operational contract for the `oci_vault` secret provider — a read / external-reference
provider backed by [Oracle Cloud Infrastructure (OCI) Vault](https://docs.oracle.com/iaas/Content/KeyManagement/Concepts/keyoverview.htm).

## Scope

- Resolves secret values that were provisioned in an OCI Vault **out-of-band** (Terraform, the
  OCI console/CLI, or another pipeline). The source of truth for values is OCI Vault, not Postgres.
- Paperclip stores only an **opaque external reference** (the OCI secret name or OCID) plus a
  fingerprint, version selector, ownership, and binding metadata — never the plaintext value.
- This provider is **external-reference only**: it does not create, rotate, or delete
  Paperclip-managed secret values. Rotate secrets in OCI Vault and the linked reference resolves
  the current version automatically. (`supportsManagedValues: false`, `requiresExternalRef: true`.)
- Values are fetched at **dispatch time** through the OCI Secret Retrieval API and injected into
  the per-run environment; they are never written to `local_encrypted` storage.

## Bootstrap Trust Model

Like the AWS provider, the OCI provider has a chicken-and-egg boundary: Paperclip cannot use
`company_secrets` to unlock the OCI credentials that read those secrets. The OCI trust must exist
before the Paperclip server starts.

Allowed bootstrap locations (the OCI credential model):

- **Instance principals** (recommended for hosted deployments): the Paperclip server's compute
  instance is a member of a dynamic group granted `read secret-family` on the target vault.
- **Resource principals** (OKE workload identity / functions).
- A local **`~/.oci/config` profile** — development only.

Do not paste OCI private keys, API signing keys, or auth tokens into the Paperclip board UI, and do
not store those bootstrap credentials in `company_secrets`. Provider vault config carries only
non-sensitive routing metadata (region, vault OCID, compartment OCID, secret-name prefix).

## Configuration

The provider reads non-secret configuration from the process environment, or per-company from a
provider vault config (`Company Settings → Secrets → Provider vaults`). Runtime credential settings
(`PAPERCLIP_SECRETS_OCI_AUTH`, config-file path/profile) are always deployment-level environment.

### Required

| Env var | Provider-vault field | Description |
| --- | --- | --- |
| `PAPERCLIP_SECRETS_OCI_REGION` | `region` | OCI region id, e.g. `il-jerusalem-1`. |
| `PAPERCLIP_SECRETS_OCI_VAULT_ID` (or `…_VAULT_OCID`) | `vaultId` | OCID of the vault that holds the secrets. |

### Optional

| Env var | Provider-vault field | Description |
| --- | --- | --- |
| `PAPERCLIP_SECRETS_OCI_COMPARTMENT_ID` | `compartmentId` | Compartment OCID (metadata; future listing). |
| `PAPERCLIP_SECRETS_OCI_SECRET_NAME_PREFIX` | `secretNamePrefix` | Guardrail: only secret **names** under this prefix may be linked/resolved (e.g. `agent-`). OCID references bypass the name prefix since they are already vault-scoped. |
| `PAPERCLIP_SECRETS_OCI_AUTH` | — | `instance_principal` (default) or `config_file`. |
| `PAPERCLIP_SECRETS_OCI_CONFIG_FILE` | — | Path to the OCI config file for `config_file` auth (default `~/.oci/config`). |
| `PAPERCLIP_SECRETS_OCI_CONFIG_PROFILE` | — | Profile name within the OCI config file. |

Select the provider at runtime with `PAPERCLIP_SECRETS_PROVIDER=oci_vault`.

## External References

- The external reference is the OCI Vault **secret name** (unique within the vault), e.g.
  `agent-claude-oauth-token`. An OCID (`ocid1.vaultsecret…`) may also be used.
- The version selector (`providerVersionRef`) maps to OCI as follows: a positive integer selects a
  specific `versionNumber`; one of `CURRENT`/`PENDING`/`LATEST`/`PREVIOUS`/`DEPRECATED` selects a
  rotation `stage`; any other string is treated as a secret version name. The default is the
  `CURRENT` stage.
- OCI Vault returns secret content base64-encoded; the provider decodes it to the raw UTF-8 value
  before injecting it into the runtime environment.

## Bootstrap Steps

1. Create the vault and the secrets (`agent-…`) in OCI Vault via Terraform/console/CLI. Secret
   values live in OCI, encrypted with an OCI KMS key.
2. Grant the Paperclip server runtime identity read access, e.g. an IAM policy for the server's
   dynamic group: `Allow dynamic-group <dg> to read secret-family in compartment <c>` (optionally
   constrained `where target.secret.name =~ 'agent-*'`).
3. Configure the server runtime with the non-secret provider environment variables above and
   `PAPERCLIP_SECRETS_PROVIDER=oci_vault`.
4. Run the provider health endpoint / `paperclipai doctor` from the deployed runtime and confirm it
   reports the expected region, vault OCID, secret-name prefix, and credential source.
5. Link each pre-provisioned secret as an external reference and bind it to the target agent/env.

## Error Handling

Provider errors are normalized to the shared `SecretProviderClientError` taxonomy
(`access_denied` 403, `throttled` 429, `not_found` 404, `conflict` 409, `invalid_request` 422,
`provider_unavailable` 503, `provider_error` 502). Operator-facing messages are redacted; the raw
OCI message is preserved on `rawMessage` for server logs only. Note that OCI's ambiguous
`NotAuthorizedOrNotFound` is mapped to `access_denied` so operators check the dynamic-group policy
first (a missing read grant is the most common cause).

## Backup Guidance

- Back up Paperclip metadata separately from OCI Vault secrets.
- Restoring access requires the Paperclip database plus read access to the same OCI Vault and secret
  names. The provider stores no secret values, so a Paperclip backup never contains OCI plaintext.
