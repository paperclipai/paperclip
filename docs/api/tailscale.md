---
title: Tailscale Connections
summary: Connect a company tailnet and select its machines in SSH environments
---

These endpoints require a board operator with instance-admin rights and access
to the company. Local implicit board access is also accepted. Agent credentials
cannot manage a Tailscale connection. Browser mutations require a trusted Origin.

| Method | Path | Result |
|--------|------|--------|
| GET | `/api/companies/{companyId}/tailscale-connections` | Connection metadata |
| POST | `/api/companies/{companyId}/tailscale-connections` | Authorization URL |
| GET | `/api/companies/{companyId}/tailscale-connections/{connectionId}/devices` | Available machines |
| POST | `/api/companies/{companyId}/tailscale-connections/{connectionId}/pairing` | Public SSH pairing command |
| DELETE | `/api/companies/{companyId}/tailscale-connections/{connectionId}` | Disconnected connection metadata |

A connection response contains only `id`, `companyId`, `name`, and `status`.
Status is `pending`, `connecting`, `connected`, or `disconnected`. Responses do
not include enrollment tokens, persisted node state, or OAuth state digests.

To start consent, POST a JSON object with optional `name` and `connectionId`.
The name defaults to `My tailnet`. An existing connection ID starts a new
authorization for that connection. The `201` response contains `authorizationUrl`
and `expiresAt`. It also contains `connection` when consent can start immediately.
An instance without Cloud enrollment first returns the enrollment URL. Hosted
consent can include a `handoff` with `kind: "paperclip_cloud"` and an opaque
`session`. Use the normal browser connector flow for that signed handoff.

Machine discovery returns `id`, `name`, `hostname`, `address`, `os`, and `online`
for each peer. Use the stable `id` when configuring a Tailscale-backed SSH
environment. The current address is resolved again for execution.

To prepare pairing, POST `{ "deviceId": "<stable-device-id>", "port": 22 }`.
The port defaults to 22. The response contains `privateKeySecretId`, `publicKey`,
and `command`. Each preparation generates a fresh key pair. Run the command as
the target SSH user and configure the environment with the returned secret ID.
The private key never appears in this response.

The browser returns from consent to
`GET /api/tools/oauth/tailscale/callback` with required `state` and either
`claim_id` or an authorization `error`. The callback rechecks the initiating
operator's company access and consumes state once. On success it returns a
`303` redirect to the company's connector page with `Cache-Control: no-store`
and `Referrer-Policy: no-referrer`.

Disconnect invalidates both pending consent and callbacks already completing.
It stops the private network client and keeps the connection record. It does
not remove the target computer from Tailscale. A later authorization can replace
the saved connection; older callbacks cannot replace that newer authorization.
