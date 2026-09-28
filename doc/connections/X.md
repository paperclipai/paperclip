# Experimental X chat bot

Enable **Experimental → Chat connectors**, then connect **X** in Apps. One X
account belongs to one company and one permanently assigned agent. Public
mentions create tasks; direct replies to a recorded bot response continue the
same task. Independent mentions under the same original post create separate
tasks. Protected posts and DMs are outside this integration.

The agent explicitly requests one public text reply with `x_reply`. Internal
comments, progress, final responses, task completion, and Board activity never
post to X. The supplied skill instructs the agent to be concise, omit Paperclip
links, and check uncertain delivery instead of posting again. Paperclip validates
weighted characters and returns an actionable error; it never rewrites,
truncates, splits, or adds a link to the answer.

## Before enabling delivery

- Obtain X's prior written approval for an AI reply bot. Explain the automated
  account in its profile, provide an opt-out, and respect the one-reply-per-user-
  interaction requirement. See [X automation rules](https://help.x.com/en/rules-and-policies/x-automation).
- Use your own X developer app with the required API access. X usage is billed
  separately; review credits and spending controls in the developer console.
  Paperclip does not include X API charges or fix their prices. See
  [X API pricing](https://docs.x.com/x-api/getting-started/pricing).
- Configure a public HTTPS Paperclip URL without an explicit port. A local-only
  URL cannot receive X delivery. Install Cloud ingress support before enabling an
  X bot on Cloud, and keep the target stack awake for registration and live proof.

## Setup

1. **Choose agent.** This assignment remains fixed. Create another connection
   to use another agent; pause or remove the old one first to reuse its bot.
2. **Configure X app.** Enable OAuth 2.0 as a confidential Web App. Copy the
   callback URL shown by Paperclip (`/api/x/oauth/callback`) into X's console.
   Enter its OAuth 2.0 Client ID and Client Secret. Draft progress is saved;
   credentials live in the company vault, never browser storage or SDK state.
3. **Authorize bot account.** Sign into the bot's X account and grant
   `tweet.read`, `tweet.write`, `users.read`, and `offline.access`. Paperclip uses
   PKCE, validates the account, and rotates refresh tokens in the vault. See
   [X OAuth 2.0](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code).
4. **Configure delivery.** Register the shown HTTPS webhook in X's console and
   subscribe the authorized account to `post.mention.create` and
   `post.reply.create`. Paperclip answers GET CRC challenges and verifies POST
   bytes with `X-Twitter-Webhooks-Signature-OAuth2` and the app's client secret.
   “Webhook callback observed” reports a callback, not a verified subscription
   inventory. Verify both subscriptions in the console. See
   [X webhooks](https://docs.x.com/x-api/webhooks/quickstart) and
   [Activity API](https://docs.x.com/x-api/activity/introduction).
5. **Link your account.** Authorize your personal X account with separate
   read-only scopes. Confirm the displayed handle against your signed-in
   Paperclip account. Human access tokens are discarded and cannot replace bot
   credentials. No identity token is posted publicly.
6. **Try it.** Choose linked Paperclip users (default) or anyone on X. Public
   participants run as restricted guests. A conversation test is optional; you
   can finish after delivery configuration and identity linking.

Every subsequent turn and queued reply rechecks current participant, company,
task, run, endpoint, and access settings. Pause/removal stop admission and sends.
`@bot stop` persists the sender's opt-out; `@bot start` resumes it. These exact
controls never start agent work or send an acknowledgement.

## Agent tools and durability

| Tool | Result |
| --- | --- |
| `x_read_thread({})` | Current task messages, known reply intents, available ancestor context, invoking post, and authorized reply target. |
| `x_reply({replyToPostId, text, idempotencyKey})` | Immutable queued reply intent and publication ID/status. Use a UUID key. |
| `x_delivery({publicationId})` | Status and resulting post ID, when known. |

CLI adapters receive the same operations through the authenticated, run-bound
`POST /api/companies/:companyId/x/tasks/:issueId/tools` endpoint, documented in
the assigned `skills/x/SKILL.md`. These operations never accept caller-supplied
bot credentials or participant identity. Targets are restricted to the run's
invoking interaction; ancestor posts are untrusted reference material. At most
ten ancestors are retrieved, with missing context labeled explicitly.

Signed events enter a durable intake ledger before acknowledgement. The patched
`@chat-adapter/x@4.39.0` normalizes mention and reply events into the shared chat
runtime using persisted activation roots. Its automatic `postMessage` path is
disabled. Reply targets never depend on the adapter's in-memory latest post.
Follow-ups that arrive before their bot-parent link is committed remain in the
intake ledger and resume when that exact link becomes available, including
after a restart. Unrelated replies cannot start tasks. Unmatched replies close
after 24 hours with an ignored disposition; their audit receipt is retained.

The publication ledger saves exact text and target before any provider request.
The same key and payload return the original intent. Reusing a key with a
different target or text returns a conflict, and the same interaction cannot
gain a second intent. A worker crash or ambiguous network error becomes
`delivery_unknown`; it is never automatically replayed. Inspect X and Activity,
then mark delivered or cancel. Marking delivered does not invent a missing post
ID or restore follow-up routing to an unknown post. Definite rejections, expired
authorization, exhausted credits, and rate limits appear in Activity. For a
rejected interaction, fix the cause and ask the person to send a new interaction.

## Cloud ingress and live acceptance

Cloud permits provider-authenticated requests only on
`/api/chat-webhooks/:publicId/x` (GET/POST; 43-character public ID). Tenant host
selection, raw POST bytes, signature headers, and CRC query parameters survive
the proxy; management and OAuth callback routes retain browser authentication.
Sleeping or waking stacks return a non-success response rather than a false
delivery acknowledgement. Existing authenticated stack wake controls remain in
place; an anonymous webhook does not grant lifecycle authority. After waking,
revalidate the webhook in X if an hourly CRC failed.

Before launch, use an approved test account and deployed HTTPS URL to record:

1. Successful console registration and both subscriptions; observed CRC.
2. A mention beneath another person's post, its Paperclip task, and fetched
   parent context (or an explicit missing-context marker).
3. One explicit reply intent, confirmed X post ID, no Paperclip link, and no
   additional post when the task finishes.
4. A reply to that bot post continuing the task; an independent mention creating
   another task; stop/start and pause behaving as documented.
5. The same round trip through the Cloud tenant URL when deploying on Cloud.

Automated fixtures cover these protocols and the browser setup, but they are
not evidence of X approval, account entitlement, model behavior on live prompts,
or a successful live provider round trip. Those checks require the operator's
authorized account. Keep live evidence separate from mocked results.
