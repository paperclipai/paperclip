# Chat and email connections

Read this **only when the provider is a chat or email provider** — Slack,
Discord, Telegram, AgentMail, and others with comparable capabilities. Most
connector work never needs it, and imposing Slack's steps on a provider that
does not work that way is one of the failure modes the guide exists to prevent.

The authority is
[`doc/connections/CHAT-CONNECTOR-UX.md`](https://github.com/paperclipai/paperclip/blob/master/doc/connections/CHAT-CONNECTOR-UX.md),
added by PR #13675 and merged at `c9e867797939fe069278c4ae660f86f7692ed866`.
Read it at the commit you are working against and record that commit. This page
is the routing layer and the self-hosted reachability rules; it is not a
substitute for the guide.

## Three things that are routinely conflated

Keep them separate in your plan, your UI, and your evidence. The guide is
explicit that they establish different things.

| Concern | Question it answers | Failure if merged |
| --- | --- | --- |
| **Resource setup** | Is the provider app/bot/mailbox created, credentialed, and delivering to this instance? | A working bot that no individual can actually address. |
| **Personal identity linking** | Which Paperclip person is this external account? | Someone inherits another person's authority by sending a message. |
| **Company membership** | Should this external person have any authority here at all? | A stranger in a shared channel acts as a member. |

New connections deny unlinked people by default; linking requires ownership
confirmation; nonmembers request access before receiving authority
(`CHAT-CONNECTOR-UX.md#apply-and-verify`). An optional message test must never
become an unexplained completion gate.

## Establish the delivery mechanism before you promise a prerequisite

This is the step that decides whether a self-hoster can use the provider at all.
Ask the provider's own documentation, not another provider's wizard:

> Whether inbound delivery needs a public HTTPS callback, an outbound socket,
> polling, or another mechanism. — `CHAT-CONNECTOR-UX.md:18-22`

Then apply the deployment matrix in
[`deployment-support-matrix.md`](./deployment-support-matrix.md):

| Mechanism | Self-hosted, same machine | Self-hosted, server/VPS | Paperclip Cloud |
| --- | --- | --- | --- |
| Public HTTPS callback | `unsupported` without a public origin | Works only with a genuinely public HTTPS origin | Cloud supplies HTTPS |
| Outbound socket | No public origin needed | No public origin needed | Supported |
| Polling | No public origin needed | No public origin needed | Supported |

Two rules the guide states and this skill enforces:

- **Having HTTPS is not being reachable.** "A private-network HTTPS URL alone is
  not proof of public reachability" (`CHAT-CONNECTOR-UX.md:77-79`). A tailnet
  certificate does not satisfy a provider that has to POST to you from its own
  infrastructure. Verify with observed inbound traffic, not with a green
  padlock.
- **Do not require a public URL for a connector that does not use public
  callbacks** (`CHAT-CONNECTOR-UX.md:81-82`). Showing a public-origin
  prerequisite on a socket-based provider tells a self-hoster their deployment
  is unsupported when it is not.

When the provider genuinely needs a public callback and the operator is
self-hosting, say so plainly and link maintained setup documentation. Cloud
"supplies HTTPS" is a fact worth stating; it is not the only answer, and it must
not be the only answer offered (`CHAT-CONNECTOR-UX.md:82-84`).

Never propose a tunnel, a relay, or a guard exception to work around
reachability. Report the gap.

## What this changes in the skill's steps

- **Step 2 (where this runs)** additionally establishes the inbound mechanism
  and, if it is a callback, whether the origin is publicly reachable from the
  provider — tested, not assumed.
- **Step 4 (configure)** keeps identity linking and membership approval as
  separate actions from resource setup, and does not treat the optional
  conversation test as a completion gate.
- **Step 5 (verify)** adds one requirement to the real-agent-run evidence: an
  incoming message *and its reply* must correlate to the same task. The runbook
  names this in its runtime-delivery row —
  "Chat/email also routes an incoming message and its reply to the same task."
  Distinguish live events from simulated ones, and distinguish an optional
  unobserved callback from a real failure.

## If you are designing the setup UI

You are past this skill's boundary. The wizard conventions — stable numbered
steps, the single step-owned footer with **Save & exit** left and the primary
action right, prerequisites first on a tinted background, help icons on
credential fields, manifests behind a modal rather than inline, resume across
back navigation and external provider visits — all live in the guide, with
`DESIGN.md` for components and tokens. Follow it there; do not re-derive it.
