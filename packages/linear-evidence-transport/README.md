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
- drops resolver, network, HTTP, and GraphQL messages from its public errors.

It does not create, persist, rotate, log, or return credentials. It also does
not configure Paperclip automatically. Deployment composition must explicitly
provide a resolver and inject the resulting transport into
`linearEvidenceConnector(db, transport)`, then inject that connector as
`createApp(..., { linearEvidenceBridge: connector })`.

```ts
const transport = createLinearEvidenceTransport({
  authorizationSecretRef: { type: "secret_ref", secretId: configuredSecretId, version: "latest" },
  secretResolver: deploymentSecretResolver,
});
const bridge = linearEvidenceConnector(db, transport);
const app = createApp(db, { linearEvidenceBridge: bridge });
```

The deployment owner must approve and supply a least-privilege Linear
credential that can read issues/comments and create comments only for the
intended workspace. Until that explicit deployment wiring and independent live
acceptance occur, the connector remains fail-closed and is not release-ready.

Untyped secret identifiers and direct `authorization`, `apiKey`, or `token`
options are rejected before secret resolution or network access.
