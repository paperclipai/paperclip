import { useLayoutEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useQueryClient } from "@tanstack/react-query";
import type { AgentObservabilitySettings, UpdateAgentObservabilityRequest } from "@paperclipai/shared";
import { Route, Routes } from "@/lib/router";
import { Layout } from "@/components/Layout";
import { CompanySettings } from "@/pages/CompanySettings";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { unconfigured as decisionSettings } from "../../../support/decision-models/fixtures";
import { companyId, configured, receipt } from "../../../support/observability/fixtures";

function Journey() {
  const client = useQueryClient();
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const original = window.fetch;
    let settings: AgentObservabilitySettings | null = null;
    let version = 1;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
      const base = `/api/companies/${companyId}/observability`;
      if (url.pathname === `/api/companies/${companyId}/decision-model`) return Response.json({ canManage: true, settings: decisionSettings, choices: [] });
      if (url.pathname === "/api/instance/settings/general") return Response.json({ censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" });
      if (url.pathname === base) {
        if (init?.method === "PUT") {
          const data = JSON.parse(String(init.body)) as UpdateAgentObservabilityRequest;
          if (data.expectedRevision !== (settings?.revision ?? null)) return Response.json({ error: "Settings changed" }, { status: 409 });
          settings = { ...configured, revision: `10000000-0000-4000-8000-${String(version++).padStart(12, "0")}`,
            enabled: data.enabled, destination: data.destination, capture: data.capture, lastTest: null };
        } else if (init?.method === "DELETE") settings = null;
        return Response.json({ canManage: true, settings });
      }
      if (url.pathname === `${base}/test` && settings) {
        settings = { ...settings, lastTest: { ...receipt, revision: settings.revision } };
        return Response.json(settings.lastTest);
      }
      return original(input, init);
    };
    setReady(true);
    return () => { window.fetch = original; client.removeQueries({ queryKey: ["agent-observability", companyId] }); };
  }, [client]);
  return ready ? <PluginLauncherProvider><Routes><Route path="/:companyPrefix" element={<Layout />}>
    <Route path="company/settings" element={<CompanySettings />} />
  </Route></Routes></PluginLauncherProvider> : null;
}
const meta = {
  id: "agent-observability-03-journey",
  title: "Getting started and access/Companies and portability/Agent observability/03 Journey",
  component: Journey,
  parameters: { layout: "fullscreen", initialEntries: ["/PAP/company/settings"], paperclip: {
    capabilities: ["companies/agent-observability"], implementation: "production", boundary: "fixtures",
    notes: "Production company settings and app shell. Stateful mocked API verifies configure, save, test, disable, and remove; no real OTLP or credentials." } },
} satisfies Meta<typeof Journey>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ConfigureTestDisable: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getByRole("heading", { name: "Agent observability" })).toBeVisible());
  const section = within(canvas.getByRole("heading", { name: "Agent observability" }).closest("section")!);
  await userEvent.type(section.getByLabelText("Project ID"), "20000000-0000-4000-8000-000000000001");
  await userEvent.type(section.getByLabelText("API key"), "fake-storybook-key");
  await userEvent.click(section.getByRole("switch", { name: "Enable export" }));
  await userEvent.click(section.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(section.getByText("API key configured")).toBeVisible());
  await userEvent.click(section.getByRole("button", { name: "Test saved settings" }));
  await waitFor(() => expect(section.getByText("Test payload accepted")).toBeVisible());
  await userEvent.click(section.getByRole("button", { name: "Disable export" }));
  await waitFor(() => expect(section.queryByRole("button", { name: "Disable export" })).not.toBeInTheDocument());
  await userEvent.click(section.getByRole("button", { name: "Remove configuration" }));
  await waitFor(() => expect(section.queryByText("API key configured")).not.toBeInTheDocument());
} };
