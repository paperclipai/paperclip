import type { Meta, StoryObj } from "@storybook/react-vite";
import { RemoteMcpConnectionReview } from "../prototypes/RemoteMcpConnectionReview";

const meta = {
  title: "Apps/Connections/Zapier",
  component: RemoteMcpConnectionReview,
  args: { provider: "zapier", scenario: "journey" },
  parameters: { layout: "fullscreen", docs: { description: { component: "Interactive design review using application views with in-memory provider responses. No real authentication, tool calls, or credential persistence. Representative catalogs are examples; production discovery supplies the actual tools." } } },
  argTypes: { provider: { control: false } },
} satisfies Meta<typeof RemoteMcpConnectionReview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CompleteSetupJourney: Story = { args: { scenario: "journey" } };
export const InitialSetup: Story = { args: { scenario: "initial" } };
export const SelectedAgents: Story = { args: { scenario: "selected_agents" } };
export const ConnectionDetails: Story = { args: { scenario: "connect" } };
export const AdvancedAuthentication: Story = { args: { scenario: "advanced" } };
export const Connecting: Story = { args: { scenario: "connecting" } };
export const InvalidUrl: Story = { args: { scenario: "invalid_url" } };
export const RejectedCredentials: Story = { args: { scenario: "rejected" } };
export const UnreachableEndpoint: Story = { args: { scenario: "unreachable" } };
export const ManageToolPermissions: Story = { args: { scenario: "permissions" } };
export const CompletedConnection: Story = { args: { scenario: "completed" } };
export const Reconnect: Story = { args: { scenario: "reconnect" } };
export const SavedDraftResume: Story = { args: { scenario: "draft" } };
export const NewToolsAllowed: Story = { args: { scenario: "new_tools" } };
export const BroadExecutionTools: Story = { args: { scenario: "broad" } };
export const NarrowSetup: Story = { args: { scenario: "initial" }, globals: { viewport: { value: "mobile", isRotated: false } } };
export const NarrowToolManagement: Story = { args: { scenario: "permissions" }, globals: { viewport: { value: "mobile", isRotated: false } } };

export const NarrowConnectionDetails: Story = { args: { scenario: "connect" }, globals: { viewport: { value: "mobile", isRotated: false } } };
