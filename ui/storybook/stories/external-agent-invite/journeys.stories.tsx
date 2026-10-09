import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { ExternalAgentInvitePreview } from "./ExternalAgentInvitePreview";

const meta = {
  title: "Onboarding/External agent invitation/Journeys",
  component: ExternalAgentInvitePreview,
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/agents"],
    docs: { description: { component: "Live invite flow using shared UI in the production app shell. Start at Invite an external agent, choose Dot, then copy the prompt. Storybook simulates each connection check after copying; no plugin, invitation, subscription, or cloud job is created. Hermes and Other use the existing external-agent prompt verbatim. The live self-hosted setup renews expired prompts and sends the event test automatically. Refresh the story to replay." } },
  },
  render: args => <ExternalAgentInvitePreview key={JSON.stringify(args)} {...args} />,
} satisfies Meta<typeof ExternalAgentInvitePreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const StartHere: Story = { name: "Start here · Invite your Dot" };
export const ChooseAgent: Story = { name: "Choose · Dot, Hermes, or Other", args: { initialScreen: "picker" } };
export const GivePromptToDot: Story = { name: "Dot · Copy and send the prompt", args: { initialScreen: "setup" } };
export const WatchingDotConnect: Story = { name: "Dot · Watching task updates", args: { initialScreen: "setup", initialConnection: { phase: "connected" }, simulate: false } };
export const ConfirmingRoundTrip: Story = { name: "Dot · Confirming the round trip", args: { initialScreen: "setup", initialConnection: { phase: "testing" }, simulate: false } };
export const DotReady: Story = { name: "Dot · Ready for tasks", args: { initialScreen: "setup", initialConnection: { phase: "ready" } } };
export const RetryEvent: Story = { name: "Recovery · Retry the test event", args: { initialScreen: "setup", initialConnection: { phase: "testing", problem: "event_timeout" } } };
export const RefreshingPrompt: Story = { name: "Setup · Preparing a fresh prompt automatically", args: { initialScreen: "setup", preparing: true, simulate: false } };
export const WatchingInterrupted: Story = { name: "Recovery · Connection updates interrupted", args: { initialScreen: "setup", initialConnection: { phase: "connected", problem: "offline" } } };
export const Hermes: Story = { name: "Hermes · Existing invitation prompt", args: { initialScreen: "setup", initialPreset: "hermes" } };
export const Other: Story = { name: "Other · Existing invitation prompt", args: { initialScreen: "setup", initialPreset: "other" } };
export const Mobile: Story = { name: "Mobile · Give the prompt to Dot", args: { initialScreen: "setup" }, globals: { viewport: { value: "mobile1", isRotated: false } } };
export const MobilePicker: Story = { name: "Mobile · Choose an agent", args: { initialScreen: "picker" }, globals: { viewport: { value: "mobile1", isRotated: false } } };
export const Light: Story = { name: "Light · Choose an agent", args: { initialScreen: "picker" }, globals: { theme: "light" } };
export const LongCompanyName: Story = { name: "Layout · Long company name", args: { initialScreen: "setup", companyName: "Northstar Research and Product Development Cooperative" } };

export const CopyAndConnect: Story = {
  name: "Test · Copy, watch, and finish",
  args: { initialScreen: "picker", stepDelayMs: 250 },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("button", { name: "Dot Your Dot in ChatGPT" }));
    await userEvent.click(page.getByRole("button", { name: "Copy setup prompt" }));
    await expect(await page.findByText("Copied to clipboard")).toBeVisible();
    await waitFor(() => expect(page.queryByRole("button", { name: "Close agent setup" })).not.toBeInTheDocument());
    await expect(page.queryByRole("button", { name: "Copy setup prompt" })).not.toBeInTheDocument();
    await waitFor(() => expect(page.getByRole("heading", { name: "Your Dot is connected" })).toBeVisible(), { timeout: 6000 });
    await expect(page.getByText("Test event confirmed", { exact: false })).toHaveTextContent("complete");
    await userEvent.click(page.getByRole("button", { name: "Done" }));
    await expect(page.queryByRole("heading", { name: "Your Dot is connected" })).not.toBeInTheDocument();
  },
};
export const RetryAndConnect: Story = {
  name: "Test · Retry preserves completed checks",
  args: { initialScreen: "setup", initialConnection: { phase: "testing", problem: "event_timeout" }, stepDelayMs: 250 },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(page.getByText("Task updates enabled", { exact: false })).toHaveTextContent("complete");
    await userEvent.click(page.getByRole("button", { name: "Retry test event" }));
    await waitFor(() => expect(page.getByRole("heading", { name: "Your Dot is connected" })).toBeVisible());
  },
};

export const AnimatedResize: Story = {
  name: "Test · Modal expands and contracts smoothly",
  args: { initialScreen: "picker", simulate: false },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const win = canvasElement.ownerDocument.defaultView!;
    const dialog = await page.findByRole("dialog", { name: "Invite an external agent" });
    const sampleChange = async (button: HTMLElement) => {
      const before = dialog.getBoundingClientRect().height;
      const samples: number[] = [];
      let frame: number;
      const sample = () => { samples.push(dialog.getBoundingClientRect().height); frame = win.requestAnimationFrame(sample); };
      frame = win.requestAnimationFrame(sample);
      try {
        await userEvent.click(button);
        await new Promise(resolve => win.setTimeout(resolve, 600));
      } finally { win.cancelAnimationFrame(frame); }
      const after = dialog.getBoundingClientRect().height;
      await expect(Math.abs(after - before)).toBeGreaterThan(30);
      if (!win.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const intermediates = samples.filter(height => height > Math.min(before, after) + 1 && height < Math.max(before, after) - 1);
        await expect(new Set(intermediates.map(height => Math.round(height))).size).toBeGreaterThan(1);
      }
    };
    // Let initial portal measurement settle before changing its content.
    await new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
    await sampleChange(page.getByRole("button", { name: "Dot Your Dot in ChatGPT" }));
    await sampleChange(page.getByRole("button", { name: "Back" }));
  },
};
