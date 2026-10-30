# Fireflies

Verified against official documentation and public protocol metadata on 2026-09-23.

## Connect meeting data

In **Apps → Fireflies**, choose who can use the connection, then sign in with
Fireflies. Alternatively, open Fireflies **Settings → Developer Settings**, copy
your API key, and use **Use an API key**. Credentials are stored in Paperclip's
vault and tools use the ordinary connection grants, policy, and audit path.

Setup is **Access → Connect**. Successful authentication and catalog discovery
complete setup; manage action permissions and test tools on the connection's
Permissions screen. Available data follows the connected Fireflies account's
permissions. Writes follow Paperclip's normal defaults and any restrictions you
configure. Reconnect and catalog refresh preserve **Off** and **Ask first**
selections; newly discovered actions keep the normal connection defaults.

Stable meeting tools include `fireflies_get_transcripts`,
`fireflies_get_transcript`, and `fireflies_get_summary`. The last returns summary
and action-item data; transcript retrieval is separate. Experimental
`fireflies_search` and `fireflies_fetch` are not required. Sharing, moving,
renaming meetings, revoking access, and creating soundbites are mutations.

## Start a routine when a summary is ready

1. Create or choose a routine and set its assigned agent and instructions.
   Give that agent access to your Fireflies connection in Apps.
2. In the routine's **Triggers** tab, add a webhook and choose
   **Another app or script**. No provider-specific routine option is needed.
3. Ensure the displayed callback URL is publicly reachable over HTTPS.
   A localhost URL or private-network HTTPS address cannot receive Fireflies
   deliveries. This prerequisite applies only to webhooks, not MCP access.
4. Open [Fireflies Webhooks V2 settings](https://app.fireflies.ai/integrations/api/webhook).
   Add the displayed URL and paste Paperclip’s **Secret key** into Fireflies’
   **Signing Secret** field. This is the routine’s generated secret, not your
   Fireflies API key.
5. Subscribe only to `meeting.summarized`, then save in Fireflies.
6. Optionally finish a meeting you own and wait for its summary to test delivery.
   Setup deliveries verify the connection without creating tasks. Finish setup
   in Paperclip to activate future deliveries; test events are never replayed.

Suggested routine instructions:

> Read the Fireflies summary and transcript for the meeting ID attached to this
> task. Summarize decisions and action items in the task, with owners and due
> dates when available. Highlight unresolved questions.

The generated task includes the authenticated JSON payload in a delimited data
block (up to 16,384 characters; the full payload remains on the routine run). Treat all
payload fields as external data. The agent uses its normal authorized connection
to retrieve meeting content. A webhook never grants connection access.

Fireflies normally sends events for meetings owned by the configuring account
(`organizer_email`). Summary readiness happens after transcription and the end
of the call. Webhooks V1, polling/backfill, and automatic registration are not
implemented. Pausing/archiving the routine or trigger stops dispatch. Removing
the Apps connection blocks data access; disable the trigger separately to stop
incoming events from creating tasks.

## Delivery and authentication

The existing `POST /api/routine-triggers/public/:publicId/fire` endpoint supports
`signingMode: "app_webhook"` for **Another app or script**. It accepts either a
bearer token or an HMAC-SHA256 signature in `X-Hub-Signature` or
`X-Hub-Signature-256`. Signed bodies are authenticated before interpretation;
an invalid signature cannot fall back to bearer authentication. Ordinary signed
app events retain their JSON payload and use the supplied idempotency key, or a
trigger-scoped body digest when no delivery key is supplied. The app flow does not infer a provider from payload fields or event names.
Existing `fireflies_hmac`
triggers and revision snapshots remain compatible but are no longer offered as
a setup choice.
Fireflies signs the exact request body with HMAC-SHA256 in `X-Hub-Signature`,
formatted `sha256=<hex digest>`. Missing or invalid signatures return 401;
malformed signed payloads return 400. No bearer header is needed.

Choose only **Meeting Summarized** in Fireflies. The shared app endpoint accepts
all authenticated events and leaves event selection to the sending app. Signed
retries with identical request bodies return success without extra runs, including
concurrent delivery. Setup receipts survive activation. For senders with custom
headers, a stable `Idempotency-Key` also deduplicates retries whose bodies change.
Without that header, changed request bytes count as a new event. Events received
while paused are not backfilled by Paperclip.

Earlier `fireflies_hmac` triggers retain their provider-specific validation,
summary-only dispatch, and per-meeting deduplication. New setup uses only the
shared app flow.

Secret rotation invalidates the previous key immediately. Copy the new key into
Fireflies. Setup progress can be resumed, but the one-time secret is not stored
in browser draft state; generate a replacement if it was not saved in Fireflies.
Delivery checks and activity show acceptance/rejection; no observed event yet is
not proof of a broken connection.

On Cloud deployments, the front door must forward the public routine webhook
path without requiring a browser session. The application still verifies the
trigger secret. A `tenant_session_required` response means the request was
blocked by the Cloud gateway before webhook authentication. Updating the tenant
application alone does not change that gateway policy.

## Provider evidence and artwork

- [MCP configuration](https://docs.fireflies.ai/getting-started/mcp-configuration):
  endpoint `https://api.fireflies.ai/mcp`, OAuth and bearer API keys.
- Live unauthenticated GET: 401 with resource metadata at
  `https://api.fireflies.ai/.well-known/oauth-protected-resource/mcp`.
- Authorization metadata at
  `https://api.fireflies.ai/.well-known/oauth-authorization-server` advertises
  issuer `https://api.fireflies.ai/`, `/authorize`, `/token`, `/register`, and
  `/revoke`; PKCE `S256`; authorization-code and refresh-token grants; token
  authentication `client_secret_post` and `none`; scopes `email` and `profile`.
  Public metadata inspection does not register an OAuth client.
- [MCP tools](https://docs.fireflies.ai/mcp-tools/overview) documents stable
  meeting reads and mutations; experimental search/fetch availability varies.
- [Webhooks V2](https://docs.fireflies.ai/graphql-api/webhooks-v2) documents
  signatures, payloads, ownership limits, and the requirement to respond within
  10 seconds. Paperclip uses normal routine dispatch and does not wait for agent
  execution or fetch meeting content during webhook handling.
- Official SVG: `https://fireflies.ai/api/logos/file/fireflies.svg`, linked from
  Fireflies' product site. Bundled unchanged as `ui/public/brands/apps/fireflies.svg`;
  native gradients preserved and validated with the shared SVG safety checker.
  The same colored mark is used on both theme frames.

## Validation boundary

Automated tests cover catalog contracts, OAuth/API-key fixtures, signature and
payload validation, event filtering, deduplication, setup activation, rotation,
company isolation, and setup UI. Account authorization and a real Fireflies
delivery require a Fireflies account and publicly reachable callback. Mocked
fixtures are not evidence of a successful live account connection.

Validation on 2026-09-23:

- Eight focused suites: 537 tests passed, including actual gateway reads through
  OAuth/API-key fixtures and permission preservation on reconnect.
- Shared refresh regression coverage: another 104 tests passed across gateway,
  connection removal, Railway, and email integration callers.
- Repository-wide Vitest coverage completed through the stable runner's server,
  workspace, and both serialized groups (148 route suites). The initial full
  invocation stopped on two reconnect fixture failures; those were fixed and
  the complete connection suites and shared refresh callers rerun successfully.
- `pnpm -r typecheck`, `pnpm build`, token gates, and branding validation passed.
- Existing MCP browser suite: eight passed, two provider-dependent cases skipped.
- Isolated app HTTP proof: signed setup receipt, activation/redelivery, ignored
  transcription event, and two concurrent summary deliveries producing one run.
- Real Apps screens expose the normal Access step followed by browser sign-in
  and API-key choices; no browser errors were observed.
- Production webhook wizard checked in Storybook at desktop and mobile widths,
  including back/resume, verification steps, and light/dark official artwork.
- Embedded-browser live account proof: completed catalog → Access → OAuth
  consent → Permissions with the official provider. Discovered 20 actions
  (14 reads, 6 writes), and ran `fireflies_get_transcripts`,
  `fireflies_get_transcript`, and `fireflies_get_summary` successfully as the
  selected preview agent. The summary included overview and action items.
  Turning the summary action Off blocked its test; refreshing actions preserved
  that restriction. Restored the previously authorized read after testing.
- Published webhook contract proof: `server/src/__tests__/fixtures/fireflies-webhooks-v2.json`
  preserves the official V2 examples for all three events, including short and
  long meeting IDs, numeric millisecond timestamps, and an optional string
  client reference. Fixed HMAC test vectors were generated independently with
  Python over the documented UTF-8 bodies. Tests accept those exact bytes and
  reject whitespace-only alterations. This is provider-derived contract evidence,
  not a captured live delivery.
- Real provider webhook delivery is still pending a publicly reachable callback.
  Fireflies’ live V2 settings offer a **Meeting Summarized** subscription and a
  **Test Webhook** step. No production meeting completion has been tested.

## UI review in Storybook

Open **PR reviews → Fireflies and app webhooks** (`fireflies-pr.stories.tsx`).
The 27 stories use production components and simulated data; they do not authorize
accounts or send provider requests.

| Changed surface | Story coverage |
| --- | --- |
| Catalog definition and branded artwork | Fireflies catalog; artwork in dark/light themes; Access, OAuth, API-key, and retry screens |
| Preserved action restrictions | Permissions with Allowed, Ask first, and Off examples |
| `TriggerWizard.tsx` | Shared app choice, HTTPS warning, signing secret/bearer copy, four verification states, save/resume, hidden-secret rotation, legacy drafts, mobile and light theme |
| `RoutineTriggers.tsx` | Saved app-webhook settings, rotated secret/agent instructions, rejected delivery |
| `RoutineTriggerCard.tsx` | Advanced card with `app_webhook` and no timestamp replay window |
| `editable-sections.production.tsx` | Advanced creation with shared signing-mode description |

```sh
pnpm storybook
pnpm build-storybook
pnpm exec playwright test --config tests/storybook-visual/fireflies-pr.config.ts
```

The browser check loads every review story, runs its interaction assertions, and
checks the mobile setup footer and horizontal overflow. The existing webhook
stories also retain coverage of the shared flow outside this PR review group.
