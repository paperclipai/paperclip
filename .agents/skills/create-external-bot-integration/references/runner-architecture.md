# Runner architecture and correctness boundaries

## Contents

- [Separate the bot, connection, controller, and workspace](#separate-the-bot-connection-controller-and-workspace)
- [Identity and authority](#identity-and-authority)
- [Durable state and operation contract](#durable-state-and-operation-contract)
- [Follow-up delivery must be coordinated with ordinary wake scheduling](#follow-up-delivery-must-be-coordinated-with-ordinary-wake-scheduling)
- [Recovery needs identity evidence, not merely a reachable process](#recovery-needs-identity-evidence-not-merely-a-reachable-process)
- [Revocation and native powers are different boundaries](#revocation-and-native-powers-are-different-boundaries)
- [Files and commands are a separate capability decision](#files-and-commands-are-a-separate-capability-decision)
- [Paperclip implementation anchors](#paperclip-implementation-anchors)

## Separate the bot, connection, controller, and workspace

```text
External provider
  Bot: reasoning, native browser/computer/apps, private memory
           | authenticated tools / signed wake events
Paperclip control plane
  MCP + OAuth + pairing + durable mailbox + operation broker
           | authenticated Runner protocol
Managed execution environment (Cloud)
  Rust Runner: assignment lifecycle, catalog validation, durable receipts
           | semantic tool requests / correlated results
Paperclip authority services
  Task/company permissions, mutations, app gateway, result finalization
```

Application tools execute through the existing authorized services. If filesystem
or shell tools are enabled, their execution target must be the assigned confined
workspace. Moving Rust into a sandbox does not magically move a server-side file
handler there. Trace the actual effect destination for every workspace operation.

Dot's model runs at OpenAI. Runner does not create its personal memory, run its
model, control its computer, or guarantee interruption of other native tools.
Do not invent model/session/usage fields to satisfy a local-provider schema.

## Identity and authority

Use a dedicated agent-purpose grant/resource where the provider is acting as an
employee. Personal assistant grants must not silently supply board/operator
permissions to a run. Bind authorization to company, agent, active grant, binding
generation, assignment, and run/turn. A supplied companyId or agentId is not proof
of authority. Recheck live permissions at execution and before returning protected
data, not only at initial pairing.

Pairing uses an operator-issued, expiring, one-use capability for a specific
agent. Redemption checks current membership/role, feature prerequisites, agent
lifecycle, company/resource hints, expiry and revocation. Preview does not consume
the code. Grant creation, code consumption, and saving the binding reference must
be atomic. Otherwise setup can display ready while the scheduler still sees an
unpaired agent. Saving the form a second time is not an acceptable hidden step.

Persistent connection identity and per-turn mutation authority are different:

| Request | Expected behavior |
| --- | --- |
| Pair, inspect own capability/inbox status | Connection-scoped operation; no managed assignment needed. |
| Start work while idle | Durable, agent-attributed intake; ordinary admission before task mutation tools. |
| Read/accept offered assignment | Current binding and offer, explicit acceptance, no arbitrary run selection. |
| Invoke a task/app tool | Same admitted assignment and live permission checks; normal receipts/audit. |
| Update own optional avatar | Narrow self-only operation; do not grant generic agent-config authority. |
| Finish | Accepted canonical result, settled required operations, normal task finalizer. |
| Acknowledge a fence | Narrow control operation may remain available while task tools are denied. |

Idle intake must retain plugin/environment context from the configured application
services. In Dot, constructing a separate heartbeat service without the sandbox
plugin registry made idle requests fail even though operator-assigned work ran.
Test both entry points against the same managed environment.

## Durable state and operation contract

Persist distinct facts for grant/binding, subscription, mailbox item, assignment,
operation receipt, run/controller ownership, and final result. Avoid a single
boolean “connected” or “done.” Enforce active-assignment concurrency in storage
as well as the UI. Dot's initial contract allowed one active assignment per binding.

An illustrative lifecycle is:

```text
intake/admission pending -> offered -> accepted -> working -> result accepted
  -> turn finished -> task disposition committed -> resource cleanup
```

Any active phase can instead become fenced, expired, failed, or reconciliation
required. These are conceptual states; use the repository's actual enums.

Every side-effecting external request needs a stable request identity plus an
argument digest and authority generation. Implement these semantics:

- Same identity + same arguments: return the same pending/settled receipt.
- Same identity + different arguments: reject a conflict.
- Completed intake retried: return its original receipt, never another task.
- Old authority generation: deny new execution, even if a historical receipt exists.
- Definite read failure: terminal bounded error; later tools and finish can proceed.
- Effect possibly happened but result was lost: explicit unknown/pending outcome
  and reconciliation. Do not reissue under a fresh ID to make progress.

Persist reservation before effects where appropriate. Use existing transactional
mutation receipts and external-effect reconciliation. Do not promise universal
exactly-once execution across arbitrary remote services. Distinguish command
acknowledgment from completion of the tool's effect.

Do not block the Runner command lane waiting for a semantic tool result delivered
on that same lane. Reserve/admit promptly, deliver a pending receipt, then settle
with a correlated event. Bound pending operations, results, bytes, and authority
duration. Pagination and control acknowledgments must still work at limits.

Serialize mailbox cursor visibility with writers so a cursor cannot skip a result
whose transaction commits later. Wake events should contain references, not task
contents, credentials, or copied app data. An event receiver drains the durable
mailbox and validates current authority rather than trusting a stale event body.

Treat event callbacks as an authenticated protocol, not arbitrary URLs to POST to.
Use the provider's current ownership challenge and signing specification. Keep
callback signing material out of prompts, descriptors, logs and task data. Enforce
the callback destination policy, including redirect and DNS/IP handling, so a
subscription cannot turn the control plane into an internal-network request proxy.
Apply bounded delivery timeouts/retries and record failures without logging secrets.
Where receiving signed callbacks, validate the expected signature, timestamp and
replay policy before changing state. Test the actual directions this provider uses;
do not invent a symmetric webhook API merely because the integration is two way.

## Follow-up delivery must be coordinated with ordinary wake scheduling

A normal comment can enter two paths: active-assignment mailbox delivery and the
ordinary scheduler. If both remain independent, a finished bot can receive a
second assignment for a comment it already handled. If the normal wake is simply
discarded when the mailbox entry is made, the comment can be lost at completion.

The Dot fix retained the normal wake as deferred until the bot successfully read
that exact comment ID through `get_task_history`. Then the existing run consumed
it. If the assignment ended before the read, normal admission kept the unread
comment for another turn. An inbox reference or webhook acknowledgment did not
prove the comment was read.

Test both sides of this race, including controller recovery. Keep explicit new
session requests, interaction replies, and self-authored comments under their
normal policy; don't blanket-suppress every wake for a connected bot.

## Recovery needs identity evidence, not merely a reachable process

Record and compare the run, session, assignment, binding generation, controller
generation, managed lease, process marker, and trustworthy process birth identity.
On Linux the process fingerprint can include boot identity and start information.
Read remote identity from the sandbox, not a same-numbered PID on the controller.

Before advertising external work, require the evidence needed to recover it.
Recovery reads the checkpoint from the owning execution target and validates it
against saved authority. Missing/invalid state after dispatch fails closed for
reconciliation; a new process or conversation must not masquerade as a resume.

Incoming operations need a durable draining/replay mechanism owned by the current
controller. An in-memory forwarding optimization alone can leave valid requests
stranded after restart. Fence old controllers and callbacks so a late result
cannot overwrite the new generation's journal. Preserve late effect evidence.

A verified terminal/shutdown receipt can establish a clean exit when a remote
monitor lacks an exit code. An unexplained process exit still requires recovery.
Configure a bounded reconnect grace consistent with the deployment lifecycle;
Dot used five minutes after shorter restart gaps exposed failures. Do not copy
that number as a universal provider requirement.

Terminal run reconciliation must clear/fence a still-active assignment, notify the
bot, and release resources. Otherwise a failed run can block every future task
even though its old tools are already denied.

## Revocation and native powers are different boundaries

Cancellation, pause, reassignment, membership loss, expired run authority, and
grant revocation must prevent subsequent Paperclip effects. Cached tool results
or UI binding references cannot restore revoked access. Old-grant revocation must
not revoke a replacement binding accidentally.

Report “Paperclip authority revoked” separately from “external bot stopped.” A
fence acknowledgment proves receipt, not termination of all provider activity.
Likewise, sandboxing the Paperclip Runner does not confine the bot's native Slack
or provider computer. Those tools retain their own permissions. If strict total
capability isolation is required, use a suitably isolated bot/account and verify
the provider's actual controls; Paperclip cannot enforce it with prompt text.

## Files and commands are a separate capability decision

Do not add workspace tools merely to make an external agent look like a coding
CLI. A bot can research or write code on its own computer without Paperclip
workspace access. The first Dot Cloud release intentionally offered none.

When the release includes workspace tools:

- Resolve paths within the admitted workspace; reject traversal, absolute paths,
  symlinks/escapes, and Paperclip instance state such as `.paperclip`.
- Check reads, writes, API downloads, uploads, and artifact publication. A generic
  `call_api` path must not bypass attachment/workspace grants.
- Serialize optimistic hash checks with writes. Two concurrent writes must not
  both commit against the same observed hash.
- A process working directory is not a sandbox. Use a proven OS/container boundary;
  test outside-workspace access, environment secrets, detached descendants, timeout,
  cancellation and cleanup. No unrestricted fallback when confinement is unavailable.
- In the historical Dot implementation, Linux used bubblewrap/private PID
  namespaces. macOS command execution was disabled after detached descendants
  escaped reliable supervision; file tools and artifacts remained available.
- For attachments, enforce current task/company, bounded pages and total bytes,
  integrity checks, and live revocation before returning each page. Treat filenames
  and contents as untrusted data. Test the generic API escape path too.

## Paperclip implementation anchors

Paths below existed in the qualified October 9 candidate. Locate their current
equivalents before editing; do not paste line numbers from historical notes.

| Concern | Historical anchor |
| --- | --- |
| Bot broker and tool definitions | `server/src/services/dot-runner-broker.ts` |
| Prototype public MCP bridge | `server/src/services/public-mcp/dot-runner.ts` |
| Rust assignment backend | `packages/paperclip-runner/runner/crates/runner-core/src/dot_provider_backend.rs` |
| TypeScript Runner driver | `packages/paperclip-runner/src/drivers/dot/runnerd-dot-driver.ts` |
| Driver/backend selection | `packages/paperclip-runner/src/backends/native-backend-factory.ts` |
| Per-turn instructions | `packages/paperclip-runner/src/backends/runtime-context.ts` |
| Governed tool authority | `server/src/services/native-runtime/paperclip-runner-tool-authority.ts` |
| Admission, wake, terminal reconciliation | `server/src/services/heartbeat.ts`, `server/src/services/heartbeat/queue.ts`, `server/src/services/heartbeat/run-lifecycle.ts` |
| Real Rust/DB and managed qualification | `server/src/__tests__/dot-runner.test.ts` |

Keep the standalone Runner package independent of server/DB implementation
imports. Extend the actual production backend and negotiated capability contract,
not just a convenient reference harness.
