import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { SpekoProviderSetup, type SpekoProviderSetupProps } from "@/components/voice/SpekoProviderSetup";
import { voiceStoryLifecycle } from "../fixtures/voiceStoryLifecycle";
function Fixture(props: Partial<SpekoProviderSetupProps>) {
  const [credentials, setCredentials] = useState(props.credentials ?? {});
  const [connected, setConnected] = useState(false);
  return connected ? <p role="status">Credentials saved. Continue to the test conversation.</p> : <SpekoProviderSetup agentName="Company Phone Agent" callbackUrl="https://paperclip.example/api/voice-webhooks/endpoint/tools" {...props} credentials={credentials} onChange={setCredentials} onConnect={(values) => { if (!props.repairing && !values.signingSecret?.startsWith("whsec_")) throw new Error("Missing signing secret"); setConnected(true); }} />;
}
const meta: Meta<typeof SpekoProviderSetup> = { ...voiceStoryLifecycle, title: "Connections/Speko/Provider setup", component: SpekoProviderSetup, parameters: { layout: "padded" } };
export default meta;
type Story = StoryObj<typeof meta>;
export const Initial: Story = { render: () => <Fixture /> };
export const CredentialsEntered: Story = { render: () => <Fixture credentials={{ apiKey: "synthetic-not-a-key", agentId: "agent_fixture" }} /> };
export const MissingHttps: Story = { render: () => <Fixture callbackUrl="http://localhost:3100/callback" /> };
export const VerificationLoading: Story = { render: () => <Fixture pending credentials={{ apiKey: "synthetic-not-a-key", agentId: "agent_fixture" }} /> };
export const ResumableSetup: Story = { render: () => <Fixture repairing /> };
export const LongAgentName: Story = { render: () => <Fixture agentName="Company Phone Agent for International Customer Support and Technical Escalations" /> };
export const KeyboardValidationAndConnect: Story = {
  render: () => <Fixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Connect Speko" })).toBeDisabled();
    await userEvent.click(canvas.getByRole("textbox", { name: "Speko agent ID" }));
    await userEvent.type(canvas.getByRole("textbox", { name: "Speko agent ID" }), "agent_fixture");
    await userEvent.tab();
    const key = canvas.getByLabelText("Speko API key");
    await expect(key).toHaveFocus();
    await expect(key).toHaveAttribute("type", "password");
    await userEvent.type(key, "synthetic-not-a-key");
    await userEvent.tab();
    await expect(canvas.getByRole("button", { name: "Connect Speko" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByRole("status")).toHaveTextContent("Credentials saved");
  },
};
