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
| POST | `/api/companies/{companyId}/tailscale-connections` | Start device sign-in |
| POST | `/api/companies/{companyId}/tailscale-connections/{connectionId}/device-login` | Resume device sign-in and read progress |
| GET | `/api/companies/{companyId}/tailscale-connections/{connectionId}/devices` | Available machines |
| POST | `/api/companies/{companyId}/tailscale-connections/{connectionId}/pairing` | Public SSH pairing command |
| DELETE | `/api/companies/{companyId}/tailscale-connections/{connectionId}` | Disconnected connection metadata |

A connection response contains only `id`, `companyId`, `name`, and `status`.
Status is `pending`, `authorizing`, `connecting`, `connected`, `disconnected`,
`expired`, or `error`. Responses do not include enrollment tokens, persisted
node state, or OAuth state digests.

To start device sign-in, POST a JSON object with optional `name` and
`connectionId`. The name defaults to `My tailnet`. No OAuth app, Cloud broker
enrollment, or pasted auth key is required. An existing connection ID resumes an
unexpired sign-in or starts a new attempt. Disconnect a connected network before
replacing it. Pending sign-in is bound to the initiating user and expires after
ten minutes; progress requests do not extend that deadline.

The `201` response contains `connection` and `expiresAt`, plus `authorizationUrl`
when the sign-in link is ready. Open that link so the user can approve the
Paperclip device in their tailnet. `needsApproval: true` means a tailnet
administrator must approve the device. `expiresAt` is null when no sign-in is
pending. No Cloud handoff is returned.

POST to `/{connectionId}/device-login` under the connections path to resume the
private client and read progress. This endpoint takes no request body and
returns the same shape with status `200`. Only the user who started the sign-in
may continue it, with the same instance-admin and company access checks. Both
responses use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
Stop progress requests when the connection leaves `authorizing` or the deadline
passes. DELETE the connection to cancel a pending attempt.

Machine discovery returns `id`, `name`, `hostname`, `address`, `os`, and `online`
for each peer. Use the stable `id` when configuring a Tailscale-backed SSH
environment. The current address is resolved again for execution.

An SSH environment with `network: "tailscale"` requires `tailscaleConnectionId`
and `tailscaleDeviceId`. Saving binds the connector's current credential identity.
Raw enrollment keys and credential-only configurations are rejected. Runtime
access checks the connection again after loading the SSH key and after device
discovery; a disconnected or replaced connection requires fresh setup.

To prepare pairing, POST `{ "deviceId": "<stable-device-id>", "port": 22 }`.
The port defaults to 22. The response contains `privateKeySecretId`, `publicKey`,
and `command`. Each preparation generates a fresh key pair. Run the command as
the target SSH user and configure the environment with the returned secret ID.
The private key never appears in this response.

Pending legacy OAuth flows can still return to
`GET /api/tools/oauth/tailscale/callback` with required `state` and either
`claim_id` or an authorization `error`. The callback rechecks the initiating
operator's company access and consumes state once. On success it returns a
`303` redirect to the company's connector page with `Cache-Control: no-store`
and `Referrer-Policy: no-referrer`.

Disconnect invalidates both pending consent and callbacks already completing.
It stops the private network client and keeps the connection record. It does
not remove the target computer from Tailscale. A later authorization can replace
the saved connection; older callbacks cannot replace that newer authorization.
