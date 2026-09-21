# Chat Connector UX

Use this companion to the [Connection authoring runbook](./CONNECTOR-PLAYBOOK.md)
when designing or reviewing chat and email connector setup, account linking, and
ongoing configuration. These conventions apply to Slack, Discord, Telegram,
AgentMail, and other providers according to their supported capabilities.

Make connecting an agent feel like a short, understandable sequence of actions.
At every point, the person should know what to do, where to do it, what Paperclip
has observed, and what happens next. These are Paperclip product conventions
extracted from a live Slack setup iteration, not a requirement to reproduce
Slack's screens or six steps for every provider.

## Start with the actual provider journey

Before changing a flow, identify:

- What the user is connecting: agent, provider app/bot/mailbox, and workspace or destination.
- How credentials are obtained and which ones this transport actually needs.
- Whether inbound delivery needs a public HTTPS callback, an outbound socket, polling, or another mechanism.
- How an external person becomes a Paperclip identity, and how a new person requests organization access.
- The simplest supported first message and how subsequent replies reach the same conversation.

Inspect the current implementation and verify provider-dependent details against
current official documentation when implementing them. Do not infer capabilities
from another provider's wizard or from similar-looking credentials. For
Paperclip code changes, follow the repository's [design system](../../DESIGN.md) and
[connection authoring runbook](./CONNECTOR-PLAYBOOK.md); use its existing components and tokens.

For examples of how these principles transfer across providers, read
[Provider adaptation](#provider-adaptation).

## 1. Give each meaningful action a stable step

Use these stages where applicable: choose agent, create/configure the provider
app, supply credentials, verify inbound delivery, connect your personal account,
and try a conversation. Merge or omit stages that have no distinct user action.
Separate creating an app from entering its credentials when the user must leave
Paperclip between those actions. Keep personal account linking separate from
the message test: they establish different things.

A step keeps its number and purpose throughout the flow. Do not turn “Add
credentials” into “Finish setup” under the same number after submission. Avoid
vague finishing screens that repeat configuration already supplied earlier.
Explain consequential choices, such as an agent being permanent for a connection,
at the point where the user makes them.

During setup, replace the generic Browse/Review sidebar with the setup steps:

- Use compact, evenly spaced numbered stops with readable labels.
- Center a vertical connector line on the numbered circles; leave a small gap at each end so it does not touch them.
- Keep completed/available steps clickable for going back. Distinguish current, complete, and unavailable states visually and accessibly.
- Preserve entered values and draft progress across back navigation, external-provider visits, refresh, and Save & exit. Resume at the relevant step.
- Earlier steps remain reviewable; revisiting them must not silently change an installed app, registered command, or established connection identity.

## 2. One footer row, owned by the step

**Every wizard state puts Save & exit on the left and the primary action on the
right in the same vertically centered row.** Save & exit uses a subdued gray
text treatment. Related secondary actions go immediately to the left of the
primary action, not in an unrelated block above or below it.

The step owns its whole footer. Do not render another Save & exit in a parent
beneath the form. Apply this rule to loading, errors, linked/unlinked states,
verification, and optional tests, not just the first screen. Prefer a shared
footer component when several steps need it. On narrow screens, wrap deliberately
while preserving order and grouping; do not introduce horizontal overflow.

Leave a clear vertical gap between the final field/help link and the footer.
“Save” should match real persistence; expose save errors and do not advance on a
failed save.

## 3. Put prerequisites first; reveal technical detail on demand

A prerequisite that can prevent the whole connection from working belongs at the
top, before app creation or credentials. Use a visible tinted background, a
concise explanation, and a specific action or Learn more link. For a public
callback, distinguish having HTTPS from being reachable by the provider. A
private-network HTTPS URL alone is not proof of public reachability.

Only show prerequisites relevant to the chosen transport and deployment. Do not
require a public URL for a connector that does not use public callbacks. When
relevant, explain that Paperclip Cloud supplies HTTPS and link self-hosters to
maintained setup documentation instead of embedding a long server tutorial.

Generated manifests, webhook URLs, and diagnostic settings should not dominate
the normal path:

- Offer a small, descriptive text link such as “View Slack App Manifest” below the relevant fields, aligned toward their trailing edge.
- Open generated configuration in an accessible modal with a read-only preview and copy action. Do not expose a long raw document by default.
- Put webhook URLs and repair instructions in troubleshooting when app creation already supplied them.
- Do not ask users to paste or edit the same configuration again unless verification shows a real need.

## 4. Make the editable surface simple and coherent

Expose meaningful choices—app name, bot display name, invocation name—directly
as normal form fields. Avoid an extra bordered container around a small group
of ordinary fields. Use standard enabled input text colors; actual values must
not look like disabled text or placeholders.

The editable values, generated configuration, creation link, and later
instructions derive from the same saved state. Validate edits before generating
or submitting them. Use the actual chosen app/bot name in subsequent instructions.
When edits become unsafe after installation, make that boundary explicit and
preserve the installed configuration on reconnect.

Show a help icon beside each provider-configuration and credential field,
visible even when the field is not hovered. Reveal its short explanation on
hover or keyboard focus, with a usable touch interaction. Explain
where the value appears or how to find it. Essential instructions and validation
errors stay visible outside tooltips. Avoid introductory copy that merely
repeats what the fields and action buttons already say.

## 5. Minimize provider-side work and make handoffs legible

Use supported manifest-prefill links, installation links, or OAuth flows when
they eliminate manual work. Verify support before promising a one-click setup;
workspace selection, consent, installation, or credential copying may still be
necessary. Do not put credentials into creation links.

An action such as “Create Slack app” should open the provider immediately. If it
also advances Paperclip, let the handoff register first—a short delay around one
second was effective for Slack. Prevent duplicate activation and cancel pending
navigation if the user leaves or goes back. Keep “I already created the app” as
a clear secondary path. A successful click is not proof that installation or
verification succeeded.

Use text links for supporting navigation such as “Open provider app settings.”
Reserve the prominent button for the step's main action.

## 6. Place credential instructions next to each credential

When secrets live on different provider screens, say so plainly and give each
field its own short numbered instructions. Prefer this pattern:

1. Open the provider app settings link and choose **the actual app name**.
2. Choose **the exact provider section label**.
3. Copy **the exact credential label** and paste it into the field below.

Keep the opening link and “choose your app name” on one readable, normal-contrast
line where space permits. Repeat that entry point for each independent sequence
so users do not have to reconstruct a path from a distant paragraph.

Use password fields and validate provider-documented formats locally. Detect
common mix-ups with actionable inline messages: name the expected credential,
name the mistaken type, and say where to find the right one. Slack examples:
a bot token starts with `xoxb-`; an `xapp-` app token is not the HTTP Signing
Secret, and an `xoxb-` bot token is not that secret either. Do not impose these
formats on other providers or invent format checks for opaque secrets. Format
validation does not prove validity or permission scope. Never echo pasted secrets
in warnings, logs, URLs, or diagnostic screenshots.

Screenshots must depict the exact credential and current provider screen.
Identify them as provider screenshots in a caption/container so they cannot be
mistaken for live Paperclip controls. Remove obsolete or misleading screenshots.
Use a troubleshooting modal only when it adds guidance beyond the inline steps;
delete redundant “Can't find it?” links when the page already explains the path.

## 7. Separate connection setup, identity linking, and membership

Installing a bot connects a provider resource. Linking an external identity
connects a person to their Paperclip permissions. Organization membership is a
separate approval boundary. Make all three understandable without exposing
implementation details to the user.

For new connections, default unlinked-person access to off; retain existing
explicit choices. Integrate the configuring user's identity link into onboarding
and show how other people can join later from the Access tab:

- Provide the actual connect command or equivalent provider-supported action, with copy support. It should discover identity without starting agent work.
- Update the UI live when the external identity is observed. Show the candidate identity, target Paperclip account, and an explicit ownership confirmation.
- Use an amber container while linking is required/pending, then green after successful linking. Include text/icons so color is not the only signal.
- Explain that future messages use that person's current Paperclip permissions.
- Let other people follow a private, expiring confirmation link and sign in. Nonmembers can request access; approval precedes confirmation. They should not need another bot or shared credentials.

Preserve authentication, bootstrap, feature-rollout, token, and company-access
checks when making invitations reachable to nonmembers. A narrow ability to
request membership must not grant membership, link the identity automatically,
or bypass a gate. Clearly distinguish link expiry, an outstanding access request,
and a connection failure, and provide the next action for each.

## 8. Make the first conversation easy and optional

After connection verification and required identity linking, suggest one concrete
message. Use the simplest interaction the provider and adapter actually support:
a real @mention where supported, a command when necessary, or an email recipient,
subject, and short body. Do not force a slash command merely because identity
linking used one. For mentions, explain selecting the real bot from suggestions
when copied plain text alone is insufficient.

Give a compact sequence: open/prepare the destination, send a copyable message,
then continue in the thread or reply mechanism that preserves the conversation.
Avoid a second generic Open Provider button when the instructions already convey
this. Remove filler such as “Complete this real conversation to finish setup.”

Detect the current linked user's first qualifying message automatically and show
a checkmark when observed. Keep a manual “I've sent the test message” action and
a way to finish without the optional test. Do not block completion solely because
the event has not arrived or the status poll failed. Conversely, optional testing
does not waive required credentials, verification, or identity authorization.

## 9. Make ongoing management compact and contextual

After setup, replace Browse/Review with the connection's Settings, Access,
Conversations, and Activity navigation. Use real links and the shell's own
navigation components so labels and selection survive production layouts and
mobile drawers. Avoid duplicate tab navigation in the content area.

- **Settings:** Repeat the simple first-message instruction with a copy icon. Use domain labels such as “Allowed Channels” instead of vague “Destinations” when accurate. Keep permissions, reconnect, and installation concepts distinct.
- **Access:** Put instructions for other people to connect here, alongside the unlinked-person policy and identity links. Explain the practical permission effect without repeating abstract identity-model copy.
- **Conversations:** Follow task-list visual conventions in a compact row: provider icon, channel/destination, task title, provider link near the destination, task link near the title. Preserve separate meaning from a task list; adapt cleanly on mobile.
- **Activity:** Use scannable event rows, precise timestamps, clear outcomes, and actionable errors. Paginate older activity. First-page updates must not reset someone reading an older page. Keep connection health and lifecycle controls secondary, such as in an expandable section.

Remove routine “Active” badges from shared headers and conversation rows.
Highlight meaningful exceptions such as paused, revoked, or failing states where
a user can act on them.

Health must describe evidence, not assumptions. An unobserved optional callback
is not a failure. Distinguish unverified, working, and changed/broken configuration.
HTTPS termination at a trusted deployment boundary must not create false URL-drift
warnings for the internal HTTP hop; continue detecting genuine host, port, and
path changes. Keep callback verification evidence separate for distinct surfaces.

On a claimed Cloud instance, callback health can use the public host forwarded
by the gateway after the provider authenticates the request. These hints are
diagnostic evidence only: they must not affect authentication, routing, or the
configured callback URL. Self-hosted instances continue using the request URL.
Preserve gateway observations in dedicated diagnostic headers when another
provider proxy replaces standard forwarded headers before reaching the tenant.

## Apply and verify

For a requested redesign, identify the relevant principles and fix the concrete
flow. Do not expand a narrow UI request into transport replacement, a new auth
system, or a repository-wide redesign. Keep API contracts synchronized when the
UX actually needs backend behavior.

Exercise the affected states: fresh setup, back/resume, external handoff,
misplaced credentials, pending/failed verification, unlinked/linked identity,
nonmember access requests, optional message detection, and populated management
pages. Pick the relevant states for the change rather than running every scenario
for a text edit. Check mobile layout, standard field contrast, visible help icons,
and footer alignment in each affected conditional state. Validate provider
behavior with real evidence when available and authorized; distinguish mocked
browser coverage from a live provider test. Do not send real messages, install
external apps, or modify memberships without authorization from the task.

## Provider adaptation

Use these as design prompts, not a current provider API specification. Verify the
selected adapter and official provider documentation before implementing steps,
links, credential validation, or test-message instructions.

| Decision | Slack lesson | Transfer to other providers |
| --- | --- | --- |
| Step boundaries | App creation, credentials, verification, linking, and testing became separate steps. | Separate distinct actions, not every field. An OAuth-only provider may need fewer steps; bot creation elsewhere may need a dedicated handoff. |
| Editable identity | App name, bot display name, command drive the same manifest. | Expose only editable properties supported by that provider. Keep creation artifacts and later instructions consistent with saved values. |
| Credential acquisition | Bot token and Signing Secret live on different screens. | Use the provider's exact credential labels and locations. An API key, bot token, application secret, and signing secret are not interchangeable. |
| Reachability | HTTP callbacks need provider-reachable HTTPS. | Derive the prerequisite from the actual delivery mechanism. Outbound sockets or polling do not automatically require an inbound public URL. |
| First message | Prefer a real @mention for normal conversation. | Prefer the provider's simplest supported trigger. Never offer a mention if privacy rules or the adapter prevent receiving it. |
| Identity link | A private connect action links a person to their Paperclip account. | Use a provider-supported private interaction or equivalent verified confirmation. Do not assume slash commands, ephemeral replies, or DMs exist everywhere. |
| Ongoing scope | “Allowed Channels” makes the policy concrete. | Use the relevant destination noun: channels, groups, repositories, chats, or mailboxes. Show only scope controls the integration enforces. |

### Discord example

Keep provider app/bot creation and installation to a server understandable as
distinct actions if the supported flow requires both. Put each credential beside
its own retrieval instructions. Do not borrow Slack's signing-secret or manifest
steps. Account linking and the message test should reflect the supported private
interaction and mention/thread behavior. Explain any channel permission or event
subscription prerequisite before asking for a message that depends on it.

### Telegram example

Center setup on the actual bot-creation and token-acquisition flow. If no separate
manifest or public callback action is required for the selected transport, omit
those steps. Verify what reaches the bot in private chats versus groups before
choosing a test instruction. A provider's privacy mode may require a command or
reply instead of an ordinary mention. Use the actual bot username and keep
personal linking distinct from sending a task request.

### AgentMail / email example

Use mailbox and sender language rather than bot/channel terminology. If the
integration provisions the mailbox inside Paperclip, do not invent an external
app-creation step. Supply the actual email address and a short copyable test
subject/body, and explain how replies continue the conversation. Verify how the
integration authenticates senders and grants authority; a displayed From address
alone must not automatically establish a Paperclip identity. Apply the same
pending/success feedback, optional test, and member-access boundaries using the
email integration's actual mechanisms.

### Review examples

- **One-token setup:** A short agent → credentials → identity → test flow can be better than six mostly empty screens.
- **Already installed:** Resume at credentials or verification as appropriate; do not require another installation. Keep prior app details reviewable without silently changing registration.
- **Working behind HTTPS proxy:** Show successful verified traffic truthfully. Hide raw URL repair instructions unless there is a real mismatch; do not discard host/path checks to silence a warning.
- **Signed-in newcomer:** Let a valid private invitation request membership without exposing normal organization UI or granting agent authority. After approval, explicitly confirm the identity.
- **No test event yet:** Keep waiting feedback and manual completion available when prerequisites are satisfied. Do not mark another person's message as the configuring user's success.

The intended result is consistent interaction and permission semantics across
providers, with instructions and step count tailored to each real workflow.

## Agent avatars in provider setup

Offer the selected agent's existing avatar as a downloadable image when the
provider supports a custom bot image. Keep manual upload instructions next to
the download, use the saved provider app name, and distinguish user confirmation
from provider verification. Keep a download in connector Settings so skipping
the optional setup step does not hide it permanently.

Slack uses a 512 × 512 PNG from the existing avatar renderer. Its optional step
comes after connection verification and before personal account linking. Upload
the file through Basic Information → Display Information → App icon & Preview,
confirm the crop, then save in Slack. Confirmation/skipping is browser-local,
scoped to the company and endpoint; it is not proof of a Slack configuration
change. No new Slack scope or API mutation is needed.
