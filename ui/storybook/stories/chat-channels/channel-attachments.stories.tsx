import type { Meta, StoryObj } from "@storybook/react-vite";
import type { IssueAttachment } from "@paperclipai/shared";
import { TaskChatBubble } from "@/components/task-chat/TaskChatBubble";
import { expect, within, waitFor } from "storybook/test";
const attachment: IssueAttachment = {
  id: "attachment-gap",
  companyId: "company-storybook",
  issueId: "task-gap",
  issueCommentId: "message-gap",
  assetId: "asset-gap",
  contentPath: "/api/assets/asset-gap/content",
  provider: "paperclip",
  objectKey: "fixture/report.txt",
  contentType: "text/plain",
  byteSize: 42,
  sha256: "fixture-sha256",
  originalFilename: "release-report.txt",
  createdByAgentId: null,
  createdByUserId: "user-storybook",
  createdAt: new Date("2026-10-12"),
  updatedAt: new Date("2026-10-12"),
};
const meta = {
  id: "feature-channel-attachments",
  title:
    "Apps, channels, and extensions/External chat and email/Task-linked files",
  component: TaskChatBubble,
  args: {
    item: {
      id: "message-gap",
      kind: "message",
      author: "human",
      text: "Here is the release report.",
      sourceChannel: "imessage-photon",
    },
    attachments: [attachment],
  },
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Production task bubble with the saved attachment receipt and channel attribution. Provider upload, delivery, download authority and replay require production tests.",
      },
    },
    paperclip: {
      "capabilities": [
        "chat-channels/attachments"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "TaskChatBubble with received/outbound saved attachment receipts, no/multiple files and missing filename. File links are fictional; no download, provider transfer or authorization is proved."
    },
  },
} satisfies Meta<typeof TaskChatBubble>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ReceivedFile: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("release-report.txt");
  },
};
export const NoFiles: Story = { args: { attachments: [] } };
export const MultipleFiles: Story = {
  args: {
    attachments: [
      attachment,
      {
        ...attachment,
        id: "attachment-two",
        assetId: "asset-two",
        contentPath: "/api/assets/asset-two/content",
        originalFilename: "checks.json",
        contentType: "application/json",
      },
    ],
  },
};
export const MissingFilename: Story = {
  args: { attachments: [{ ...attachment, originalFilename: null }] },
};
export const OutboundFile: Story = {
  args: {
    item: {
      id: "message-gap",
      kind: "message",
      author: "agent",
      text: "I attached the reviewed release report.",
    },
  },
  play: async ({ canvasElement }) => {
    const title = await within(canvasElement).findByText("release-report.txt");
    await waitFor(() => expect(title).toBeVisible());
  },
};
