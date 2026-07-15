# Linear evidence transport deployment companion

This private workspace package is the credential-bearing implementation of
Paperclip's `LinearEvidenceTransport` port. It is intentionally separate from
Paperclip core and has no database dependency.

The companion:

- accepts only a SecretRef plus an injected deployment-owned resolver;
- resolves the credential immediately before each Linear GraphQL request;
- uses the fixed `https://api.linear.app/graphql` origin;
- exposes only comment lookup, comment creation, and concrete comment readback;
- scans the complete bounded comment history before concluding a marker is
  absent and rejects duplicate markers;
- treats lost mutation responses as ambiguous so the connector reconciles by
  marker before retrying; and
- drops resolver, network, HTTP, and GraphQL messages from its public errors;
  remote request IDs and GraphQL extension codes are always represented only
  as `[redacted]`.

It does not create, persist, rotate, log, or return credentials. It also does
not configure Paperclip automatically. Deployment composition must explicitly
provide a resolver and inject the resulting transport into
`linearEvidenceConnector(db, transport)`, then inject that connector as
`createApp(..., { linearEvidenceBridge: connector })`.

```ts
const transport = createLinearEvidenceTransport({
  authorizationSecretRef: { type: "secret_ref", secretId: configuredCompanySecretUuid, version: "latest" },
  secretResolver: deploymentSecretResolver,
});
const bridge = linearEvidenceConnector(db, transport);
const app = createApp(db, { linearEvidenceBridge: bridge });
```

The deployment owner must approve and supply a least-privilege Linear
credential that can read issues/comments and create comments only for the
intended workspace. Until that explicit deployment wiring and independent live
acceptance occur, the connector remains fail-closed and is not release-ready.

The transport applies a strict positive schema to its configuration and
SecretRef. `secretId` must be a canonical company-secret UUID accepted by the
Paperclip shared UUID/reference schema; opaque strings and credential-shaped
values are rejected. Options, the resolver port, and the nested SecretRef must
be plain own-data objects. Proxies, accessors, symbols, non-enumerable or
inherited fields, exotic prototypes, unknown fields, and every direct
credential field or casing/punctuation variant are rejected before secret
resolution or network access. Valid input is copied into fresh null-prototype,
frozen DTOs before the transport closure retains it.
