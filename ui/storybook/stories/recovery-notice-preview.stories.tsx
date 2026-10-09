import { expect, userEvent, within } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { RecoveryNoticePreview } from "../prototypes/recovery-notice/RecoveryNoticePreview";

const meta = {
  title: "Design previews/Recovery notice",
  component: RecoveryNoticePreview,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "Production recovery notice with a simulated request. Rendering, disclosure, pending, failure, and acknowledgement use the same component as both task interfaces. No real task is changed.",
      },
    },
  },
  args: {
    agentName: "Alex",
    defaultExpanded: false,
    holdRequest: false,
    retryOutcome: "queued",
    retryBlockedReason: "",
    mobile: false,
    comparison: false,
    noticeOnly: false,
  },
  argTypes: {

    retryOutcome: { control: "select", options: ["queued", "failed"] },
  },
} satisfies Meta<typeof RecoveryNoticePreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InConversation: Story = { name: "Start here · In conversation" };
export const BeforeAndAfter: Story = { args: { comparison: true } };
export const ExpandedDetails: Story = { args: { defaultExpanded: true } };
export const RetryUnavailable: Story = {
  args: { retryBlockedReason: "The company’s spending limit has been reached. Update the limit before retrying." },
};
export const RequestingRetry: Story = { args: { holdRequest: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement); await userEvent.click(canvas.getByRole("button", { name: "Retry agent" }));
  await expect(canvas.getByRole("button", { name: "Requesting retry…" })).toBeDisabled();
} };
export const RetryRequested: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement); await userEvent.click(canvas.getByRole("button", { name: "Retry agent" }));
  await expect(await canvas.findByText("Retry requested")).toBeVisible();
} };
export const RetryRequestFailed: Story = { args: { retryOutcome: "failed" }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement); await userEvent.click(canvas.getByRole("button", { name: "Retry agent" }));
  await expect(await canvas.findByRole("alert")).toHaveTextContent("Couldn’t confirm the retry.");
} };
export const Mobile: Story = {
  args: { mobile: true },
  globals: { viewport: { value: "mobile", isRotated: false } },
};
export const NoticeOnly: Story = { args: { noticeOnly: true } };
