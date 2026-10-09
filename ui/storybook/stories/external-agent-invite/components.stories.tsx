import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { DotConnectionChecks, ExternalAgentPresetPicker } from "@/components/new-agent/ExternalAgentInviteContent";

const meta = {
  title: "Onboarding/External agent invitation/Components",
  component: DotConnectionChecks,
  parameters: { layout: "centered", docs: { description: { component: "Controlled presentation states. Connection checks must be driven by server evidence. Subscription verification alone must never mark the connection ready." } } },
  decorators: [Story => <div className="w-full max-w-md p-6"><Story /></div>],
} satisfies Meta<typeof DotConnectionChecks>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Presets: Story = { args: { state: { phase: "waiting" } }, render: () => <ExternalAgentPresetPicker onSelect={fn()} /> };
export const Waiting: Story = { args: { state: { phase: "waiting" } } };
export const Connected: Story = { args: { state: { phase: "connected" } } };
export const Subscribed: Story = { args: { state: { phase: "subscribed" } } };
export const Testing: Story = { args: { state: { phase: "testing" } } };
export const Ready: Story = { args: { state: { phase: "ready" } } };
export const TestTimedOut: Story = { args: { state: { phase: "testing", problem: "event_timeout" } } };
export const UpdatesInterrupted: Story = { args: { state: { phase: "connected", problem: "offline" } } };
