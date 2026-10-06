# Agent cryptographic identity

Each agent has one persistent Ed25519 keypair. New agents receive it in the
agent-creation transaction. Existing agents receive it when Paperclip prepares
their next managed run. Migration, startup, public API reads, and opening the
agent page do not provision existing agents. There is no backfill command.

## Storage

`agent_identity_keys` lives in the agent's home instance database, including a
hosted stack's database. Its agent primary key and composite company/agent
foreign key enforce one identity and company-consistent ownership. Deleting an
agent cascades to its identity. Creation locks the agent row inside a transaction,
so simultaneous first runs use the same stored pair.

Public keys use SPKI PEM and private keys use PKCS#8 PEM. `keyId` is `sha256:`
followed by the base64url SHA-256 digest of the public key's SPKI DER bytes.
Private material is encrypted using the existing `local_encrypted` provider and
stored separately from company secrets. The wrapping key is the stack's
`PAPERCLIP_SECRETS_MASTER_KEY` or the local instance's secrets master-key file.
The file is published atomically with mode `0600` on first use. No per-agent
Cloud secret or Cloud registry record is needed.

Decryption and public/private key validation happen before launch. A wrong
master key, corrupt ciphertext, or mismatched public key fails the run; none
causes automatic key replacement. Renames, model changes, pauses, resumes, and
restarts preserve the keypair.

## Managed runs

Paperclip supplies these server-owned environment variables:

```text
PAPERCLIP_AGENT_KEY_ID
PAPERCLIP_AGENT_PUBLIC_KEY
PAPERCLIP_AGENT_PRIVATE_KEY
```

The two key values are multiline PEM strings. Runtime-only adapter context and
native runner environment fields deliver them to managed processes. Configured
or inherited environment values cannot replace the assigned identity. Session
compatibility includes the public key ID, so an older warm process is replaced
before its next turn. Private values are excluded from invocation metadata and
execution configuration; output and failure diagnostics redact known private
material. The run-log redactor handles split stdout/stderr chunks independently.

Independently hosted HTTP and gateway agents, including Runner's API-hosted Claude Managed and AWS AgentCore providers, do not receive private keys in v1.
Their new agent records still get stored identities; their existing records stay
unprovisioned until a supported managed run.

An agent can sign using an ordinary cryptographic library, for example Node.js:

```js
import { sign } from "node:crypto";
const signature = sign(null, challengeBytes, process.env.PAPERCLIP_AGENT_PRIVATE_KEY);
```

This identity does not change Paperclip bearer-token authentication. There is no
signing API, private-key download endpoint, Git integration, rotation UI, or
external-key import. Agents possess their private keys. External consumers must
define their own authorization, expiry, and revocation rules.

## Public identity

`GET /api/agents/:id/identity` applies the existing agent-read access checks. It
returns `null` before provisioning, otherwise:

```ts
{ algorithm: "Ed25519", keyId: string, publicKeyPem: string, createdAt: string }
```

The agent's Identity section shows a shortened fingerprint and copies the full
public PEM. Before provisioning it shows “Not created yet” and explains that
creation happens on the next managed run.

## Copies and recovery

Company/template imports and duplication use normal agent creation and get new
identities. Minimal and full development seeds omit identity **rows**, while
retaining the schema, even with live-work preservation. Those copied agents get
fresh identities on their next managed runs.

Ordinary disaster-recovery backups include encrypted identities. Recovery needs
both the database and the matching wrapping key; back up the key separately.
Do not use a disaster-recovery backup as a development clone when agents should
have distinct identities.
