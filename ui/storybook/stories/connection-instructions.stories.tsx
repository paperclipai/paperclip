import { useEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { useQueryClient } from "@tanstack/react-query";
import { getConnectableAppDefinition } from "@paperclipai/shared";
import { Route, Routes, useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { Layout } from "@/components/Layout";
import { AppDetail } from "@/pages/apps/AppDetail";
import { Browse } from "@/pages/apps/Browse";
import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";
import { AgentConnectionInstructions } from "@/features/connections/ConnectionInstructions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GUIDANCE_COMPANY, GUIDANCE_CONNECTION, guidanceAgents, installConnectionGuidanceFixtures } from "../fixtures/connectionInstructions";

const HONCHO = getConnectableAppDefinition("honcho")!.agentInstructions!.text;
const NOTION = "Use Notion as the source for our published product decisions. Look up the relevant decision before proposing a change, and link to the page you used. Ask before changing a published decision. If a page is unavailable, say which context is missing and continue with the information you have.";
type Scenario = "normal" | "off" | "save-error" | "missing-context" | "write-approval" | "reconnect";
type Props = { initialView?: "connect" | "connection" | "agent"; provider?: "Honcho" | "Notion"; scenario?: Scenario; baseline?: boolean; providedInstructions?: string };

/** Production pages and editors with stateful API fixtures. */
function ConnectionInstructionsPrototype({ initialView = "connection", provider = "Honcho", scenario = "normal", baseline = false, providedInstructions }: Props) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const [ready, setReady] = useState(false);
  const initialized = useRef(false);
  const [previewOpen, setPreviewOpen] = useState(initialView === "agent");
  const connectionPath = `/PAP/apps/${GUIDANCE_CONNECTION}/permissions`;
  useEffect(() => installConnectionGuidanceFixtures(client, provider, {
    setup: initialView === "connect" && scenario !== "reconnect", askFirst: scenario === "write-approval",
    template: baseline ? null : providedInstructions ?? null, disabled: scenario === "off",
    missingWorkspace: scenario === "missing-context", failSave: scenario === "save-error",
  }), [client, provider, initialView, scenario, baseline, providedInstructions]);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    setSelectedCompanyId(GUIDANCE_COMPANY);
    navigate(initialView === "connect"
      ? `/PAP/apps/connect?source=${provider.toLowerCase()}${scenario === "reconnect" ? `&reconnect=${GUIDANCE_CONNECTION}` : ""}`
      : connectionPath, { replace: true });
    setReady(true);
  }, [provider, initialView, scenario, navigate, setSelectedCompanyId, connectionPath]);
  if (!ready || selectedCompanyId !== GUIDANCE_COMPANY) return null;
  return <PluginLauncherProvider>
    <Routes>
      <Route path="/:companyPrefix" element={<Layout />}>
        <Route path="apps" element={<Browse />} />
        <Route path="apps/connect" element={<ConnectionSetupFlow onComplete={() => navigate(connectionPath)} />} />
        <Route path="apps/:connectionId/:tab?" element={<><AppDetail /><Button variant="ghost" onClick={() => setPreviewOpen(true)}>Preview on Ada</Button></>} />
      </Route>
    </Routes>
    <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader><DialogTitle>Instructions for Ada</DialogTitle><DialogDescription>Instructions provided by assigned connections.</DialogDescription></DialogHeader>
        <AgentConnectionInstructions companyId={GUIDANCE_COMPANY} agentId={guidanceAgents[0]!.id} />
      </DialogContent>
    </Dialog>
  </PluginLauncherProvider>;
}

const meta = {
  title: "Design explorations/Connections/Agent instructions",
  component: ConnectionInstructionsPrototype,
  args: { providedInstructions: HONCHO },
  parameters: { layout: "fullscreen", docs: { description: { component: "Production Layout, ConnectionSetupFlow, AppDetail, identity/access controls, and searchable Actions list with local API fixtures. The production instructions editor saves and reloads through mocked APIs. Baseline stories omit template metadata. No provider calls." } } },
} satisfies Meta<typeof ConnectionInstructionsPrototype>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ConnectHoncho: Story = { args: { initialView: "connect" } };
export const ConnectionSettings: Story = {};
export const CurrentConnectPage: Story = { args: { initialView: "connect", baseline: true } };
export const CurrentConfigurationPage: Story = { args: { baseline: true } };
export const ExistingConnectionOff: Story = { args: { scenario: "off" } };
export const InstructionsOnAgent: Story = { args: { initialView: "agent" } };
export const InstructionsOffOnAgent: Story = {
  args: { initialView: "agent", scenario: "off" },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const dialog = within(await page.findByRole("dialog"));
    await expect(await dialog.findByText("These instructions are turned off for this connection.")).toBeVisible();
    await expect(dialog.getByText(HONCHO)).toBeVisible();
  },
};
export const WorkspaceNeeded: Story = { args: { scenario: "missing-context" } };
export const ConnectWorkspaceNeeded: Story = { args: { initialView: "connect", scenario: "missing-context" } };
export const WritesAskFirst: Story = { args: { scenario: "write-approval" } };
export const ReconnectKeepsInstructions: Story = { args: { initialView: "connect", scenario: "reconnect" } };
export const NotionOptionalInstructions: Story = { args: { initialView: "connect", provider: "Notion", providedInstructions: NOTION }, parameters: { docs: { description: { story: "Example of a non-memory connection explicitly supplying an instruction template." } } } };
export const NotionWithoutInstructions: Story = { args: { initialView: "connect", provider: "Notion", providedInstructions: undefined } };
export const ConnectionWithoutInstructions: Story = { args: { provider: "Notion", providedInstructions: undefined } };
export const Light: Story = { globals: { theme: "light" } };
export const Mobile: Story = { args: { initialView: "connect" }, globals: { viewport: { value: "mobile", isRotated: false } } };

export const EditAndPreview: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Edit instructions" }));
    const field = canvas.getByRole("textbox", { name: "Instructions text" });
    await userEvent.clear(field);
    await userEvent.type(field, "Recall release decisions before planning. Save confirmed changes with a source link.");
    await userEvent.click(canvas.getByRole("button", { name: "Save instructions" }));
    await waitFor(() => expect(canvas.queryByRole("button", { name: "Save instructions" })).not.toBeInTheDocument());
    await userEvent.click(canvas.getByRole("button", { name: "Preview on Ada" }));
    const dialog = within(canvasElement.ownerDocument.body).getByRole("dialog");
    await expect(within(dialog).getByText("Recall release decisions before planning. Save confirmed changes with a source link.")).toBeVisible();
  },
};
export const DisableKeepsText: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("switch", { name: "Tell agents to use Honcho" }));
    await expect(canvas.getByText("Agents can still use this connection’s tools, but won’t receive these instructions.")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Save instructions" }));
    await waitFor(() => expect(canvas.queryByRole("button", { name: "Save instructions" })).not.toBeInTheDocument());
    await expect(canvas.getByText(HONCHO)).toBeVisible();
  },
};
export const SaveFailure: Story = {
  args: { scenario: "save-error" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Edit instructions" }));
    await userEvent.type(canvas.getByRole("textbox", { name: "Instructions text" }), " Include source links.");
    await userEvent.click(canvas.getByRole("button", { name: "Save instructions" }));
    await expect(canvas.getByRole("alert")).toHaveTextContent("Your changes are still here");
    await expect(canvas.getByRole("textbox", { name: "Instructions text" })).toHaveValue(`${HONCHO} Include source links.`);
  },
};

export const ResetToDefault: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Edit instructions" }));
    const field = canvas.getByRole("textbox", { name: "Instructions text" });
    await userEvent.clear(field);
    await userEvent.type(field, "Look up prior release decisions.");
    await userEvent.click(canvas.getByRole("button", { name: "Save instructions" }));
    await waitFor(() => expect(canvas.queryByRole("button", { name: "Save instructions" })).not.toBeInTheDocument());
    await userEvent.click(canvas.getByRole("button", { name: "Reset to default" }));
    await expect(field).toHaveValue(HONCHO);
    await expect(canvas.queryByRole("button", { name: "Reset to default" })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Save instructions" }));
    await expect(canvas.getByRole("switch", { name: "Tell agents to use Honcho" })).toBeChecked();
  },
};
