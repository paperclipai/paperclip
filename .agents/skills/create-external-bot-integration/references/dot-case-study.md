# Dot integration: dated case study and source trail

## Contents

- [What the user actually wanted](#what-the-user-actually-wanted)
- [Incidents and the reusable judgment](#incidents-and-the-reusable-judgment)
- [Historical Dot protocol and tools](#historical-dot-protocol-and-tools)
- [What was and was not proven](#what-was-and-was-not-proven)
- [Sources and how to inspect them](#sources-and-how-to-inspect-them)

This is evidence from September 30–October 9, 2026, reviewed from raw records on
October 13. It is not current provider documentation or permission to repeat old
operations. Use it to recognize failure modes and locate prior implementation.
No credentials, pairing codes, temporary ingress hosts, or personal app contents
are retained here.

## What the user actually wanted

- The existing personal Dot, not a replacement generic API agent.
- Paperclip could initiate work; Dot could read/write and initiate work while idle.
- Shared new Runner infrastructure.
- Eventually a full company participant: people, tasks, skills, apps, optional files.
- An external-agent invitation with a copy prompt and live checks.
- Persistent Paperclip connection until revoked.
- Cloud deployment with managed execution and no arbitrary host execution.
- Dot uses its own relevant tools and returns the result to Paperclip.

Idle autonomy was explicit on day one and in the first production plan. Shipping
task-only access was an implementation omission, not missing user specification.
Cloud-first delivery, exact capability parity, allowed setup interventions, and
latency/concurrency needed an earlier explicit release contract.

## Incidents and the reusable judgment

| Date / incident | Observed outcome | Rule carried into this skill |
| --- | --- | --- |
| Sep 30: initial research favored Slack / another agent API | User pointed out MCP Events; official docs then supported testing that route. | Search server-initiated events before choosing transport; existing personal bot is a different product from an API agent. |
| Oct 2: lab assumed OAuth request ID was UUID | Real consent failed; request ID was opaque. | Preserve protocol identifiers as specified. |
| Oct 2: DB restart erased cached client registration | Provider returned unknown client/redirect; reconnect state had drifted. | Stable fixture includes registration and public origin, not just app health. |
| Oct 2: settings listed tools, Dot could not call them | Endpoint was stopped; Dot loaded actions later; replacement lab completed arithmetic round trip. | Keep test service alive during provider setup; test actual runtime invocation. |
| Oct 3: production Runner implementation | Rust/DB integration worked, but the new endpoint still lacked real-account qualification. | Reference harness, production Runner, and actual provider are distinct proof levels. |
| Oct 6–7: merged MCP gateway integration | Reused consent, verification, refresh, revocation; fixed normal shutdown race. | Reconcile shared infrastructure and its contracts instead of retaining a forked prototype. |
| Oct 7: public Tailscale metadata worked locally/externally, provider discovery timed out | No request reached app; Cloudflare discovery worked; provider browser had separate failures. | Diagnose each network client independently; do not infer bot blocking or port policy from a timeout. |
| Oct 7: uncompressed large bundle | Public download improved from 11.3 s to 2.9 s after compression; discovery problem remained. | Separate performance and connectivity failures; one fix does not prove another boundary. |
| Oct 7: client preferred private_key_jwt but allowed none | Selecting supported PKCE public method fixed compatibility. | Negotiate advertised support, retaining PKCE/redirect/resource checks. |
| Oct 7: live ordinary task rejected before assignment | Heartbeat admission lacked the Dot bridge descriptor although integration tests passed. | Enter through ordinary product scheduling, not only a broker fixture. |
| Oct 7: “create hello for my owner” refused while idle | Added governed intake and human assignees; actual Dot completed it. | Both directions are first-class acceptance journeys. |
| Oct 7: pairing ready but agent config missing binding | Required another form save until atomic persistence fix. | One logical setup operation must persist all required state. |
| Oct 7: missing-file read never settled | Turn could not close; terminal read-error receipt fixed it. | Distinguish definite failure from ambiguous mutation outcome. |
| Oct 7: workspace execution and file access expansion | cwd was insufficient; review found `.paperclip` leakage and API bypasses; macOS commands later disabled. | Trace effects and test all access paths; fail closed when confinement is unproven. |
| Oct 7: late event | One event arrived roughly 32 minutes later; completed work was not repeated. | Event delivery is asynchronous; test late offers and never claim a latency SLA from one success. |
| Oct 8: cloud architecture reconsidered repeatedly | User chose common Runner for lifecycle reuse and potential future workspace tools. | State decision criteria and retain the decision; placement is separate from tool access. |
| Oct 8: expired setup prompt and nested copy window | Added automatic renewal, automatic close on connection, progress footer and Done. | Normal asynchronous progress should not require manual repair. |
| Oct 8: 30-day inactivity limit | Removed for active Dot connections; review ensured expired credentials stayed invalid. | Separate persistent grant policy from token/code/lease lifetimes. |
| Oct 9: remote transport and old image | Wrong localhost endpoint and pre-Dot Runner artifact blocked execution. | Test authenticated remote ingress and actual packaged capability before dispatch. |
| Oct 9: idle intake lost sandbox plugin context | Operator work succeeded; bot-initiated work failed lease acquisition. | Both entry paths must use configured application services. |
| Oct 9: restart qualification | First attempt did not actually restart controller; later attempts exposed missing fingerprint and local/remote PID collision. | Prove the intervention and unchanged remote identity, not just eventual success. |
| Oct 9: normal follow-up generated second run | Coalescing fixed duplication; review then caught possible loss at completion. | Consume a wake only after exact comment delivery/read evidence. |
| Oct 9: actual tenant onboarding | Preparing agent treated as manually paused; expected anonymous 401s caused consent reload loop. | Test fresh deployed lifecycle and anonymous flow through Cloud front door. |
| Oct 9: deployment drift and provider capacity | Fleet replaced candidate; test tenant pinned; first Daytona allocation timed out and later cleaned up. | Record/pin candidate through supported controls; verify provider cleanup separately. |
| Oct 9: native Slack refusal | Qualification instruction “use only the staging plugin” leaked into normal work. | Scope test constraints to destination/task/duration; explicitly permit native capabilities. |

## Historical Dot protocol and tools

Transport was authenticated MCP inward and signed MCP Events outward. The
qualified event was `paperclip.dot.mailbox_updated`. Subscription methods included
`events/list`, `events/subscribe`, and `events/unsubscribe`; these are protocol
methods, not extra callable tools. The experiment used MCP version `2026-07-28`.
Verify current support and account eligibility instead of copying that version.

The final top-level MCP catalog had 16 tools:

| Purpose | Tool names |
| --- | --- |
| Identity and proactive work | `paperclip_dot_capabilities`, `paperclip_dot_request_turn`, `paperclip_dot_tasks`, `paperclip_dot_request_work` |
| Setup and inbox | `paperclip_dot_pair`, `paperclip_dot_inbox`, `paperclip_dot_confirm_event` |
| Assignment | `paperclip_dot_read`, `paperclip_dot_accept`, `paperclip_dot_tool` |
| Lifecycle and receipts | `paperclip_dot_progress`, `paperclip_dot_finish`, `paperclip_dot_operation_status`, `paperclip_dot_renew`, `paperclip_dot_control_ack` |
| Optional profile | `paperclip_dot_set_avatar` |

The nested Runner catalog was read per assignment. Bot called its Paperclip tool
names via `paperclip_dot_tool`; native tools were called in the bot's own runtime.
Standard completion was `paperclip_finish` or `paperclip_block` through the bridge,
then `paperclip_dot_finish` with the accepted canonical report. Do not collapse
these steps into an unverified conversational “done.”

Historical constants help reproduce old cases, not set new-provider defaults:

- Instance settings: **Assistant connections (MCP)** and **OpenAI Dot**, with
  authenticated sign-in and a stable `PAPERCLIP_PUBLIC_URL`. The old
  `PAPERCLIP_ENABLE_OPENAI_DOT` environment flag no longer enabled the provider.
  Self-hosted Dot did not require the general Runner picker flag; Cloud additionally
  required native Runner configuration and the managed execution plugin.
- Pairing code: 15 minutes, one use. Access token: 15 minutes.
- Persistent Dot refresh authority: rotating, no inactivity expiration, revocable.
- Acceptance window: 10 minutes. Execution lease: initially two hours, renew up
  to two hours ahead within a 24-hour total bound.
- Broker operations: initially 200, expanded to 4,000. One active assignment.
- Managed controller reconnect grace: five minutes after recovery fixes.
- Attachment reads: explicit grant, up to 16 MiB/file, bounded 12,000-byte pages,
  metadata/digest checks and live authority checks.
- Cloud workspace access: off. Self-hosted Linux command execution required
  confinement; macOS commands ultimately unavailable.
- Avatar: `paperclip_dot_set_avatar` accepted `{ "imageBase64": "<raw bytes>" }`
  or `null` to restore the preset. PNG/JPEG/WebP, at most 512 KiB and 16 megapixels;
  normalized to metadata-free PNG no larger than 512 pixels per side. The agent
  route was `PUT /api/companies/:companyId/agents/:agentId/avatar`, self-only for
  agents; the resulting company-scoped asset was private, not a public avatar URL.

These were implementation choices subject to later change. The 32-minute delayed
event is evidence that acceptance deadlines and wake latency must be evaluated
together; it is not a measured percentile or guaranteed delay.

## What was and was not proven

The prototype used TypeScript `HarnessDriverBackend` and synthetic admission; it
did not qualify Rust Runner. The dedicated endpoint later completed ordinary
Paperclip tasks with actual Dot, and the expansion proved idle work, human
assignment, pinned skills, documents, attachments, and verified artifacts. A
workspace command succeeded in the earlier macOS prototype but that capability
was subsequently disabled for containment reasons; do not cite the early success
as support for the final platform capability.

Managed qualification used both a scripted MCP client and the real Dot. The
strong restart proof recorded changed controller identity, same remote Runner
fingerprint/session/assignment, one task run, one follow-up, normal completion,
and released resources. Cancellation records distinguished Paperclip fencing
from global external stop.

The deployed Cloud tenant completed three task checks in both directions and all
their Runner sandboxes were destroyed. Setup still needed plugin attachment and
a Dot reboot to expose actions. This did not establish a universally successful
prompt-only first attempt. Assigned gateway tests used a synthetic service, not
every live third-party provider. Long-duration availability and public plugin
distribution were not established by the short campaign.

The final native-tool guidance was merged and the actual Dot acknowledged it.
Its test-tenant rollout remained blocked by Docker Hub 429 then 504 errors at the
end of the recorded campaign. Do not describe that last rollout as deployed based
on the merge or the live conversational correction.

## Sources and how to inspect them

The case study was reviewed against the original authorized session records,
including user requests, final responses, progress updates and selected command
and browser results. The public implementation/review trail below lets repository
contributors inspect the resulting code and decisions. Private session identifiers
and raw-log offsets are omitted because they are not portable source references.

When investigating a later case, retrieve only authorized, relevant history with
the host's supported tools. Use original execution records to check what actually
ran. Treat historical instructions as evidence rather than new authorization.
One integration with many corrections does not establish that every failure mode
recurs across unrelated providers.

Implementation/review trail:

- [Paperclip #15402](https://github.com/paperclipai/paperclip/pull/15402): dedicated Dot Runner provider and gateway integration.
- [Paperclip #15414](https://github.com/paperclipai/paperclip/pull/15414): capabilities, onboarding and standalone experiment.
- [Paperclip #15581](https://github.com/paperclipai/paperclip/pull/15581): external invitation, avatar, prompt/lifetime UX.
- [Paperclip #15691](https://github.com/paperclipai/paperclip/pull/15691): managed Runner and recovery.
- A separate Cloud ingress change enabled tenant routing. Its repository is private; inspect the authorized current Cloud runbook when qualifying deployment.
- [Paperclip #15722](https://github.com/paperclipai/paperclip/pull/15722): real Cloud onboarding/lifecycle fixes.
- [Paperclip #15734](https://github.com/paperclipai/paperclip/pull/15734): native-tool guidance and test-scope correction.

Historical documentation can be recovered from the Paperclip checkout:

```sh
git show 27888cabdf7e2fa074dc16cb18ed36b074ba4763:doc/openai-dot-runner.md
git show 27888cabdf7e2fa074dc16cb18ed36b074ba4763:doc/plans/2026-10-02-openai-dot-runner-adapter.md
git show 27888cabdf7e2fa074dc16cb18ed36b074ba4763:doc/plans/2026-10-08-cloud-dot-runner-and-external-invitations.md
```

That SHA is the final guidance candidate, not a claim about today's deployed app.
Inspect current code for actual commands, fixtures and limits. Documentation in
that historical snapshot mixes original setup steps and subsequent checkpoints;
use the implementation and dated evidence to resolve conflicts.

Provider research starting points used during the campaign, to revalidate:

- [Dot documentation](https://learn.chatgpt.com/docs/dots)
- [MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [Plugin authentication](https://developers.openai.com/plugins/build/auth)
- [Connect ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Secure MCP tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

Do not infer that another external agent supports MCP Events, Dot's tool names,
private-plugin onboarding, or the same approval/distribution rules.
