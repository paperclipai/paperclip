import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import type { PaperclipQuestionResponse, PaperclipQuestionSet } from "@paperclipai/adapter-utils";
import { QuestionForm, QuestionResponseSummary } from "@/components/task-chat/QuestionForm";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { Button } from "@/components/ui/button";

const composerQuestions: PaperclipQuestionSet = {
  schema: "paperclip.question_set.v1",
  title: "Express app — scope",
  questions: [
    {
      id: "storage",
      prompt: "Does it need to store anything?",
      answerMode: "single_select",
      required: true,
      options: [
        { id: "memory", label: "No — in-memory is fine", description: "Fastest to something running; state dies on restart." },
        { id: "sqlite", label: "SQLite file", description: "Real persistence, zero infrastructure. Good default for a first version." },
        { id: "postgres", label: "Postgres", description: "Needs a database to point at." },
      ],
      customAnswer: { enabled: true },
    },
    {
      id: "features",
      prompt: "Which features should it include?",
      helpText: "Choose all that apply, then click Next.",
      answerMode: "multi_select",
      required: true,
      options: [
        { id: "auth", label: "Sign in" },
        { id: "search", label: "Search" },
        { id: "uploads", label: "File uploads" },
      ],
    },
    {
      id: "timing",
      prompt: "When should we start?",
      answerMode: "single_select",
      required: true,
      options: [
        { id: "now", label: "Now" },
        { id: "later", label: "Later" },
      ],
    },
  ],
};

function InteractiveComposerQuestions() {
  const [response, setResponse] = useState<PaperclipQuestionResponse | null>(null);
  const [open, setOpen] = useState(true);
  const [reset, setReset] = useState(0);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {response ? (
        <div role="status" className="space-y-3">
          <p className="text-sm font-medium">Answers submitted</p>
          <QuestionResponseSummary questionSet={composerQuestions} response={response} />
        </div>
      ) : null}
      <TaskChatComposer
        onAdd={() => {}}
        workMode="standard"
        takeover={open ? {
          id: `composer-questions-${reset}`,
          label: composerQuestions.title!,
          pendingCount: 1,
          inlineSkip: true,
          content: <QuestionForm
            key={reset}
            id="composer-questions"
            questionSet={composerQuestions}
            onSubmit={(next) => { setResponse(next); setOpen(false); }}
          />,
          onDismiss: () => setOpen(false),
          onSkip: () => setOpen(false),
        } : null}
      />
      <Button variant="outline" onClick={() => { setResponse(null); setReset((value) => value + 1); setOpen(true); }}>
        Restart questions
      </Button>
    </div>
  );
}

const meta = {
  title: "Composer/Question flow",
  component: InteractiveComposerQuestions,
  parameters: {
    layout: "padded",
    docs: { description: { component: "A structured question card above the usable composer. Choices stay selected until Next or Submit, and Other opens a text field." } },
  },
} satisfies Meta<typeof InteractiveComposerQuestions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const QuestionsAndComposer: Story = {};
export const AnswersSubmitted: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("radio", { name: "Other" }));
    await expect(canvas.getByText("1 of 3")).toBeVisible();
    await expect(canvas.getByTestId("question-other-answer-composer")).toBeVisible();
    await userEvent.click(canvas.getByRole("radio", { name: /SQLite file/ }));
    await expect(canvas.getByText("1 of 3")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Next" }));
    await expect(canvas.getByText("2 of 3")).toBeVisible();
    await userEvent.click(canvas.getByRole("checkbox", { name: "Sign in" }));
    await userEvent.click(canvas.getByRole("checkbox", { name: "Search" }));
    await expect(canvas.getByText("2 of 3")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Next" }));
    await userEvent.click(canvas.getByRole("radio", { name: "Now" }));
    await expect(canvas.getByText("3 of 3")).toBeVisible();
    await expect(canvas.queryByText("Answers submitted")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Submit answers" }));
    await expect(canvas.getByText("Answers submitted")).toBeVisible();
    await expect(canvas.getByText("SQLite file", { exact: true })).toBeVisible();
    await expect(canvas.getByText("Sign in, Search", { exact: true })).toBeVisible();
  },
};


function EditableDraftQuestion() {
  const [response, setResponse] = useState<PaperclipQuestionResponse | null>(null);
  const questionSet: PaperclipQuestionSet = { schema: "paperclip.question_set.v1", questions: [{
    id: "draft", prompt: "Edit the release note", required: true, answerMode: "text",
    initialText: "Draft release note\n\nDescribe what changed and how it was verified.",
  }] };
  return response
    ? <QuestionResponseSummary questionSet={questionSet} response={response} />
    : <QuestionForm id="editable-draft" draftKey="storybook:editable-initial-text" questionSet={questionSet} onSubmit={setResponse} />;
}

/** Provider-supplied starting text stays editable and needs explicit submission. */
export const EditableInitialText: Story = { render: () => <EditableDraftQuestion /> };
