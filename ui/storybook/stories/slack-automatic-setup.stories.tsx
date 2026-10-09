import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { SlackSetupFixture } from "../fixtures/SlackSetupFixture";

const start = "/PAP/apps/chat/connect?provider=slack&purpose=chat";
const meta = {
  title: "Connections/Slack/Automatic setup",
  component: SlackSetupFixture,
  parameters: { layout: "fullscreen", initialEntries: [`${start}&resume=slack-story`],
    docs: { description: { component: "Production Slack setup pages in journey order. Automatic stories use the same four-step wizard; manual setup retains account linking. Slack creation, consent, verification, and identity discovery are simulated; use synthetic tokens only." } } },
  render: args => <SlackSetupFixture key={args.scenario} {...args} />,
} satisfies Meta<typeof SlackSetupFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ChooseConnection: Story = {
  name: "00 · Choose connection", args: { scenario: "choose" },
  parameters: { initialEntries: ["/PAP/apps/chat/connect?provider=slack"] },
};
export const ChooseAgent: Story = {
  name: "01 · Choose agent", args: { scenario: "choose" }, parameters: { initialEntries: [start] },
};
export const AppConfigurationToken: Story = { name: "02 · App configuration access token", args: { scenario: "create" } };
export const InstallSlackApp: Story = { name: "03 · Install Slack app", args: { scenario: "install" } };
export const SendAMessage: Story = { name: "04 · Send a message", args: { scenario: "verify" } };
export const Success: Story = { name: "04 · Success", args: { scenario: "success" }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole("heading", { name: "Success" })).toBeVisible();
} };
export const ChooseAgentSelected: Story = {
  name: "Choose agent · Advanced defaults", args: { scenario: "choose" }, parameters: { initialEntries: [`${start}&agentId=agent-codex`] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText("Advanced", { selector: "summary" }));
    await expect(canvas.getByLabelText("Slack app name", { exact: true })).toHaveValue("maya-paperclip");
    await expect(canvas.getByLabelText("Bot display name", { exact: true })).toHaveValue("maya");
    await expect(canvas.getByLabelText("Slash command", { exact: true })).toHaveValue("/maya");
  },
};
export const ManualFallback: Story = { name: "Recovery · Manual setup", args: { scenario: "manual" } };
export const InstallationPending: Story = { name: "Recovery · Installation pending", args: { scenario: "install" } };
export const InstallationDeclined: Story = { name: "Recovery · Installation declined", args: { scenario: "declined" } };
export const UncertainCreation: Story = { name: "Recovery · Uncertain creation", args: { scenario: "uncertain" } };
export const EventConfigurationPending: Story = { name: "Recovery · Event configuration pending", args: { scenario: "manifest_pending" }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole("button", { name: "Retry app configuration" })).toBeDisabled();
  await userEvent.type(canvas.getByLabelText("App configuration access token", { exact: true }), "synthetic-fixture-token");
  await userEvent.click(canvas.getByRole("button", { name: "Retry app configuration" }));
  await expect(await canvas.findByRole("button", { name: "Install in Slack" })).toBeEnabled();
} };
export const SavedCredentialsRecovery: Story = { name: "Recovery · Saved credentials", args: { scenario: "recovery" } };
export const AvatarUploadFailed: Story = { name: "Recovery · Avatar upload failed", args: { scenario: "avatar_failed" } };
export const WelcomeFailed: Story = { name: "Recovery · Welcome DM failed", args: { scenario: "welcome_failed" } };
export const Mobile: Story = { name: "Mobile · App configuration access token", args: { scenario: "create" }, globals: { viewport: { value: "mobile1", isRotated: false } } };

export const SuccessMobile: Story = { name: "Mobile · Success", args: { scenario: "success" }, globals: { viewport: { value: "mobile1", isRotated: false } } };

export const ChooseConnectionMobile: Story = {
  ...ChooseConnection, name: "Mobile · Choose connection",
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
