import type { Meta, StoryObj } from "@storybook/react-vite";
import { CredentialTaskPage } from "../../../support/credential-access/CredentialTaskPage";

const meta = {
  id: "task-credential-access-02-task-page",
  title: "Apps, channels, and extensions/Secrets and proposals/Task credential access/02 Task page",
  component: CredentialTaskPage,
  parameters: { layout: "fullscreen", waitForViewport: true,
    docs: { description: { component: "Production task detail and app shell. The latest credential failure stays expanded in the conversation and names the selected credential. The settings link uses the existing agent runtime route. Example data is local to Storybook." } },
    paperclip: {
      "capabilities": [
        "secrets/runtime-delivery",
        "recovery/diagnosis"
      ],
      "implementation": "production",
      "boundary": "fixtures"
    },
  },
  args: { otherPerson: false, runtimeMode: "native", newerAttempt: false },
  render: args => <CredentialTaskPage key={JSON.stringify(args)} {...args} />,
} satisfies Meta<typeof CredentialTaskPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const YourAccess: Story = {};
export const NickyCannotUseDottasKey: Story = { args: { otherPerson: true } };
export const LegacyRunner: Story = { args: { runtimeMode: "legacy" } };
export const Mobile: Story = { globals: { viewport: { value: "mobile", isRotated: false } } };
export const Light: Story = { globals: { theme: "light" } };
export const NewerSuccessfulAttempt: Story = { args: { newerAttempt: true } };
