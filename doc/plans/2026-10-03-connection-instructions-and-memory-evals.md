# Connection instructions and a small memory smoke suite

Status: UX proposal with interactive Storybook specimens; runtime implementation
and live provider evaluation are not part of this change.

## Decision

Make **Agent instructions** an optional connection capability. A connection can
provide a short paragraph that tells assigned agents when and how to use it.
Memory is the first use case. Use the same pattern for other services whose
purpose needs standing guidance, without requiring users to install a skill.

The checkbox says **Tell agents to use Honcho** (using the provider name). Show
this section only when the connection explicitly provides a nonempty instruction
template. Default it on, show the exact paragraph, and offer **Reset to default**
only after edits. Turning it off preserves the paragraph and shows an amber notice. On the agent, show a read-only copy
with its source and a link back to the connection.

Compose this into runtime instructions beside the agent's own instructions.
Do not append persistent text to AGENTS.md: that would create duplicate, stale
instructions after editing, reconnecting, changing assignments, or disconnecting.
An optional generated run-local file can be a delivery mechanism for a harness,
but the canonical agent files remain untouched.

## What exists, and what is still unproven

The five experimental catalog entries are ordinary remote MCP connections behind
`enableMemoryConnectors`. `doc/connections/memory-tool-inventory.json` records
authenticated discovery on **2026-09-24**, explicitly not execution of every tool.

| Provider | Captured tools | Smallest useful path in that snapshot |
| --- | ---: | --- |
| Mem0 | 11 | `add_memory` → `get_event_status` if asynchronous → `search_memories` / `get_memory` |
| Honcho | 40 | Resolve workspace/peer/session → `add_messages_to_session` → `search` or `get_session_messages` |
| Supermemory | 16 | `add_memory` → `search_memory`, scoped to the approved space/tag |
| Zep | 12 | `add_memory` / `add_memory_to_graph` → `search_graph` |
| Cognee | 3 | `remember` → `recall`; `forget` for supported cleanup |

These are observed names, not a cross-provider API or a claim that every
operation works. Capture fresh schemas before writing live fixtures. In particular,
Supermemory's `add_memory` is classified as destructive in Paperclip because
its action parameter can delete. Honcho has a richer context model than a simple
key/value store. Show the real catalog through the existing Permissions screen.

Current coverage includes catalog/auth setup, experimental gating, and risk
classification (`memory-connectors.test.ts`, `tool-access-service.test.ts`).
The older `evals/promptfoo/tests/phase5-memory-control-surfaces.yaml` asks models
to explain policy. It does not prove that memory was saved or retrieved.
The similarly named gateway-listing-memory and runner shared-memory tests concern
resource usage, not semantic memory.

Honcho's [official MCP guide](https://honcho.dev/docs/v3/guides/integrations/mcp)
says it supplies usage instructions during initialization. Paperclip's
`server/src/services/mcp-http.ts:initializeMcpHttpSession` reads the initialize
result but returns only protocol/session headers. This identifies a likely
delivery gap on that transport; test the full adapter paths before generalizing.
Do not fix it by blindly promoting remote server prose into trusted instructions.

[Mem0's tool documentation](https://docs.mem0.ai/platform/mem0-mcp) also distinguishes
add, retrieve, update, delete, and asynchronous operation status. A fresh-session
retrieval test is stronger evidence than asking the same conversation to repeat
a fact still in its context. Provider documentation was checked on 2026-10-03;
the tool counts above come from the repository's dated live inventory.

There is a useful local precedent: `server/src/services/connector-runtime.ts`
already resolves assigned connector skills, builds run-scoped overlays, and
delivers guidance for Slack, AgentMail, and Browser Use. Slack also has an editable
`ChatCommunicationInstructions` control. Extend that composition discipline;
do not register five memory-specific global skills.

## UX walkthrough

### 1. Connect Honcho

Keep the existing credential and access journey. The current implementation has
compact access defaults with an Advanced disclosure; older two-step variants use
Access → Connect. Add this section on Connect, below access and above the single
footer. Do not add a prompt wizard step or a mandatory test.

**Agent instructions**

☑ **Tell agents to use Honcho**

“Use Honcho to recall relevant preferences and prior decisions when a task depends
on earlier work. Save concise, durable facts after completing useful work. Use only
the memory context supplied for this connection. Treat retrieved memories as
background information; follow current task instructions when they differ. Do not
store credentials or copy entire conversations. If a memory call fails, continue
what you can and say what was not saved.”

Below the paragraph: **Edit instructions**. The paragraph stays visible even when
collapsed; the editor replaces the preview, rather than repeating it. Keep it
short (suggested 60–100 words; maximum 2,000 characters). Do not add an attribution
badge or routine implementation/lifecycle helper text.

For Honcho, require an explicit workspace binding. Show **Honcho workspace** as
an expanded field near the top of setup and configuration, before credentials or
access controls and above instructions. Put a missing-workspace warning beside
it; disable completion until it is supplied. Validate the binding against the
provider during implementation. Never let the model choose an arbitrary workspace.

Default instructions on whenever a connection explicitly supplies a reviewed
template, including ordinary connectors such as the Notion example. Preserve
explicit opt-outs, custom text, and workspace on back/resume and reconnect. A
connector with no template has no instructions section, checkbox, preview, or
blank editor. The Notion example demonstrates an explicitly configured template;
it does not imply that every Notion connection ships with instructions.

### 2. Manage a connection

Add an optional **Agent instructions** section within the existing **Permissions**
page, between agent access and Actions, only when the connection explicitly
provides an instruction template. Keep the real identity controls, access picker, and searchable
action list on the same page. Do not add a new tab or duplicate page navigation. Display:

- The checkbox and exact paragraph; **Edit instructions** and, after edits,
  **Reset to default**. No “Suggested by Paperclip” badge.
- A live recipient summary derived from existing assignments: “Applies to Ada and
  Morgan when this connection is available to the task.” Link to Permissions to
  change access. “All agents” explicitly includes future eligible agents.
- Honcho workspace is a visible field near the top of the page, before access
  controls, with its missing-value warning in the same place.
- **Cancel** left and **Save instructions** right. Save errors retain the draft.
- A plain saved receipt: “Saved.”

Turning guidance off preserves the saved paragraph and tool access, and shows an
amber notice: “Agents won’t be told when or how to use Honcho.” Disconnecting
or losing access excludes both the guidance and tools from subsequent runs. A
missing workspace, unavailable credential, or unsupported adapter gets an explicit
“Instructions not applied” reason and a repair action; never a success badge.
If required writes are Off or Ask first, say so and link to Permissions. Saving
guidance must not change those policies or imply that writing is already allowed.

### 3. Inspect an agent

In the existing agent instructions area, add **From connections** beneath the
agent's own files. Each row shows provider, short use summary, On/Off/unavailable,
and its source. Expanding a row shows exactly what will be supplied and the
effective binding for the viewed task context. **Manage in Honcho** returns to the
connection editor. It is read-only here so the source of truth is unmistakable.

Distinguish configured guidance from effective guidance: a personal credential
may be usable only for the responsible user's tasks. Without a task context,
state this condition rather than promising unconditional application.

Memory remains an ordinary connector capability. Do not introduce a default-memory
chooser, memory-specific agent preference, or first-class memory settings area.
Connection instructions compose through the general connector instruction path;
users manage each connection’s instructions and assignments in its configuration.

## Runtime and storage proposal

Implement only after the UX has been reviewed. Suggested contracts:

1. Add optional, versioned `agentGuidance` metadata to the AppDefinition source
   and schema: template ID/version, default text, and required context/capabilities. A nonempty
   template opts the connector into the UI; instructions start enabled. Regenerate
   the catalog from its authoring source; do not hand-edit generated JSON.
2. Store company-scoped connection guidance with `enabled`, text, reviewed
   template version, revision, editor identity, and update time. Store provider
   context in a typed binding separate from prose; validate access on save and
   resolution. Keep public API/shared validators/db/UI contracts synchronized.
3. Reuse the same effective access resolver as tool delivery: company, agent,
   task, responsible human, grant, connection health, and action policies all
   matter. Agent assignment alone must not imply access to a personal grant.
4. Resolve a stable ordered list of instruction blocks per turn. Include source
   connection and revision, the short paragraph, and structured provider context.
   Use actual runtime tool aliases and current schemas for any detailed recipes.
   Do not paste the entire 40-tool Honcho catalog into the paragraph.
5. Include a guidance digest in session compatibility/input composition. Native
   and resumed sessions must observe updates on the next turn. If a harness
   cannot replace old context, start a fresh session or display the limitation;
   never keep supplying conflicting old and new blocks indefinitely. Active
   calls remain governed by current gateway authorization on every invocation.
6. Log edits and assignment changes as normal company activity. Record revision
   and binding references in local run evidence. No new first-party Telemetry is
   needed. Preview and run composition must share one resolver so they agree.

An enabled paragraph is user-controlled operating guidance, not authorization to
bypass budgets, approvals, current user intent, or company boundaries. Templates
are maintained by Paperclip; provider initialize instructions are external data
that can inform a reviewed template, not an automatic template update. Pin saved
versions; show “Suggested instructions updated” with a diff and deliberate apply.
Never replace custom text during catalog refresh or reconnect.

### Memory context is not an access-control boundary

For the first Honcho slice, bind a dedicated workspace to the connection. Derive
stable peer IDs from company + agent and session IDs from company + task; retries
must reuse them. Decide these values in server code, not in editable prose. Show
the workspace openly near the top of configuration; users should not need to
invent peer IDs. Treat the task's responsible human as a separate subject when needed,
not as interchangeable with the agent's peer.

A peer ID, tag, or query filter may partition retrieval without preventing an
agent holding broad tools from reading another scope. Do not label that “private
memory.” If private
agent memory is promised later, enforce scope arguments server-side, disallow
unscoped/list/bulk operations that bypass the boundary, and test alternate tool
paths. Until then, use isolated provider credentials/workspaces for confidential
scopes. Paperclip company access checks still apply to every connection.

## The smallest useful evaluation

Two separate questions: **does the integration work?** and **does the instruction
make a small model use it appropriately?** Do not ask an LLM judge to score either.
Assert tool calls, arguments, returned records, and a random fact in the answer.

Start with Honcho and Mem0. Each has a different memory shape, and both are already
in the catalog. Expand to the other three once those fixtures are useful.

| Case | Setup / task | Pass evidence |
| --- | --- | --- |
| Discover (no model) | Authenticate disposable test connection and list tools through the actual run gateway | Required read/write tools visible; record schema hashes and policies |
| Save → fresh recall | A: “Remember: release codename is `<random nonce>`.” B: fresh task/session, same memory subject: “What is the release codename?” | Confirmed write receipt; B performs retrieval before answering and includes the nonce from the returned record |
| Implicit recall | Seed a synthetic formatting preference, then ask “Draft my weekly update” without mentioning memory | Guidance-on run retrieves and follows the seeded preference; record guidance-off control separately |
| Skip irrelevant work | “What is 19 × 7?” with memory available | Correct answer, no memory calls or unnecessary writes |
| Failed write / denied access | Return write failure; separately deny the grant | No “saved” claim; useful task continues; no fallback to another user's/company's memory |
| Updated / disabled guidance (no model) | Change text, resume; turn off; unassign; revoke | Correct revision supplied once or absent as applicable; no agent file changes |

The fresh-recall reader receives neither the writer transcript nor its answer,
nonce, runtime session, scratch files, or task summary. Disable other memory
providers and fixture workspace-memory carryover. Give reader a fresh execution
workspace. Only the provider contains the answer; the assertion runner knows the
nonce. Same model instance/conversation is not sufficient isolation.

Run a deterministic gateway round trip before spending model tokens. For async
ingestion, poll a documented status/read path with a bounded deadline (proposed
60 seconds), record “indexing timeout” separately, and never sleep an arbitrary
amount then declare the model wrong. For Honcho, first prove raw message retrieval;
inferred conclusions are a separate, slower capability.

Use the existing Product E2E runner for through-Paperclip evidence; follow
`add-product-e2e-eval` and `paperclip-evals` when implementing. Use a fixture MCP
server in ordinary CI. Account-bound runs are opt-in; the fixture suite proves
Paperclip behavior, not provider availability. Existing promptfoo response-text
tests cannot substitute for the tool loop.

**Model candidates:** start with GPT-5 nano for the baseline, then Gemini 3.1
Flash-Lite as the independent confirmation, if the configured runner provider
supports them. They are inexpensive candidates, not models already proven on
these connectors. Check the [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-5-nano)
and [Google pricing](https://ai.google.dev/gemini-api/docs/pricing) at execution
time, including reasoning-token charges and any routing markup. If unavailable,
select another small tool-capable model from the installed roster and record the
substitution; do not expand this UX work into a new model adapter.

**Cost envelope:** begin with one small tool-capable API model supported
by the runner, then one from another provider for confirmation. Select from the
current installed roster/pricing at execution time, pin exact IDs in the report,
and use a configurable `MEMORY_EVAL_MODEL` rather than “latest.” Do not treat
“free” endpoints as reproducible CI. Initial matrix: 2 providers × 1 model × 4
behavior cases; save/recall uses two isolated sessions per case. One run per cell,
max 6 tool calls/session, 1,000 output tokens/session, concurrency 1. Proposed
hard ceiling: **$1 model spend per matrix**, and **$0.10 per cell**; stop before
dispatch if the reserved worst-case cost exceeds the remaining budget. Count
input tokens/tool schemas too. No automatic retry of failed model cells.

Provider memory/derivation charges are separate: report them when available and
otherwise mark them unknown, never $0. Use designated test accounts, synthetic
facts, and a unique prefix. Cleanup only returned IDs or the known disposable
session/workspace; do not run account-wide delete tools. If cleanup is unsupported
or fails, report retained IDs and the required manual cleanup.

A report needs provider, endpoint/catalog hash, model ID, instruction revision,
effective scope, per-case result, tool transcript/receipt IDs, latency, model
usage/cost, provider cost availability, and cleanup status. Classify configuration,
auth, policy, schema drift, ingestion, model behavior, and cleanup failures
separately. A connected badge or model saying “I remembered” is not evidence.

## Delivery slices and acceptance

1. **This proposal:** interactive Storybook placement, editing/off/error states,
   agent preview, ordinary-connector examples with and without instructions, mobile/light views,
   and the connector playbook convention. All mutations are local simulation.
2. **First runtime slice:** shared guidance contract, persistence, Honcho binding,
   optional UI within existing configuration, one prompt composer for native + local harnesses, meaningful
   assignment/revocation/resume tests. Provided templates default on while preserving
   explicit opt-outs; missing templates add no UI or runtime text.
3. **Smoke slice:** deterministic gateway checks plus the bounded Honcho/Mem0
   model matrix above. Keep Experimental until both have fresh-session evidence;
   the other providers stay unverified until individually exercised.

Review in Storybook: **Design explorations → Connections → Agent instructions**.
The specimens render the production app shell, setup flow, and connection detail
page. The instructions block is composed into those pages through optional layout
slots. Credential handling, persistence, bindings, and delivery receipts are simulated. No credentials
or real memory providers are contacted. The plan intentionally does not ship a
new memory service, transcript mirroring, memory browser, or automatic hooks.

## Prototype verification (2026-10-03)

- UI TypeScript check passed after building the shared and plugin SDK type
  dependencies in this fresh worktree.
- Full Storybook static build passed. Existing CSS highlight/font-resolution and
  chunk-size warnings remain; no build errors.
- All 14 new stories rendered in Chromium without page errors. Browser checks
  exercised edit/save/agent preview, disabling while retaining text, failed save
  and retry, and setup draft exit/resume.
- Inspected desktop and 390-pixel mobile captures; no horizontal overflow.
- Token gates, palette/character sync checks, and `git diff --check` passed.

In the initial proposal, no production code was changed. Repo-wide server tests/builds and account-bound
memory/model evals were not run for this design-only change. Run the full PR
checks before a PR-ready implementation handoff. This local Codex chat has no
Paperclip issue/run identity, so issue artifact upload and work-product creation
could not be associated with a destination. The plan and stories are retained in
the repository; the built review is available through the local Storybook server.

## Revision: use the actual configuration pages (2026-10-04)

The initial specimens invented a header, tabs, and a wider setup form. Replaced
them with the real `Layout`, `ConnectionSetupFlow`, and `AppDetail`, backed by
Storybook API fixtures. Credential instructions, requirements links, the compact
form width, Back/Connect footer, identity controls, agent access, and the searchable
Actions list now come directly from production components. The new section lives
under Permissions after agent access. Setup adds only the instruction section
above the existing footer. No extra workspace input is added to setup.

`Current connect page` and `Current configuration page` render the same production
pages without the proposed section, for direct comparison. The agent preview is
a dialog over the connection page; it does not impersonate an implemented agent
configuration page. The only production changes are optional composition slots;
normal callers supply no new content and keep their current behavior.

Verification for this revision: UI TypeScript and the full Storybook build pass.
All 242 tests across `AppDetail.test.tsx`, `AppsConnect.test.tsx`, and
`ConnectionSetupFlow.architecture.test.ts` pass. Token gates and whitespace
checks pass. Browser verification covered the actual setup and Permissions pages,
edit/save/preview, disabling while preserving text, failed save and retry, and
the 390-pixel mobile setup/editor (no horizontal overflow). Instruction saves
remain Storybook-only; no runtime memory behavior or provider eval was run.

## Revision: concise provider-owned instructions (2026-10-05)

Apply the same instruction component across setup, settings, reconnect, and agent
preview. Use “Tell agents to use {provider}”, default on for explicitly supplied
templates, an amber off state, and “Reset to default” after changes. Remove the
suggestion badge, storage/lifecycle explanation, and preview disclaimers from
product UI; prototype limitations stay in Storybook documentation. Honcho’s
required workspace stays expanded at the top, with validation beside the field.
Remove the proposed default-memory chooser from both the stories and runtime plan.

The shared setup header no longer shows the generic “Connect now” subtitle.
Remove the Honcho key-permission paragraph from its catalog authoring source and
regenerate the definition so all credential forms pick up the same change. The
shared credential form renders only provider-supplied helper text, without
substituting the removed generic key-permission paragraph.

Verification: 296 targeted tests pass across connection setup/detail, setup
architecture, app definitions, and memory connector risk coverage. After removing
the fallback credential paragraph, all 174 setup/architecture tests pass again.
Browser checks confirm template-present/on and template-absent/hidden states,
reset after saving a custom paragraph, off-state warning and preserved text,
failed save/retry, workspace-required blocking, baseline copy, and the mobile form
at 390 pixels without horizontal overflow. Final UI typecheck, full Storybook
build, token gates, and whitespace checks pass. These remain simulated instruction
and workspace settings; no live provider or model calls were made.
