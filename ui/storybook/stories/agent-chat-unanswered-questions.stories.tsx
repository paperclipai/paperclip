import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { QuestionChat, question } from "../fixtures/unansweredQuestionChat";

const meta = { title: "Chat & Comments/Agent Chat Unanswered Questions", parameters: { layout: "fullscreen" }, component: QuestionChat,
  beforeEach: () => {
    localStorage.removeItem(`paperclip:task-question-dismissals:user-board:${question.issueId}`);
    for (const key of Object.keys(localStorage)) {
      if (key.includes(`paperclip:task-input:${question.issueId}:`)) localStorage.removeItem(key);
    }
  },
} satisfies Meta<typeof QuestionChat>;
export default meta;
type Story = StoryObj<typeof meta>;
export const JustAsked: Story = { args: {} };
export const DismissFreshQuestion: Story = { args: {}, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getByRole("radio", { name: "Green" })).toBeVisible());
  await userEvent.click(canvas.getByRole("radio", { name: "Green" }));
  await userEvent.click(canvas.getByRole("button", { name: /^Cancel$/ }));
  await expect(canvas.getByTestId("task-chat-unanswered-question")).toBeVisible();
  await expect(canvas.queryByTestId("task-chat-composer-takeover")).not.toBeInTheDocument();
  await expect(canvas.queryByTestId("task-chat-pending-input-indicator")).not.toBeInTheDocument();
} };
export const MovedOn: Story = { args: { movedOn: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getByTestId("task-chat-unanswered-question")).toBeVisible());
  await expect(canvas.queryByTestId("task-chat-composer-takeover")).not.toBeInTheDocument();
  await expect(canvas.queryByTestId("task-chat-pending-input-indicator")).not.toBeInTheDocument();
} };
export const Reopened: Story = { args: { movedOn: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getByTestId("task-chat-unanswered-question")).toBeVisible());
  await userEvent.click(canvas.getByRole("button", { name: "Answer question: Which color should the welcome note use?" }));
  await waitFor(() => expect(canvas.getByTestId("task-chat-composer-takeover")).toBeVisible());
  await expect(canvas.getByRole("radio", { name: "Blue" })).toBeVisible();
} };
export const AnswerLater: Story = { args: { movedOn: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getByTestId("task-chat-unanswered-question")).toBeVisible());
  await userEvent.click(canvas.getByTestId("task-chat-unanswered-question"));
  await userEvent.click(canvas.getByRole("radio", { name: "Blue" }));
  await userEvent.click(canvas.getByRole("button", { name: /^(Send|Submit) answers$/ }));
  await expect(canvas.queryByTestId("task-chat-unanswered-question")).not.toBeInTheDocument();
  await waitFor(() => expect(canvas.getByTestId("task-chat-answered-questions-receipt")).toBeVisible());
} };
export const MultipleUnanswered: Story = { args: { multiple: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getAllByTestId("task-chat-unanswered-question")).toHaveLength(2));
  await expect(canvas.queryByTestId("task-chat-composer-takeover")).not.toBeInTheDocument();
  await expect(canvas.queryByTestId("task-chat-pending-input-indicator")).not.toBeInTheDocument();
} };
export const AnsweredHistory: Story = { args: { answered: true } };
export const Mobile: Story = { args: { movedOn: true }, globals: { viewport: { value: "mobile", isRotated: false } } };

export const MoveOnWithoutAnswering: Story = { args: {}, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getByTestId("task-chat-unanswered-question")).toBeVisible());
  await userEvent.click(canvas.getByRole("radio", { name: "Green" }));
  await userEvent.type(canvas.getByRole("textbox", { name: "editable markdown" }), "Leave that for later. Tell me about tasks.");
  await userEvent.click(canvas.getByRole("button", { name: /^Send$/ }));
  await expect(canvas.queryByTestId("task-chat-composer-takeover")).not.toBeInTheDocument();
  await expect(canvas.queryByTestId("task-chat-pending-input-indicator")).not.toBeInTheDocument();
  await userEvent.click(canvas.getByTestId("task-chat-unanswered-question"));
  await expect(canvas.getByRole("radio", { name: "Green" })).toBeChecked();
} };
