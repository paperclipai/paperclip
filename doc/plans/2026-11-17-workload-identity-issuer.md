# Workload identity issuer: public signing keys for connections

Status: decided and built, 2026-11-17. Dotta chose one issuer per company and
a new table. The API is in [docs/api/workload-identity.md](../../docs/api/workload-identity.md).
Part of
[the AWS connector plan](./2026-11-17-aws-connector-and-minted-credentials.md)
(phase 1b).

## The message

Paperclip needs a signing key whose public half it publishes, so an outside
cloud (AWS first, later GCP or Azure) can verify "this request comes from
connection X of company Y on this Paperclip" without Paperclip storing any
cloud keys.

None of our existing keys can do this safely, so we add one new kind of key.
It follows the pattern agent identity keys already use:

- created lazily the first time it's needed,
- private half encrypted with the existing vault master key,
- stored in the database.

No instance has to run a migration script. The only migration is the normal
schema migration that ships with the release and creates an empty table.

## Existing keys, and why none can be reused

| Key | Where | Algorithm | Why not |
|---|---|---|---|
| Agent identity keys | `agent_identity_keys`, [agent-identity.ts](../../server/src/services/agent-identity.ts) | Ed25519, one per agent | AWS accepts only RS256/384/512 and ES256/384/512, not Ed25519. **The private key is also handed to the agent's run** (that's why the run-output redactor exists), so an agent could mint AWS access itself and skip gateway policy. Disqualifying. |
| Agent run JWTs | [agent-auth-jwt.ts](../../server/src/agent-auth-jwt.ts) | HS256, derived from `PAPERCLIP_AGENT_JWT_SECRET` | Symmetric: publishing the verification key would publish the ability to sign. |
| Machine sign-in keys (MCP client credentials) | vault, per connection, `generateClientKeyPair` | RS256 / ES256 | Right algorithm, wrong purpose: each authenticates one connection to one provider's token endpoint. Using one key for two purposes invites token confusion. **The code is reusable**: key generation, JWK export, key IDs. |
| Cloud runtime identity, Cloud connector keys | Cloud Harness | Ed25519 | Held by Paperclip Cloud, not the instance, and absent on self-hosted. |
| Vault master key | `PAPERCLIP_SECRETS_MASTER_KEY` or key file | 32-byte symmetric | Not publishable. **It is the root that protects the new key.** Cloud already keeps it stable per stack across release rolls. |

## Design

### 1. One issuer per company (recommended)

Issuer URL: `https://<instance public origin>/oidc/companies/<companyId>`

AWS allows a path in the issuer URL. A per-company issuer, rather than one
for the whole instance, matters for two reasons:

- **Misconfiguration blast radius.** The classic OIDC mistake (well known from
  GitHub Actions) is a role trust policy that checks the issuer but forgets to
  check `sub`. With a per-instance issuer, that mistake would let *any
  company* on a shared instance assume the customer's role. With a
  per-company issuer, the worst case is another connection in the customer's
  own company.
- **It fits the company-scoping rule.** Keys are company-scoped entities, so
  no new instance-wide exception is needed.

**This choice is effectively permanent.** Changing the issuer later breaks
every customer trust, so it has to be decided before the first release.

### 2. Keys

- **Algorithm: ES256 (P-256).** AWS, GCP and Azure accept it, and signing is
  fast and the keys are small. RS256 is the fallback if a later provider needs
  it; the table records the algorithm per key.
- **New table `company_workload_identity_keys`.** Fields: `company_id`,
  `key_id` (SHA-256 fingerprint, the same scheme agent keys use), `algorithm`,
  `public_jwk`, `private_key_material` (encrypted by `localEncryptedProvider`),
  `status` (`next`, `active`, `retiring` or `retired`), `created_at`,
  `status_changed_at`. Partial unique indexes allow one `active` key and one
  `next` key per company. A `retiring` key stays published for 24 hours after
  it stops signing. This is computed when keys are read, so no background job
  is needed.
- **Lazy creation.** The first time a connection in the company needs a token
  (in practice, at AWS role setup), the server creates the key with
  insert-on-conflict-do-nothing, then reads it back. Two processes racing end
  up with the same key. Companies that never use federation never get a key.
- **No backfill and no script.** A new release only adds the empty table.
- **In memory:** the decrypted private key is cached per process. Signing a
  JWT takes well under a millisecond.

### 3. Public endpoints

| Route | Returns |
|---|---|
| `GET /oidc/companies/:companyId/.well-known/openid-configuration` | `issuer`, `jwks_uri`, `id_token_signing_alg_values_supported: ["ES256"]`, `response_types_supported: ["id_token"]`, `subject_types_supported: ["public"]`, `claims_supported` |
| `GET /oidc/companies/:companyId/jwks.json` | Public keys with status `active` or `next` |

- Both routes are unauthenticated, because AWS must fetch them anonymously.
- Both return **404 until the company has a key**, so they reveal nothing
  about companies that don't use federation. Company IDs are random UUIDs.
- `Cache-Control: public, max-age=300`.
- **Enforced by a test:** the JWKS never contains private parameters (`d`,
  and so on). AWS rejects the whole key set if one appears and treats the key
  as compromised.
- Only served when the instance has a public HTTPS origin (Cloud, or
  `authenticated` + `public` with `PAPERCLIP_PUBLIC_URL`). Elsewhere the setup
  screen offers only the access-key method.

### 4. Tokens

```json
{
  "iss": "https://<origin>/oidc/companies/<companyId>",
  "sub": "connection:<connectionId>",
  "aud": "sts.amazonaws.com",
  "iat": 0, "nbf": 0, "exp": 300, "jti": "<uuid>"
}
```

- **Lifetime: 5 minutes.** Each token is used once, immediately, for
  `AssumeRoleWithWebIdentity`.
- **Only the credential minter in the gateway can request a token.** There is
  no API that signs arbitrary claims, and agents never see these tokens.
- `sub` and `aud` come from the connection and its method, never from caller
  input.
- Each issuance writes a tool-access audit event (connection and key ID, never
  the token).
- **The issuer is fixed per connection.** It is stored when the connection is
  set up. If the instance's public origin later changes, the connection shows
  a health warning ("This instance's address changed. Update the identity
  provider in AWS.") instead of silently signing for a new issuer.

### 5. Rotation

- **Planned rotation.** Create a `next` key, published alongside `active`.
  After at least 24 hours (AWS caches key sets and doesn't publish how long),
  switch signing to it, keep the old key published for another 24 hours, then
  retire it. v1 offers this as an admin action; automatic yearly rotation can
  come later.
- **Emergency rotation** (key believed exposed): retire immediately and
  publish only the new key. Calls fail for at most the AWS cache window, and
  the connection health message says so. Per AWS's guidance, the customer can
  also revoke active role sessions.
- **Master key rotation is not supported yet.** No step re-encrypts vault
  material when the master key changes, and that includes these rows and
  `agent_identity_keys`. Replacing the master key makes the stored signing
  keys unreadable, so signing fails closed. Operators must keep the original
  master key; Cloud already keeps it stable per stack across release rolls.
  Future work: a master-key re-encryption step that covers these rows. It
  would keep the signing key itself, so customer trust would be unaffected.
- AWS allows at most 100 EC keys per key set. One active key plus one next key
  per company is far below that.

### 6. Threats and limits

- **Holding the database plus the master key** lets someone sign as any
  company on that instance, toward roles that already trust that company's
  issuer and connection subject. That's the same exposure as today's vault
  secrets, including stored AWS access keys under method 2, so it adds no new
  class of risk.
- **Worktrees and forks** often copy the master key. Worktree seeding leaves
  out `company_workload_identity_keys` in both the minimal and full modes, as
  it already does for `agent_identity_keys`, so a development copy never holds
  production's signing key. As a further guard, the signer refuses to sign
  when the instance's current public origin doesn't match the issuer recorded
  on the connection.
- **Not considered and rejected: deriving the key from the master key** (no
  table at all). It would remove the schema migration, but then **anyone with
  the master key alone could sign as production**. Master keys are copied into
  worktree environments by design, and the agent JWT code carries an incident
  note about exactly this. A rotated master key would also silently change the
  signing key and break every customer's trust.

### 7. Reuse beyond AWS

The issuer is provider-neutral. Only `aud` and the minter differ:

- GCP Workload Identity Federation accepts OIDC tokens from external issuers.
- Azure accepts federated credentials from external OIDC issuers.

Each needs its own check before we claim support.

## Delivery (one PR)

1. Schema: `company_workload_identity_keys`, generated through the normal
   `pnpm db:generate` flow.
2. Service: `ensureCompanySigningKey`, `signConnectionToken`, rotation
   operations and the in-memory cache. This reuses the JWK and key-ID code
   from `generateClientKeyPair`.
3. Routes: discovery and JWKS (public), plus admin rotate actions (board
   only, written to the activity log).
4. Red/green tests:
   - 404 before a key exists.
   - Racing lazy creation produces one key.
   - The JWKS has no private parameters.
   - A token verifies against the published key.
   - Signing is refused when the origin doesn't match.
   - Rotation publishes two keys, then one.
   - No token appears in audit records or logs.
5. Real proof: from a staging instance, AWS
   `AssumeRoleWithWebIdentity` succeeds for a role that trusts the company
   issuer and connection subject. It fails for a different connection's
   subject and for another company's issuer.

## Decisions (made 2026-11-17)

1. **One issuer per company**, at `https://<instance>/oidc/companies/<companyId>`.
2. **A new table through the normal release migration**, not a key derived
   from the master key. A derived key would let the master key alone sign as
   production.
