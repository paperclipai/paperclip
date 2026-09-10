# Cloud support chat (Plain)

Cloud uses Plain's default floating chat launcher. Self-hosted instances retain
Share feedback and do not load the Plain script. No custom chat UI is added.

## Customer context

The integration passes only the signed-in user's verified email and optional
display name. The server signs the email with Plain's HMAC secret; the browser
never receives that secret. The hash is a bearer credential: do not log, persist,
or cache it. The support-session response uses `Cache-Control: no-store`.

No Paperclip user ID, organization name, tenant membership, task content, URLs,
or logs are attached. Users can describe their organization in the conversation.
Plain may independently group customers by their email domain. The integration
does not create or update Plain tenants or customer memberships.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PLAIN_CHAT_APP_ID` | Public chat app ID. Omit to disable the integration. |
| `PLAIN_CHAT_EMAIL_HMAC_SECRET` | Server-only email-signing secret from the chat app settings. |
| `PAPERCLIP_SUPPORT_CHAT_DEV_PREVIEW` | Local development opt-in (`1` or `true`); ignored in production. |

A configured app ID enables chat only on Cloud-managed instances or explicitly
opted-in non-production local previews. No Plain Core API key is needed.
The HMAC secret is stripped from inherited agent-adapter environments.

Without a signing secret or verified email, no customer details are supplied;
Plain handles the anonymous chat experience. Do not claim verified identity
for this mode. Vendor email-verification requirements must match widget settings.

## Lifecycle and fallback

The gate requests configuration once per account. Organization changes require
no support request or widget update. Theme changes use Plain's update API.
The feedback flag hides only while Plain is active and returns on load/update
failure. Failed transitions remove the default `plain-chat` host and require a
page reload before retrying; this host ID is a vendor DOM dependency.

Plain documents no teardown/reset API. A document binds to one account; a
same-document account change disables chat. Cloud sign-out navigates away.
Shared-browser account isolation still needs end-to-end staging verification.

## Staging and rollback

Use the dedicated staging chat app. Configure its app ID and HMAC secret on
explicit test stacks, then deploy the reviewed preview through the normal fleet
rollout. Keep the fleet default unchanged and record the previous release.
No database migration is introduced. Disable by removing the app ID and
restarting the stack; existing pages need a reload.

Verify Cloud gating, name and verified email, chat delivery and replies, logout
and a second account, failure fallback, and unchanged OSS feedback. Check that
no organization or internal ID is included in the outgoing widget configuration.
Prior local organization-association tests apply only to the superseded broader
implementation; this revision deliberately removes that behavior. Previously
created Plain test records are not deleted by this change.
