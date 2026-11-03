import { normalizeClaudeRunnerOptions } from "@paperclipai/shared";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { Route, Routes } from "@/lib/router";
import { AgentDetail } from "@/pages/AgentDetail";
import { Layout } from "@/components/Layout.production";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { storybookAgents } from "../../../fixtures/paperclipData";
import { resetOnboardingFixtureState, setOnboardingFixtureState } from "../../../fixtures/onboardingEnvironment";

type Scenario = {
  harness?: "codex_local" | "claude_local";
  failOnce?: boolean;
  incompatible?: boolean;
  unavailable?: boolean;
  upgraded?: boolean;
  running?: boolean;
  delay?: number;
  nativeComputerTest?: boolean;
};

function installUpgradeFixture({ harness = "codex_local", failOnce = false, incompatible = false, unavailable = false, upgraded = false, running = false, delay = 0, nativeComputerTest = false }: Scenario = {}) {
  resetOnboardingFixtureState();
  setOnboardingFixtureState({ environments: "local", authSignal: "present", localLoginStatus: "ready" });
  const profile = harness === "claude_local" ? { provider: "acpx", acpxAgent: "claude" } : { provider: "codex" };
  const savedComputer = { id: "environment-native-recovery", name: "Paperclip Computer", driver: "sandbox", status: "active",
    config: { provider: "daytona", snapshot: "managed-snapshot" }, metadata: { managedByPaperclip: true } };
  let qualified = false;
  let agent = { ...storybookAgents[0]!, urlKey: "migration-agent", name: harness === "claude_local" ? "ClaudeWriter" : "CodexCoder",
    status: running ? "running" : "idle", lifecycleState: "ready", defaultEnvironmentId: nativeComputerTest ? savedComputer.id : null,
    adapterType: upgraded || nativeComputerTest ? "paperclip_runner" : harness,
    adapterConfig: { model: harness === "claude_local" ? "claude-sonnet-4-6" : "gpt-5.4", modelReasoningEffort: "medium", timeoutSec: 180,
      ...(nativeComputerTest ? { provider: "opencode" } : upgraded ? profile : {}), ...(incompatible ? { chrome: true } : {}), env: { MIGRATION_MARKER: { type: "plain", value: "keep-this-setting" } } },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    chainOfCommand: [], access: { canAssignTasks: true, taskAssignSource: "explicit_grant", membership: null, grants: [] },
  };
  const previous = window.fetch;
  const fixtureFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    const method = init?.method ?? "GET";
    if (nativeComputerTest && url.pathname === `/api/companies/${agent.companyId}/environments`) return Response.json([savedComputer]);
    if (nativeComputerTest && url.pathname === `/api/agents/${agent.id}/qualify-runner`) {
      if (JSON.parse(String(init?.body ?? "{}")).expectedEnvironmentId !== savedComputer.id) return Response.json({ error: "Computer changed." }, { status: 409 });
      qualified = true;
      return Response.json({ ok: true, driver: "sandbox", details: { platformQualificationRecorded: true } });
    }
    if (nativeComputerTest && url.pathname.endsWith("/adapters/paperclip_runner/test-environment")) {
      return Response.json({ adapterType: "paperclip_runner", status: qualified ? "pass" : "fail", testedAt: new Date().toISOString(),
        checks: [{ code: "native_runtime_test", level: qualified ? "info" : "error", message: qualified ? "Native runtime ready." : "Saved computer qualification is stale." }] });
    }
    if (url.pathname === "/api/adapters") {
      const response = await previous(input, init);
      return Response.json((await response.json()).map((item: { type: string }) => ["codex_local", "claude_local"].includes(item.type)
        ? { ...item, defaultRunner: unavailable ? "legacy" : "paperclip", supportedRunners: unavailable ? ["legacy"] : ["legacy", "paperclip"] } : item));
    }
    if (url.pathname === `/api/companies/${agent.companyId}/agents`) {
      return Response.json(storybookAgents.map(item => item.id === agent.id ? agent : item));
    }
    if ([`/api/agents/${agent.id}`, `/api/agents/${agent.urlKey}`].includes(url.pathname)) {
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body ?? "{}"));
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        if (patch.runner !== "paperclip") return Response.json({ error: "This fixture expects an explicit runner upgrade." }, { status: 422 });
        if (failOnce) {
          failOnce = false;
          return Response.json({ error: "Could not save this agent. Try again." }, { status: 503 });
        }
        const { runner: _runner, replaceAdapterConfig: _replace, adapterConfig, ...rest } = patch;
        const converted = { ...agent.adapterConfig, ...adapterConfig, ...profile };
        const normalized = harness === "claude_local" ? normalizeClaudeRunnerOptions(converted) : { config: converted, warnings: [] };
        agent = { ...agent, ...rest, adapterType: "paperclip_runner", adapterConfig: normalized.config as typeof agent.adapterConfig };
        return Response.json({ ...agent, configurationWarnings: normalized.warnings });
      }
      return Response.json(agent);
    }
    return previous(input, init);
  };
  window.fetch = fixtureFetch;
  return () => { if (window.fetch === fixtureFetch) window.fetch = previous; resetOnboardingFixtureState(); };
}

function UpgradePage() {
  return <PluginLauncherProvider><Routes>
    <Route path="/:companyPrefix" element={<Layout />}>
      <Route path="agents/:agentId/:tab?" element={<AgentDetail />} />
    </Route>
  </Routes></PluginLauncherProvider>;
}

const meta = {
  id: "agents-runner-upgrade",
  title: "Agents and reusable capabilities/Hiring, configuration, and organization/Agents/Runner upgrade",
  component: UpgradePage,
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/agents/migration-agent/runtime"],
    docs: { description: { component: "Existing Codex and Claude agents in the production agent page and app shell. The upgrade PATCH and subsequent reads use a mutable HTTP fixture. These stories demonstrate the notice, save, retry and refreshed form; real migration and provider proof are separate checks." } },
    paperclip: {
      capabilities: ["agents/instructions", "runs-adapters/validation"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "Production AgentDetail, ConfigurationTab, AgentConfigForm and app shell. Mutable fixtures simulate upgrade persistence and rejection; no provider, credential access, session reset or durable database is exercised.",
    },
  },
  beforeEach: ({ parameters }) => installUpgradeFixture(parameters.runnerUpgrade),
  render: () => <UpgradePage />,
} satisfies Meta<typeof UpgradePage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const LegacyCodex: Story = {};
export const LegacyClaude: Story = { parameters: { runnerUpgrade: { harness: "claude_local" } } };
export const Upgrading: Story = { parameters: { runnerUpgrade: { delay: 60_000 } }, play: async ({ canvasElement }) => {
  const page = within(canvasElement);
  await userEvent.click(await page.findByRole("button", { name: "Upgrade runner" }));
  await expect(await page.findByRole("button", { name: "Upgrading…" })).toBeDisabled();
} };
export const UpgradeCodex: Story = { play: async ({ canvasElement }) => {
  const page = within(canvasElement);
  await userEvent.click(await page.findByRole("button", { name: "Upgrade runner" }));
  await expect(await page.findByText("Upgraded to Paperclip Runner.")).toBeVisible();
  await waitFor(() => expect(page.queryByRole("button", { name: "Upgrade runner" })).not.toBeInTheDocument());
  await expect(await page.findByRole("button", { name: /^Model$/ })).toHaveTextContent(/gpt-5.4/i);
} };
export const UpgradeClaude: Story = { ...UpgradeCodex, parameters: { runnerUpgrade: { harness: "claude_local" } }, play: async ({ canvasElement }) => {
  const page = within(canvasElement);
  await userEvent.click(await page.findByRole("button", { name: "Upgrade runner" }));
  await expect(await page.findByText("Upgraded to Paperclip Runner.")).toBeVisible();
  await expect(await page.findByRole("button", { name: /^Model$/ })).toHaveTextContent(/claude[- ]sonnet[- ]4[-.]6/i);
} };
export const FailureAndRetry: Story = { parameters: { runnerUpgrade: { failOnce: true } }, play: async ({ canvasElement }) => {
  const page = within(canvasElement);
  await userEvent.click(await page.findByRole("button", { name: "Upgrade runner" }));
  await expect(await page.findByRole("alert")).toHaveTextContent("Could not save this agent");
  await userEvent.click(page.getByRole("button", { name: "Upgrade runner" }));
  await expect(await page.findByText("Upgraded to Paperclip Runner.")).toBeVisible();
} };
export const IncompatibleClaudeSetting: Story = { name: "Ignored Claude setting", parameters: { runnerUpgrade: { harness: "claude_local", incompatible: true } }, play: async ({ canvasElement }) => {
  const page = within(canvasElement);
  await expect(await page.findByText(/Chrome integration.*is ignored/)).toBeVisible();
  await userEvent.click(await page.findByRole("button", { name: "Upgrade runner" }));
  await expect(await page.findByText("Upgraded to Paperclip Runner.")).toBeVisible();
} };
export const RepairAndUpgrade: Story = { ...IncompatibleClaudeSetting, name: "Remove obsolete option and upgrade", play: async ({ canvasElement }) => {
  const page = within(canvasElement);
  await userEvent.click(await page.findByRole("switch", { name: "Enable Chrome" }));
  await expect(page.getByText("Your unsaved changes will be included.")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Upgrade runner" }));
  await expect(await page.findByText("Upgraded to Paperclip Runner.")).toBeVisible();
} };
export const AlreadyUpgraded: Story = { parameters: { runnerUpgrade: { upgraded: true } } };
export const UnavailableEnvironment: Story = { parameters: { runnerUpgrade: { unavailable: true } } };
export const AgentRunning: Story = { parameters: { runnerUpgrade: { running: true } } };
export const Mobile: Story = { globals: { viewport: { value: "mobile1", isRotated: false } } };
export const Light: Story = { globals: { theme: "light" } };

export const NativeComputerRecovery: Story = {
  name: "Native saved computer Test",
  parameters: { runnerUpgrade: { nativeComputerTest: true }, paperclip: {
    notes: "Production native agent page. The normal Run test action qualifies its saved computer before runtime testing. Both responses are simulated; real provider qualification is separate.",
  } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await userEvent.click(await page.findByRole("button", { name: /^Run test$/ }));
    await expect(await page.findByRole("heading", { name: "Connection successful" })).toBeVisible();
    await userEvent.click(page.getByText("Test details", { exact: true }));
    await expect(await page.findByText("Native runtime ready.")).toBeVisible();
    await expect(page.queryByRole("button", { name: "Upgrade runner" })).not.toBeInTheDocument();
  },
};
