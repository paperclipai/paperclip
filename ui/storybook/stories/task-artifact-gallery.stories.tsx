import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueAttachment, IssueWorkProduct } from "@paperclipai/shared";
import { IssuePropertiesArtifactsTab } from "@/components/issue-properties/IssuePropertiesArtifactsTab";
import { RichWorkProductCard } from "@/components/task-chat/RichWorkProductCard";
import { ImageGalleryModal, type GalleryMediaItem } from "@/components/ImageGalleryModal";
import { IssueGalleryContext } from "@/context/IssueGalleryContext";
import { queryKeys } from "@/lib/queryKeys";
import { isImageLikeOutput, isVideoLikeOutput } from "@/lib/issue-output";
import { TaskChatBubble } from "@/components/task-chat/TaskChatBubble";
import { workProductHref } from "@/lib/issue-artifacts";
import { createIssue, storybookAgents } from "../fixtures/paperclipData";
import manila from "../fixtures/artifact-media/manila-ledger.mp4?url";
import night from "../fixtures/artifact-media/night-pills.mp4?url";
import tickets from "../fixtures/artifact-media/ticket-board.mp4?url";
import type from "../fixtures/artifact-media/big-type.mp4?url";
import trail from "../fixtures/artifact-media/paper-trail.mp4?url";
import manilaImage from "../fixtures/artifact-media/manila-ledger.png?url";
import nightImage from "../fixtures/artifact-media/night-pills.png?url";

const issue = createIssue({ id: "artifact-gallery-story", identifier: "DEMO-101", title: "Explore Paperclip Ships styles", status: "done" });
const date = new Date("2026-09-22T18:03:00Z");
const media = [["Paper Trail", trail], ["Big Type", type], ["Ticket Board", tickets], ["Night Pills", night], ["Manila Ledger", manila]];
function product(title: string, index: number, overrides: Partial<IssueWorkProduct> = {}): IssueWorkProduct {
  return {
    id: `gallery-product-${index}`, companyId: issue.companyId, projectId: null, issueId: issue.id,
    executionWorkspaceId: null, runtimeServiceId: null, type: "artifact", provider: "paperclip",
    externalId: null, title, url: null, status: "approved", reviewState: "none", isPrimary: false,
    healthStatus: "unknown", summary: null, metadata: null, createdByRunId: "style-exploration",
    createdAt: new Date(date.getTime() - index * 1000), updatedAt: date, ...overrides,
  } as IssueWorkProduct;
}
const videos = [...media, ["Motion concept — Sep 21", manila], ["Motion concept — Sep 19", night], ["Motion concept — Sep 18", tickets]].map(([name, src], index) => product(`Paperclip Ships — ${name}`, index, {
  createdByRunId: index < 5 ? "style-exploration" : "first-concepts",
  metadata: { contentType: "video/mp4", contentPath: src, openPath: src, originalFilename: `${name.toLowerCase().replaceAll(" ", "-")}.mp4`, byteSize: 128_000 },
}));
const files = [
  product("Style exploration notes.txt", 20, { metadata: { contentType: "text/plain", byteSize: 2400, downloadPath: "data:text/plain,Five%20Paperclip%20Ships%20style%20directions", contentPath: "data:text/plain,Five%20Paperclip%20Ships%20style%20directions" } }),
  product("Preview the daily ships page", 21, { type: "preview_url", url: "https://paperclip.ing", metadata: null }),
  product("Source package is still being prepared", 22, { status: "pending" }),
];
const images = [manilaImage, nightImage].map((src, index) => product(index ? "Night Pills — cover image" : "Manila Ledger — cover image", index + 10, {
  metadata: { contentType: index ? "application/octet-stream" : "image/png", contentPath: src, originalFilename: `cover-${index}.png`, byteSize: 42000 },
}));

type Scenario = "videos" | "mixed" | "rows" | "fallback" | "empty";
function GalleryStory({ scenario = "videos", width = 480 }: { scenario?: Scenario; width?: number }) {
  const workProducts = scenario === "empty" ? [] : scenario === "rows" ? [...videos.slice(0, 1), ...images.slice(0, 1), ...files] : scenario === "mixed" ? [...videos.slice(0, 2), ...images, ...files] : scenario === "fallback" ? [product("Video preview unavailable", 30, { metadata: { contentType: "video/mp4", contentPath: "data:video/mp4;base64,AA==", originalFilename: "unavailable.mp4" } }), product("Image preview unavailable", 31, { metadata: { contentType: "image/png", contentPath: "data:image/png;base64,AA==" } })] : videos;
  const attachments = scenario === "mixed" ? [{ id: "loose-image", companyId: issue.companyId, issueId: issue.id, createdByAgentId: storybookAgents[0].id, contentPath: nightImage, contentType: "image/png", originalFilename: "Unpromoted agent attachment.png", objectKey: "cover.png", byteSize: 42000, createdAt: date } as IssueAttachment] : [];
  const [client] = useState(() => {
    const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    cache.setQueryData(queryKeys.issues.workProducts(issue.id), workProducts);
    cache.setQueryData(queryKeys.issues.attachments(issue.id), attachments);
    cache.setQueryData([...queryKeys.issues.documents(issue.id), "list"], []);
    cache.setQueryData(queryKeys.issues.runs(issue.id), [
      { runId: "style-exploration", agentId: storybookAgents[0].id, startedAt: date },
      { runId: "first-concepts", agentId: storybookAgents[0].id, startedAt: new Date("2026-09-22T17:43:00Z") },
    ]);
    cache.setQueryData(queryKeys.agents.list(issue.companyId), [{ ...storybookAgents[0], name: "CodexRunner" }]);
    return cache;
  });
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null);
  const items: GalleryMediaItem[] = [...workProducts.flatMap((wp) => {
    const metadata = wp.metadata;
    if (typeof metadata?.contentPath !== "string" || typeof metadata?.contentType !== "string" || !(isImageLikeOutput(metadata.contentType, String(metadata.originalFilename ?? wp.title)) || isVideoLikeOutput(metadata.contentType, String(metadata.originalFilename ?? wp.title)))) return [];
    return [{ id: wp.id, contentPath: metadata.contentPath, contentType: metadata.contentType, originalFilename: typeof metadata.originalFilename === "string" ? metadata.originalFilename : wp.title }];
  }), ...attachments.map((attachment) => ({ id: attachment.id, contentPath: attachment.contentPath, contentType: attachment.contentType, originalFilename: attachment.originalFilename }))];
  return (
    <QueryClientProvider client={client}>
      <IssueGalleryContext.Provider value={(src) => { const index = items.findIndex((item) => item.contentPath === src); if (index < 0) return false; setGalleryIndex(index); return true; }}>
        <main className="min-h-screen bg-background p-6 text-foreground">
          <div className="mx-auto flex max-w-6xl flex-wrap items-start gap-8">
            <div className="flex min-w-0 flex-1 flex-col gap-3" style={{ minWidth: 240 }}>
              <p className="font-mono text-xs text-muted-foreground">Media artifacts · Design review</p>
              <h1 className="text-xl font-semibold">Paperclip Ships artifacts</h1>
              <p className="max-w-md text-sm text-muted-foreground">Eight video outputs across two runs. Compare previews at a glance, then click anywhere on a tile to watch it.</p>
              <p className="max-w-md text-xs text-muted-foreground">Illustrative offline clips inspired by the task’s five style directions. These stories use the production artifact components.</p>
              {scenario === "rows" ? <div className="flex flex-col gap-2"><TaskChatBubble item={{ id: "clip-comment", kind: "message", author: "agent", text: "Video ready to review." }} attachments={[{ id: "chat-clip", issueCommentId: "clip-comment", contentPath: trail, contentType: "video/mp4", originalFilename: "paper-trail.mp4", byteSize: 128000 } as IssueAttachment]} />{workProducts.map((wp) => <RichWorkProductCard key={wp.id} workProduct={wp} href={workProductHref(wp)} variant="compact" />)}</div> : null}
            </div>
            <section className="max-w-full shrink-0 rounded-lg border border-border bg-background" style={{ width }} aria-label="Task artifacts panel">
              <header className="flex items-center gap-4 border-b border-border px-4 py-3 text-sm"><span className="text-muted-foreground">Properties</span><strong className="font-medium">Artifacts</strong></header>
              <div className="p-3"><IssuePropertiesArtifactsTab issue={issue} /></div>
            </section>
          </div>
        </main>
        {galleryIndex !== null ? <ImageGalleryModal items={items} initialIndex={galleryIndex} open onOpenChange={(open) => { if (!open) setGalleryIndex(null); }} /> : null}
      </IssueGalleryContext.Provider>
    </QueryClientProvider>
  );
}
const meta = { title: "Tasks/Artifact Gallery", component: GalleryStory, parameters: { layout: "fullscreen" }, args: { scenario: "videos", width: 480 }, render: (args, context) => <GalleryStory key={`${context.id}-${args.scenario}`} {...args} /> } satisfies Meta<typeof GalleryStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const EightVideoOutputs: Story = {};
export const MixedMediaAndFiles: Story = { args: { scenario: "mixed" } };
export const WholeRowClickable: Story = { args: { scenario: "rows" } };
export const NarrowPanel: Story = { args: { width: 320 } };
export const ExpandedPanel: Story = { args: { width: 800 } };
export const UnavailablePreviews: Story = { args: { scenario: "fallback" } };
export const Empty: Story = { args: { scenario: "empty" } };
export const Light: Story = { globals: { theme: "light" } };
