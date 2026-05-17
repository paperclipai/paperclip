# Hyperagent-Style Agent UX And Global/Local Capability Scopes

Status: proposed implementation plan
Date: 2026-05-14
Owner: Agent OS / Paperclip UX
Scope: Agent creation, agent detail UX, and global/local MCP/skills/tools configuration for Paperclip agents

## Goal

Bring Paperclip's agent setup closer to the Hyperagent-style UX shown in the user screenshots:

- A polished agent profile surface with a large colored header, centered agent identity, compact icon tabs, and a right-side summary/inspector panel.
- Normal Paperclip agent creation remains available: choose adapter/agent type, role, title, reporting line, model/runtime config, permissions, and skills.
- Inside each agent, expose clear tabs similar to Hyperagent:
  - Overview
  - Config / model limits
  - Invocations / runs
  - Tools
  - Skills
  - Knowledge / instructions / memory
- Capability selection must support two scopes:
  - **Global defaults**: configured in Agent OS, applied to all newly-created agents.
  - **Local overrides**: configured inside an individual agent, only affect that agent.
- MCP installs and external/live tool execution stay approval-gated; this UX must not silently install MCP servers, execute external actions, reveal secrets, or bypass existing safety gates.

## Current State Observed

### Existing agent creation

Relevant files:

- `ui/src/pages/NewAgent.tsx`
- `ui/src/components/AgentConfigForm.tsx`
- `ui/src/lib/new-agent-hire-payload.ts`
- `server/src/routes/agents.ts`
- `packages/shared/src/validators/agent.ts`

Current behavior:

- New agent form supports:
  - name, title, role, reportsTo
  - adapter type and adapter config via `AgentConfigForm`
  - selected company skill keys via `desiredSkills`
  - hire flow via `POST /companies/:companyId/agent-hires`
- Skills are selectable at creation, but the UI is a plain list, not a Hyperagent-style card/grid.
- There is no first-class global default capability bundle that is auto-applied to new agents.

### Existing agent detail tabs

Relevant file:

- `ui/src/pages/AgentDetail.tsx`

Current tabs:

- `dashboard`
- `instructions`
- `skills`
- `configuration`
- `runs`
- `budget`

Existing skill UI:

- `AgentSkillsTab` already calls:
  - `GET /agents/:id/skills`
  - `POST /agents/:id/skills/sync`
  - `GET /companies/:companyId/skills`
- Selected skills are stored through adapter skill sync preference in `adapterConfig`.
- Required/runtime skills are differentiated from optional company skills.

Gap:

- No dedicated Tools tab.
- MCP/install bundle selection is not integrated into agent settings.
- Instructions/knowledge/memory are split across current `Instructions` and internal bundle files, but not presented like a unified Knowledge tab.
- No right-side summary panel that shows active model/invocations/tools/skills/memory/library counts.

### Existing capability primitives

Relevant files:

- `packages/db/src/schema/agents.ts`
- `packages/db/src/schema/company_skills.ts`
- `packages/db/src/schema/instance_settings.ts`
- `packages/shared/src/mcp-marketplace.ts`
- `packages/shared/src/tool-permissions.ts`
- `packages/shared/src/ready-agent-pool.ts`

Current persistence options:

- `agents.adapterConfig`, `agents.runtimeConfig`, and `agents.metadata` are available JSON fields for per-agent settings.
- `company_skills` stores company skill library entries.
- `instance_settings.general/experimental` exists, but is instance-wide, not company-scoped.
- `companies` has no generic metadata/settings JSON field.
- MCP marketplace currently has shared preview/build primitives, but no installed/global/local selection store for agent capability bundles.

## Product Model

### Capability Scopes

Define a capability selection object with two explicit scopes:

```ts
type AgentCapabilityScope = "global" | "local";

type AgentCapabilitySelection = {
  skills: string[];       // company_skills.key or managed skill refs
  mcpServers: string[];   // installed/approved MCP server keys or bundle refs
  tools: string[];        // tool names/policy keys enabled for the agent
};
```

Proposed resolved view:

```ts
type ResolvedAgentCapabilities = {
  globalDefaults: AgentCapabilitySelection;
  localOverrides: AgentCapabilitySelection;
  effective: AgentCapabilitySelection;
  inherited: {
    skills: string[];
    mcpServers: string[];
    tools: string[];
  };
  blocked: Array<{
    key: string;
    kind: "skill" | "mcp" | "tool";
    reason: string;
    requiredApprovalGate?: string;
  }>;
};
```

### Persistence Strategy

Use explicit server-side normalization instead of letting the UI write arbitrary JSON.

Recommended persistence:

1. Add a company-scoped Agent OS settings store, either:
   - preferred: new DB table `company_agent_os_settings(company_id, global_capabilities, created_at, updated_at)`; or
   - acceptable short-term: `instance_settings.general.agentOs.companyDefaultsByCompanyId[companyId]` if we want a smaller first pass.
2. Store local per-agent overrides under `agents.metadata.agentOsCapabilities` after schema validation.
3. Keep existing skill sync preference for adapter runtime materialization, but make it derive from `effective.skills`.
4. Treat MCP/tool selections as configuration/permissions only until an approved install/apply path exists.

### Merge Rules

For newly-created agents:

```text
effective = global defaults + creation-local selections
```

For existing agents:

```text
effective = global defaults + local overrides
```

Rules:

- Deduplicate keys in stable order.
- Required built-in runtime skills remain mandatory and cannot be disabled locally.
- Local config can add capabilities.
- Local config can optionally hide inherited capabilities only if the capability is marked `disableable`; do not support this in the first pass unless necessary.
- MCP/tool capabilities with `requiresExplicitApproval === true` appear as blocked/pending until approved.

## UX Target

### Agent OS Global Defaults

Add a new Agent OS section/tab: **Global Agent Defaults**.

It should show three panels:

- **Global MCP**
  - Installed/approved MCP bundles/servers.
  - Preview-only external marketplace candidates with approval request CTA.
  - Secret names only; never secret values.
- **Global Tools**
  - Tool policy registry cards grouped by risk:
    - read-only
    - Paperclip write
    - approval flow
    - runtime control
    - destructive
    - external live
  - External/destructive tools show approval-gated badges.
- **Global Skills**
  - Company skill library card grid.
  - Selected global skills will be inherited by newly-created agents.

Expected copy:

```text
Global defaults apply to newly-created agents and appear as inherited capabilities on each agent. Existing agents keep their local overrides; approval-gated MCP/tool actions stay blocked until approved.
```

### New Agent Creation

Keep current Paperclip creation fields, but redesign as a two-column Hyperagent-like setup:

- Top/profile card:
  - agent name
  - title/description
  - role chip
  - reports-to chip
- Main setup sections:
  - Agent type / adapter
  - Model & limits
  - Instructions prompt / role brief
  - Skills
  - MCP & tools
  - Knowledge/context files later
- Right inspector:
  - Role
  - Model
  - Inherited global skills/tools/MCP count
  - Local additions count
  - Approval warnings

Creation should preselect global defaults and show them as inherited/locked cards. Local additions should be selectable before clicking Create.

### Agent Detail

Restructure `AgentDetail` around a reusable `AgentProfileShell`:

- Large top gradient header with agent icon/name/description.
- Compact icon tabs:
  - Overview
  - Config
  - Invocations
  - Tools
  - Skills
  - Knowledge
- Right summary panel:
  - Description
  - Model
  - Invocations count/status
  - Integrations/MCP count
  - Tools count
  - Skills count
  - Memory/knowledge count
  - Library/docs count

Suggested tab mapping from current Paperclip tabs:

- `dashboard` -> `overview`
- `configuration` + parts of `budget` -> `config`
- `runs` -> `invocations`
- new `tools` -> `tools`
- existing `skills` -> `skills`
- existing `instructions` -> `knowledge`

Backwards-compatible routes should keep old paths working:

- `/agents/:id/dashboard` redirects or aliases to `/agents/:id/overview`
- `/agents/:id/configuration` aliases to `/agents/:id/config`
- `/agents/:id/runs` aliases to `/agents/:id/invocations`
- `/agents/:id/instructions` aliases to `/agents/:id/knowledge`

## PR Slices

### PR 1 — Hyperagent-style agent detail shell, no data-model changes

Goal: visual/UX upgrade only, using current data.

Scope:

- Add `AgentProfileShell` component.
- Reorder/rename tabs to the Hyperagent-like set while keeping compatibility aliases.
- Add right inspector panel using existing data:
  - model from adapter config/runtime config
  - runs count from loaded heartbeats
  - skills count from `AgentSkillsTab` snapshot when available, or fallback to desired skill count
  - instructions bundle status
- Add placeholder Tools tab with honest copy:
  - “Tool/MCP selection is coming next; current tool permissions are enforced by adapter/runtime policy.”
- Do not change backend persistence.
- Do not change live execution behavior.

Tests:

- `AgentDetail` route alias parsing.
- Tabs render expected labels: Overview, Config, Invocations, Tools, Skills, Knowledge.
- Right inspector shows model/skills/runs counts with safe fallbacks.
- Existing AgentDetail tests remain green.

### PR 2 — Global/local capability schema + read/write APIs

Goal: persist global defaults and local overrides safely.

Scope:

- Add shared validators for capability selections.
- Add service functions:
  - `getAgentOsGlobalDefaults(companyId)`
  - `updateAgentOsGlobalDefaults(companyId, patch, actor)`
  - `getAgentLocalCapabilities(agentId)`
  - `updateAgentLocalCapabilities(agentId, patch, actor)`
  - `resolveAgentCapabilities(agentId)`
- Add routes:
  - `GET /companies/:companyId/agent-os/default-capabilities`
  - `PATCH /companies/:companyId/agent-os/default-capabilities`
  - `GET /agents/:id/capabilities`
  - `PATCH /agents/:id/capabilities`
- Persist local overrides in `agents.metadata.agentOsCapabilities` or a dedicated table.
- Log activity without secret values.

Tests:

- Validation rejects unknown shapes, raw secret values, duplicate invalid keys.
- Global + local merge/dedup rules.
- Authz: company access/board-only write where appropriate.
- Activity log redacts capability details if necessary.

### PR 3 — Agent OS global defaults UI

Goal: UI to select global MCP/skills/tools defaults.

Scope:

- Add Agent OS tab/card group for Global Agent Defaults.
- List company skills from existing `companySkillsApi`.
- List Paperclip tool policy cards from existing registry or a new read-only endpoint.
- MCP marketplace/install candidates remain approval-preview only unless already approved/installed.
- Save global defaults through PR 2 API.

Tests:

- Global Skills selection saves and reloads.
- Tool risk badges render correctly.
- External/live tools show approval-gated copy.
- No UI prompts for raw secret values.

### PR 4 — New Agent creation uses inherited global defaults

Goal: apply global defaults to newly-created agents.

Scope:

- Load global defaults on `NewAgent`.
- Show inherited global capabilities as locked cards.
- Let user add local capabilities before create.
- Include effective skills in hire payload `desiredSkills`.
- Store local overrides through the new local capability API after create, or include validated local overrides in hire payload.

Tests:

- New agent form preloads global skills/tools/MCP counts.
- Create payload includes selected effective skill keys but not raw secrets.
- If global defaults are empty, current creation behavior stays unchanged.

### PR 5 — Local agent Tools/Skills/Knowledge settings

Goal: per-agent local override UX.

Scope:

- Replace existing Skills tab internals with scoped sections:
  - inherited global skills
  - local agent skills
  - required runtime skills
  - unmanaged/runtime-discovered skills
- Implement Tools tab:
  - inherited global tools
  - local tools
  - risk/approval status
- Add MCP section inside Tools or a separate Integrations section:
  - inherited global MCP
  - local MCP additions
  - blocked pending approval
- Keep Knowledge tab mapped to instructions bundle + memory/context placeholders.

Tests:

- Local skill add/remove updates only local overrides.
- Required runtime skills cannot be disabled.
- Tool risk gating labels and disabled states render correctly.
- Skills sync still calls existing `/agents/:id/skills/sync` with effective skills.

### PR 6 — MCP install/apply integration, approval-gated

Goal: connect selected MCP servers to safe install/apply flow.

Scope:

- Read-only installed/approved MCP catalog.
- Preview external MCP marketplace choices.
- Approval request for any install or external live capability.
- No silent external install.
- Idempotent apply only after explicit approval.

Tests:

- External MCP choice creates approval request, not live install.
- Approved apply is idempotent.
- Secrets are references/placeholders only; values are never logged or returned.

## Non-Goals For First Slices

- No live external MCP execution without approval.
- No raw secret input/storage in Agent OS UI.
- No automatic enablement of destructive/runtime-control tools.
- No Enterprise sandbox/runtime expansion unless explicitly requested.
- No removal of existing Paperclip agent creation flow.

## Safety Requirements

- All writes are authenticated and company-scoped.
- Global defaults write should be board/admin gated.
- Local agent capability changes should require board or authorized manager permissions.
- MCP/tool choices must preserve existing `tool-permissions` approval gates.
- Activity logs must store capability keys/counts, not raw payloads with secrets.
- Existing `approvalService` and Agent OS apply guards remain the boundary for live apply.

## Initial Implementation Recommendation

Start with **PR 1** to get the UX shape right without data-model risk:

1. Add the Hyperagent-style detail shell and tab aliases.
2. Add a read-only Tools placeholder tab.
3. Add right-side inspector summary.
4. Keep existing Skills/Instructions/Configuration internals wired as-is.

Then move to PR 2/3 for global/local persistence and Agent OS settings. This gives a visible UX win immediately while keeping the riskier capability model isolated in later, testable backend PRs.
