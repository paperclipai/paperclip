import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useQueryClient } from "@tanstack/react-query";
import { Routes, Route, useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { Layout } from "@/components/Layout";
import { Agents } from "@/pages/Agents";
import { queryKeys } from "@/lib/queryKeys";
import type { Agent, AiConnectionBinding, AiManagedConnectionSummary } from "@paperclipai/shared";
import { storybookAgents } from "../../fixtures/paperclipData";
import { connections, harnesses, roster } from "../../support/design-proposals/bulk-agent-settings-data";

const companyId = "company-storybook";
const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const accounts: AiManagedConnectionSummary[] = connections.map((c, i) => ({ ...c, id: uuid(i + 1), grantId: uuid(i + 101), isDefault: false,
  ...(c.id === "codex-limited" ? { routing: { kind: "gateway", protocol: "responses", auth: "bearer", baseUrl: "https://models.example.invalid/v1", models: [{ id: "gpt-5.5" }, { id: "gpt-5.4" }] } as const } : {}),
}));
function initialAgents(): Agent[] {
  return roster.map((r, i) => {
    const connection = accounts[connections.findIndex(c => c.id === r.connectionId)];
    const binding: AiConnectionBinding | undefined = connection ? { provider: connection.provider, method: connection.method, mode: "shared", connectionId: connection.id, grantId: connection.grantId } : undefined;
    return { ...storybookAgents[0], id: uuid(i + 201), urlKey: r.id, name: r.name, title: r.title, companyId,
      adapterType: r.harness === "external" ? "http" : harnesses[r.harness].adapter,
      adapterConfig: { model: r.model, cwd: "/workspace" }, runtimeConfig: { heartbeat: { intervalSec: 900 }, ...(binding ? { aiConnection: binding } : {}) }, status: r.paused ? "paused" : "idle", pausedAt: r.paused ? new Date("2026-10-22T00:00:00Z") : null };
  });
}

function BulkSettingsPage({ failOne = false, localHermes = false }: { failOne?: boolean; localHermes?: boolean }) {
  const [ready, setReady] = useState(false);
  const client = useQueryClient();
  const navigate = useNavigate();
  const { setSelectedCompanyId } = useCompany();
  useEffect(() => {
    let agents = localHermes ? initialAgents().slice(0, 1).map(a => ({ ...a, name: "Hermes", adapterType: "hermes_local" as const, runtimeConfig: {}, adapterConfig: { model: "provider/old-model" } })) : initialAgents();
    let failed = false;
    const previous = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
      const path = url.pathname;
      if (path === `/api/companies/${companyId}/agents`) return Response.json(agents);
      if (path === `/api/companies/${companyId}/ai-connections`) return Response.json({ currentUserId: "user-board", canManageConnections: true, connections: accounts, pools: [] });
      const adapter = path.match(/\/adapters\/([^/]+)\/models$/)?.[1];
      if (adapter) return Response.json(Object.values(harnesses).find(h => h.adapter === adapter)?.models.map(id => ({ id, label: id })) ?? []);
      const agentId = path.match(/^\/api\/agents\/([^/]+)$/)?.[1];
      if (agentId) {
        const agent = agents.find(a => a.id === agentId);
        if (!agent) return Response.json({ error: "Not found" }, { status: 404 });
        if (init?.method === "PATCH") {
          if (failOne && agent.name === "Scout" && !failed) { failed = true; return Response.json({ error: "Connection interrupted while saving. Try again." }, { status: 503 }); }
          const { runtimeSettings } = JSON.parse(String(init.body));
          const updated = { ...agent, adapterConfig: { ...agent.adapterConfig, ...(runtimeSettings.model ? { model: runtimeSettings.model } : {}) }, runtimeConfig: { ...agent.runtimeConfig, ...(runtimeSettings.aiConnection ? { aiConnection: runtimeSettings.aiConnection } : {}) } };
          agents = agents.map(a => a.id === agentId ? updated : a);
          return Response.json(updated);
        }
        return Response.json(agent);
      }
      return previous(input, init);
    };
    client.setQueryData(queryKeys.agents.list(companyId), agents);
    setSelectedCompanyId(companyId);
    navigate("/PAP/agents/all", { replace: true });
    setReady(true);
    return () => { window.fetch = previous; };
  }, [client, navigate, setSelectedCompanyId, failOne, localHermes]);
  return ready ? <PluginLauncherProvider><Routes><Route path="/:companyPrefix" element={<Layout />}><Route path="agents/all" element={<Agents />} /></Route></Routes></PluginLauncherProvider> : null;
}

const meta = {
  id: "agents-bulk-settings", title: "Agents and reusable capabilities/Hiring, configuration, and organization/Agents/Bulk settings",
  component: BulkSettingsPage,
  parameters: { layout: "fullscreen", initialEntries: ["/PAP/agents/all"], paperclip: {
    capabilities: ["agents/organization", "agents/instructions"], implementation: "production", boundary: "fixtures",
    notes: "Actual Agents page, filter icon/popover with preserved selection, bulk roster, sheet, account picker, model intersection and narrow PATCH client. Includes paused agents at normal contrast. The roster has no status selector or persistent selection hint. HTTP accounts/catalogs/writes are synthetic, including one transient failure and an empty local Hermes catalog. Does not establish live provider credential validity or database persistence. The original approved proposal remains in Design proposals.",
  } },
} satisfies Meta<typeof BulkSettingsPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Playground: Story = {};
export const Light: Story = { globals: { theme: "light" } };

export const FilterJourney: Story = { play: async ({ canvasElement }) => {
  const page = within(canvasElement);
  const screen = within(canvasElement.ownerDocument.body);
  await userEvent.click(await page.findByRole("checkbox", { name: "Select Sage" }));
  await userEvent.click(page.getByRole("button", { name: "Filter agents" }));
  const filters = within(await screen.findByRole("dialog", { name: "Agent filters" }));
  await userEvent.click(filters.getByRole("button", { name: "Codex" }));
  await expect(page.queryByRole("checkbox", { name: "Select Sage" })).not.toBeInTheDocument();
  await expect(page.getByText("1 hidden by filters")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Scout" })).toBeEnabled();
  await userEvent.click(filters.getByRole("button", { name: "Clear" }));
  await expect(await page.findByRole("checkbox", { name: "Select Sage" })).toBeChecked();
  await userEvent.keyboard("{Escape}");
  await expect(page.getByRole("button", { name: "Filter agents" })).toHaveFocus();
  await userEvent.click(page.getByRole("button", { name: "Clear selection" }));
} };

async function selectCodex(canvasElement: HTMLElement, mixed = false) {
  const page = within(canvasElement);
  for (const name of ["Atlas", "Nova", "Pixel", "Scout", ...(mixed ? ["Sage"] : [])]) await userEvent.click(await page.findByRole("checkbox", { name: `Select ${name}` }));
  await userEvent.click(page.getByRole("button", { name: mixed ? "Edit 4 Codex" : "Edit connection & model" }));
  return within(canvasElement.ownerDocument.body);
}
export const ModelJourney: Story = { play: async ({ canvasElement }) => {
  const screen = await selectCodex(canvasElement);
  await userEvent.click(await screen.findByRole("checkbox", { name: "Change default model" }));
  await userEvent.click(screen.getByRole("button", { name: "Model" }));
  await userEvent.click(await screen.findByRole("option", { name: "gpt-5.5" }));
  await expect(screen.getByRole("button", { name: "Update 3 agents" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Update 3 agents" }));
  await expect(await within(canvasElement).findByText("Updated 3 Codex agents.")).toBeVisible();
  const scout = within(canvasElement).getByRole("checkbox", { name: "Select Scout" }).closest("tr")!;
  await expect(scout).toHaveTextContent("gpt-5.5");
  await expect(scout).toHaveTextContent("OpenAI · Engineering");
} };
export const ConnectionJourney: Story = { play: async ({ canvasElement }) => {
  const screen = await selectCodex(canvasElement, true);
  await expect(await screen.findByText("1 other selected agent won’t change.")).toBeVisible();
  await userEvent.click(screen.getByRole("checkbox", { name: "Change connection" }));
  await userEvent.click(await screen.findByRole("combobox", { name: "Connection" }));
  await userEvent.click(screen.getByRole("option", { name: /^OpenAI · Production ·/ }));
  await expect(screen.getByRole("button", { name: "Update 4 agents" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Update 4 agents" }));
  await expect(await within(canvasElement).findByText("Updated 4 Codex agents.")).toBeVisible();
  await expect(within(canvasElement).getByRole("checkbox", { name: "Select Sage" })).toBeChecked();
  await expect(within(canvasElement).getByRole("checkbox", { name: "Select Scout" }).closest("tr")!).toHaveTextContent("gpt-5.3-codex");
} };
export const RetryJourney: Story = { args: { failOne: true }, play: async ({ canvasElement }) => {
  const screen = await selectCodex(canvasElement);
  await userEvent.click(await screen.findByRole("checkbox", { name: "Change connection" }));
  await userEvent.click(await screen.findByRole("combobox", { name: "Connection" }));
  await userEvent.click(screen.getByRole("option", { name: /^OpenAI · Production ·/ }));
  await expect(screen.getByRole("button", { name: "Update 4 agents" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Update 4 agents" }));
  await expect(await screen.findByText("3 updated · 1 couldn’t be saved")).toBeVisible();
  await waitFor(() => expect(screen.getByRole("button", { name: "Retry 1 agent" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "Retry 1 agent" }));
  await expect(await within(canvasElement).findByText("Updated 4 Codex agents.")).toBeVisible();
} };

export const ManualModelJourney: Story = { args: { localHermes: true }, play: async ({ canvasElement }) => {
  const page = within(canvasElement);
  await userEvent.click(await page.findByRole("checkbox", { name: "Select Hermes" }));
  await userEvent.click(page.getByRole("button", { name: "Edit connection & model" }));
  const screen = within(canvasElement.ownerDocument.body);
  await userEvent.click(await screen.findByRole("checkbox", { name: "Change default model" }));
  await userEvent.click(screen.getByRole("button", { name: "Model" }));
  await userEvent.type(await screen.findByPlaceholderText("Search models... (type to create)"), "provider/custom-model");
  await userEvent.click(screen.getByRole("option", { name: "Use manual model provider/custom-model" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Update 1 agent" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "Update 1 agent" }));
  await expect(await page.findByText("Updated 1 Hermes agent.")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Hermes" }).closest("tr")!).toHaveTextContent("provider/custom-model");
} };
