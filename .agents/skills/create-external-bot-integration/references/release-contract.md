# Release contract and provider discovery

## Contents

- [Make the requested outcome testable](#make-the-requested-outcome-testable)
- [Define capability parity rather than promising “full-fledged”](#define-capability-parity-rather-than-promising-full-fledged)
- [Research only what can change the next decision](#research-only-what-can-change-the-next-decision)
- [Choose the execution model once, using stated criteria](#choose-the-execution-model-once-using-stated-criteria)
- [Keep a finite delivery sequence](#keep-a-finite-delivery-sequence)

## Make the requested outcome testable

An external bot is an existing agent whose execution is hosted elsewhere. It may
have memory, a browser, skills, accounts, and tools Paperclip neither supplies nor
controls. Decide whether this integration connects that existing agent or creates
a separate API agent. They can have different identity, billing, tools, and memory.

Do not substitute a provider's generic agent API for the user's personal bot
without making that distinction explicit. Dot's initial investigation considered
both; the user wanted the actual existing Dot.

Use this contract in the task or existing implementation plan:

```text
Provider / existing bot or newly created API agent:
Ordinary entry point and target users:
Release targets: self-hosted / Cloud / both:
Transport outward / return channel / provider evidence:
Paperclip acting identity and company/agent mapping:
Paperclip-originated work acceptance journey:
Bot-originated idle work acceptance journey:
Native tools policy:
Required Paperclip capabilities / explicitly deferred capabilities:
Workspace access and execution placement:
Allowed human setup steps:
Connection lifetime / revocation / subscription renewal:
Latency, concurrency, run duration, resource and test-spend bounds:
Provider controls unavailable or unknown:
Target deployment and authorization already established:
Finish line and evidence required:
Next critical-path gate / owner / action:
```

Fill from context and supported defaults. Ask only where an unknown changes the
product, authority, cost, or acceptance. Do not turn the template into a mandatory
questionnaire. If the user says “two way,” keep both directions in the finish line.
If Cloud is deferred, state that before delivering an apparently complete agent.

## Define capability parity rather than promising “full-fledged”

For each area, mark Required, Optional, Deferred, or Provider unavailable. Add
whether it works idle, during a run, after completion, and after revocation.

| Area | Questions that affect implementation |
| --- | --- |
| Identity | Is the caller a company agent or a human's personal assistant? Can one external bot bind multiple agents? |
| Idle intake | Can the bot create governed work when no task is assigned? Does the user see the intake and its attribution? |
| Coordination | Search/read tasks; create and assign to agents or people; comment and edit authorized cross-task documents? |
| Native tools | Can the bot use its existing Slack/browser/computer? What permissions remain provider-owned? |
| Assigned tools | Pinned Paperclip skills, gateway apps, dynamically granted tools, permission changes during a turn? |
| Attachments | Which task/company files may leave Paperclip, how are pages/integrity checked, and can access be revoked mid-read? |
| Workspace | Files, shell, Git, artifact publishing; whose machine; explicit settings; which platforms? |
| Human interaction | Questions, approval requests, replies, denial, resumption, and visibility in the task thread? |
| Lifecycle | Follow-up, interruption, cancellation, restart, reconnect, lease renewal, and a terminal failure path? |
| Observability | Acceptance, progress, operation results, persisted output, task disposition; which provider data is absent? |
| Economics | Provider usage/cost versus managed Runner cost; admission budget checks when provider usage is unknown? |
| Identity presentation | Provider logo, agent name/avatar, export/import portability; optional profile work must not block connection. |

Three separate grants deserve explicit treatment: persistent agent connection,
access to task attachments, and Paperclip workspace execution. One does not imply
the others. For Dot, attachment and workspace settings were independently off by
default and were never inherited automatically by a newly hired teammate.

## Research only what can change the next decision

Use official provider docs and current code. Record the source, date, fact, and
remaining experiment. Classify claims as documented, observed with real provider,
simulated, inferred, or unknown. Search for these capabilities before selecting:

- Direct create/message/status/cancel APIs for this exact kind of agent.
- Out-of-band events, subscription discovery/renewal, callbacks and verification.
- In-session notifications versus wakeup when no live conversation is connected.
- Bot-to-bot mentions, DMs, channel permissions, and automated-message filtering.
- Tool/plugin installation, OAuth discovery, public-client support, runtime loading.
- Structured tool calls/results, correlation IDs, idempotency, and result polling.
- Provider-native session identity, resume, interruption, usage, and rate limits.
- Private testing, workspace distribution, public review, and account/admin limits.

An HTTP success from a notification endpoint proves receipt at that layer. It
does not prove that the agent woke, loaded tools, accepted work, or finished.
Browser automation can help investigate and qualify setup; do not accidentally
make an undocumented UI automation path the production transport.

For a proposed chat transport, send one authorized synthetic automated message
and require the bot's correlated callback. A human-written mention succeeding is
not evidence that messages from another bot will wake it.

## Choose the execution model once, using stated criteria

Paperclip's established preference is shared Runner infrastructure for remote
agents. It preserves existing lifecycle/receipt semantics and a sandbox boundary
if workspace capabilities are granted later. Remote reasoning does not eliminate
the need for run coordination, nor does using Runner imply local model execution.

Evaluate alternatives against common admission/finalization, authority, recovery,
compute waiting cost, operating complexity, and future workspace requirements.
Document the choice and trigger for revisiting it. Do not alternate between a
Runner, worker fleet, and database-only backend just because each was questioned.

For the Dot Cloud release the decision was one managed Runner per admitted
assignment, no sandbox for idle MCP traffic, and no exposed workspace tools. It
accepted compute while waiting as the cost of reusing the normal lifecycle.
Do not generalize “one sandbox per assignment” to providers/releases that have an
explicitly different approved execution contract.

## Keep a finite delivery sequence

1. **Feasibility:** actual provider wake/read/report loop on synthetic data.
2. **Governed vertical slice:** normal task + idle intake through actual Runner.
3. **Product onboarding:** natural entry, copy prompt, real watched readiness.
4. **Reliability:** duplicate/lost response, follow-up race, restart, stop, cleanup.
5. **Selected capabilities:** native apps, assigned apps/skills/files as promised.
6. **Deployed acceptance:** ordinary app image, Runner artifact, tenant ingress.

Some work can overlap; the key is not building a broad tool catalog before the
uncertain provider boundary and both entry paths work. Split reviewable changes
when they span app, ingress, execution, or broad authority changes. Record their
dependencies instead of declaring an arbitrary count of PRs required.

Useful final acceptance statement:

> On the named Cloud tenant and immutable candidate, a new user can invite the
> existing bot with the generated prompt and one scoped consent approval. Without
> a chat nudge, an ordinary assigned task saves a verifiable result and completes.
> From idle, the bot can initiate work and assign a task to the responsible human.
> A follow-up and real controller restart preserve one assignment. Revocation
> denies further Paperclip actions, and every managed resource is accounted for.

Adapt this to the actual release. If plugin attachment or reboot is required,
include it as a supported visible step or report an onboarding gap; do not claim
the stricter prompt-only journey passed.
