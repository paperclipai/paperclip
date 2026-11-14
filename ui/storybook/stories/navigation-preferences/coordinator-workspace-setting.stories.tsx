import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { ClassicWorkspaceSetting } from "@/components/ClassicWorkspaceSetting";
import { storybookAuthSession } from "../../fixtures/paperclipData";
import { prepareFixtureApi, type FixtureState } from "../../support/capability-gaps/api";

const meta = {
  id: "feature-coordinator-workspace-setting",
  title: "Oversight and operation/Navigation, profile, and announcements/Coordinator workspace preference",
  component: ClassicWorkspaceSetting,
  parameters: {
    layout: "padded",
    paperclip: {
      capabilities: ["navigation-preferences/preferences"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "Classic workspace Settings card with off/on/loading/failed-save states. Coordinator is the standard interface. API writes are simulated and retained only for this story. Real persistence, company/account isolation and shell switching need the feature recipe checks.",
    },
  },
  beforeEach: ({ parameters }) => {
    let classicEnabled = parameters.initiallyEnabled === true;
    const preference = () => ({ userId: storybookAuthSession.user.id, coordinatorWorkspaceEnabled: !classicEnabled, updatedAt: null });
    return prepareFixtureApi([
      { path: "/api/instance/settings/experimental", method: "GET", read: () => ({ enableAgentChat: parameters.chatDisabled !== true }) },
      { path: "/api/cli-auth/me", method: "GET", read: () => ({ userId: storybookAuthSession.user.id, source: "session", isInstanceAdmin: parameters.instanceAdmin === true }) },
      { path: "/api/workspace-preferences/me", method: "GET", read: preference },
      { path: /\/api\/companies\/[^/]+\/workspace-preferences\/me$/, method: "PUT", read: ({ body }) => {
        classicEnabled = body.coordinatorWorkspaceEnabled === false;
        return preference();
      } },
    ], parameters.fixtureState as FixtureState).cleanup;
  },
} satisfies Meta<typeof ClassicWorkspaceSetting>;
export default meta;
type Story = StoryObj<typeof meta>;

export const OffByDefault: Story = { name: "Classic off by default" };
export const Enabled: Story = { name: "Classic enabled", parameters: { initiallyEnabled: true } };
export const AgentChatDisabledForAdmin: Story = {
  name: "Historical: retired Chat prerequisite for administrators",
  parameters: { chatDisabled: true, instanceAdmin: true, paperclip: {
    status: "historical", capabilities: ["navigation-preferences/preferences"], implementation: "production", boundary: "fixtures",
    notes: "Retained identity from the retired Chat prerequisite. The current Classic preference has no Chat dependency.",
  } },
};
export const AgentChatDisabledForMember: Story = {
  name: "Historical: retired Chat prerequisite for members",
  parameters: { chatDisabled: true, paperclip: {
    status: "historical", capabilities: ["navigation-preferences/preferences"], implementation: "production", boundary: "fixtures",
    notes: "Retained identity from the retired Chat prerequisite. The current Classic preference has no Chat dependency.",
  } },
};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const SaveAndReturnToClassic: Story = {
  name: "Choose Classic and return to Coordinator",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole("switch", { name: "Enable classic workspace" });
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
    const toggle = await canvas.findByRole("switch", { name: "Enable classic workspace" });
    await waitFor(() => expect(toggle).toBeEnabled());
    await userEvent.click(toggle);
    await canvas.findByRole("alert");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  },
};
