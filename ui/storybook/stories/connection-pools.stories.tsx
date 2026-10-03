import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, AiConnectionList, AiConnectionPool, AiConnectionRouterSelection, AiRuntimeConnectionBinding, Issue } from "@paperclipai/shared";
import { AiConnectionField } from "@/components/ai-connections/AiConnectionField";
import { AiConnectionPoolRunDetails } from "@/components/ai-connections/AiConnectionPoolRunDetails";
import { IssueMonitorBanner, IssueMonitorComposerStrip } from "@/components/IssueMonitorBanner";
import { ComposerRunSettingsPicker } from "@/components/task-chat/ComposerRunSettingsPicker";
import type { ComposerRunSettings } from "@/components/task-chat/composer-run-settings";
import { RunRetryDetails } from "@/components/RunRetryDetails";
import { AiConnectionRoutersSetting } from "@/pages/InstanceExperimentalSettings";
import { queryKeys } from "@/lib/queryKeys";
import { storybookAgents, storybookIssues } from "../fixtures/paperclipData";

const companyId = "company-storybook", agentId = "agent-codex";
const poolId = "10000000-0000-4000-8000-000000000001";
const pool: AiConnectionPool = {
  id: poolId, companyId, pluginKey: "paperclip-cloud.plugin-connection-pool", revision: 3,
  name: "Research accounts", enabled: true, mode: "round_robin", thresholdPercent: 90,
  members: [
    { id: "20000000-0000-4000-8000-000000000001", binding: { mode: "delegated", provider: "openai", method: "subscription", connectionId: "30000000-0000-4000-8000-000000000001", grantId: "40000000-0000-4000-8000-000000000001" }, profile: { provider: "codex", model: "gpt-5.6-sol", effort: "high" } },
    { id: "20000000-0000-4000-8000-000000000002", binding: { mode: "delegated", provider: "anthropic", method: "subscription", connectionId: "30000000-0000-4000-8000-000000000002", grantId: "40000000-0000-4000-8000-000000000002" }, profile: { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" } },
  ],
};
const accounts: AiConnectionList = { currentUserId: "user-board", canManageConnections: true, pools: [pool], connections: pool.members.map((m, index) => ({
  id: m.binding.connectionId!, grantId: m.binding.grantId!, companyId, provider: m.binding.provider, method: m.binding.method!, name: index === 0 ? "My OpenAI subscription" : "My Claude subscription", ownership: "personal", ownerUserId: "user-board", isDefault: true, status: "connected",
})) };
const models = [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol · Codex" }, { id: "claude-sonnet-5", label: "Claude Sonnet 5 · Claude ACP" }];
const agent: Agent = { ...storybookAgents.find(a => a.id === agentId)!, adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-sol" }, runtimeConfig: { aiConnection: { mode: "router", connectionId: poolId } } };
type Scenario = "overview" | "selector" | "legacy" | "adoption" | "unavailable" | "read-only" | "models" | "effort" | "mobile" | "claude-model" | "quota" | "checking" | "run-codex" | "run-claude" | "fallback" | "retry" | "flag-off" | "flag-on" | "flag-managed";

function PoolComposer({ scenario }: { scenario: Scenario }) {
  const [settings, setSettings] = useState<ComposerRunSettings>({ model: scenario === "claude-model" ? "claude-sonnet-5" : "gpt-5.6-sol", effort: null, fast: false });
  return <div className="space-y-3 rounded-xl border bg-card p-4">
    <p className="text-sm">Choose settings for the next turn. The task keeps its account and harness.</p>
    <ComposerRunSettingsPicker companyId={companyId} assigneeValue={`agent:${agentId}`} currentAssigneeValue={`agent:${agentId}`}
      options={[{ id: `agent:${agentId}`, label: agent.name }]} agents={new Map([[agentId, agent]])}
      settings={settings} onSettingsChange={setSettings} onAssigneeChange={() => setSettings({ model: null, effort: null, fast: false })}
      modelOptionsOverride={models} mobile={scenario === "mobile"} initialOpen={scenario !== "overview"}
      initialView={scenario === "models" || scenario === "mobile" ? "models" : "settings"} />
  </div>;
}
function PoolWait({ checking = false }: { checking?: boolean }) {
  const [issue] = useState<Issue>(() => ({ ...storybookIssues[0]!, status: "in_progress", executionState: null,
    scheduledRetry: { status: "scheduled_retry", scheduledRetryReason: "ai_connection_pool_wait", scheduledRetryAt: new Date(Date.now() + 60_000).toISOString(), scheduledRetryAttempt: 1 } as Issue["scheduledRetry"],
  }));
  return <div className="space-y-4"><IssueMonitorBanner issue={issue} onCheckNow={() => undefined} checkingNow={checking} /><IssueMonitorComposerStrip issue={issue} onCheckNow={() => undefined} checkingNow={checking} /></div>;
}
function PoolRun({ scenario }: { scenario: Scenario }) {
  const claude = scenario === "run-claude", member = pool.members[claude ? 1 : 0]!;
  const selection: AiConnectionRouterSelection = { poolId, memberId: member.id, binding: member.binding,
    runtimeConfig: { ...member.profile, ...(claude ? {} : { modelReasoningEffort: "high" }) },
    notes: scenario === "fallback" ? ["Model override is unavailable for this member; using its default.", "Effort override is unavailable for the effective model; using its default."] : [],
  };
  return <div className="space-y-4"><AiConnectionPoolRunDetails context={{ aiRouterSelection: selection, aiConnection: { accountName: claude ? "My Claude subscription" : "My OpenAI subscription" } }} />
    {scenario === "retry" && <RunRetryDetails agentRouteId={agentId} run={{ status: "scheduled_retry", scheduledRetryReason: "ai_connection_pool_wait", scheduledRetryAt: new Date(Date.now() + 60_000).toISOString(), scheduledRetryAttempt: 1, retryOfRunId: "run-pool-wait" }} />}</div>;
}
function PoolSurfaces({ scenario = "overview" }: { scenario?: Scenario }) {
  const [client] = useState(() => {
    const query = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    query.setQueryData(["ai-connections", companyId, agentId], { ...accounts, pools: scenario === "unavailable" ? [] : accounts.pools });
    query.setQueryData(queryKeys.instance.settings, {});
    return query;
  });
  const [binding, setBinding] = useState<AiRuntimeConnectionBinding | undefined>(scenario === "adoption" ? undefined : { mode: "router", connectionId: poolId });
  const [enabled, setEnabled] = useState(scenario === "flag-on");
  const overview = scenario === "overview";
  return <QueryClientProvider client={client}><main className="mx-auto max-w-3xl space-y-6 p-6">
    <header className="space-y-2"><h1 className="text-xl font-semibold">Experimental connection pools</h1><p className="text-sm text-muted-foreground">Core integration · production components with fixture accounts. Configure the pool itself in Cloud’s plugin Storybook.</p></header>
    {(overview || scenario.startsWith("flag")) && <AiConnectionRoutersSetting checked={enabled} onCheckedChange={setEnabled} managed={scenario === "flag-managed" ? { managed: true, managedBy: "paperclip-cloud" } : undefined} />}
    {(overview || ["selector", "legacy", "adoption", "unavailable", "read-only"].includes(scenario)) && <section className="space-y-2"><h2 className="text-sm font-semibold">Agent connection</h2><AiConnectionField companyId={companyId} agentId={agentId} agentName={agent.name}
      adapterType={scenario === "legacy" ? "claude_local" : "codex_local"} routerAdapterType={scenario === "legacy" ? "claude_local" : "paperclip_runner"}
      value={binding} onChange={setBinding} legacy={scenario === "adoption"} readOnly={scenario === "read-only"} /></section>}
    {(overview || ["models", "effort", "mobile", "claude-model"].includes(scenario)) && <section className="space-y-2"><h2 className="text-sm font-semibold">Composer model and effort</h2><PoolComposer scenario={scenario} /></section>}
    {(overview || scenario === "quota" || scenario === "checking") && <section><h2 className="text-sm font-semibold">Usage recovery</h2><PoolWait checking={scenario === "checking"} /></section>}
    {(overview || ["run-codex", "run-claude", "fallback", "retry"].includes(scenario)) && <section className="space-y-2"><h2 className="text-sm font-semibold">Run account and runtime</h2><PoolRun scenario={scenario === "overview" ? "fallback" : scenario} /></section>}
  </main></QueryClientProvider>;
}
const meta = { title: "AI Connections/Connection pools", component: PoolSurfaces, parameters: { layout: "fullscreen", docs: { description: { component: "All user-facing Core additions for the private connection-pool plugin. These stories mount the production selector, composer, quota banners, run details/retry metadata, and instance setting. Accounts are fixtures; no live provider calls or instance mutations occur." } } }, render: args => <PoolSurfaces key={args.scenario} {...args} /> } satisfies Meta<typeof PoolSurfaces>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AllCoreSurfaces: Story = { args: { scenario: "overview" } };
export const ConnectionSelector: Story = { args: { scenario: "selector" }, play: async ({ canvasElement }) => { const c = within(canvasElement); await userEvent.selectOptions(c.getByRole("combobox", { name: /^AI connection/ }), ""); await expect(c.getByText("Responsible user’s connection", { exact: false })).toBeVisible(); await userEvent.selectOptions(c.getByRole("combobox", { name: /^AI connection/ }), poolId); await expect(c.getByText(/New tasks rotate/)).toBeVisible(); } };
export const CompatibleLegacyHarness: Story = { args: { scenario: "legacy" } };
export const ExistingSessionAdoption: Story = { args: { scenario: "adoption" }, play: async ({ canvasElement }) => { const c = within(canvasElement); await userEvent.click(c.getByRole("button", { name: "Choose a managed connection" })); await userEvent.selectOptions(c.getByRole("combobox", { name: /^AI connection/ }), poolId); await expect(await within(canvasElement.ownerDocument.body).findByRole("dialog")).toHaveTextContent("Task-pinned connection pool"); } };
export const PoolUnavailable: Story = { args: { scenario: "unavailable" } };
export const ReadOnlySelection: Story = { args: { scenario: "read-only" } };
export const ComposerModelsFromBothProviders: Story = { args: { scenario: "models" } };
export const ComposerCodexEffort: Story = { args: { scenario: "effort" } };
export const ComposerClaudeModelOnly: Story = { args: { scenario: "claude-model" } };
export const MobileComposer: Story = { args: { scenario: "mobile" } };
export const PoolExhaustedBannerAndStrip: Story = { args: { scenario: "quota" } };
export const UsageRecheckInProgress: Story = { args: { scenario: "checking" } };
export const PinnedCodexRun: Story = { args: { scenario: "run-codex" } };
export const PinnedClaudeRun: Story = { args: { scenario: "run-claude" } };
export const IndependentOverrideFallbackNotes: Story = { args: { scenario: "fallback" } };
export const ScheduledQuotaRetry: Story = { args: { scenario: "retry" } };
export const ExperimentalOffByDefault: Story = { args: { scenario: "flag-off" } };
export const ExperimentalEnabled: Story = { args: { scenario: "flag-on" } };
export const ExperimentalManagedByCloud: Story = { args: { scenario: "flag-managed" } };
