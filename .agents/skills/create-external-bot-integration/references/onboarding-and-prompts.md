# Onboarding, consent, and agent instructions

## Contents

- [Design from the user's entry point](#design-from-the-users-entry-point)
- [Model the states the user will actually encounter](#model-the-states-the-user-will-actually-encounter)
- [Separate setup approvals from repeated intervention](#separate-setup-approvals-from-repeated-intervention)
- [Separate the four lifetimes](#separate-the-four-lifetimes)
- [Generate instructions the receiving agent can execute](#generate-instructions-the-receiving-agent-can-execute)
- [Test prompts must constrain the destination without disabling the bot](#test-prompts-must-constrain-the-destination-without-disabling-the-bot)
- [Keep optional identity polish narrowly scoped](#keep-optional-identity-polish-narrowly-scoped)

## Design from the user's entry point

For the Dot flow, the approved entry was **New Agent → Invite an external agent →
Dot / Hermes / Other**, not a hidden Runner provider configuration. Use the current
product's equivalent. A provider preset may customize its logo, instructions and
checks; it must not silently redesign another provider's enrollment protocol.
Hermes originally retained the existing external-agent prompt.

Use the same square selection cards as the harness picker, actual provider logos,
the shared copy-prompt component, and the normal dialog footer. Preserve agent
details on Back. Animate changes in dialog size using the design system and honor
reduced motion. Follow current repository design/token instructions.

Show prerequisite features and evaluate their actual server-side availability.
Dot's standalone experiment did not implicitly enable every Runner provider.
Cloud's managed execution also required its native Runner configuration. Distinguish
those environment prerequisites from the user-facing provider picker; do not make
users discover a disabled backend only after they have completed provider consent.

Make the user-facing sequence short:

1. Choose the bot and create/resume its agent invitation.
2. Copy the complete prompt and give it to that bot.
3. Grant any required scoped consent through the supported flow.
4. Watch connection, task updates, and a harmless test event.
5. Choose Done when both the connection and agent are ready.

A readiness probe should not create a visible work task. Create a real task later
for assignment qualification. Optional avatar/profile steps must not delay readiness.

## Model the states the user will actually encounter

| State or event | Required behavior |
| --- | --- |
| Opening setup with no usable pending code | Create a fresh prompt automatically after checking authoritative connection state. |
| Pending prompt expires while open | Refresh it safely; explain genuine renewal failure with Retry rather than looping. |
| Existing connection is already established | Resume its status; do not revoke it to generate a new code. |
| Another tab replaced the pending prompt | Avoid renewal ping-pong; ask before replacing that newer prompt or follow the product's explicit conflict policy. |
| OAuth/binding observed | Close any nested copy-prompt window; replace the copy action with Connecting… status. |
| Callback subscription verified | Keep completed checks checked; show confirmation of the test event in progress. |
| Event challenge confirmed, agent still preparing | Show Finishing setup…; do not claim the event is still pending. |
| Agent and connection ready | Enable Done, which closes the modal. |
| Watch connection interrupted | Recover/resync from server state and explain the interruption; do not discard the pairing. |
| Agent preparing/verifying with compatibility status paused | Allow setup when the server says setup is permitted. |
| Agent genuinely manually paused or awaiting hire approval | Show the actual blocker and its action; do not auto-resume or bypass approval. |
| Returning after refresh | Resume the same agent/invitation; do not create another agent. |

Derive UI decisions from server lifecycle facts. Dot Cloud initially had a circular
dependency: hire preparation waited for pairing, but the UI treated preparation
as a manual pause and demanded resume before pairing. Story fixtures alone did
not reveal the real newly-created-agent state.

Keep one current setup procedure in documentation. Move historical/manual steps
to an explicitly dated section when automatic renewal or atomic pairing replaces
them. Do not leave “revoke, pair, save again” beside a newer one-step flow.

## Separate setup approvals from repeated intervention

Specify the allowed human actions in the release contract. “No human operates the
bot's computer” can still involve a human approving a grant in chat and Codex
submitting the already-authorized action. It does not prove that the bot alone
completed every browser step. Record who performed consent, app attachment,
catalog refresh, and reboot during qualification.

Consent should preview the exact company, agent, access scope and duration before
submission. A one-use pairing code can preauthorize that exact agent without
handing an operator password or board session to the external computer. Keep
preview read-only and code consumption atomic. Revalidate current permissions at
redemption, including when the creator has since left the company.

The historical user authorized a specific plugin-creation risk notice through
this exact extra prompt paragraph:

> When you setup the plugin, I already understand that MCP servers have risk, so
> you check “I understand and want to continue,” and click “Create as a plugin.”
> I want you to create the plugin for me completely and I don't want to have to
> do anything.

This is a historical consent example, not permission for future agents or users.
Do not bake an assertion of user approval into every generated prompt. Use current
authorization, distinguish a nonbinding risk notice from granting ongoing access,
and obey the actual browser/provider policy. An agent relaying approval may not be
accepted as the human's approval by the receiving agent. Do not impersonate the
human to resolve that; use a supported direct approval path when authorized.

## Separate the four lifetimes

1. **Pairing capability:** short-lived, one use; safe automatic renewal before use.
2. **Access token:** short-lived bearer authority, refreshed through its protocol.
3. **Persistent connection/refresh authority:** product policy; Dot was changed to
   remain valid until revoked with rotating refresh tokens and replay checks.
4. **Subscription and assignment leases:** bounded and separately renewed; a
   persistent account connection does not make a task's authority permanent.

The Dot user requested no Paperclip inactivity expiration. Migration preserved
currently valid connections; it did not revive expired, consumed, or revoked
credentials. Test renewal, rotation, replay and revocation independently. Do not
promise that Paperclip's lifetime policy controls the provider's own account rules.

## Generate instructions the receiving agent can execute

Adapt the following to the provider's supported protocol and actual tool names.
Do not send placeholder values, credentials, or a URL from an old environment.

```text
Connect yourself to Paperclip as <agent> in <company>.

Add or reuse the private plugin for this exact server URL: <MCP_URL>.
Use the supported OAuth flow. Reuse an existing definition only if its URL matches;
if the name belongs to another URL, choose a distinct name instead of replacing it.
Use this one-use pairing code on the consent page: <PAIRING_CODE>.
Review the exact company, agent, permissions, and duration. Complete the authorized
steps; if a required approval is missing, request that specific approval.

Verify an actual read-only call through this connection. If the installed plugin's
tools are absent in your runtime, refresh/attach it through the provider's supported
flow and report any remaining blocker. Do not claim access from a settings listing.

Enable the task-update subscription returned by Paperclip. Follow its event
instructions, drain the inbox from your saved cursor, and confirm the readiness
challenge. Do not create a task just to confirm readiness.

For assignments, read and accept current work, use stable request IDs, reconcile
pending results, and follow the supplied reporting/completion contract. For new
work requested while idle, use the governed intake tool and poll the same request
if admission is pending; do not ask the human to create a placeholder task.

Use your own relevant tools, apps, plugins, skills, and capabilities to complete
the request, then return the result and deliverables to the Paperclip task.
The Paperclip catalog describes Paperclip operations. It does not disable your
native tools or require those tools to appear in that catalog. Respect the tools'
existing permissions and approvals. Keep Paperclip operations within the current
connection's authorized company, agent, and task; do not use another identity to
bypass a denied Paperclip operation.

Report which connection checks actually succeeded and any exact blocker.
```

Put native-tool guidance at the points where it changes behavior: setup prompt,
server onboarding text, event instructions, capabilities, and each assignment.
Test rendered plain-text documents as well as JSON fields. The Dot follow-up
initially added guidance to the JSON manifest but omitted the `onboarding.txt`
renderer; agents receiving only that URL still missed it.

Do not copy every instruction into every tool description. Keep one common source
where package boundaries permit. Use a lightweight dependency-free shared export
for UI copy to avoid importing a heavy shared barrel. The standalone Runner may
need its own small instruction constant with a clearly documented alignment point.

Historical instruction surfaces to locate in the current checkout:

- `ui/src/lib/dot-setup-prompt.ts`
- `ui/src/lib/agent-onboarding-prompt.ts`
- `server/src/routes/access.ts` and its actual onboarding text renderer
- `server/src/services/dot-runner-broker.ts` pairing/event/capability responses
- `packages/paperclip-runner/src/backends/runtime-context.ts`
- `packages/shared/src/external-agent-guidance.ts`

## Test prompts must constrain the destination without disabling the bot

Bad: “Use only the staging plugin.” Dot carried this into later work and refused
to use its already-connected native Slack.

Use a narrowly scoped qualification instruction:

```text
For qualification task <CASE_ID> only, send Paperclip operations through
<TEST_CONNECTION> for <TEST_COMPANY>. This selects the Paperclip destination;
it does not restrict your relevant native tools. Do not alter other connections.
After this case, these test-only restrictions end. Return results to its task
using the normal reporting and completion tools.
```

If a case deliberately excludes native tools to isolate one transport, say so
for that case only, then end the restriction explicitly. Run a subsequent native
tool case to detect leakage of the test restriction into normal behavior.

## Keep optional identity polish narrowly scoped

Dot's avatar tool accepts image bytes for its own bound Paperclip agent, re-encodes
them, and never grants generic agent administration. Validate format, byte and
pixel limits; remove metadata; make replay safe. A private asset ID cannot simply
be exported to another company. Preserve portable name/character/palette and omit
or remap company-local image IDs on import.

Do not invent an avatar-export API or extract an unrelated image just because the
UI has an avatar. Ask the bot to upload its current avatar only if available; lack
of that capability must not block connection or task qualification.
