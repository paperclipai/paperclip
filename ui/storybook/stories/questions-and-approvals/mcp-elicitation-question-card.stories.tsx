import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import { TaskChatInteractionCard } from "@/components/task-chat/TaskChatInteractionCard";
import { issueThreadInteractionFixtureMeta } from "@/fixtures/issueThreadInteractionFixtures";
import {
  mcpAnsweredCard,
  mcpAskingCard,
  mcpExpiredCard,
  mcpSkippedCard,
  mcpTwoQuestionCards,
} from "@/fixtures/mcpElicitationFixtures";
import { storybookAgentMap } from "../../fixtures/paperclipData";

/**
 * An MCP app asked the person a question in the middle of a tool call (MCP
 * elicitation, doc/connections/MCP-ELICITATION.md). The card names the app,
 * shows its message as plain text, and only people can answer it.
 */
function ElicitationCards({ interactions, presentation }: { interactions: IssueThreadInteraction[]; presentation: "takeover" | "timeline" }) {
  const [sent, setSent] = useState<string[]>([]);
  return (
    <div className="mx-auto grid max-w-2xl gap-4 p-4">
      {interactions.map((interaction) => (
        <TaskChatInteractionCard
          key={interaction.id}
          item={{ id: `interaction:${interaction.id}`, kind: "interaction", interaction }}
          presentation={presentation}
          agentMap={storybookAgentMap}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          onAcceptInteraction={async () => undefined}
          onRejectInteraction={async () => undefined}
          onSubmitInteractionAnswers={async () => { setSent((current) => [...current, interaction.id]); }}
          onSubmitInteractionVerdicts={async () => undefined}
        />
      ))}
      {sent.length ? <p className="text-sm text-muted-foreground" data-testid="sent">Sent to the app</p> : null}
    </div>
  );
}

const meta = {
  id: "questions-and-approvals-mcp-elicitation-question-card",
  title: "Tasks and conversations/Questions and approvals/MCP App Questions",
  component: ElicitationCards,
  parameters: {
    layout: "fullscreen",
    paperclip: {
      "capabilities": [
        "questions-and-approvals/questions"
      ],
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Production question card with question sets produced by the server's MCP elicitation mapper. Sending answers back to the app, waking the agent, and the human-only rule are covered by server tests (server/src/__tests__/mcp-elicitation.test.ts)."
    },
  },
} satisfies Meta<typeof ElicitationCards>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Asking: every spec field type, with the app's defaults filled in. */
export const Asking: Story = {
  args: { interactions: [mcpAskingCard], presentation: "takeover" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Linear needs your input")).toBeInTheDocument();
    await expect(canvas.getByText("Linear needs a few details to file this ticket.")).toBeInTheDocument();
    // The app's default is filled in and stays editable.
    await expect(canvas.getByText("Login button does nothing")).toBeInTheDocument();
    await expect(canvas.getByText("1 of 5")).toBeInTheDocument();
  },
};

/** Answered: the receipt shows what went back to the app. */
export const Answered: Story = {
  args: { interactions: [mcpAnsweredCard], presentation: "timeline" },
};

/** Skipped: the app was told the person declined. */
export const Skipped: Story = {
  args: { interactions: [mcpSkippedCard], presentation: "timeline" },
};

/** Expired: nobody answered within a day, so the card was withdrawn and the app asks again. */
export const Expired: Story = {
  args: { interactions: [mcpExpiredCard], presentation: "timeline" },
};

/** Two questions at once: each card is answered on its own; both answers go back together. */
export const TwoQuestions: Story = {
  args: { interactions: mcpTwoQuestionCards, presentation: "takeover" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Which team should own this?")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("radio", { name: /Platform/ }));
  },
};
