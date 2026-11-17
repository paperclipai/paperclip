import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { SpekoProviderSetup, type SpekoProviderSetupProps } from "@/components/voice/SpekoProviderSetup";
import { voiceStoryLifecycle } from "../../../support/speko/voiceStoryLifecycle";
function Fixture(props: Partial<SpekoProviderSetupProps>) {
  const [credentials, setCredentials] = useState(props.credentials ?? {});
  const [connected, setConnected] = useState(false);
  return connected ? <p role="status">Credentials saved. Continue to the test conversation.</p> : <SpekoProviderSetup onSaveExit={() => {}} agentName="Company Phone Agent" callbackUrl="https://paperclip.example/api/voice-webhooks/endpoint/tools" {...props} credentials={credentials} onChange={setCredentials} onConnect={(values) => { if ((!props.repairing || props.signingSecretConfigured === false) && !values.signingSecret?.startsWith("whsec_")) throw new Error("Missing signing secret"); setConnected(true); }} />;
}
const meta: Meta<typeof SpekoProviderSetup> = { ...voiceStoryLifecycle, id: "connections-speko-provider-setup", title: "Apps, channels, and extensions/External chat and email/Speko/Provider setup", component: SpekoProviderSetup, parameters: { layout: "padded", paperclip: {"capabilities": ["chat-channels/providers", "connection-setup/channel-setup", "connection-setup/credentials", "connection-setup/draft-recovery", "connection-setup/failure"], "status": "current", "implementation": "production", "boundary": "fixtures", "notes": "Production credential/persona setup form with fixture verification responses. Recovery and validation are exercised without real secrets or provider requests."} } };
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
    await expect(canvas.getByRole("button", { name: "Save & exit" })).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole("button", { name: "Connect Speko" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByRole("status")).toHaveTextContent("Credentials saved");
  },
};

export const InterruptedBeforeCredentials: Story = {
  render: () => <Fixture repairing signingSecretConfigured={false} />,
  play: async ({canvasElement}) => {
    const canvas = within(canvasElement);
    const connect = canvas.getByRole("button", {name: "Reconnect Speko"});
    await expect(connect).toBeDisabled();
    await userEvent.type(canvas.getByRole("textbox", {name: "Speko agent ID"}), "agent_fixture");
    await userEvent.type(canvas.getByLabelText("Speko API key"), "synthetic-not-a-key");
    await userEvent.click(connect);
    await expect(canvas.getByRole("status")).toHaveTextContent("Credentials saved");
  },
};
