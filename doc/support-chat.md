# Cloud Support Chat (Plain)

This document is the contract for the Plain support chat surface on Paperclip
Cloud: what enables it, which secrets it needs, how identity attestation
works, and how to roll it out and back. The integration is **Cloud-only and
opt-in**: an ordinary open-source/self-hosted installation loads no Plain code
and makes no third-party network request — its existing flag → Share feedback
entry point is untouched.

## How it works

- `GET /api/support-chat/session` (`server/src/routes/support-chat.ts`) is the
  single server-owned switch. It answers **404 `support_chat_disabled`**
  unless this instance is enabled (see gating below), and 401 without a
  signed-in board session.
- When enabled, the response carries the Plain Chat App id plus a narrow,
  server-attested customer identity: verified email, hex HMAC-SHA256
  `emailHash`, display name, and the Paperclip user id as Plain's
  `externalId`. Nothing else — no logs, task content, prompts, URLs, or other
  product context. The route reads no caller input, so a client cannot
  request a hash for another email.
- `SupportChatGate` (`ui/src/components/SupportChatGate.tsx`) asks that route
  once per signed-in account, and only then injects Plain's script
  (`https://chat.cdn-plain.com/index.js`) and calls the documented
  `Plain.init` with the identity block. The widget is Plain's native
  bottom-right launcher and chat panel; product theme is passed through
  Plain's documented `theme` option.
- The sidebar flag (`SidebarAccountMenu`) hides only while the Plain launcher
  is actually mounted and visible; a script or config failure keeps the flag
  as the discoverable fallback.

## Environment / secret bindings

| Variable | Sensitivity | Meaning |
| --- | --- | --- |
| `PLAIN_CHAT_APP_ID` | Public identifier | The Plain Chat App id (e.g. `liveChatApp_…`). Absent → support chat off everywhere. |
| `PLAIN_CHAT_EMAIL_HMAC_SECRET` | **Secret, bearer-grade** | Plain's chat authentication secret (Plain → Settings → Chat → the Chat App → Authentication). Holder can mint a chat identity for any email. Server-side env only: never in client bundles, issue comments, documents, or logs. Absent → the widget still mounts, but unauthenticated; Plain's own email OTP flow covers identity. |
| `PAPERCLIP_SUPPORT_CHAT_DEV_PREVIEW` | Dev-only switch | `1`/`true` enables the surface on a local development instance for product review. Ignored (fails closed) when `NODE_ENV=production` or when the instance is Cloud-managed. |

Gating (`server/src/services/support-chat.ts`): the surface is enabled when a
Chat App id is set **and** the instance is Cloud-managed per
`isCloudManagedInstance` (`PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN` or
`PAPERCLIP_MANAGED_CONFIG`), or the dev-preview opt-in applies. A production
build cannot enable the dev opt-in; tests pin this.

`emailHash` is issued only for a **verified** email (`authUsers.emailVerified`).
Cloud tenant identities arrive through trusted harness headers and are
upserted verified; self-hosted better-auth accounts must verify email before
the hash is attested.

### Where the secret should live on Cloud

The signing secret belongs in the Cloud provisioner's per-stack server env
(same trust boundary as `PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN`), sourced from
the Cloud secret store — not committed to any repo and not distributed
outside tenant server processes. All tenant stacks of one Plain workspace
share one Chat App and therefore one secret; rotation is: generate a new
secret in Plain → roll the env var across stacks → old hashes stop
authenticating on next widget init.

## Cloud rollout contract

Provisioning a new stack: inject `PLAIN_CHAT_APP_ID` (+
`PLAIN_CHAT_EMAIL_HMAC_SECRET` once generated) into the tenant server env.

Existing stacks: provisioning-code changes do not reconcile already-provisioned
tenants — rollout to existing stacks is an explicit env update + process
restart per stack, and should be staged (one canary stack → cohort → fleet).

Disable/rollback: remove `PLAIN_CHAT_APP_ID` (or just stop injecting it) and
restart — the route returns 404 again, browsers stop loading Plain code on
next page load, and the flag entry point returns automatically. No schema or
data migration is involved in either direction.

Separate test app: local/dev rehearsals use the dedicated
"Plain Chat App Paperclip Cloud — Local Test" Chat App and synthetic
identities, never the production Chat App or real customer emails.

## Vendor-side settings (Plain workspace, not this repo)

- Support identity: shared "Paperclip Support" queue; individual human
  responders; no AI persona, no auto-replies, no business hours or SLA
  display.
- Welcome copy (set in the Chat App settings): "Have a question or feedback
  about the Cloud beta? Leave the Paperclip team a message. Replies may not
  be immediate."
- When enabling verified chat, pair **Require authentication** with
  **Require email verification** in the Chat App settings; enabling only one
  weakens the identity story.
- Notifications: new thread / customer reply → the `#support-cloud` Slack
  channel. Email reply continuity requires a configured support email in
  Plain; until that exists, do not promise email follow-up.

## Known limits / open vendor questions

- Plain documents no widget teardown or identity-reset API (`Plain.close()`
  hides the panel; it is not a reset). The client therefore binds one chat
  identity per page lifetime: a second account signing in on the same
  document keeps the widget hidden (flag returns) until a full page load. On
  Cloud this is unreachable — tenant sign-out is a top-level navigation — so
  it only shows up in local dev previews.
- Open question for Plain support: what browser storage does the chat widget
  persist across page loads, and what is the supported way to clear it on
  sign-out from a shared machine?
- `Plain.update` partial-config semantics are undocumented; the client always
  passes a complete config on update, which is correct under both merge and
  replace behavior.
- Associating the customer's current company with a thread needs Plain-side
  `threadFields`/tenant configuration first; the server response deliberately
  omits company data until that is set up and reviewed.
