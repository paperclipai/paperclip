import type { Meta, StoryObj } from "@storybook/react-vite";
import { BoardChat } from "@/pages/BoardChat";
import { expect, userEvent, within } from "storybook/test";
import { storybookIssues } from "../../fixtures/paperclipData";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
const meta = {
  id: "feature-conference-room",
  title:
    "Tasks and conversations/Agent conversations and project handoff/Conference Room",
  component: BoardChat,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Shipped Conference Room with isolated conversation receipts and SSE. This does not execute a provider or verify server access.",
      },
    },
    paperclip: {
      "capabilities": [
        "agent-chat/conference-room"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "BoardChat empty, reply, send pending/error/403 through fixture SSE and persisted comment reads. 403 uses the shipped generic unavailable message; route gates and real Claude execution remain separate."
    },
  },
  beforeEach: ({ parameters }) => {
    let comments: unknown[] = [];
    return prepareFixtureApi(
      [
        {
          path: "/api/companies/company-storybook/issues",
          read: () => [
            {
              ...storybookIssues[0],
              id: "conference-gap",
              title: "Board Operations",
            },
          ],
        },
        { path: "/api/issues/conference-gap/comments", read: () => comments },
        { path: "/api/issues/conference-gap/feedback-votes", read: () => [] },
        {
          path: "/api/board/chat/stream",
          method: "POST",
          read: ({ body }) => {
            comments = [
              {
                id: "comment-human",
                issueId: "conference-gap",
                companyId: "company-storybook",
                authorUserId: "user-storybook",
                authorAgentId: null,
                body: String(body.message),
                createdAt: "2026-10-12T12:00:00Z",
                updatedAt: "2026-10-12T12:00:00Z",
              },
              {
                id: "comment-agent",
                issueId: "conference-gap",
                companyId: "company-storybook",
                authorUserId: null,
                authorAgentId: "agent-codex",
                body: "The release is ready for review.",
                createdAt: "2026-10-12T12:00:01Z",
                updatedAt: "2026-10-12T12:00:01Z",
              },
            ];
            return new Response(
              'data: {"type":"chunk","text":"The release is ready for review."}\n\ndata: {"type":"done"}\n\n',
              { headers: { "Content-Type": "text/event-stream" } },
            );
          },
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup;
  },
} satisfies Meta<typeof BoardChat>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
async function send(canvasElement: HTMLElement) {
  const c = within(canvasElement);
  await userEvent.type(await c.findByRole("textbox"), "Review the release", {
    delay: 15,
  });
  await userEvent.click(c.getByRole("button", { name: "Send message" }));
}
export const Responded: Story = {
  play: async ({ canvasElement }) => {
    await send(canvasElement);
    await expect(
      await within(canvasElement).findByText(
        "The release is ready for review.",
      ),
    ).toBeVisible();
  },
};
export const Sending: Story = {
  parameters: { fixtureState: "saving" },
  play: async ({ canvasElement }) => {
    await send(canvasElement);
    await within(canvasElement).findByText("Connecting...");
  },
};
export const SendFailed: Story = {
  parameters: { fixtureState: "mutation-failure" },
  play: async ({ canvasElement }) => {
    await send(canvasElement);
    await within(canvasElement).findByText(
      "The board assistant is unavailable right now. Please try again in a moment.",
    );
  },
};
export const PermissionDenied: Story = {
  parameters: { fixtureState: "mutation-permission" },
  play: async ({ canvasElement }) => {
    await send(canvasElement);
    await within(canvasElement).findByText(
      "The board assistant is unavailable right now. Please try again in a moment.",
    );
  },
};
