import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { Layout } from "@/components/Layout";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { Link, Route, Routes } from "@/lib/router";
import { Browse } from "@/pages/apps/Browse";
import { AssistantConnection } from "@/pages/apps/AssistantConnection";
import { InstanceExperimentalSettings } from "@/pages/InstanceExperimentalSettings";
import { PublicMcpPresenter } from "./public-mcp-presenter";
import { connectedUser, installPublicMcpFixture } from "../fixtures/publicMcp";

function ConnectionJourney({ assistant = "opencode" }: { assistant?: "codex" | "claude" | "opencode" | "other" }) {
  return <PluginLauncherProvider><Routes>
    <Route path="/:companyPrefix" element={<Layout />}>
      <Route path="apps" element={<Browse />} />
      <Route path="apps/assistant-connection" element={<AssistantConnection initialAssistant={assistant} />} />
      <Route path="company/settings/instance/experimental" element={<InstanceExperimentalSettings />} />
      <Route path="*" element={<Link className="text-sm underline" to="/apps">Return to Connections</Link>} />
    </Route>
  </Routes></PluginLauncherProvider>;
}

const meta = {
  title: "Assistant connections/Start here",
  component: ConnectionJourney,
  parameters: {
    layout: "fullscreen", initialEntries: ["/PAP/apps"], fixture: { enabled: false, empty: true },
    docs: { description: { component: "Begin inside Paperclip. Open Assistant Connection (MCP), follow its Experimental settings link if needed, then choose your assistant. These are production pages in the real app shell; API responses are fixtures. Follow the displayed commands in a live instance to launch browser sign-in and consent. Storybook does not run a terminal, grant access, or simulate a successful OpenCode conversation. Consent states have their own stories. The Connected checkpoint represents returning after a real grant, not clicking a mock connect button." } },
  },
  beforeEach: ({ parameters }) => installPublicMcpFixture(parameters.fixture),
} satisfies Meta<typeof ConnectionJourney>;
export default meta;
type Story = StoryObj<typeof meta>;
export const GuidedWalkthrough: Story = { render: () => <PublicMcpPresenter /> };
export const Connections: Story = {};
export const EnableSetup: Story = { parameters: { initialEntries: ["/PAP/apps/assistant-connection"] } };
export const ConnectionStatusUnavailable: Story = { parameters: { fixture: { enabled: true, connectionsUnavailable: true } } };
export const OpenCodeSetup: Story = { parameters: { initialEntries: ["/PAP/apps/assistant-connection"], fixture: { enabled: true, empty: true } } };
export const CodexSetup: Story = { ...OpenCodeSetup, args: { assistant: "codex" } };
export const ClaudeSetup: Story = { ...OpenCodeSetup, args: { assistant: "claude" } };
export const Connected: Story = { parameters: { initialEntries: ["/PAP/apps/assistant-connection"], fixture: { enabled: true, empty: false, connections: [
  { id: "opencode", companyId: "company-storybook", companyName: "Paperclip", clientName: "OpenCode", user: connectedUser, scopes: ["paperclip:read", "paperclip:write", "offline_access"], createdAt: "2026-10-05T12:00:00Z", revokedAt: null },
  { id: "other-org", companyId: "another-company", companyName: "Other organization", clientName: "Private other client", scopes: ["paperclip:read"], createdAt: "2026-10-05T12:00:00Z", revokedAt: null },
] } } };
export const Unavailable: Story = { parameters: { initialEntries: ["/PAP/apps/assistant-connection"], fixture: { unavailable: true } } };
export const Loading: Story = { parameters: { initialEntries: ["/PAP/apps/assistant-connection"], fixture: { loading: true } } };
export const NavigationCheck: Story = { play: async ({ canvasElement }) => {
  const c = within(canvasElement);
  await userEvent.click(await c.findByRole("button", { name: "Set up Assistant Connection (MCP)" }));
  await userEvent.click(await c.findByRole("link", { name: "Open Experimental settings" }));
  await userEvent.click(await c.findByRole("switch", { name: "Toggle assistant connections experimental setting" }));
  await userEvent.click(await c.findByRole("link", { name: "Set up an assistant connection" }));
  await expect(await c.findByRole("button", { name: "Copy invitation" })).toBeVisible();
  await userEvent.click(c.getByText("Set up manually"));
  await expect(c.getByText("opencode mcp auth paperclip")).toBeVisible();
  await expect(c.getByText(/No assistants connected/)).toBeVisible();
} };

/** userEvent provides a clipboard fixture; this story does not write system credentials. */
export const InvitationCopied: Story = { ...OpenCodeSetup, play: async ({ canvasElement }) => {
  const c = within(canvasElement);
  const user = userEvent.setup({ document: canvasElement.ownerDocument });
  await user.click(await c.findByRole("button", { name: "Copy invitation" }));
  await expect(await within(canvasElement.ownerDocument.body).findByRole("button", { name: "Copied to clipboard" })).toBeVisible();
  await expect(await navigator.clipboard.readText()).toContain("/mcp/setup?company=");
} };
export const ManualSetup: Story = { ...OpenCodeSetup, play: async ({ canvasElement }) => { await userEvent.click(await within(canvasElement).findByText("Set up manually")); } };

export const RevokeConnection: Story = { ...Connected, play: async ({ canvasElement }) => {
  const c = within(canvasElement);
  await userEvent.click(await c.findByRole("button", { name: "Revoke Dotta’s OpenCode connection" }));
  await expect(await c.findByText("No assistants connected to Paperclip Storybook yet.")).toBeVisible();
  await expect(c.queryByText("Dotta’s OpenCode connection")).not.toBeInTheDocument();
} };
