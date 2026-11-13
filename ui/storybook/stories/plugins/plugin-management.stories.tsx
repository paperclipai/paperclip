import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { PluginManager } from "@/pages/PluginManager";
import { ToastViewport } from "@/components/ToastViewport";
import { installPluginFixtures } from "../../support/capability-gaps/plugins";
import type { FixtureState } from "../../support/capability-gaps/api";
function Plugins() {
  return (
    <>
      <PluginManager />
      <ToastViewport />
    </>
  );
}
const meta = {
  id: "feature-plugin-management",
  title: "Apps, channels, and extensions/Plugins/Installation and lifecycle",
  component: Plugins,
  parameters: { layout: "padded",
    paperclip: {
      "capabilities": [
        "plugins/installation",
        "plugins/lifecycle"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "PluginManager list states, install pending/error/success, disable and uninstall receipts. Local record transitions only; package loading and worker lifecycle require production verification."
    },
  },
  beforeEach: ({ parameters }) =>
    installPluginFixtures(
      parameters.fixtureState as FixtureState,
      Boolean(parameters.empty),
    ),
} satisfies Meta<typeof Plugins>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Installed: Story = {};
export const Empty: Story = { parameters: { empty: true } };
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Failed: Story = { parameters: { fixtureState: "failure" } };
export const PermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
};
async function install() {
  const c = within(document.body);
  await userEvent.click(
    await c.findByRole("button", { name: "Install Plugin" }),
  );
  await userEvent.type(
    await c.findByRole("textbox"),
    "@paperclipai/storybook-fixture",
    { delay: 15 },
  );
  await userEvent.click(c.getByRole("button", { name: "Install" }));
}
export const InstallPackage: Story = {
  parameters: { empty: true },
  play: async () => {
    await install();
    await within(document.body).findByText("Plugin installed successfully");
    await within(document.body).findByText("Preview plugin");
  },
};
export const Installing: Story = {
  parameters: { empty: true, fixtureState: "saving" },
  play: async () => {
    await install();
    await expect(
      await within(document.body).findByRole("button", {
        name: "Installing...",
      }),
    ).toBeDisabled();
  },
};
export const InstallFailed: Story = {
  parameters: { empty: true, fixtureState: "mutation-failure" },
  play: async () => {
    await install();
    await within(document.body).findByText("Failed to install plugin");
  },
};
export const DisablePlugin: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByTitle("Disable"));
    await within(document.body).findByText("Plugin disabled");
    await c.findByTitle("Enable");
  },
};
export const UninstallPlugin: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByTitle("Uninstall"));
    const c = within(document.body);
    await userEvent.click(c.getByRole("button", { name: "Uninstall" }));
    await c.findByText("Plugin uninstalled successfully");
    await expect(c.queryByText("Preview plugin")).not.toBeInTheDocument();
  },
};
