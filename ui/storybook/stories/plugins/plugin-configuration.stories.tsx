import { PluginManager } from "@/pages/PluginManager";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Routes, Route } from "@/lib/router";
import { PluginSettings } from "@/pages/PluginSettings";
import { expect, userEvent, within } from "storybook/test";
import { installPluginFixtures } from "../../support/capability-gaps/plugins";
import type { FixtureState } from "../../support/capability-gaps/api";
function Settings() {
  return (
    <Routes>
      <Route
        path="/PAP/company/settings/instance/plugins"
        element={<PluginManager />}
      />
      <Route
        path="/PAP/plugins/:pluginId/settings"
        element={<PluginSettings />}
      />
    </Routes>
  );
}
const meta = {
  id: "feature-plugin-configuration",
  title: "Apps, channels, and extensions/Plugins/Configuration",
  component: Settings,
  parameters: {
    layout: "padded",
    initialEntries: ["/PAP/plugins/plugin-gap/settings"],
    paperclip: {
      "capabilities": [
        "plugins/configuration"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "PluginSettings configuration route with hydrated values, read pending/unavailable and saved/error/403 responses. Real config storage and plugin worker validation are not proved."
    },
  },
  beforeEach: ({ parameters }) =>
    installPluginFixtures(parameters.fixtureState as FixtureState),
} satisfies Meta<typeof Settings>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Configured: Story = {};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Unavailable: Story = { parameters: { fixtureState: "failure" } };
export const SaveConfiguration: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const input = await c.findByDisplayValue("Release preview");
    await userEvent.clear(input);
    await userEvent.type(input, "Reviewed release", { delay: 15 });
    await userEvent.click(
      c.getByRole("button", { name: "Save Configuration" }),
    );
    await c.findByText("Configuration saved.");
    await expect(input).toHaveValue("Reviewed release");
  },
};
export const SaveFailed: Story = {
  parameters: { fixtureState: "mutation-failure" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const input = await c.findByDisplayValue("Release preview");
    await userEvent.clear(input);
    await userEvent.type(input, "Reviewed release", { delay: 15 });
    await userEvent.click(
      c.getByRole("button", { name: "Save Configuration" }),
    );
    await c.findByText("The request failed. Please try again.");
  },
};
export const PermissionDenied: Story = {
  parameters: { fixtureState: "mutation-permission" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const input = await c.findByDisplayValue("Release preview");
    await userEvent.type(input, " updated", { delay: 15 });
    await userEvent.click(
      c.getByRole("button", { name: "Save Configuration" }),
    );
    await c.findByText("You do not have permission to perform this action.");
  },
};
