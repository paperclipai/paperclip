import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { CoordinatorWorkspaceSetting } from "@/components/CoordinatorWorkspaceSetting";
import { storybookAuthSession } from "../../fixtures/paperclipData";
import { prepareFixtureApi, type FixtureState } from "../../support/capability-gaps/api";

const meta = {
  id: "feature-coordinator-workspace-setting",
  title: "Oversight and operation/Navigation, profile, and announcements/Coordinator workspace preference",
  component: CoordinatorWorkspaceSetting,
  parameters: {
    layout: "padded",
    paperclip: {
      capabilities: ["navigation-preferences/preferences"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "Personal workspace Settings card with off/on/loading/failed-save states. API writes are simulated and retained only for this story. Real persistence, company/account isolation and shell switching need the feature recipe checks.",
    },
  },
  beforeEach: ({ parameters }) => {
    let enabled = parameters.initiallyEnabled === true;
    const preference = () => ({ userId: storybookAuthSession.user.id, coordinatorWorkspaceEnabled: enabled, updatedAt: null });
    return prepareFixtureApi([
      { path: "/api/instance/settings/experimental", method: "GET", read: () => ({ enableAgentChat: parameters.chatDisabled !== true }) },
      { path: "/api/cli-auth/me", method: "GET", read: () => ({ userId: storybookAuthSession.user.id, source: "session", isInstanceAdmin: parameters.instanceAdmin === true }) },
      { path: "/api/workspace-preferences/me", method: "GET", read: preference },
      { path: /\/api\/companies\/[^/]+\/workspace-preferences\/me$/, method: "PUT", read: ({ body }) => {
        enabled = body.coordinatorWorkspaceEnabled === true;
        return preference();
      } },
    ], parameters.fixtureState as FixtureState).cleanup;
  },
} satisfies Meta<typeof CoordinatorWorkspaceSetting>;
export default meta;
type Story = StoryObj<typeof meta>;

export const OffByDefault: Story = {};
export const Enabled: Story = { parameters: { initiallyEnabled: true } };
export const AgentChatDisabledForAdmin: Story = { parameters: { chatDisabled: true, instanceAdmin: true } };
export const AgentChatDisabledForMember: Story = { parameters: { chatDisabled: true } };
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const SaveAndReturnToClassic: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole("switch", { name: "Enable coordinator workspace" });
    await waitFor(() => expect(toggle).toBeEnabled());
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  },
};
export const SaveFailed: Story = {
  parameters: { fixtureState: "mutation-failure" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole("switch", { name: "Enable coordinator workspace" });
    await waitFor(() => expect(toggle).toBeEnabled());
    await userEvent.click(toggle);
    await canvas.findByRole("alert");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  },
};
