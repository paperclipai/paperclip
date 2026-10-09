import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { QuestionChat } from "../fixtures/unansweredQuestionChat";

const meta = {
  title: "Chat & Comments/Task Chat Unanswered Questions",
  parameters: { layout: "fullscreen" },
  component: QuestionChat,
  args: { conversationMode: false },
} satisfies Meta<typeof QuestionChat>;
export default meta;
type Story = StoryObj<typeof meta>;

// Keep the test-drive story's dismissal preference across actual page reloads.
export const TestDrive: Story = {};
export const MovedOn: Story = { args: { movedOn: true } };
export const MultipleUnanswered: Story = { args: { multiple: true } };
export const AnsweredHistory: Story = { args: { answered: true } };
export const Mobile: Story = { args: { movedOn: true }, globals: { viewport: { value: "mobile", isRotated: false } } };
export const DismissAndAnswerLater: Story = {
  beforeEach: () => {
    localStorage.removeItem("paperclip:task-question-dismissals:user-board:task-unanswered-questions-demo");
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole("radio", { name: "Green" })).toBeVisible());
    await userEvent.click(canvas.getByRole("radio", { name: "Green" }));
    await userEvent.click(canvas.getByRole("button", { name: /^Dismiss / }));
    await expect(canvas.getByTestId("task-chat-unanswered-question")).toBeVisible();
    await expect(canvas.queryByTestId("task-chat-composer-takeover")).not.toBeInTheDocument();
    await expect(canvas.queryByTestId("task-chat-pending-input-indicator")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByTestId("task-chat-unanswered-question"));
    await expect(canvas.getByRole("radio", { name: "Green" })).toBeChecked();
    await userEvent.click(canvas.getByRole("button", { name: /^(Send|Submit) answers$/ }));
    await waitFor(() => expect(canvas.getByTestId("task-chat-answered-questions-receipt")).toBeVisible());
  },
};
