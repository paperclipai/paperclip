import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { instanceGeneralSettingsSchema } from "@paperclipai/shared";
import { InstanceGeneralSettings } from "@/pages/InstanceGeneralSettings";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
let settings = instanceGeneralSettingsSchema.parse({});
const meta = {
  id: "feature-backup-retention",
  title: "Oversight and operation/Instance operations/Backup retention",
  component: InstanceGeneralSettings,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Shipped general settings. Retention changes persist within this fixture; database backup and restoration require operator verification.",
      },
    },
    paperclip: {
      "capabilities": [
        "instance-operations/backup",
        "instance-operations/configuration"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Retention presets, initial read, loading, error, denial and pending/saved selection in InstanceGeneralSettings. Backup creation/restore and real settings authority remain production obligations. The recipe distinguishes process liveness from authenticated database readiness; these examples do not exercise that operator API boundary."
    },
  },
  beforeEach: ({ parameters }) => {
    settings = instanceGeneralSettingsSchema.parse({});
    const fixture = prepareFixtureApi(
      [
        {
          path: "/api/instance/settings/general",
          read: ({ method, body }) => {
            if (method === "PATCH")
              settings = instanceGeneralSettingsSchema.parse({
                ...settings,
                ...body,
              });
            return settings;
          },
        },
      ],
      parameters.fixtureState as FixtureState,
    );
    return fixture.cleanup;
  },
} satisfies Meta<typeof InstanceGeneralSettings>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CurrentPolicy: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("heading", {
      name: "Backup retention",
    });
  },
};
export const Loading: Story = {
  parameters: { fixtureState: "loading" },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("Loading general settings...");
  },
};
export const LoadFailed: Story = {
  parameters: { fixtureState: "failure" },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(
      "The request failed. Please try again.",
    );
  },
};
export const PermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(
      "You do not have permission to perform this action.",
    );
  },
};
export const SaveRetention: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const button = await c.findByRole("button", { name: "14 days" });
    await userEvent.click(button);
    await waitFor(() => expect(settings.backupRetention.dailyDays).toBe(14));
    await waitFor(() => expect(button).toBeEnabled());
    await expect(button).toHaveClass("bg-accent");
  },
};
export const Saving: Story = {
  parameters: { fixtureState: "saving" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const button = await c.findByRole("button", { name: "14 days" });
    await userEvent.click(button);
    await expect(button).toBeDisabled();
  },
};
