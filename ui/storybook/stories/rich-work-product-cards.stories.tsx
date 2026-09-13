import type { Meta, StoryObj } from "@storybook/react-vite";
import type { IssueAttachment, IssueWorkProduct } from "@paperclipai/shared";
import { expect } from "storybook/test";
import { RichWorkProductCard } from "../../src/components/task-chat/RichWorkProductCard";
import { TaskChatBubble } from "../../src/components/task-chat/TaskChatBubble";
import type { TaskChatMessageItem } from "../../src/components/task-chat/task-chat-model";

const meta = {
  title: "Task Chat/Rich Work Product Cards",
  component: RichWorkProductCard,
  parameters: { layout: "centered" },
} satisfies Meta<typeof RichWorkProductCard>;

export default meta;
type Story = StoryObj<typeof meta>;

type CardKind = {
  id: string;
  label: string;
  type: IssueWorkProduct["type"];
  provider: string;
  title: string;
  url: string;
  metadata: Record<string, unknown>;
};

type CardState = {
  id: string;
  label: string;
  status: string;
  reviewState?: IssueWorkProduct["reviewState"];
  healthStatus?: IssueWorkProduct["healthStatus"];
};

const IMAGE_PREVIEW =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='640' height='360'><rect width='640' height='360' fill='#3158d4'/><circle cx='320' cy='180' r='72' fill='#f5f7ff'/></svg>",
  );

const KINDS: CardKind[] = [
  {
    id: "pull-request",
    label: "Pull request",
    type: "pull_request",
    provider: "github",
    title: "Add rich work-product cards",
    url: "https://github.com/paperclipai/paperclip/pull/12717",
    metadata: { repo: "paperclipai/paperclip", number: 12717, baseRef: "master", headRef: "rich-cards" },
  },
  {
    id: "commit",
    label: "Commit",
    type: "commit",
    provider: "github",
    title: "Render kind-specific work products",
    url: "https://github.com/paperclipai/paperclip/commit/9c12ae7b41e5",
    metadata: { sha: "9c12ae7b41e5", branch: "rich-cards" },
  },
  {
    id: "branch",
    label: "Branch",
    type: "branch",
    provider: "github",
    title: "rich-cards",
    url: "https://github.com/paperclipai/paperclip/tree/rich-cards",
    metadata: { repository: "paperclipai/paperclip", branch: "rich-cards" },
  },
  {
    id: "artifact-file",
    label: "Artifact · file",
    type: "artifact",
    provider: "paperclip",
    title: "interaction-map.pdf",
    url: "/api/attachments/story-file/content",
    metadata: { contentType: "application/pdf", byteSize: 48_120 },
  },
  {
    id: "artifact-image",
    label: "Artifact · image",
    type: "artifact",
    provider: "paperclip",
    title: "thread-preview.png",
    url: IMAGE_PREVIEW,
    metadata: { contentType: "image/png", byteSize: 204_800, openPath: IMAGE_PREVIEW },
  },
  {
    id: "document",
    label: "Document",
    type: "document",
    provider: "paperclip",
    title: "Implementation plan",
    url: "/PAP/issues/PAP-18213#document-plan",
    metadata: { revisionNumber: 4 },
  },
  {
    id: "preview-url",
    label: "Preview URL",
    type: "preview_url",
    provider: "custom",
    title: "Rich cards preview",
    url: "https://preview.paperclip.ing/rich-cards",
    metadata: {},
  },
  {
    id: "runtime-service",
    label: "Runtime service",
    type: "runtime_service",
    provider: "paperclip",
    title: "Storybook",
    url: "http://localhost:6006",
    metadata: { service: "storybook", port: 6006 },
  },
];

const STATES: CardState[] = [
  { id: "resting", label: "Resting", status: "approved" },
  { id: "pending", label: "Pending", status: "pending" },
  { id: "failed", label: "Failed", status: "failed" },
  { id: "needs-review", label: "Needs review", status: "ready_for_review", reviewState: "needs_board_review" },
  { id: "changes-requested", label: "Changes requested", status: "changes_requested", reviewState: "changes_requested" },
];

const PR_STATES: CardState[] = [
  { id: "open", label: "Open", status: "open" },
  { id: "draft", label: "Draft", status: "draft" },
  { id: "merged", label: "Merged", status: "merged" },
  { id: "closed", label: "Closed", status: "closed" },
];

const RUNTIME_STATES: CardState[] = [
  { id: "running", label: "Running", status: "active", healthStatus: "healthy" },
  { id: "stopped", label: "Stopped", status: "closed", healthStatus: "healthy" },
  { id: "unhealthy", label: "Unhealthy", status: "active", healthStatus: "unhealthy" },
];

function product(kind: CardKind, state: CardState, withStats = false): IssueWorkProduct {
  return {
    id: `${kind.id}-${state.id}-${withStats ? "stats" : "plain"}`,
    companyId: "company-storybook",
    projectId: null,
    issueId: "issue-storybook",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: kind.type,
    provider: kind.provider,
    externalId: kind.type === "commit" ? "9c12ae7b41e5" : null,
    title: kind.title,
    url: kind.url,
    status: state.status,
    reviewState: state.reviewState ?? "none",
    isPrimary: false,
    healthStatus: state.healthStatus ?? (state.id === "failed" ? "unhealthy" : "healthy"),
    summary: null,
    metadata: {
      ...kind.metadata,
      ...(kind.type === "pull_request" ? { state: state.status, draft: state.status === "draft" } : {}),
      ...(withStats ? { additions: 214, deletions: 18, changedFiles: 3 } : {}),
    },
    createdByRunId: null,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    updatedAt: new Date("2026-09-02T00:00:00.000Z"),
  };
}

function Matrix({ kinds = KINDS, states = STATES }: { kinds?: CardKind[]; states?: CardState[] }) {
  return (
    <div className="flex w-(--container-4xl) max-w-full flex-col gap-8 p-6">
      {kinds.map((kind) => (
        <section key={kind.id} className="flex flex-col gap-3" aria-labelledby={`${kind.id}-heading`}>
          <h2 id={`${kind.id}-heading`} className="text-sm font-semibold text-foreground">{kind.label}</h2>
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {states.flatMap((state) => [false, true].map((withStats) => {
              const workProduct = product(kind, state, withStats);
              return (
                <div key={workProduct.id} className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs text-muted-foreground">{state.label} · {withStats ? "with stats" : "without stats"}</span>
                  <RichWorkProductCard workProduct={workProduct} href={workProduct.url} />
                </div>
              );
            }))}
          </div>
        </section>
      ))}
    </div>
  );
}

export const KindByStateMatrix: Story = {
  args: { workProduct: product(KINDS[0], STATES[0]), href: KINDS[0].url },
  render: () => <Matrix />,
};

/** The original one-card-per-kind inventory, retained as a compact comparison baseline. */
export const PreviousInventory: Story = {
  args: { workProduct: product(KINDS[0], STATES[0]), href: KINDS[0].url },
  render: () => (
    <div className="flex w-(--container-md) max-w-full flex-col gap-3 p-6">
      {KINDS.map((kind) => {
        const workProduct = product(kind, STATES[0]);
        return <RichWorkProductCard key={kind.id} workProduct={workProduct} href={workProduct.url} />;
      })}
    </div>
  ),
};

export const PullRequestLifecycle: Story = {
  args: { workProduct: product(KINDS[0], PR_STATES[0]), href: KINDS[0].url },
  render: () => <Matrix kinds={[KINDS[0]]} states={PR_STATES} />,
};

export const RuntimeServiceLifecycle: Story = {
  args: { workProduct: product(KINDS[7], RUNTIME_STATES[0]), href: KINDS[7].url },
  render: () => <Matrix kinds={[KINDS[7]]} states={RUNTIME_STATES} />,
  play: async ({ canvasElement }) => {
    const chipLabels = [...canvasElement.querySelectorAll(".status-chip")].map((chip) => chip.textContent);
    expect(chipLabels).toEqual(["Running", "Running", "Stopped", "Stopped", "Unhealthy", "Unhealthy"]);
  },
};

export const LongTitleTruncation: Story = {
  args: { workProduct: product(KINDS[0], STATES[0]), href: KINDS[0].url },
  render: () => {
    const longTitle = "Implement the complete rich work-product card inventory with an intentionally long title that must truncate cleanly";
    return (
      <div className="w-(--container-sm) max-w-full p-6">
        <RichWorkProductCard
          workProduct={{ ...product(KINDS[0], STATES[3], true), title: longTitle }}
          href={KINDS[0].url}
        />
      </div>
    );
  },
};

export const Mobile375: Story = {
  args: { workProduct: product(KINDS[0], STATES[0]), href: KINDS[0].url },
  parameters: {
    layout: "fullscreen",
    viewport: {
      options: { mobile375: { name: "Mobile 375", styles: { width: "375px", height: "812px" } } },
    },
  },
  globals: { viewport: { value: "mobile375" } },
  render: () => (
    <div className="flex w-full flex-col gap-3 p-4">
      {KINDS.map((kind) => {
        const workProduct = product(kind, kind.type === "pull_request" ? PR_STATES[0] : STATES[3], true);
        return <RichWorkProductCard key={kind.id} workProduct={workProduct} href={workProduct.url} />;
      })}
    </div>
  ),
};

function attachment(id: string, name: string, contentType: string, byteSize: number): IssueAttachment {
  return {
    id,
    companyId: "company-storybook",
    issueId: "issue-storybook",
    issueCommentId: "message-storybook",
    assetId: `asset-${id}`,
    provider: "paperclip",
    objectKey: id,
    contentType,
    byteSize,
    sha256: id,
    originalFilename: name,
    createdByAgentId: "agent-storybook",
    createdByUserId: null,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    updatedAt: new Date("2026-09-02T00:00:00.000Z"),
    contentPath: `/api/attachments/${id}/content`,
    openPath: contentType.startsWith("image/") ? IMAGE_PREVIEW : `/api/attachments/${id}/content`,
    downloadPath: `/api/attachments/${id}/content?download=1`,
  };
}

const MESSAGE_ATTACHMENTS = [
  ...Array.from({ length: 5 }, (_, index) => attachment(`shot-${index + 1}`, `desktop ${index + 1}.png`, "image/png", (index + 1) * 18_000)),
  attachment("run-log", "verification.log", "text/plain", 14 * 1024),
  attachment("patch", "rich-cards.patch", "text/x-diff", 2_640),
  attachment("spec", "review-spec.pdf", "application/pdf", 300 * 1024),
];

const MESSAGE_ITEM: TaskChatMessageItem = {
  id: "message-storybook",
  kind: "message",
  author: "agent",
  authorName: "CodexCoder",
  text: [
    "Implemented the review inventory.",
    "",
    ...MESSAGE_ATTACHMENTS.map((item) => `[${item.originalFilename}](${item.contentPath})`),
  ].join("\n"),
};

export const MessageTailMediaAndTypedChips: Story = {
  args: { workProduct: product(KINDS[0], STATES[0]), href: KINDS[0].url },
  parameters: { layout: "fullscreen" },
  render: () => (
    <div className="mx-auto w-full max-w-2xl p-6">
      <TaskChatBubble item={MESSAGE_ITEM} attachments={MESSAGE_ATTACHMENTS} animateEntry={false} />
    </div>
  ),
};
