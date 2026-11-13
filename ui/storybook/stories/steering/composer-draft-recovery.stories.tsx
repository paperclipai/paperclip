import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { Button } from "@/components/ui/button";
import {
  saveDraft,
  loadDraft,
  clearDraft,
  saveDraftSubmission,
  loadDraftSubmission,
} from "@/lib/composer-draft";
import { expect, userEvent, within, waitFor } from "storybook/test";
const first = "paperclip:storybook:gap-draft-a",
  second = "paperclip:storybook:gap-draft-b";
function resetFixtureDraft(key: string) {
  clearDraft(key, loadDraftSubmission(key)?.attemptId);
}
function Drafts({ fail = false }: { fail?: boolean }) {
  const [task, setTask] = useState(first);
  return (
    <>
      <Button onClick={() => setTask(task === first ? second : first)}>
        Switch task
      </Button>
      <TaskChatComposer
        key={task}
        draftKey={task}
        workMode="standard"
        onAdd={async () => {
          if (fail) throw new Error("The message could not be saved.");
        }}
      />
    </>
  );
}
const meta = {
  id: "feature-composer-draft-recovery",
  title: "Tasks and conversations/Steering and queued messages/Draft recovery",
  component: Drafts,
  parameters: { layout: "padded",
    paperclip: {
      "capabilities": [
        "steering/drafts"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "TaskChatComposer uses owned task-keyed browser drafts, uncertain submission fence, switch/restore and failed/accepted send callbacks. API receipt authority and real submission durability remain separate. Storybook-owned draft keys are reset using the matching retained submission ID on setup and cleanup; same-browser uncertain-to-empty/send switching is covered separately."
    },
  },
  beforeEach: ({ parameters }) => {
    resetFixtureDraft(first);
    resetFixtureDraft(second);
    if (!parameters.empty)
      saveDraft(first, "Review the release before publishing.");
    saveDraft(second, "Check provider qualification.");
    if (parameters.uncertain)
      saveDraftSubmission(first, {
        attemptId: "00000000-0000-4000-8000-000000000001",
        reviewed: false,
      });
    return () => {
      resetFixtureDraft(first);
      resetFixtureDraft(second);
    };
  },
} satisfies Meta<typeof Drafts>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Restored: Story = {};
export const Empty: Story = { parameters: { empty: true } };
export const UncertainSubmission: Story = { parameters: { uncertain: true } };
export const SwitchAndRestore: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const editor = await c.findByRole("textbox");
    await userEvent.click(editor);
    await userEvent.paste(" Additional evidence.");
    await waitFor(
      () => expect(loadDraft(first)).toContain("Additional evidence."),
      { timeout: 3000 },
    );
    await userEvent.click(c.getByRole("button", { name: "Switch task" }));
    await c.findByText("Check provider qualification.");
    await userEvent.click(c.getByRole("button", { name: "Switch task" }));
    await c.findByText(/Additional evidence/);
  },
};
export const SendFailedKeepsDraft: Story = {
  args: { fail: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByRole("button", { name: /Send/ }));
    await waitFor(() =>
      expect(loadDraft(first)).toContain("Review the release"),
    );
  },
};
export const SentClearsDraft: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByRole("button", { name: /Send/ }));
    await waitFor(() => expect(loadDraft(first)).toBe(""));
  },
};
