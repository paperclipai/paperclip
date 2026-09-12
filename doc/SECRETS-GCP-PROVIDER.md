# Google Secret Manager provider

Paperclip can link and resolve existing **global** Google Secret Manager secrets.
The provider uses the server's Application Default Credentials (ADC). It supports
UTF-8 secret values up to Google's 64 KiB payload limit and verifies the returned
CRC32C checksum before returning a value.

This implementation does not create, update, list, disable or delete Google
secrets. Manage remote values and IAM in Google Cloud. Removing a Paperclip
reference only changes Paperclip metadata.

## Configure a provider vault

Create a company provider vault with non-sensitive routing metadata:

```json
{
  "provider": "gcp_secret_manager",
  "displayName": "Production Google secrets",
  "status": "ready",
  "config": {
    "projectId": "example-project",
    "location": "global",
    "secretNamePrefix": "app-"
  }
}
```

`projectId` accepts a Google project ID or number and is required for resolution.
`location` can be omitted or `global`; regional resources are not supported.
`secretNamePrefix` is optional and restricts the names this vault can resolve.
Legacy `namespace` metadata is informational only; it is not an access boundary.
No credentials, credential file paths or access tokens belong in this JSON.

A deployment default can instead use `PAPERCLIP_SECRETS_GCP_PROJECT_ID`. An
explicitly selected vault never falls back to the deployment project. Reference
project identifiers must exactly match the configured ID or number. Google may
return the equivalent numeric project number in its response; Paperclip retains
the configured identifier in its stored reference.

New GCP vaults default to `ready`. Existing vaults explicitly saved as
`coming_soon` remain locked until an operator changes their status. A health check
validates routing metadata only and reports credentials/access as unverified;
it does not read a secret or claim an IAM check succeeded.

## Credentials and permissions

The supported Google authentication library discovers ADC from deployment
configuration, a local ADC file or an attached workload identity. ADC and the
credentials used by an ordinary `gcloud` command are distinct. A Windows ADC file
is not automatically discovered by a Linux server. Operators can set
`GOOGLE_APPLICATION_CREDENTIALS` to an existing, trusted ADC configuration file
that the server can read; its path belongs in deployment configuration, not the
company provider vault.

For local development without existing ADC, Google supports
`gcloud auth application-default login`. This is a separate sign-in step. For
hosted use, prefer workload identity configured by the deployment operator.
Paperclip does not run login commands, change IAM, enable APIs or create service
accounts.

The server identity needs `secretmanager.versions.access` on each intended
secret, normally through Secret Manager Secret Accessor (`roles/secretmanager.secretAccessor`).
Scope that permission to the necessary secrets. The provider does not need
permissions to list secrets or write versions. User ADC may additionally need
the quota-project permissions required by Google; a signed-in CLI alone does not
prove any of these permissions.

## Link and resolve

Use the existing company secret create API in external-reference mode:

```json
{
  "name": "Application credential",
  "provider": "gcp_secret_manager",
  "managedMode": "external_reference",
  "providerConfigId": "<company-provider-vault-id>",
  "externalRef": "projects/example-project/secrets/app-credential",
  "providerVersionRef": "7"
}
```

The reference can also include `/versions/7`. If both selectors are supplied,
they must agree. An omitted selector or `latest` resolves the latest Google
version **at link time**. Linking reads that version once to verify access and
integrity, then pins the returned numeric version. The stored material contains
the resource reference, version and fingerprint, never the payload.

Subsequent resolutions read the pinned Google version. To adopt a later remote
rotation, use Paperclip's change-reference action with the new version or
`latest`; Paperclip creates a new local version record. A Google version that is
disabled or destroyed causes resolution to fail. Legacy metadata-only GCP links
with no version selector continue to follow `latest` until relinked.

Calls use Google's fixed HTTPS access endpoint, bounded request timeouts and no
HTTP redirects. Malformed responses, payload integrity failures and provider or
authentication errors fail closed. Returned errors contain fixed explanations
and error codes; raw response bodies, credentials and exception causes are not
retained in them.

## Where the boundary ends

Company scoping, binding checks, access auditing and run-log redaction remain in
Paperclip's existing secret service. Resolving a reference on the server avoids
storing plaintext values in the provider material; it does not make values
unreadable to their consumers.

An environment binding injects the resolved value into the agent process.
Paperclip also already exposes `POST /api/agents/me/secrets/:key/value`, which
returns a raw value to a suitably authorised agent with an active run and a
granted secret binding. This provider does not add or bypass that API. An agent
that receives a value can read, log or transmit it. Unrestricted agents running
under the server's operating-system user may also access its ADC files or other
process resources. Strong isolation requires separate operating-system
identities or sandboxes and appropriately scoped Google IAM.

Back up Paperclip's database to preserve vaults, references, bindings and pinned
version records. The values remain in Google Secret Manager; a restore also
requires access to those same remote versions.

## References

- [Google Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)
- [AccessSecretVersion REST contract and required permission](https://cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets.versions/access)
- [Secret payload encoding and integrity checksum](https://cloud.google.com/secret-manager/docs/reference/rest/v1/SecretPayload)
- [Google Auth Library for Node.js](https://github.com/googleapis/google-cloud-node-core/tree/main/packages/google-auth-library)
