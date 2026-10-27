---
navigation: {"section":"Agents and reusable capabilities","sectionOrder":30,"order":10}
---

# Hiring, configuration, and organization

Operators hire agents, configure their identity and instructions, assign reporting relationships, and manage their lifecycle. Built-in agents have their own setup and lifecycle constraints.

Feature ID: `agents`.

Implementation: [hiring](../../ui/src/pages/NewAgent.tsx), [configuration](../../ui/src/components/AgentConfigForm.tsx), [organization](../../ui/src/pages/OrgChart.tsx).

Agent access: [companion](../agent-access-map/agents.md).

## Sub-features

- `hire`: `agents/hire` — choose identity, harness, model, and required account settings; edit
  reporting relationships through the agent configuration afterward.
- `grok-bot`: `agents/grok-bot` — experimental existing-Bot agent setup through remote OAuth, routine credentials, and an authenticated two-way challenge; current contact, stop and explicit recovery.
- `instructions`: `agents/instructions` — edit agent configuration and instruction files with durable revisions.
- `organization`: `agents/organization` — inspect and change reporting relationships through supported controls.
- `primary-agent`: `agents/primary-agent` — choose a personal primary agent for the company, confirm replacement, and inspect its roster/sidebar and task/chat defaults.
- `lifecycle`: `agents/lifecycle` — pause/resume or retire an agent while preserving history.
- `built-in`: `agents/built-in` — configure required agents without treating them as ordinary removable hires.
- `api-keys`: `agents/api-keys` — create and inspect named agent credentials, copy a new token once, and revoke it without changing agent identity.
- `managed-agent-setup`: `agents/managed-agent-setup` — probe, create, or adopt a qualified Anthropic managed-agent profile with pinned provider resources and retention acknowledgement.

## How to get to it (user POV)

### `hire-agent`

Use New agent from the roster or `/agents/new`.

Submitting the name creates an inactive record before adapter selection or account setup.
A name-only draft returns to adapter selection when reopened.
Save & exit keeps its configuration; Finish setup on the agent returns to the
same record. Final submission requests approval when required, then follows the
existing preparation and verification lifecycle.

Agent-owned plugin environments prepare the saved draft in the background when
their driver declares `requiresAgent`. The draft waits in `verifying` with its
setup hold until hiring finishes. Changing environments keeps the selected
account and Configure step, saves the selection, and invalidates its test.
Preparation and failed-save retries remain visible without reconnecting.
Companies requiring hire approval save the account with pending verification;
resource allocation waits for approval.

### `agent-configuration`

Open `/agents/:agentId` and the configuration/instruction surfaces it exposes.

For a low-trust agent, open **Permissions / Trust → Allowed projects**. An operator
with agent-management permission can select additional projects and explicitly
save them. Existing projects and other containment restrictions remain intact.
Cancel discards the draft; a failed save retains it. Reload to verify persistence.
This does not start or retry a task.

In `/agents/all`, select roster checkboxes and choose **Edit connection & model**.
A mixed selection offers one action per harness. Each field is opt-in. The editor
previews each changed value and excludes agents already at the target value.
Models must be compatible with every selected connection. Failed writes show
per-agent errors; Retry touches only the remaining agents. Connection pools and
externally managed agents are not editable through this shortcut.

Verify connection-only, model-only, both fields, mixed-harness selection, hidden
selections, no-op counts, incompatible models, partial failure and retry. Reload
the roster and compare stored settings, including unrelated heartbeat and adapter
fields. A concurrent configuration edit must return a conflict. Shared runtime
validation, access checks, revisions and audit logging still apply. Live runs
retain their existing settings; model changes can reset saved sessions. Connection
adoption can require an explicit reset of existing sessions.

### `organization`

Use the roster’s organization view; `/org` redirects to the roster in the streamlined shell.

### `personal-primary-agent`

Open an agent profile and choose **Set as my primary**. Inspect its crown on the
profile/roster and its position in the Agents sidebar, then open a new task or Chat.

### `agent-api-keys`

Open `/agents/:agentId/api-keys` → **API Keys** with an authenticated person who can manage agents. The operator CLI also supports `paperclipai token agent create -C <company-id> --agent <agent-id> --name <label>`, `token agent list -C <company-id> --agent <agent-id>`, and `token agent revoke <key-id> -C <company-id> --agent <agent-id>`.

### `managed-agent-cli`

Use the operator command `paperclipai managed-agent setup --company-id <company-id> --profile-key <key> --display-name <name> --api-key-secret-id <company-secret-id> --acknowledge-retention --json`. Supply ANTHROPIC_API_KEY through the process environment. Use `--agent-id`, `--agent-version`, and `--environment-id` to adopt resources, or `--probe` for provider reads without profile persistence. The optional session-list cost ceiling is `--max-session-list-cost-usd`.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a disposable company and supported adapter; hiring may require a formal approval.

### `hire-agent`

Automated: [new agent page](../../ui/src/pages/NewAgent.test.tsx) and [configuration form](../../ui/src/components/AgentConfigForm.render.test.tsx) cover mocked UI behavior.

For an agent-owned plugin environment, verify preparation before connecting,
same-agent probes, account preservation after an environment change, failed
selection-save retry, and switching back while the computer stops. Confirm the
setup hold still blocks ordinary work and API key creation before finishing.
Start through the name/adapter dialog with a managed-only or forced Kubernetes
policy and a draft that inherits its environment. Once preparation completes,
confirm the auth choices, Advanced gateway, and saved subscription remain usable.
The [setup lifecycle tests](../../server/src/modules/agent-lifecycle/__tests__/setup.test.ts)
exercise durable transitions with synthetic plugin resources; they do not prove
live VM provisioning.

Manual: Hire an agent with a distinct name and role. Complete any required approval, reload the roster, and open its configuration. Confirm manager, adapter, and model persisted; run a small task to prove execution readiness.

For a new Codex hire, choose the Codex harness. Automatic selection uses Paperclip
Runner on a qualified selected target; Advanced offers an explicit Legacy runner
override. Record the persisted runner and
underlying harness, rather than treating the displayed Codex name as execution
proof. See [runtime selection and validation](./runs-adapters.md#adapter-setup)
and [target qualification](./execution-environments.md#environment-settings).

Repeat with an explicit Legacy Codex hire. If approval is required, compare its
reviewed execution configuration before and after restart and activation; approval
must retain the reviewed runner. Test an existing Legacy and native agent through
an unrelated edit, reload and restart: neither is automatically upgraded.

Creation defaults also apply to API/CLI hires, built-ins, plugins and new team
imports. Exports preserve resolved execution choices; a package without a runner
choice uses the new-agent default, while updating an existing same-harness agent
preserves its execution. For a native Codex import, edit a model or account binding
and verify unchanged runtime settings survive; an explicit clear must stay cleared.
Use the [portability recipe](./companies.md) for package preparation and boundaries.

For Claude Code on qualified macOS or GNU/Linux x64/ARM64, submit without a
runner override and inspect
saved configuration: `paperclip_runner`, `provider: acpx`, `acpxAgent: claude`,
and ordinary model `claude-opus-5-5`. The Advanced runner selector can explicitly
choose Legacy. Keep explicit model/account choices and saved runners on edits.
Verify useful output and a follow-up after a controller restart; setup success
alone does not establish session continuity. Unsupported architectures/libc and unknown environment qualification retain
Legacy. Darwin SSH also defaults to Legacy until automatic matching assets are
qualified; explicit matching native assets and saved native configurations remain
supported. Linux ARM64 cloud-image production remains deferred.

The current hiring wizard assigns the first hire CEO and subsequent hires
General reporting to the CEO. Change manager/role afterward through supported
configuration. Process/HTTP agents can be created through API/CLI but are excluded
from the hiring picker; API fixture creation does not prove this UI journey.

### `agent-configuration`

Automated: [instruction service](../../server/src/__tests__/agent-instructions-service.test.ts) and [instruction revisions](../../server/src/__tests__/agent-instruction-revisions.test.ts) cover file/revision contracts.

The [AI account field regression](../../ui/src/components/ai-connections/AiConnectionField.test.tsx)
checks duplicate provider names, account identity in choices and adoption confirmation,
the exact selected grant, and disabled unavailable accounts with authorized metadata fixtures.
Manually compare a personal API key and shared subscription with the same name in
Harness / Runtime. Confirm their method, scope and available identity before saving.
Reload the saved choice and verify the next eligible task uses it; labels alone
do not establish credential validity or change account access.

Manual: Save a harmless instruction edit, reload, and verify its revision and effect in the next eligible run. Pause and resume the disposable agent; confirm pause prevents new work and does not erase previous runs.

For failed setup, use an unavailable model or invalid command on a disposable agent.
Confirm the profile names the failed verification step and gives a relevant action.
Check that it explains automatic retry and offers **Retry now**. Fix the configuration,
retry, and reload; the failure must disappear only after readiness commits.
Provider output and credentials must not appear in the lifecycle message.

An explicit runner change is a configuration change, with normal revisions and
session invalidation. Obsolete Claude tuning options (including maxTurnsPerRun) are ignored with a field-specific warning;
permission, network, filesystem and command incompatibilities still produce an error.
Selecting another runner must not silently discard security settings or change an active run's
recorded execution. Keep runner choice in Advanced and verify the next eligible
run separately from historical transcripts.

Existing legacy Claude, Codex, and Grok Build agents on qualified default environments, or
probe-capable Daytona snapshots / immutable sandbox images, show **Upgrade runner** above their configuration. Verify a company owner with `agents:configure` and no instance-admin role can qualify the saved computer and upgrade. A caller without configuration permission must be denied before a probe starts. Exercise that action with
pending edits and an environment-variable draft. An unsaved change to a different
effective computer must disable the action and explain that the computer change
must be saved first; restoring the saved target must re-enable it. Reopen the page and compare the
saved harness, model, account bindings, instructions, and run policy. Check a
Grok upgrade with an unset or `grok-build` model: it must use `grok-4.7`.
Compare effective search policy before and after, including the implicit disabled
default and explicit enabled search. Verify task model and effort changes use the
Grok catalog and reach execution while retaining the account and search policy. Check a
saved `maxTurnsPerRun: 1000`: upgrade must warn and remove it. Test an initially
unqualified Daytona Paperclip Computer: click must probe, record qualification,
refresh availability, and only then save. A failed probe or changed selection must
leave the agent on Legacy. Check a rejected permission setting, repair it, and retry. Verify a real task before
and after migration, including its output, preserved history, and fresh session.
The notice must stay absent for native agents, other harnesses, and unsupported
targets. Discovery failure must not imply that an upgrade is available.
Navigate to another agent while an upgrade is pending. Its result must stay with
the original agent, without showing success on the new page or redirecting back.
Focused coverage: [save receipt](../../ui/src/pages/AgentRunnerUpgrade.test.tsx)
and [configuration form](../../ui/src/components/AgentConfigForm.render.test.tsx).

For an existing native agent on a Daytona snapshot or immutable sandbox image,
use **Test** in its saved Harness or Runtime configuration after a managed
computer update. This action qualifies the saved computer under the existing
agent configuration permission before testing the runtime. A current proof must
remain unchanged. A missing proof requires a real successful probe and verified
cleanup. Failed qualification must stop the runtime test. Unsaved configuration
or a different computer must not qualify a draft target. A company owner must not
need instance-admin permission, and the generic environment probe must remain
restricted. Existing runs retain their recorded allocation and snapshot binding.

Storybook: [Runner upgrade](../../ui/storybook/stories/agents/codex-runner/upgrade.stories.tsx)
mounts the production page and shell with mutable HTTP fixtures for both harnesses,
pending, failure/retry, incompatible settings, repair, native/unsupported states,
and mobile/light presentation. Fixture success does not establish real migration
or provider execution.

### `organization`

Automated: [org chart](../../ui/src/pages/OrgChart.test.tsx) is component evidence. Built-in setup also has [configuration modal tests](../../ui/src/components/ConfigureBuiltInAgentModal.test.tsx).

Manual: Inspect a manager and report, change the relationship through the offered controls, and reload both views. Exercise a rejected invalid relationship. Configure a built-in agent and verify it retains its required identity and restrictions.

### `personal-primary-agent`

Automated: [primary-agent context](../../ui/src/context/PrimaryAgentProvider.test.tsx)
and [primary-agent routes](../../server/src/__tests__/primary-agent.test.ts)
cover selection, company/user scope, and request contracts.

Manual: Select an available agent, reload, and inspect the retained personal choice.
Replace it and verify confirmation is required. Leave or terminate the selected
agent through permitted controls and inspect the unavailable/cleared state.
Switch company/user to check isolation. Open a task and Chat with a
valid draft or recent selection; verify those explicit choices take precedence
over the primary fallback. Opening Chat must not start execution.

### `agent-api-keys`

Automated: [CLI token tests](../../cli/src/__tests__/token.test.ts) mock create/list/revoke. [Cross-tenant routes](../../server/src/__tests__/agent-cross-tenant-authz-routes.test.ts), [agent permissions](../../server/src/__tests__/agent-permissions-routes.test.ts), and [authentication middleware](../../server/src/__tests__/agent-auth-middleware.test.ts) cover company/key ownership, management permission, responsible-user binding, and denial. They do not prove a browser-created key working against a live instance.

Manual: As an authenticated person with agents:create, create a named key for an eligible disposable agent and copy it privately from the once-only display. Make a harmless same-company agent request with that bearer, then reload the Keys tab and verify only metadata remains. Revoke the key through UI or CLI, reload, and retry the exact same bearer: authentication must fail. Inspect key-created/key-revoked activity without token values. Test a board person lacking agent-management permission, an agent caller, another company’s agent, a different agent’s key ID, and a pending-approval/terminated target. A created key without a real responsible-user binding is a failed acceptance prerequisite, not a working credential.

Sources: [Keys tab](../../ui/src/pages/AgentDetail.tsx), [key routes](../../server/src/routes/agents.ts), [key service](../../server/src/services/agents.ts), [authentication](../../server/src/middleware/auth.ts), and [CLI token commands](../../cli/src/commands/client/token.ts).

### `managed-agent-cli`

Automated: [Managed-agent CLI](../../cli/src/__tests__/managed-agent.test.ts) uses mocked provider/API responses. [Profile route authorization](../../server/src/__tests__/managed-agent-profile-routes-authz.test.ts) and [remote profiles](../../server/src/services/remote-agent-profiles.test.ts) cover actor/company checks and qualification. They do not establish provider provisioning or a useful managed task.

Manual: Start with known adopted provider IDs in an authorized disposable provider account. Run --probe and verify only provider reads: no resources are created and no Paperclip profile is written. Reject unsafe tools/network/package configuration, an unsupported model, duplicate profile matches, a missing retention acknowledgement, and a malformed secret UUID. During persistence, reject missing, inactive, or foreign-company secret references. Then create or adopt a locked profile in a disposable company; inspect its pinned version, model, environment, retention attestation, and cost ceiling through the profile API. Repeat setup and verify resource reuse. Reject viewer/agent writes and foreign-company references. Qualify useful task execution separately through the runtime recipe; a successful probe is not execution acceptance.

Sources: [Managed-agent CLI](../../cli/src/commands/managed-agent.ts), [profile routes](../../server/src/routes/managed-agent-profiles.ts), [profile service](../../server/src/services/managed-agent-profiles.ts), and [runtime validation](./runs-adapters.md).

## Gotchas

- Managed-agent probing is read-only at the provider and does not persist a Paperclip profile. The explicit retention acknowledgement remains required even for probe.

- Agent keys, human CLI tokens, and personal assistant OAuth grants are different credentials. Never include a key’s plaintext token in screenshots, logs, or verification artifacts.

- A roster entry is not proof of an authenticated or invokable adapter.
- Pending hires may live in approval/task surfaces rather than the active roster.
- Skill and tool grants are separate: see [skills](./skills.md) and [app permissions](./app-permissions.md).
- A personal primary agent is a per-user/company preference. It does not change
  reporting lines, stars, permissions, or another person's primary agent.

### `connect-grok-bot`

Choose **Invite an external agent → Grok Bot**, identify the Bot by its desktop name, connect its remote MCP plugin, configure a webhook-only routine, and verify delivery plus authenticated reply. Save & exit resumes the same agent. Keep pairing codes in browser authorization and routine credentials in Paperclip’s fields. A working Bot web URL is not required.

Prerequisites: authenticated public HTTPS, Assistant connections (MCP), Paperclip Runner and Grok Bot experimental settings. Cloud uses its normal managed Runner environment. Provider usage is unknown. Routine uncertainty blocks new assignments until explicit inspection and recovery; stopping work revokes Paperclip authority without confirming remote termination.

Evidence: source implementation and focused protocol tests; real provider assigned/proactive workflows and deployed managed acceptance remain release gates.
### Documentation scope: Agents, organization, and runtime setup

Per-harness/model/account capabilities, every instruction-file error, and complete built-in-agent lifecycle variants remain separate qualification matrices.
