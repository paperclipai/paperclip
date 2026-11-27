# Chat connector development

Setting up Slack chat against a local instance, and connector diagnostics.

## Slack chat setup in a test drive

Enable **Chat connectors** in Instance Settings, then open **Connectors → Slack →
Chat with an agent**. Before creating an app, configure a public HTTPS board URL
and webhook ingress that Slack can reach. The setup page shows this prerequisite;
a loopback test drive can exercise the UI before HTTPS is configured.

New Slack connections use five steps: choose an agent, enter an app configuration
token, install the app, verify Slack delivery, and try a conversation. Agent
selection generates readable defaults for the Slack app name, bot display name,
and slash command; edit them under **Advanced** if needed. **Get your App
configuration token** opens Slack app settings. Enter the temporary token directly
into Paperclip, then select **Create Slack app**. Paperclip creates the app,
vaults its credentials, and attempts avatar upload before discarding the token.
App details lock after creation dispatch, including an uncertain result.

**Install in Slack** obtains the bot token through OAuth, links the installing
Slack account to the Paperclip account that started installation, and sends one
welcome DM. Approve with your own Slack account. After Slack verifies the Events
Request URL, use **Open your Slack DM**, send the suggested message, and continue
in the thread. **Done** finishes setup; the conversation test is optional.
See [Automatic Slack app setup](connections/SLACK-AUTOMATIC-SETUP.md) for
HTTPS configuration and recovery.

**Create manually** and **Use an existing app** are under **Advanced** on the
token step. These paths retain manual credential entry and a separate personal
account-linking step. Send `/<your-command> connect` to discover your identity
without starting work, then confirm **This is my Slack account** in the wizard
or use the private confirmation link. The link expires after 15 minutes and
requires company membership. Future messages use the linked user's current
permissions. Additional or different accounts can be linked later in **Access**.

New Slack connections disable **Allow unlinked people** by default. The Access
page includes the shareable connect command and instructions for other users.
Other Slack users join through the same connect command after setup. A signed-in
nonmember can **Request access** from the confirmation page. This creates a
pending human join request in the company's existing admin approval queue; it
does not grant membership or link the identity. After approval, confirm the
identity, or send the connect command again if the link has expired. Successful
confirmation also queues a private Slack acknowledgement.

Slack identity invitation pages retain the cloud authentication and bootstrap
checks. Signed-in nonmembers may open a valid private invitation to request
membership, but confirmation still requires membership in the invitation's
company. Preview, access-request, and confirmation APIs also enforce the chat
connector rollout flag on the server; invitees cannot read board experimental
settings before they join. Expired or consumed tokens grant no access.

The manual path suggests `@<your-bot> you there?`, then continuing in the agent's
thread. Select the bot from Slack's @mention suggestions so the message includes
a real mention. **Done** finishes setup once webhook verification and required
account linking are complete, whether or not a test message was sent. The
separate strict connection-test API retains its conversation and delivery checks.

New Slack conversations receive default communication guidance that requires a
clickable link to each task the agent creates. Agents use the public task URL
from Paperclip tools or task context and report when a link is unavailable.
Existing conversations keep their original communication guidance snapshot.

Slack catalog discovery uses `resolveSlackTaskAuthorization` to recheck the live
run, task, agent, linked user, endpoint, and current bot credential. Discovery
does not consume a compatibility revision, so it avoids hashing company policy
and profile rows. Callers that need a revision continue to use
`resolveSlackTaskAuthority`; connector skill snapshots and governed operations
retain their existing fingerprint. Both paths share the same authorization
implementation and perform fresh checks on every call. The real PostgreSQL
controls are in `server/src/__tests__/slack-tool-preparation.test.ts`.

## GitHub updates during an active review

Accepted GitHub messages and automatic PR updates try same-turn steering by
default after normal wake admission. The active native run must belong to the
same task, agent, conversation, responsible person, and source trust level.
Messages with attachments, omitted attachments, or a fresh-session requirement keep a separate turn.
The message carries the admitted GitHub review instructions.

The durable wake stays pending until the runner acknowledges steering. An
acknowledged message joins the active run's input and requester lineage, and
its wake becomes coalesced. Automatic review records for the new head point to
that run. A rejected or unavailable steer retains ordinary queued delivery.
Late acknowledgements and retries use the native acknowledgement receipt to
avoid sending the same update twice. Other chat providers keep their existing
delivery behavior.

Each native GitHub receipt stays separate until steering acknowledges its exact input.
This prevents ordinary wake coalescing from merging a newer input into an
uncertain delivery. Steering dispatch does not hold task or conversation locks while it waits for
the provider. A saved receipt records the run, identity reservation, and exact
comment revision before dispatch. Deferred delivery recovers an acknowledgement
after a restart, including when it replays a batch on a closed task. Recovery
does not consume an edit that the provider did not receive or replace a newer
requester lineage. An uncertain reservation stays pending while its source run
can still acknowledge it; recovery rejects it when that run stops without an
acknowledgement.
Retries preserve the original steering revision. An edit that was not sent
keeps ordinary delivery. Overlapping inputs also keep their admitted wakes
while another steering acknowledgement is pending. After the active review
ends, unacknowledged inputs retain ordinary delivery. Legacy runs keep their
existing conversation batching when no native steering receipt is outstanding.
Admission rechecks that condition under the task and run locks.

## Chat activity pagination and callback diagnostics

The connection Activity tab loads 25 records per page. `GET /api/chat-endpoints/:id/activity?limit=25`
returns `{ items, nextCursor }`; pass `cursor` to read older records. The limit must be 1–100.
A timestamp and ID cursor preserves records with equal timestamps and avoids shifts from new arrivals.
The first page refreshes automatically; older pages do not poll. Mutable action status can move an
entry forward in time, so this is a live ledger, not a historical snapshot. Requests without pagination
parameters retain the recent-100 array response for existing clients.

Slack callback diagnostics tolerate HTTP between a TLS proxy and Paperclip when the public host,
port, and path still match. A changed authority or path remains stale. This comparison only affects
health display; it does not trust forwarded headers or alter Slack signature verification.

## Slack provisioning paths

Self-hosted development continues to use independent Slack app setup. Managed
Slack installation is a disabled-by-default Cloud feature that also requires the
companion broker profile and Slack approval. Do not add manager client credentials
to a local `.env` or an open-source deployment. See
[Slack setup and Cloud qualification](connections/slack-setup.md) for the gates,
recovery behavior, and production-component stories.
