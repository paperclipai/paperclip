import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { SlackSetupFixture } from "../fixtures/SlackSetupFixture";

const start = "/PAP/apps/chat/connect?provider=slack&purpose=chat";
const meta = {
  title: "Connections/Slack/Managed setup", component: SlackSetupFixture,
  args: { managed: true },
  parameters: { layout: "fullscreen", initialEntries: [`${start}&resume=slack-story`] },
  render: args => <SlackSetupFixture key={`${args.scenario}-${args.workspaceCount}-${args.managedAvailable}`} {...args} />,
} satisfies Meta<typeof SlackSetupFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ChooseAgent: Story = { name: "01 · Choose agent", args: { scenario: "choose" }, parameters: { initialEntries: [start] } };
export const AuthorizeWorkspace: Story = { name: "02 · Add to Slack · First authorization", args: { scenario: "create", workspaceCount: 0 } };
export const AddToSlack: Story = { name: "02 · Add to Slack · Returning workspace", args: { scenario: "create" }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getByRole("button", { name: /^Add to Slack$/ })).toBeEnabled());
  await expect(canvas.getByText("Use your own app")).toBeVisible();
} };
export const MultipleWorkspaces: Story = { name: "02 · Add to Slack · Multiple workspaces", args: { scenario: "create", workspaceCount: 2 } };
export const Connect: Story = { name: "03 · Connect · Waiting for a message", args: { scenario: "verify" } };
export const Success: Story = { name: "03 · Connect · Success", args: { scenario: "success" } };
export const ApprovalPending: Story = { name: "Recovery · Slack approval pending", args: { scenario: "declined" } };
export const ApprovalDeclined: Story = { name: "Recovery · Slack approval declined", args: { scenario: "approval_denied" } };
export const EventConfigurationPending: Story = { name: "Recovery · App configuration pending", args: { scenario: "manifest_pending" } };
export const UncertainCreation: Story = { name: "Recovery · Uncertain creation", args: { scenario: "uncertain" } };
export const SavedCredentials: Story = { name: "Recovery · Saved credentials", args: { scenario: "recovery" } };
export const Unavailable: Story = { name: "Recovery · Managed setup unavailable", args: { scenario: "install", managedAvailable: false } };
export const OwnApp: Story = { name: "Advanced · Use your own app", args: { scenario: "create" }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "Use your own app" }));
  await expect(await canvas.findByRole("heading", { name: "App configuration access token" })).toBeVisible();
} };
export const SelfHosted: Story = { name: "Self-hosted · Own app directly", args: { scenario: "create", managed: false, managedAvailable: false } };
export const Mobile: Story = { ...AddToSlack, name: "Mobile · Add to Slack", globals: { viewport: { value: "mobile1", isRotated: false } } };
export const MobileSuccess: Story = { ...Success, name: "Mobile · Success", globals: { viewport: { value: "mobile1", isRotated: false } } };
