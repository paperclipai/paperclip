import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { Edit3, RotateCcw, Settings2 } from "lucide-react";
import {
  AGENT_ICON_NAMES,
  type Agent,
  type AgentRuntimeState,
  type CompanySecret,
  type EnvBinding,
} from "@paperclipai/shared";
import { ActiveAgentsPanel } from "@/components/ActiveAgentsPanel";
import { AgentConfigForm, type CreateConfigValues } from "@/components/AgentConfigForm";
import { defaultCreateValues } from "@/components/agent-config-defaults";
import {
  DraftInput,
  DraftTextarea,
  Field,
  ToggleField,
  help,
} from "@/components/agent-config-primitives";
import { AgentIcon, AgentIconPicker } from "@/components/AgentIconPicker";
import { AgentProperties } from "@/components/AgentProperties";
import { RunButton, PauseResumeButton } from "@/components/AgentActionButtons";
import type { LiveRunForIssue } from "@/api/heartbeats";
import type { AdapterInfo } from "@/api/adapters";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { storybookAgents, storybookIssues } from "../fixtures/paperclipData";

const COMPANY_ID = "company-storybook";
const now = new Date("2026-04-20T12:00:00.000Z");
const recent = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="paperclip-story__frame overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <div className="paperclip-story__label">{eyebrow}</div>
        <h2 className="mt-1 text-xl font-semibold">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function agentWith(overrides: Partial<Agent>): Agent {
  return {
    ...storybookAgents[0]!,
    ...overrides,
    adapterConfig: {
      ...storybookAgents[0]!.adapterConfig,
      ...(overrides.adapterConfig ?? {}),
    },
    runtimeConfig: {
      ...storybookAgents[0]!.runtimeConfig,
      ...(overrides.runtimeConfig ?? {}),
    },
    permissions: {
      ...storybookAgents[0]!.permissions,
      ...(overrides.permissions ?? {}),
    },
    metadata: overrides.metadata ?? storybookAgents[0]!.metadata,
  };
}

const agentManagementAgents: Agent[] = [
  agentWith({
    id: "agent-codex",
    name: "CodexCoder",
    urlKey: "codexcoder",
    status: "running",
    icon: "code",
    role: "engineer",
    title: "Senior Product Engineer",
    reportsTo: "agent-cto",
    capabilities: "Owns full-stack product changes, Storybook coverage, and local verification loops.",
    adapterType: "codex_local",
    adapterConfig: {
      command: "codex",
      model: "gpt-5.4",
      modelReasoningEffort: "high",
      search: true,
      dangerouslyBypassApprovalsAndSandbox: true,
      promptTemplate:
        "You are {{ agent.name }}. Work only on the checked-out issue, keep comments concise, and verify before handoff.",
      instructionsFilePath: "agents/codexcoder/AGENTS.md",
      extraArgs: ["--full-auto"],
      env: {
        OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-openai", version: "latest" },
        PAPERCLIP_TRACE: { type: "plain", value: "storybook" },
      } satisfies Record<string, EnvBinding>,
      timeoutSec: 7200,
      graceSec: 20,
    },
    runtimeConfig: {
      heartbeat: {
        enabled: true,
        intervalSec: 900,
        wakeOnDemand: true,
        cooldownSec: 30,
        maxConcurrentRuns: 2,
      },
    },
    lastHeartbeatAt: recent(2),
    updatedAt: recent(2),
  }),
  agentWith({
    id: "agent-qa",
    name: "QAChecker",
    urlKey: "qachecker",
    status: "idle",
    icon: "shield",
    role: "qa",
    title: "QA Engineer",
    reportsTo: "agent-cto",
    capabilities: "Runs targeted browser checks, release smoke tests, and visual Storybook reviews.",
    adapterType: "claude_local",
    adapterConfig: {
      command: "claude",
      model: "claude-sonnet-4.5",
      effort: "medium",
      dangerouslySkipPermissions: false,
      chrome: true,
      instructionsFilePath: "agents/qachecker/AGENTS.md",
      env: {
        PLAYWRIGHT_HEADLESS: { type: "plain", value: "false" },
      } satisfies Record<string, EnvBinding>,
    },
    runtimeConfig: {
      heartbeat: {
        enabled: false,
        intervalSec: 1800,
        wakeOnDemand: true,
        cooldownSec: 60,
        maxConcurrentRuns: 1,
      },
    },
    lastHeartbeatAt: recent(31),
    updatedAt: recent(31),
  }),
  agentWith({
    id: "agent-cto",
    name: "CTO",
    urlKey: "cto",
    status: "paused",
    icon: "crown",
    role: "cto",
    title: "CTO",
    reportsTo: null,
    capabilities: "Reviews engineering strategy, architecture risk, and high-impact implementation tradeoffs.",
    adapterType: "codex_local",
    pauseReason: "manual",
    pausedAt: recent(18),
    permissions: { canCreateAgents: true },
    adapterConfig: {
      command: "codex",
      model: "gpt-5.4",
      modelReasoningEffort: "xhigh",
      search: false,
    },
    runtimeConfig: {
      heartbeat: {
        enabled: true,
        intervalSec: 3600,
        wakeOnDemand: false,
        cooldownSec: 120,
        maxConcurrentRuns: 1,
      },
    },
    lastHeartbeatAt: recent(57),
    updatedAt: recent(18),
  }),
  agentWith({
    id: "agent-observability",
    name: "OpsWatch",
    urlKey: "opswatch",
    status: "error",
    icon: "radar",
    role: "devops",
    title: "Runtime Operations Engineer",
    reportsTo: "agent-cto",
    capabilities: "Monitors local runners, workspace services, and stuck-run recovery signals.",
    adapterType: "http",
    pauseReason: null,
    pausedAt: null,
    adapterConfig: {
      webhookUrl: "https://ops.internal.example/heartbeat",
      payloadTemplateJson: JSON.stringify({ channel: "paperclip-storybook", priority: "normal" }, null, 2),
      env: {
        OPS_WEBHOOK_TOKEN: { type: "secret_ref", secretId: "secret-ops-webhook", version: 3 },
      } satisfies Record<string, EnvBinding>,
    },
    runtimeConfig: {
      heartbeat: {
        enabled: true,
        intervalSec: 600,
        wakeOnDemand: true,
        cooldownSec: 45,
        maxConcurrentRuns: 1,
      },
    },
    lastHeartbeatAt: recent(9),
    updatedAt: recent(9),
  }),
];

const runtimeState: AgentRuntimeState = {
  agentId: "agent-codex",
  companyId: COMPANY_ID,
  adapterType: "codex_local",
  sessionId: "session-codex-storybook-management-20260420",
  sessionDisplayId: "codex-storybook-20260420",
  sessionParamsJson: {
    issueIdentifier: "PAP-1670",
    workspaceStrategy: "git_worktree",
  },
  stateJson: {
    currentIssue: "PAP-1670",
    workspace: "PAP-1641-create-super-detailed-storybooks-for-our-project",
  },
  lastRunId: "run-agent-management-live",
  lastRunStatus: "running",
  totalInputTokens: 286_400,
  totalOutputTokens: 42_900,
  totalCachedInputTokens: 113_200,
  totalCostCents: 4320,
  lastError: "Previous run lost its Storybook Vite websocket after a local server restart.",
  createdAt: recent(8_000),
  updatedAt: recent(2),
};

const storybookSecrets: CompanySecret[] = [
  {
    id: "secret-openai",
    companyId: COMPANY_ID,
    name: "OPENAI_API_KEY",
    provider: "local_encrypted",
    externalRef: null,
    latestVersion: 5,
    description: "Primary coding model key for local Codex agents.",
    createdByAgentId: null,
    createdByUserId: "user-board",
    createdAt: recent(21_000),
    updatedAt: recent(400),
  },
  {
    id: "secret-ops-webhook",
    companyId: COMPANY_ID,
    name: "OPS_WEBHOOK_TOKEN",
    provider: "local_encrypted",
    externalRef: null,
    latestVersion: 3,
    description: "Webhook token for runtime observability callbacks.",
    createdByAgentId: "agent-cto",
    createdByUserId: null,
    createdAt: recent(12_000),
    updatedAt: recent(80),
  },
];

const adapterFixtures: AdapterInfo[] = [
  {
    type: "codex_local",
    label: "Codex Local",
    source: "builtin",
    modelsCount: 3,
    loaded: true,
    disabled: false,
    capabilities: {
      supportsInstructionsBundle: true,
      supportsSkills: true,
      supportsLocalAgentJwt: true,
      requiresMaterializedRuntimeSkills: true,
      supportsModelProfiles: true,
    },
  },
  {
    type: "claude_local",
    label: "Claude Local",
    source: "builtin",
    modelsCount: 2,
    loaded: true,
    disabled: false,
    capabilities: {
      supportsInstructionsBundle: true,
      supportsSkills: true,
      supportsLocalAgentJwt: true,
      requiresMaterializedRuntimeSkills: true,
      supportsModelProfiles: true,
    },
  },
  {
    type: "http",
    label: "HTTP Webhook",
    source: "builtin",
    modelsCount: 0,
    loaded: true,
    disabled: false,
    capabilities: {
      supportsInstructionsBundle: false,
      supportsSkills: false,
      supportsLocalAgentJwt: false,
      requiresMaterializedRuntimeSkills: false,
      supportsModelProfiles: false,
    },
  },
];

const liveRuns: LiveRunForIssue[] = [
  {
    id: "run-agent-management-live",
    status: "running",
    invocationSource: "assignment",
    triggerDetail: "issue_assigned",
    startedAt: recent(8).toISOString(),
    finishedAt: null,
    createdAt: recent(8).toISOString(),
    agentId: "agent-codex",
    agentName: "CodexCoder",
    adapterType: "codex_local",
    issueId: "issue-storybook-1",
    livenessState: "advanced",
    livenessReason: null,
    continuationAttempt: 0,
    lastUsefulActionAt: recent(1).toISOString(),
    nextAction: "Run a targeted Storybook static build.",
  },
  {
    id: "run-agent-management-queued",
    status: "queued",
    invocationSource: "on_demand",
    triggerDetail: "manual",
    startedAt: null,
    finishedAt: null,
    createdAt: recent(3).toISOString(),
    agentId: "agent-qa",
    agentName: "QAChecker",
    adapterType: "claude_local",
    issueId: "issue-storybook-3",
    livenessState: null,
    livenessReason: "Waiting for current visual review to finish.",
    continuationAttempt: 0,
    lastUsefulActionAt: null,
    nextAction: "Open the Storybook preview and capture mobile screenshots.",
  },
  {
    id: "run-agent-management-succeeded",
    status: "succeeded",
    invocationSource: "timer",
    triggerDetail: "scheduler",
    startedAt: recent(48).toISOString(),
    finishedAt: recent(39).toISOString(),
    createdAt: recent(48).toISOString(),
    agentId: "agent-cto",
    agentName: "CTO",
    adapterType: "codex_local",
    issueId: "issue-storybook-2",
    livenessState: "completed",
    livenessReason: null,
    continuationAttempt: 0,
    lastUsefulActionAt: recent(39).toISOString(),
    nextAction: null,
  },
  {
    id: "run-agent-management-failed",
    status: "failed",
    invocationSource: "automation",
    triggerDetail: "routine",
    startedAt: recent(76).toISOString(),
    finishedAt: recent(70).toISOString(),
    createdAt: recent(76).toISOString(),
    agentId: "agent-observability",
    agentName: "OpsWatch",
    adapterType: "http",
    issueId: null,
    livenessState: "blocked",
    livenessReason: "Webhook returned 503 during local runtime restart.",
    continuationAttempt: 1,
    lastUsefulActionAt: recent(72).toISOString(),
    nextAction: "Retry after runtime service health check recovers.",
  },
];

function StorybookQueryFixtures({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  queryClient.setQueryData(queryKeys.agents.list(COMPANY_ID), agentManagementAgents);
  queryClient.setQueryData(queryKeys.secrets.list(COMPANY_ID), storybookSecrets);
  queryClient.setQueryData(queryKeys.adapters.all, adapterFixtures);
  queryClient.setQueryData(queryKeys.issues.list(COMPANY_ID), storybookIssues);
  queryClient.setQueryData([...queryKeys.issues.list(COMPANY_ID), "with-routine-executions"], storybookIssues);
  queryClient.setQueryData([...queryKeys.liveRuns(COMPANY_ID), "dashboard"], liveRuns);
  queryClient.setQueryData(queryKeys.instance.generalSettings, { censorUsernameInLogs: false });
  queryClient.setQueryData(queryKeys.agents.adapterModels(COMPANY_ID, "codex_local"), [
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  ]);
  queryClient.setQueryData(queryKeys.agents.detectModel(COMPANY_ID, "codex_local"), {
    model: "gpt-5.4",
    provider: "openai",
    source: "config",
    candidates: ["gpt-5.4", "gpt-5.4-mini"],
  });
  queryClient.setQueryData(queryKeys.agents.adapterModels(COMPANY_ID, "claude_local"), [
    { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
    { id: "claude-opus-4.1", label: "Claude Opus 4.1" },
  ]);

  return children;
}

function AgentConfigFormStory() {
  const [values, setValues] = useState<CreateConfigValues>({
    ...defaultCreateValues,
    adapterType: "codex_local",
    command: "codex",
    model: "gpt-5.4",
    thinkingEffort: "high",
    search: true,
    dangerouslyBypassSandbox: true,
    promptTemplate:
      "You are {{ agent.name }}. Read the assigned issue, make a small verified change, and update the task.",
    extraArgs: "--full-auto, --search",
    envBindings: {
      OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-openai", version: "latest" },
      PAPERCLIP_TRACE: { type: "plain", value: "storybook" },
    },
    runtimeServicesJson: JSON.stringify(
      [
        {
          name: "storybook",
          command: "pnpm storybook",
          url: "http://localhost:6006",
        },
      ],
      null,
      2,
    ),
    heartbeatEnabled: true,
    intervalSec: 900,
  });

  return (
    <AgentConfigForm
      mode="create"
      values={values}
      onChange={(patch) => setValues((current) => ({ ...current, ...patch }))}
      sectionLayout="cards"
      showAdapterTestEnvironmentButton={false}
    />
  );
}

function IconPickerMatrix() {
  const [selectedIcon, setSelectedIcon] = useState("code");
  const visibleIcons = AGENT_ICON_NAMES.slice(0, 28);

  return (
    <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle>Selected identity</CardTitle>
          <CardDescription>The real picker trigger updates the selected fixture state.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3 rounded-lg border border-border bg-background/70 p-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-accent/40">
              <AgentIcon icon={selectedIcon} className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-medium">StorybookEngineer</div>
              <div className="font-mono text-xs text-muted-foreground">{selectedIcon}</div>
            </div>
          </div>
          <AgentIconPicker value={selectedIcon} onChange={setSelectedIcon}>
            <Button variant="outline" className="w-full justify-start">
              <Settings2 className="h-4 w-4" />
              Open icon picker
            </Button>
          </AgentIconPicker>
        </CardContent>
      </Card>

      <div className="rounded-xl border border-border bg-background/70 p-4">
        <div className="grid grid-cols-7 gap-2 sm:grid-cols-10 md:grid-cols-14">
          {visibleIcons.map((name) => (
            <button
              key={name}
              type="button"
              title={name}
              onClick={() => setSelectedIcon(name)}
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-lg border border-border transition-colors hover:bg-accent",
                selectedIcon === name && "border-primary bg-primary/10 text-primary ring-1 ring-primary",
              )}
            >
              <AgentIcon icon={name} className="h-4 w-4" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function AgentActionsMatrix() {
  const actionAgents = [
    agentManagementAgents[0]!,
    agentManagementAgents[1]!,
    agentManagementAgents[2]!,
    agentManagementAgents[3]!,
  ];

  return (
    <div className="grid gap-4 xl:grid-cols-4">
      {actionAgents.map((agent) => {
        const paused = agent.status === "paused";
        const runDisabled = agent.status === "running" || agent.status === "paused";
        const restartDisabled = agent.status === "paused";

        return (
          <Card key={agent.id} className="shadow-none">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-accent/40">
                    <AgentIcon icon={agent.icon} className="h-4 w-4" />
                  </span>
                  <div>
                    <CardTitle className="text-base">{agent.name}</CardTitle>
                    <CardDescription>{agent.title}</CardDescription>
                  </div>
                </div>
                <Badge variant={agent.status === "error" ? "destructive" : "outline"}>{agent.status}</Badge>
              </div>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <PauseResumeButton
                isPaused={paused}
                onPause={() => undefined}
                onResume={() => undefined}
                disabled={agent.status === "running"}
              />
              <RunButton
                label={agent.status === "running" ? "Running" : "Run now"}
                onClick={() => undefined}
                disabled={runDisabled}
              />
              <Button variant="outline" size="sm" disabled={restartDisabled}>
                <RotateCcw className="h-3.5 w-3.5 sm:mr-1" />
                <span className="hidden sm:inline">Restart</span>
              </Button>
              <Button variant="ghost" size="sm">
                <Edit3 className="h-3.5 w-3.5 sm:mr-1" />
                <span className="hidden sm:inline">Edit</span>
              </Button>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function ConfigPrimitivesStory() {
  const [textValue, setTextValue] = useState("gpt-5.4");
  const [selectValue, setSelectValue] = useState("git_worktree");
  const [toggleValue, setToggleValue] = useState(true);
  const [jsonValue, setJsonValue] = useState(JSON.stringify({
    runtimeServices: [
      { name: "api", command: "pnpm dev:once", healthUrl: "http://localhost:3100/api/health" },
    ],
    env: { PAPERCLIP_BIND: "lan" },
  }, null, 2));

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-4 rounded-xl border border-border bg-background/70 p-4">
        <Field label="Text field" hint={help.model}>
          <DraftInput
            value={textValue}
            onCommit={setTextValue}
            immediate
            className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 font-mono text-sm outline-none"
          />
        </Field>
        <Field label="Select field" hint={help.workspaceStrategy}>
          <Select value={selectValue} onValueChange={setSelectValue}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Workspace strategy" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="project_primary">Project primary</SelectItem>
              <SelectItem value="git_worktree">Git worktree</SelectItem>
              <SelectItem value="agent_home">Agent home</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <ToggleField
          label="Toggle field"
          hint={help.wakeOnDemand}
          checked={toggleValue}
          onChange={setToggleValue}
        />
      </div>
      <div className="rounded-xl border border-border bg-background/70 p-4">
        <Field label="JSON editor" hint={help.runtimeServicesJson}>
          <DraftTextarea
            value={jsonValue}
            onCommit={setJsonValue}
            immediate
            minRows={10}
            placeholder='{"runtimeServices":[]}'
          />
        </Field>
      </div>
    </div>
  );
}

function AgentManagementStories() {
  return (
    <StorybookQueryFixtures>
      <div className="paperclip-story">
        <main className="paperclip-story__inner space-y-6">
          <section className="paperclip-story__frame p-6">
            <div className="flex flex-wrap items-start justify-between gap-5">
              <div>
                <div className="paperclip-story__label">Agent management</div>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight">Agent details, controls, and config surfaces</h1>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
                  Management stories exercise the dense pieces of the agent lifecycle: status detail panels,
                  adapter configuration, icon identity, run controls, live-agent cards, and the config-field primitives
                  used inside the form.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">adapter config</Badge>
                <Badge variant="outline">runtime policy</Badge>
                <Badge variant="outline">env bindings</Badge>
              </div>
            </div>
          </section>

          <Section eyebrow="AgentProperties" title="Full detail panel with runtime and reporting data">
            <div className="grid gap-5 lg:grid-cols-[380px_minmax(0,1fr)]">
              <Card className="shadow-none">
                <CardHeader>
                  <div className="flex items-start gap-3">
                    <span className="flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-accent/40">
                      <AgentIcon icon={agentManagementAgents[0]!.icon} className="h-5 w-5" />
                    </span>
                    <div>
                      <CardTitle>{agentManagementAgents[0]!.name}</CardTitle>
                      <CardDescription>{agentManagementAgents[0]!.capabilities}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <AgentProperties agent={agentManagementAgents[0]!} runtimeState={runtimeState} />
                </CardContent>
              </Card>
              <div className="rounded-xl border border-border bg-background/70 p-5">
                <div className="mb-4 flex flex-wrap gap-2">
                  <Badge variant="secondary">session populated</Badge>
                  <Badge variant="secondary">last error shown</Badge>
                  <Badge variant="secondary">manager lookup seeded</Badge>
                </div>
                <div className="grid gap-3 text-sm md:grid-cols-2">
                  <div className="rounded-lg border border-border p-3">
                    <div className="text-xs text-muted-foreground">Budget</div>
                    <div className="mt-1 font-mono">${(agentManagementAgents[0]!.budgetMonthlyCents / 100).toFixed(0)} / month</div>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <div className="text-xs text-muted-foreground">Spent</div>
                    <div className="mt-1 font-mono">${(agentManagementAgents[0]!.spentMonthlyCents / 100).toFixed(0)}</div>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <div className="text-xs text-muted-foreground">Instructions</div>
                    <div className="mt-1 break-all font-mono text-xs">
                      {String(agentManagementAgents[0]!.adapterConfig.instructionsFilePath)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <div className="text-xs text-muted-foreground">Runtime policy</div>
                    <div className="mt-1 font-mono text-xs">heartbeat / 900s / max 2</div>
                  </div>
                </div>
              </div>
            </div>
          </Section>

          <Section eyebrow="AgentConfigForm" title="Adapter selection, runtime config, and env vars">
            <div className="max-w-4xl">
              <AgentConfigFormStory />
            </div>
          </Section>

          <Section eyebrow="AgentIconPicker" title="Available icon grid with selected state">
            <IconPickerMatrix />
          </Section>

          <Section eyebrow="AgentActionButtons" title="Pause, resume, restart, edit, and run actions by state">
            <AgentActionsMatrix />
          </Section>

          <Section eyebrow="ActiveAgentsPanel" title="Mixed live, queued, succeeded, and failed agent runs">
            <ActiveAgentsPanel companyId={COMPANY_ID} />
          </Section>

          <Section eyebrow="agent-config-primitives" title="Individual text, select, toggle, and JSON field types">
            <ConfigPrimitivesStory />
          </Section>

          <Separator />
        </main>
      </div>
    </StorybookQueryFixtures>
  );
}

const meta = {
  title: "Product/Agent Management",
  component: AgentManagementStories,
  parameters: {
    docs: {
      description: {
        component:
          "Agent management stories cover detail, configuration, icon, action, live-run, and config primitive states using extended Paperclip fixtures.",
      },
    },
  },
} satisfies Meta<typeof AgentManagementStories>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ManagementMatrix: Story = {};
