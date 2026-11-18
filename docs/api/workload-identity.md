---
title: Workload Identity
summary: Public signing keys that let outside clouds verify a company's connections
---

Each company can sign short-lived OIDC tokens that name one of its
connections. An outside cloud, such as AWS through `AssumeRoleWithWebIdentity`,
verifies them against the company's published public keys, so Paperclip never
stores that cloud's keys. Only the control plane signs. Agents never receive
these tokens.

## Public endpoints

These endpoints need no authentication, because the outside cloud fetches them
anonymously. They return only public keys.

| Method | Path | Result |
|--------|------|--------|
| GET | `/oidc/companies/{companyId}/.well-known/openid-configuration` | OIDC discovery document |
| GET | `/oidc/companies/{companyId}/jwks.json` | Public key set (`ES256`, P-256) |

Both return `404` until the company has a signing key. The discovery document
is also `404` unless the instance has a public HTTPS address with no port that
isn't a loopback host, because an outside cloud can't use any other issuer.
Responses are cacheable for five minutes.

The issuer is `https://{instance}/oidc/companies/{companyId}`. Tokens have
`sub` set to `connection:{connectionId}`, an `aud` chosen by the connection
type, and a lifetime of five minutes. Only an enabled, active connection can get a token,
so disabling a connection stops new tokens at once.

## Board endpoints

These require board access to the company. Agent credentials are rejected.

| Method | Path | Result |
|--------|------|--------|
| GET | `/api/companies/{companyId}/workload-identity` | Issuer (or why it is unavailable) and the published keys with their states |
| POST | `/api/companies/{companyId}/workload-identity/rotation` | Rotation step result and new state |

The rotation body is `{ "step": "begin" | "complete" | "emergency" }`:

- `begin` publishes a `next` key next to the active one. Repeating it while a
  rotation is pending changes nothing and writes no log entry. It answers `409`
  (`workload_identity_no_key`) when the company has no key yet.
- `complete` makes the `next` key sign once it has been published for 24 hours,
  and keeps the old key published for another 24 hours. Before that it
  answers `409` (`workload_identity_rotation_not_ready`) with `readyAt`.
- `emergency` stops publishing every current key and signs with a fresh one
  immediately. Use it when a key may be exposed.

Each step writes its activity log entry in the same transaction as the key
change. Responses never include private key
material.
