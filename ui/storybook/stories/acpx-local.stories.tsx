import { useMemo, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import type { AdapterConfigSchema, CreateConfigValues } from "@paperclipai/adapter-utils";
import { parseAcpxStdoutLine } from "@paperclipai/adapter-acpx-local/ui";
import type {
  Agent,
  AgentSkillSnapshot,
  CompanySkillListItem,
} from "@paperclipai/shared";
import { SchemaConfigFields } from "@/adapters/schema-config-fields";
import type { TranscriptEntry } from "@/adapters";
import { RunTranscriptView } from "@/components/transcript/RunTranscriptView";
import { AgentSkillsTab } from "@/pages/AgentDetail";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { queryKeys } from "@/lib/queryKeys";

type SchemaWindow = typeof window & {
  __paperclipStorybookAdapterSchemas?: Record<string, unknown>;
};

// Mirrors packages/adapters/acpx-local/src/server/config-schema.ts. Inlined so the
// storybook bundle does not pull node-only imports from the adapter server entry.
const acpxLocalConfigSchema: AdapterConfigSchema = {
  fields: [
    {
      key: "agent",
      label: "ACP agent",
      type: "select",
      default: "claude",
      required: true,
      options: [
        { value: "claude", label: "Claude via ACPX" },
        { value: "codex", label: "Codex via ACPX" },
        { value: "custom", label: "Custom ACP command" },
      ],
      hint: "Choose the ACP agent launched through ACPX.",
    },
    {
      key: "agentCommand",
      label: "Agent command",
      type: "text",
      hint: "Required for custom agents; optional override for built-in Claude or Codex ACP commands.",
    },
    {
      key: "mode",
      label: "Session mode",
      type: "select",
      default: "persistent",
      options: [
        { value: "persistent", label: "Persistent" },
        { value: "oneshot", label: "One shot" },
      ],
    },
    {
      key: "permissionMode",
      label: "Permission mode",
      type: "select",
      default: "approve-all",
      options: [
        { value: "approve-all", label: "Approve all" },
        { value: "default", label: "ACP default" },
      ],
      hint: "Defaults to maximum permissions: ACPX permission requests are auto-approved.",
    },
    {
      key: "nonInteractivePermissions",
      label: "Non-interactive permissions",
      type: "select",
      default: "deny",
      options: [
        { value: "deny", label: "Deny" },
        { value: "fail", label: "Fail" },
      ],
    },
    {
      key: "cwd",
      label: "Working directory",
      type: "text",
      hint: "Absolute fallback directory. Paperclip execution workspaces can override this at runtime.",
    },
    {
      key: "stateDir",
      label: "State directory",
      type: "text",
      hint: "Optional ACPX session state directory. Defaults to Paperclip-managed company/agent scoped storage.",
    },
    {
      key: "instructionsFilePath",
      label: "Instructions file",
      type: "text",
      hint: "Optional absolute path to markdown instructions injected into the run prompt.",
    },
    { key: "promptTemplate", label: "Prompt template", type: "textarea" },
    { key: "bootstrapPromptTemplate", label: "Bootstrap prompt template", type: "textarea" },
    { key: "timeoutSec", label: "Timeout seconds", type: "number", default: 0 },
    {
      key: "env",
      label: "Environment JSON",
      type: "textarea",
      hint: "Optional JSON object of environment values or secret bindings.",
    },
  ],
};

function installAcpxSchemaMock(): void {
  if (typeof window === "undefined") return;
  const win = window as SchemaWindow;
  win.__paperclipStorybookAdapterSchemas = {
    ...(win.__paperclipStorybookAdapterSchemas ?? {}),
    acpx_local: acpxLocalConfigSchema,
  };
}

function ConfigSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card className="shadow-none border-border">
      <CardHeader>
        <CardTitle className="text-base font-semibold">{title}</CardTitle>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </CardHeader>
      <CardContent>
        <div className="space-y-3">{children}</div>
      </CardContent>
    </Card>
  );
}

function AcpxLocalConfigStory() {
  installAcpxSchemaMock();

  const [values, setValues] = useState<CreateConfigValues>(() => ({
    name: "",
    role: "",
    title: "",
    capabilities: "",
    icon: "code",
    adapterType: "acpx_local",
    command: "",
    promptTemplate: "",
    bootstrapPromptTemplate: "",
    instructionsFilePath: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    runtimeServicesJson: "",
    runtimeDesiredState: "manual",
    runtimeServiceStates: {},
    heartbeatEnabled: false,
    intervalSec: 900,
    wakeOnDemand: true,
    cooldownSec: 60,
    maxConcurrentRuns: 1,
    pauseOnIdle: false,
    idleTimeoutSec: 0,
    runtimeMaxStuckHeartbeats: 0,
    adapterSchemaValues: {},
  } as unknown as CreateConfigValues));

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <header className="space-y-2">
        <Badge variant="outline" className="rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.18em]">
          UX preview
        </Badge>
        <h1 className="text-2xl font-semibold tracking-tight">Agent config — acpx_local</h1>
        <p className="text-sm text-muted-foreground">
          Renders the schema-driven adapter config block exactly as the operator sees it inside the agent edit form.
          Defaults reflect Phase 3 of PAP-2944: maximum-permission auto-approve, persistent session mode, Claude as the
          default ACP agent.
        </p>
      </header>

      <ConfigSection
        title="Adapter configuration"
        description="Schema fields rendered through the generic SchemaConfigFields component."
      >
        <SchemaConfigFields
          mode="create"
          isCreate
          adapterType="acpx_local"
          values={values}
          set={(patch) => setValues((current) => ({ ...current, ...patch }))}
          config={{}}
          eff={(_group, _field, original) => original}
          mark={() => {}}
          models={[]}
        />
      </ConfigSection>

      <ConfigSection title="Resolved values (debug)">
        <pre className="whitespace-pre-wrap text-xs font-mono text-muted-foreground">
          {JSON.stringify(values.adapterSchemaValues ?? {}, null, 2)}
        </pre>
      </ConfigSection>
    </div>
  );
}

const ACPX_TS_BASE = new Date("2026-04-30T15:30:00.000Z").getTime();

function ts(offsetMs: number): string {
  return new Date(ACPX_TS_BASE + offsetMs).toISOString();
}

function flattenLines(lines: Array<{ payload: Record<string, unknown>; offsetMs: number }>): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const { payload, offsetMs } of lines) {
    const parsed = parseAcpxStdoutLine(JSON.stringify(payload), ts(offsetMs));
    entries.push(...parsed);
  }
  return entries;
}

function useAcpxTranscript(): TranscriptEntry[] {
  return useMemo(
    () =>
      flattenLines([
        {
          offsetMs: 0,
          payload: {
            type: "acpx.session",
            agent: "claude",
            mode: "persistent",
            permissionMode: "approve-all",
            acpSessionId: "acp_session_42a8c1",
            runtimeSessionName: "acpx-claude-PAP-1812",
          },
        },
        {
          offsetMs: 800,
          payload: {
            type: "acpx.status",
            tag: "context_window",
            used: 12000,
            size: 200000,
          },
        },
        {
          offsetMs: 1200,
          payload: {
            type: "acpx.text_delta",
            text: "Looking at the failing test in `runtime-state.test.ts` — ",
            channel: "thought",
          },
        },
        {
          offsetMs: 1500,
          payload: {
            type: "acpx.text_delta",
            text: "the assertion expects `pendingRestart` but the new state machine uses `restartScheduled`.\n",
            channel: "thought",
          },
        },
        {
          offsetMs: 1900,
          payload: {
            type: "acpx.text_delta",
            text: "I'll inspect the test file to confirm the change.\n\n",
            channel: "output",
            tag: "agent_message_chunk",
          },
        },
        {
          offsetMs: 2200,
          payload: {
            type: "acpx.tool_call",
            name: "read",
            toolCallId: "tool_read_01",
            status: "running",
            text: "server/src/runtime-state.test.ts",
            input: { path: "server/src/runtime-state.test.ts" },
          },
        },
        {
          offsetMs: 3500,
          payload: {
            type: "acpx.tool_call",
            name: "read",
            toolCallId: "tool_read_01",
            status: "completed",
            text: "Read 142 lines",
          },
        },
        {
          offsetMs: 3700,
          payload: {
            type: "acpx.text_delta",
            text:
              "The test still references the old `pendingRestart` field. I'll update the assertion to use the renamed `restartScheduled` flag.\n\n",
            channel: "output",
          },
        },
        {
          offsetMs: 4200,
          payload: {
            type: "acpx.tool_call",
            name: "edit",
            toolCallId: "tool_edit_02",
            status: "running",
            input: {
              path: "server/src/runtime-state.test.ts",
              find: "expect(state.pendingRestart).toBe(true)",
              replace: "expect(state.restartScheduled).toBe(true)",
            },
          },
        },
        {
          offsetMs: 5400,
          payload: {
            type: "acpx.tool_call",
            name: "edit",
            toolCallId: "tool_edit_02",
            status: "completed",
            text: "1 replacement",
          },
        },
        {
          offsetMs: 5800,
          payload: {
            type: "acpx.status",
            text: "Running vitest for runtime-state.test.ts",
          },
        },
        {
          offsetMs: 6100,
          payload: {
            type: "acpx.tool_call",
            name: "command",
            toolCallId: "tool_run_03",
            status: "running",
            input: { command: "pnpm exec vitest run server/src/runtime-state.test.ts" },
          },
        },
        {
          offsetMs: 9100,
          payload: {
            type: "acpx.tool_call",
            name: "command",
            toolCallId: "tool_run_03",
            status: "completed",
            text:
              "Test Files  1 passed (1)\nTests  6 passed (6)\nDuration  2.31s",
          },
        },
        {
          offsetMs: 9400,
          payload: {
            type: "acpx.text_delta",
            text:
              "**Test passes.** Updated `runtime-state.test.ts` to assert against `restartScheduled` instead of the renamed `pendingRestart` field.\n\n",
            channel: "output",
          },
        },
        {
          offsetMs: 9600,
          payload: {
            type: "acpx.text_delta",
            text:
              "Next I'll update the issue with a summary and hand it back to QA for verification.",
            channel: "output",
          },
        },
        {
          offsetMs: 9800,
          payload: {
            type: "acpx.status",
            tag: "context_window",
            used: 18450,
            size: 200000,
          },
        },
        {
          offsetMs: 10000,
          payload: {
            type: "acpx.result",
            summary: "completed",
            stopReason: "end_turn",
            inputTokens: 18450,
            outputTokens: 412,
            cachedTokens: 12000,
            costUsd: 0.024,
            subtype: "end_turn",
          },
        },
      ]),
    [],
  );
}

function AcpxLocalTranscriptStory() {
  const entries = useAcpxTranscript();

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <header className="space-y-2">
        <Badge variant="outline" className="rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.18em]">
          UX preview
        </Badge>
        <h1 className="text-2xl font-semibold tracking-tight">Run transcript — acpx_local streamed events</h1>
        <p className="text-sm text-muted-foreground">
          Demonstrates how a streamed acpx_local run renders through the existing transcript pipeline. Events flow
          through <code>parseAcpxStdoutLine</code> (session init, thought delta, assistant delta, tool call/result
          pairs, context window status, final result) and into <code>RunTranscriptView</code> in nice mode.
        </p>
      </header>

      <Card className="shadow-none border-border overflow-hidden">
        <CardHeader>
          <CardTitle className="text-base font-semibold">Run Transcript (nice mode)</CardTitle>
          <p className="text-xs text-muted-foreground">
            Streaming, comfortable density. Mirrors the agent detail page transcript surface.
          </p>
        </CardHeader>
        <CardContent>
          <RunTranscriptView entries={entries} mode="nice" density="comfortable" streaming />
        </CardContent>
      </Card>

      <Card className="shadow-none border-border overflow-hidden">
        <CardHeader>
          <CardTitle className="text-base font-semibold">Run Transcript (compact density)</CardTitle>
          <p className="text-xs text-muted-foreground">
            Same parsed events, compact density — matches the live-run widget on the issue thread.
          </p>
        </CardHeader>
        <CardContent>
          <RunTranscriptView entries={entries} mode="nice" density="compact" streaming={false} />
        </CardContent>
      </Card>
    </div>
  );
}

const SKILLS_COMPANY_ID = "company-storybook";

const acpxSkillsCompanyLibrary: CompanySkillListItem[] = [
  {
    id: "skill-paperclip",
    companyId: SKILLS_COMPANY_ID,
    key: "paperclip",
    slug: "paperclip",
    name: "Paperclip",
    description:
      "Coordination skill: heartbeats, checkout, comments, and routine API patterns for Paperclip agents.",
    sourceType: "local_path",
    sourceLocator: "skills/paperclip",
    sourceRef: null,
    trustLevel: "scripts_executables",
    compatibility: "compatible",
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    createdAt: new Date("2026-04-12T09:00:00.000Z"),
    updatedAt: new Date("2026-04-22T15:30:00.000Z"),
    attachedAgentCount: 4,
    editable: false,
    editableReason: "Required by Paperclip",
    sourceLabel: "Paperclip",
    sourceBadge: "paperclip",
    sourcePath: "skills/paperclip",
  },
  {
    id: "skill-design-guide",
    companyId: SKILLS_COMPANY_ID,
    key: "design-guide",
    slug: "design-guide",
    name: "Design guide",
    description:
      "Paperclip UI design system reference: tokens, typography, status colors, and reusable component patterns.",
    sourceType: "local_path",
    sourceLocator: "skills/design-guide",
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    createdAt: new Date("2026-04-15T10:00:00.000Z"),
    updatedAt: new Date("2026-04-25T12:00:00.000Z"),
    attachedAgentCount: 2,
    editable: true,
    editableReason: null,
    sourceLabel: "Local",
    sourceBadge: "local",
    sourcePath: "skills/design-guide",
  },
  {
    id: "skill-mobile-qa",
    companyId: SKILLS_COMPANY_ID,
    key: "mobile-app-qa",
    slug: "mobile-app-qa",
    name: "Mobile app QA",
    description:
      "Exploratory QA flows for mobile/web apps using Chrome automation. Captures bugs and writes a final report.",
    sourceType: "local_path",
    sourceLocator: "skills/mobile-app-qa",
    sourceRef: null,
    trustLevel: "assets",
    compatibility: "compatible",
    fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    createdAt: new Date("2026-04-18T11:00:00.000Z"),
    updatedAt: new Date("2026-04-26T09:30:00.000Z"),
    attachedAgentCount: 1,
    editable: true,
    editableReason: null,
    sourceLabel: "Local",
    sourceBadge: "local",
    sourcePath: "skills/mobile-app-qa",
  },
];

function buildAcpxAgent({
  agentId,
  acpAgent,
  desiredSkills,
}: {
  agentId: string;
  acpAgent: "claude" | "codex" | "custom";
  desiredSkills: string[];
}): Agent {
  return {
    id: agentId,
    companyId: SKILLS_COMPANY_ID,
    name: `ACPX ${acpAgent === "custom" ? "Custom" : acpAgent === "codex" ? "Codex" : "Claude"}`,
    urlKey: `acpx-${acpAgent}`,
    role: "engineer",
    title: `ACPX ${acpAgent} agent`,
    icon: "code",
    status: "idle",
    reportsTo: null,
    capabilities: "Routes work through the ACPX adapter for skill-tagged agent flows.",
    adapterType: "acpx_local",
    adapterConfig: {
      agent: acpAgent,
      mode: "persistent",
      permissionMode: "approve-all",
      paperclipSkillSync: {
        desiredSkills,
      },
    },
    runtimeConfig: {},
    budgetMonthlyCents: 100_000,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-04-30T12:00:00.000Z"),
    updatedAt: new Date("2026-04-30T12:00:00.000Z"),
  } as Agent;
}

function buildAcpxClaudeSnapshot(): AgentSkillSnapshot {
  return {
    adapterType: "acpx_local",
    supported: true,
    mode: "ephemeral",
    desiredSkills: ["paperclip", "design-guide"],
    warnings: [],
    entries: [
      {
        key: "paperclip",
        runtimeName: "paperclip",
        desired: true,
        managed: true,
        required: true,
        requiredReason: "Paperclip coordination skill is mandatory for control-plane agents.",
        state: "configured",
        origin: "paperclip_required",
        originLabel: "Required by Paperclip",
        readOnly: false,
        sourcePath: "skills/paperclip",
        targetPath: null,
        detail: "Will be mounted into the next ACPX Claude session.",
      },
      {
        key: "design-guide",
        runtimeName: "design-guide",
        desired: true,
        managed: true,
        required: false,
        state: "configured",
        origin: "company_managed",
        originLabel: "Managed by Paperclip",
        readOnly: false,
        sourcePath: "skills/design-guide",
        targetPath: null,
        detail: "Will be mounted into the next ACPX Claude session.",
      },
      {
        key: "mobile-app-qa",
        runtimeName: "mobile-app-qa",
        desired: false,
        managed: true,
        required: false,
        state: "available",
        origin: "company_managed",
        originLabel: "Managed by Paperclip",
        readOnly: false,
        sourcePath: "skills/mobile-app-qa",
        targetPath: null,
        detail: null,
      },
    ],
  };
}

function buildAcpxCodexSnapshot(): AgentSkillSnapshot {
  return {
    adapterType: "acpx_local",
    supported: true,
    mode: "ephemeral",
    desiredSkills: ["paperclip"],
    warnings: [],
    entries: [
      {
        key: "paperclip",
        runtimeName: "paperclip",
        desired: true,
        managed: true,
        required: true,
        requiredReason: "Paperclip coordination skill is mandatory for control-plane agents.",
        state: "configured",
        origin: "paperclip_required",
        originLabel: "Required by Paperclip",
        readOnly: false,
        sourcePath: "skills/paperclip",
        targetPath: null,
        detail: "Will be linked into the effective CODEX_HOME/skills/ directory for the next ACPX Codex session.",
      },
      {
        key: "design-guide",
        runtimeName: "design-guide",
        desired: false,
        managed: true,
        required: false,
        state: "available",
        origin: "company_managed",
        originLabel: "Managed by Paperclip",
        readOnly: false,
        sourcePath: "skills/design-guide",
        targetPath: null,
        detail: null,
      },
      {
        key: "mobile-app-qa",
        runtimeName: "mobile-app-qa",
        desired: false,
        managed: true,
        required: false,
        state: "available",
        origin: "company_managed",
        originLabel: "Managed by Paperclip",
        readOnly: false,
        sourcePath: "skills/mobile-app-qa",
        targetPath: null,
        detail: null,
      },
    ],
  };
}

function buildAcpxCustomSnapshot(): AgentSkillSnapshot {
  return {
    adapterType: "acpx_local",
    supported: false,
    mode: "unsupported",
    desiredSkills: ["design-guide"],
    warnings: [
      "Custom ACP commands do not expose a Paperclip skill integration contract yet; selected skills are tracked only.",
    ],
    entries: [
      {
        key: "paperclip",
        runtimeName: "paperclip",
        desired: false,
        managed: true,
        required: true,
        requiredReason: "Paperclip coordination skill is mandatory for control-plane agents.",
        state: "available",
        origin: "paperclip_required",
        originLabel: "Required by Paperclip",
        readOnly: false,
        sourcePath: "skills/paperclip",
        targetPath: null,
        detail: null,
      },
      {
        key: "design-guide",
        runtimeName: "design-guide",
        desired: true,
        managed: true,
        required: false,
        state: "configured",
        origin: "company_managed",
        originLabel: "Managed by Paperclip",
        readOnly: false,
        sourcePath: "skills/design-guide",
        targetPath: null,
        detail:
          "Desired state is stored in Paperclip only; custom ACP commands need an explicit skill integration contract before runtime sync is available.",
      },
      {
        key: "mobile-app-qa",
        runtimeName: "mobile-app-qa",
        desired: false,
        managed: true,
        required: false,
        state: "available",
        origin: "company_managed",
        originLabel: "Managed by Paperclip",
        readOnly: false,
        sourcePath: "skills/mobile-app-qa",
        targetPath: null,
        detail: null,
      },
    ],
  };
}

function StoryFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <header className="space-y-2">
        <Badge variant="outline" className="rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.18em]">
          UX preview
        </Badge>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </header>

      <Card className="shadow-none border-border">
        <CardHeader>
          <CardTitle className="text-base font-semibold">Agent detail — Skills tab</CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}

function AcpxSkillsState({
  agent,
  snapshot,
  library,
}: {
  agent: Agent;
  snapshot: AgentSkillSnapshot;
  library: CompanySkillListItem[];
}) {
  const queryClient = useQueryClient();
  queryClient.setQueryData(queryKeys.companySkills.list(SKILLS_COMPANY_ID), library);
  queryClient.setQueryData(queryKeys.agents.skills(agent.id), snapshot);
  return <AgentSkillsTab agent={agent} companyId={SKILLS_COMPANY_ID} />;
}

function AcpxClaudeSkillsStory() {
  const agent = buildAcpxAgent({
    agentId: "agent-acpx-claude",
    acpAgent: "claude",
    desiredSkills: ["paperclip", "design-guide"],
  });
  return (
    <StoryFrame
      title="ACPX Claude — Skills tab"
      subtitle="Runtime-synced state. Selected skills are mounted into the next ACPX Claude session via the Paperclip skills directory."
    >
      <AcpxSkillsState agent={agent} snapshot={buildAcpxClaudeSnapshot()} library={acpxSkillsCompanyLibrary} />
    </StoryFrame>
  );
}

function AcpxCodexSkillsStory() {
  const agent = buildAcpxAgent({
    agentId: "agent-acpx-codex",
    acpAgent: "codex",
    desiredSkills: ["paperclip"],
  });
  return (
    <StoryFrame
      title="ACPX Codex — Skills tab"
      subtitle="Runtime-synced state. Selected skills are linked into the effective CODEX_HOME/skills/ directory for the next ACPX Codex session."
    >
      <AcpxSkillsState agent={agent} snapshot={buildAcpxCodexSnapshot()} library={acpxSkillsCompanyLibrary} />
    </StoryFrame>
  );
}

function AcpxCustomSkillsStory() {
  const agent = buildAcpxAgent({
    agentId: "agent-acpx-custom",
    acpAgent: "custom",
    desiredSkills: ["design-guide"],
  });
  return (
    <StoryFrame
      title="ACPX custom — Skills tab"
      subtitle="Unsupported runtime sync. Desired skills are tracked in Paperclip only until a custom ACP command declares a skill integration contract."
    >
      <AcpxSkillsState agent={agent} snapshot={buildAcpxCustomSnapshot()} library={acpxSkillsCompanyLibrary} />
    </StoryFrame>
  );
}

function AcpxClaudeSkillsLoadingStory() {
  const agent = buildAcpxAgent({
    agentId: "agent-acpx-claude-loading",
    acpAgent: "claude",
    desiredSkills: [],
  });
  return (
    <StoryFrame
      title="ACPX Claude — Skills tab (loading)"
      subtitle="Initial render before /api/agents/{id}/skills resolves. Uses the shared list skeleton."
    >
      <AgentSkillsTab agent={agent} companyId={SKILLS_COMPANY_ID} />
    </StoryFrame>
  );
}

function AcpxClaudeSkillsEmptyLibraryStory() {
  const agent = buildAcpxAgent({
    agentId: "agent-acpx-claude-empty",
    acpAgent: "claude",
    desiredSkills: [],
  });
  const emptySnapshot: AgentSkillSnapshot = {
    adapterType: "acpx_local",
    supported: true,
    mode: "ephemeral",
    desiredSkills: [],
    warnings: [],
    entries: [],
  };
  return (
    <StoryFrame
      title="ACPX Claude — Skills tab (empty company library)"
      subtitle="Runtime supports skills, but the company library has no skills imported yet. Operator is prompted to import skills first."
    >
      <AcpxSkillsState agent={agent} snapshot={emptySnapshot} library={[]} />
    </StoryFrame>
  );
}

const meta: Meta = {
  title: "Adapters / acpx_local",
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

export const ConfigForm: StoryObj = {
  name: "Agent config form",
  render: () => <AcpxLocalConfigStory />,
};

export const Transcript: StoryObj = {
  name: "Streamed run transcript",
  render: () => <AcpxLocalTranscriptStory />,
};

export const SkillsTabClaude: StoryObj = {
  name: "Skills tab — ACPX Claude",
  render: () => <AcpxClaudeSkillsStory />,
};

export const SkillsTabCodex: StoryObj = {
  name: "Skills tab — ACPX Codex",
  render: () => <AcpxCodexSkillsStory />,
};

export const SkillsTabCustom: StoryObj = {
  name: "Skills tab — ACPX custom (unsupported)",
  render: () => <AcpxCustomSkillsStory />,
};

export const SkillsTabLoading: StoryObj = {
  name: "Skills tab — loading",
  render: () => <AcpxClaudeSkillsLoadingStory />,
};

export const SkillsTabEmptyLibrary: StoryObj = {
  name: "Skills tab — empty company library",
  render: () => <AcpxClaudeSkillsEmptyLibraryStory />,
};
