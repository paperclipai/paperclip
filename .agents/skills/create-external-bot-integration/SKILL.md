---
name: create-external-bot-integration
description: >-
  Build and qualify external bots such as Dot in Paperclip. Use for two-way work,
  invitation, identity, wakeup, Runner lifecycle, native tools, recovery, and
  Cloud delivery. CLI adapters and app-only connectors use their existing skills.
---

# Create an External Bot Integration

Make an existing external agent a useful Paperclip participant: Paperclip can
assign work to it, and it can initiate governed work from its own conversation.
It uses its relevant native capabilities, returns inspectable results to
Paperclip, and participates in normal admission, authority, and finalization.

This workflow incorporates the September 30–October 9, 2026 Dot integration.
Provider facts and code paths in the references are dated evidence, not a claim
that every future bot supports the same APIs. Verify the current implementation
and official provider documentation before choosing a transport or changing code.

## 1. Establish the release contract before narrowing the implementation

Read [release-contract.md](references/release-contract.md). Infer already-stated
requirements and authorization from the conversation. Ask only about consequential
unknowns; do not ask the user to repeat “two way,” Cloud, or use of Runner.

Record the target environment, acting identity, capabilities, allowed human setup
steps, delivery/stop expectations, and checkable finish line. Keep one compact
matrix in the existing plan or task. Follow repository conventions if creating a
plan file. “Works” must name its level: prototype, real provider, real Runner,
managed sandbox, deployed tenant, or unattended first-time onboarding.

Reuse the current implementation and qualification evidence. Inspect the relevant
checkout, instructions, app/Cloud PRs, and Runner artifact. Do not recreate work
already merged or apply an old plan to a different deployed revision.

## 2. Prove the uncertain provider boundary first

Identify supported ways to authenticate, wake the agent, load tools, correlate
work, return results, and stop or revoke authority. Check events/subscriptions as
well as direct APIs and chat channels. Do not assume that a bot mention wakes
another bot, that MCP notifications wake an offline agent, or that a plugin listed
in settings is callable in the agent's current conversation.

Use a synthetic company and stable public HTTPS endpoint. Start with a scripted
client for deterministic protocol tests, then the actual provider account:

1. Fresh connection → callable read tool → verified event round trip.
2. Paperclip assignment → autonomous acceptance → persisted result → finalization.
3. Idle bot request → one governed intake → useful action → finalization.

If idle autonomy is in scope, the third journey is a first milestone, not an
optional expansion. Do not make the user create a placeholder task for the bot.
Label every nudge, operator repair, simulated dependency, and manual tool call.
A successful assisted run does not prove prompt-only first-time setup.

## 3. Reuse Runner while keeping placement and capability separate

Read [runner-architecture.md](references/runner-architecture.md) before changing
execution or authority. For Paperclip, prefer the existing Runner infrastructure:
shared lifecycle, receipts, recovery, and a future sandbox boundary for workspace
tools. The bot's model and native tools can remain entirely at its provider.

Use the ordinary configured managed execution environment on Cloud. One admitted
assignment reuses its Runner across messages and tool calls; idle connection
traffic does not allocate compute. A sandbox hosting Runner does not grant the
bot filesystem or shell access. Never add a fallback to the control-plane host.

Implement dedicated agent identity, durable assignment/operation state, current
authority checks, and normal finalization. Treat a proposed alternative backend
as an explicit architecture decision with preserved invariants and evidence of
benefit, not as a reaction to the latest question about overhead.

## 4. Build onboarding as a watched, resumable workflow

Read [onboarding-and-prompts.md](references/onboarding-and-prompts.md). Start at
the natural UI entry: invite an external agent, select the provider, copy a setup
prompt, give it to the bot, and watch real connection checks. Reuse the product's
copy-prompt component and provider-independent invitation flow.

Distinguish OAuth grant, runtime tool availability, subscription verification,
event confirmation, and agent readiness. Generate or renew pending prompts
automatically where safe; preserve connected agents. Finish with an explicit Done
action. Use stories for waiting, expiry, errors, pause, readiness, and recovery,
then verify the real rendered transitions and persistence.

The prompt must tell the bot to use its own relevant tools/apps/skills and return
results. The Paperclip catalog governs Paperclip calls, not the bot's entire
runtime. Limit qualification restrictions to the specific test and Paperclip
destination. Never turn “use this test connection” into “use no other tools.”

## 5. Qualify both correctness and the ordinary user experience

Read [conformance-tests.md](references/conformance-tests.md) and select the rows
required by the release contract. Reuse existing Runner and Product E2E fixtures;
add regression cases for uncovered contracts instead of building a parallel test
system. Keep simulated protocol, actual provider, and actual deployment evidence
separate. A provider saying “done” is not proof of task disposition or cleanup.

Test a lost response, duplicate wake, follow-up at completion, real controller
restart, authority loss, and cleanup. For recovery, compare the original run,
assignment, session, process identity, and lease. A restart test in which the
controller never restarted is invalid. Unknown mutation outcomes require
reconciliation, not a new request ID and a second execution.

If setup needs a reboot, app reattachment, or manual inbox nudge, record the
functional success and the remaining onboarding defect separately. Do not quietly
teach the tester to navigate around a product defect and then call it self-serve.

## 6. Deliver one identifiable candidate and verify the deployed path

Read [troubleshooting-and-deployment.md](references/troubleshooting-and-deployment.md)
when setting up a test drive, diagnosing a failure, or deploying. Preserve one
environment manifest: checkout/revision, origin, local port, data directory,
tenant, image/Runner artifact, active task, and owned resources. Keep secrets out.
Retain the environment while the user/provider is testing; do not expire it
silently or reset the OAuth database behind a cached client registration.

Use the repository's adapter, eval, PR, and release workflows when available.
The Paperclip `create-agent-adapter` skill covers shared configuration surfaces;
`paperclip-runner-release` coordinates a release; `test-it-for-real` validates the
actual experience. Discover their installed locations rather than assuming they
are siblings of this skill. This skill adds external-bot-specific contracts.

Carry authorized merge and rollout through the app, ingress, and Runner artifact
dependencies. Verify the serving revision and repeat the main journeys on the
real tenant with ordinary defaults. Distinguish implementation defects, provider
behavior, infrastructure failures, and test/evidence defects. Bound retries by
the operation and observed cause; preserve the same resumable deployment request.

Report supported capabilities, exact live evidence, interventions, unsupported
provider controls, remaining gates, and resource disposition. Never equate unknown
cost with zero cost, or revoked Paperclip access with confirmed global bot stop.
This skill supplies procedure, not new permission to message, grant access, spend,
publish, or deploy. Apply the current user's authorization and host policies.

## References

- [Release contract](references/release-contract.md): scope, capability matrix,
  provider research, architecture decision, and finish-line template.
- [Runner architecture](references/runner-architecture.md): identity, state,
  admission, receipts, follow-ups, recovery, files, and concrete Paperclip anchors.
- [Onboarding and prompts](references/onboarding-and-prompts.md): UI states,
  consent, lifetime, tool loading, native capabilities, and reusable prompt text.
- [Conformance tests](references/conformance-tests.md): runnable journey recipes,
  failure matrix, evidence schema, and release gates.
- [Troubleshooting and deployment](references/troubleshooting-and-deployment.md):
  network planes, specific symptom-to-action diagnostics, stable environments,
  managed execution, and release provenance.
- [Dot case study](references/dot-case-study.md): dated incidents, exact historical
  protocol/tool names, observed limitations, and source trail. Read when comparing
  a new provider to Dot or checking why a rule exists.
