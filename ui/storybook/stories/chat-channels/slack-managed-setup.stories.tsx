import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { SlackSetupFixture } from "../../fixtures/SlackSetupFixture";

const start = "/PAP/apps/chat/connect?provider=slack&purpose=chat";
const meta = {
  id: "connections-slack-managed-setup",
  title: "Apps, channels, and extensions/External chat and email/Connections/Slack/Managed setup", component: SlackSetupFixture,
  args: { managed: true },
  parameters: { layout: "fullscreen", initialEntries: [`${start}&resume=slack-story`],
    paperclip: {
      "capabilities": [
        "chat-channels/providers",
        "connection-setup/channel-setup"
      ],
      "implementation": "production",
      "boundary": "fixtures"
    },
  },
  render: args => <SlackSetupFixture key={`${args.scenario}-${args.workspaceCount}-${args.managedAvailable}-${args.optionsDelayMs}-${args.optionsError}`} {...args} />,
} satisfies Meta<typeof SlackSetupFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
/** Walk the production wizard from the same entry point as the connector catalog. */
export const DefaultJourney: Story = {
  name: "00 · Start here · Managed by default",
  args: { scenario: "choose" },
  parameters: { initialEntries: ["/PAP/apps/chat/connect?provider=slack"] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText("App configuration access token")).not.toBeInTheDocument();
    await userEvent.click(await canvas.findByRole("button", { name: /^Chat with an agent/ }));
    await userEvent.click(await canvas.findByRole("button", { name: "Choose an active agent" }));
    await userEvent.click(await within(document.body).findByRole("button", { name: "Select Maya" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Continue" })).toBeEnabled());
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    await expect(await canvas.findByRole("heading", { name: "Send a message to your agent" })).toBeVisible();
    await expect(canvas.queryByLabelText("App configuration access token")).not.toBeInTheDocument();
  },
};
export const ChooseAgent: Story = { name: "01 · Choose agent", args: { scenario: "choose" }, parameters: { initialEntries: [start] } };
export const ChooseAgentAdvanced: Story = {
  ...ChooseAgent, name: "01 · Choose agent · Advanced",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Choose an active agent" }));
    await userEvent.click(await within(document.body).findByRole("button", { name: "Select Maya" }));
    await userEvent.click(await canvas.findByText("Advanced", { exact: true }));
    await expect(await canvas.findByRole("button", { name: "Use your own app" })).toBeVisible();
  },
};
export const AuthorizeWorkspace: Story = { name: "02 · Connect · First authorization", args: { scenario: "create", workspaceCount: 0 } };
export const AddToSlack: Story = { name: "02 · Connect · Returning workspace", args: { scenario: "create" }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole("heading", { name: "Send a message to your agent" })).toBeVisible();
  await expect(canvas.queryByText("Use your own app")).not.toBeInTheDocument();
} };
export const MultipleWorkspaces: Story = { name: "02 · Connect · Choose workspace", args: { scenario: "create", workspaceCount: 2 } };
export const Connect: Story = { name: "02 · Connect · Waiting for a message", args: { scenario: "verify" } };
export const Success: Story = { name: "02 · Connect · Success", args: { scenario: "success" } };
export const ApprovalPending: Story = { name: "Recovery · Slack approval pending", args: { scenario: "declined" } };
export const ApprovalDeclined: Story = { name: "Recovery · Slack approval declined", args: { scenario: "approval_denied" } };
export const EventConfigurationPending: Story = { name: "Recovery · App configuration pending", args: { scenario: "manifest_pending" } };
export const UncertainCreation: Story = { name: "Recovery · Uncertain creation", args: { scenario: "uncertain" } };
export const SavedCredentials: Story = { name: "Recovery · Saved credentials", args: { scenario: "recovery" } };
export const Unavailable: Story = { name: "Recovery · Managed setup unavailable", args: { scenario: "install", managedAvailable: false } };
export const OwnApp: Story = { name: "Advanced · Use your own app", args: { scenario: "choose" }, parameters: { initialEntries: [start] }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "Choose an active agent" }));
  await userEvent.click(await within(document.body).findByRole("button", { name: "Select Maya" }));
  await userEvent.click(await canvas.findByText("Advanced", { exact: true }));
  await userEvent.click(await canvas.findByRole("button", { name: "Use your own app" }));
  await expect(await canvas.findByRole("heading", { name: "App configuration access token" })).toBeVisible();
} };
export const SelfHosted: Story = { name: "Self-hosted · Own app directly", args: { scenario: "create", managed: false, managedAvailable: false } };
export const Mobile: Story = { ...AddToSlack, name: "Mobile · Connect", globals: { viewport: { value: "mobile1", isRotated: false } } };
export const MobileSuccess: Story = { ...Success, name: "Mobile · Success", globals: { viewport: { value: "mobile1", isRotated: false } } };

export const BrokerUnavailable: Story = {
  ...DefaultJourney,
  name: "Recovery · Broker unavailable · No token fallback",
  args: { scenario: "choose", managedAvailable: false },
  play: async context => {
    const entry = within(context.canvasElement);
    await userEvent.click(await entry.findByRole("button", { name: /^Chat with an agent/ }));
    await userEvent.click(await entry.findByRole("button", { name: "Choose an active agent" }));
    await userEvent.click(await within(document.body).findByRole("button", { name: "Select Maya" }));
    await userEvent.click(await entry.findByRole("button", { name: "Continue" }));
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByText("Managed Slack setup is unavailable. Try again later.")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeVisible();
  },
};
export const LoadingOptions: Story = {
  name: "Loading · Checking Slack setup",
  args: { scenario: "choose", optionsDelayMs: 3000 },
  parameters: { initialEntries: [start] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("status")).toHaveTextContent("Loading Slack");
    await expect(canvas.getByRole("button", { name: "Continue" })).toBeDisabled();
    await expect(canvas.queryByText("App configuration access token")).not.toBeInTheDocument();
  },
};
export const OptionsError: Story = {
  name: "Recovery · Setup lookup failed · No token fallback",
  args: { scenario: "choose", optionsError: true },
  parameters: { initialEntries: [start] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Couldn't load Slack setup");
    await expect(canvas.queryByText("App configuration access token")).not.toBeInTheDocument();
  },
};
