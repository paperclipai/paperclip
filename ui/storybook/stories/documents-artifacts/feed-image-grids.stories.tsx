import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { IssueAttachment, IssueComment, IssueWorkProduct } from "@paperclipai/shared";
import { expect, userEvent, within } from "storybook/test";
import { TaskChatThreadView } from "../../../src/components/task-chat/TaskChatThreadView";
import { TaskChatPresentationProvider } from "../../../src/components/task-chat/presentation-mode";
import type { TaskChatItem, TaskChatMaterializedResourceItem } from "../../../src/components/task-chat/task-chat-model";
import { TaskChatThread } from "../../../src/components/TaskChatThread";
import { storybookAgents } from "../../fixtures/paperclipData";
import { Button } from "../../../src/components/ui/button";

const meta = {
  id: "task-chat-feed-image-grids",
  title: "Tasks and conversations/Documents, attachments, and work products/Task Chat/Image grids",
  parameters: {
    layout: "fullscreen",
    paperclip: {
      capabilities: ["documents-artifacts/work-products", "documents-artifacts/attachments"],
      status: "current", implementation: "production", boundary: "fixtures",
      notes: "Production thread renderer and media gallery. Representative PAP-2525 conversation with seven original sample-account screenshots from its 2026-11-06 turn; no live task or provider actions. Streaming appends saved resources through the same renderer used during execution.",
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const screenshots = [
  ["01-connectors-crown.png", "01 — Crown marks your default"],
  ["02-openai-kebab.png", "02 — Set as default for OpenAI"],
  ["03-default-changed.png", "03 — Crown moves after save"],
  ["04-claude-kebab.png", "04 — Set as default for Claude"],
  ["05-mobile-kebab.png", "05 — Mobile connector menu"],
  ["06-unavailable-default.png", "06 — Unavailable default stays selected"],
  ["07-dark-kebab.png", "07 — Dark theme connector menu"],
];
const images: TaskChatMaterializedResourceItem[] = screenshots.map(([filename, title], index) => {
  const attachmentId = `00000000-0000-4000-8000-00000000000${index}`;
  const href = `/api/attachments/${attachmentId}/content`;
  const workProduct = {
    id: `image-${index}`, companyId: "storybook-company", issueId: "pap-2525", projectId: null, executionWorkspaceId: null, runtimeServiceId: null, externalId: null, isPrimary: false, summary: null, url: null, type: "artifact", provider: "paperclip", title,
    status: "active", reviewState: "none", healthStatus: "unknown",
    createdByRunId: "pap-2525-revised-prototype", createdAt: new Date("2026-11-06T13:31:00Z"), updatedAt: new Date("2026-11-06T13:31:00Z"),
    metadata: { attachmentId, byteSize: 118000, contentType: "image/png", originalFilename: filename, contentPath: href, openPath: href, downloadPath: `${href}?download=1` },
  } as unknown as IssueWorkProduct;
  return { id: `resource:${workProduct.id}`, kind: "protocol", surface: "resource", resourceKind: "deliverable", title, subtitle: "Image", href, workProduct };
});
const message = (id: string, text: string, author: "human" | "agent" = "agent"): TaskChatItem => ({
  id, kind: "message", author, isCurrentUser: author === "human", authorName: author === "agent" ? "Codie" : "You", text,
});
const document: TaskChatMaterializedResourceItem = {
  id: "resource:document:plan", kind: "protocol", surface: "resource", resourceKind: "document",
  title: "AI account defaults — revised plan", subtitle: "Document · rev 2", href: "#document-plan",
};

function Feed({ streaming = false, narrow = false, classic = false, mixed = false, broken = false, single = false }: {
  streaming?: boolean; narrow?: boolean; classic?: boolean; mixed?: boolean; broken?: boolean; single?: boolean;
}) {
  const [count, setCount] = useState(streaming ? 3 : single ? 1 : 7);
  const selectedImages = broken
    ? [{ ...images[0], workProduct: { ...images[0].workProduct!, metadata: { contentType: "image/png", originalFilename: "missing.png", contentPath: "/api/attachments/missing/content" } } }]
    : images.slice(0, count);
  const results: TaskChatItem[] = mixed
    ? [...selectedImages.slice(0, 2), document, message("context", "The menu examples follow the account overview."), ...selectedImages.slice(2)]
    : [document, ...selectedImages];
  const items = [
    message("request", "Show me how I can choose my default AI account and how it appears in the connector menu.", "human"),
    message("progress", "I’ve revised the design around the crown and the connector menu. Here are the updated screens."),
    ...results,
    ...(streaming && count < 7 ? [] : [message("reply", "The crown marks your default for each provider. Use the connector menu to choose a different account. The screenshots include mobile, dark mode, and an unavailable default.")]),
  ];
  return <main className="min-h-screen bg-background p-4 text-foreground">
    <div className={narrow ? "mx-auto w-full max-w-sm" : "mx-auto w-full max-w-3xl"}>
      <div className="flex flex-col gap-1 px-1 pb-4">
        <p className="text-xs text-muted-foreground">PAP-2525 · Task conversation</p>
        <h1 className="text-lg font-semibold">Plan explicit AI account defaults</h1>
      </div>
      <TaskChatPresentationProvider mode={classic ? "production" : "streamlined"}>
        <TaskChatThreadView items={items} scroll={false} />
      </TaskChatPresentationProvider>
      {streaming ? <div className="flex items-center gap-3 pt-4">
        <Button onClick={() => setCount(n => Math.min(7, n + 1))} disabled={count === 7}>Add next image</Button>
        <span role="status" className="text-sm text-muted-foreground">{count === 7 ? "7 images · Complete" : `${count} images · Working`}</span>
      </div> : null}
    </div>
  </main>;
}

export const Pap2525 = { render: () => <Feed />, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("group", { name: "7 images" })).toBeVisible();
  await expect(canvas.getAllByRole("button", { name: /^Open gallery:/ })).toHaveLength(7);
} } satisfies Story;
export const Mobile = { render: () => <Feed narrow /> } satisfies Story;
export const Classic = { render: () => <Feed classic /> } satisfies Story;
export const MixedResults = { render: () => <Feed mixed /> } satisfies Story;
export const SingleImage = { render: () => <Feed single /> } satisfies Story;
export const UnavailableImage = { render: () => <Feed broken /> } satisfies Story;
export const StreamingResults = { render: () => <Feed streaming />, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const first = canvas.getAllByRole("button", { name: /^Open gallery:/ })[0];
  const grid = canvas.getByRole("group", { name: "3 images" });
  for (let count = 4; count <= 7; count++) {
    await userEvent.click(canvas.getByRole("button", { name: "Add next image" }));
    await expect(canvas.getByRole("group", { name: `${count} images` })).toBe(grid);
    await expect(canvas.getAllByRole("button", { name: /^Open gallery:/ })[0]).toBe(first);
  }
  await expect(canvas.getByRole("status")).toHaveTextContent("Complete");
} } satisfies Story;
export const Gallery = { render: () => <Feed />, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getAllByRole("button", { name: /^Open gallery:/ })[1]);
  const body = within(canvasElement.ownerDocument.body);
  await expect(body.getByRole("dialog")).toBeVisible();
  await expect(body.getByRole("link", { name: "Download 02-openai-kebab.png" })).toBeVisible();
  await userEvent.keyboard("{ArrowRight}");
  await expect(body.getByRole("link", { name: "Download 03-default-changed.png" })).toBeVisible();
} } satisfies Story;


/** Includes the generated receipt between every pair of source images. */
export const ProductionFeed = { render: () => {
  const agent = storybookAgents[0];
  const products = images.map((i, n) => ({ ...i.workProduct!, createdAt: new Date(1793971860000 + n * 3000), updatedAt: new Date(1793971860000 + n * 3000) }));
  const attachments = products.map((p, n) => ({
    id: p.metadata!.attachmentId, issueCommentId: `receipt-${n}`, originatingRunId: p.createdByRunId,
    createdByAgentId: agent.id, originalFilename: p.metadata!.originalFilename, contentType: "image/png", contentPath: p.metadata!.contentPath,
    createdAt: p.createdAt, updatedAt: p.updatedAt, byteSize: 118000,
  })) as unknown as IssueAttachment[];
  const comments = products.map((p, n) => ({
    id: `receipt-${n}`, body: `Prepared ${p.title} for this response.`, authorType: "agent", authorAgentId: agent.id, createdByRunId: p.createdByRunId,
    createdAt: new Date(new Date(p.createdAt).getTime() + 100), updatedAt: p.updatedAt, metadata: { version: 1 as const, sections: [], authorizationReason: "paperclip_runner_protocol" },
  })) as unknown as IssueComment[];
  return <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col bg-background px-4 text-foreground">
    <TaskChatThread comments={comments} workProducts={products} attachments={attachments} issueStatus="done" onAdd={async () => {}}
      agentMap={new Map([[agent.id, agent]])} currentAssigneeValue={`agent:${agent.id}`}
      threadHeader={<header className="py-4"><p className="text-xs text-muted-foreground">PAP-2525 · Original upload sequence</p><h1 className="text-lg font-semibold">AI account default screenshots</h1></header>} />
  </main>;
}, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole("group", { name: "7 images" })).toBeVisible();
  await expect(canvas.queryByText(/^Prepared .* for this response\.$/)).not.toBeInTheDocument();
} } satisfies Story;
