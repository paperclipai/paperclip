import type { Meta, StoryObj } from "@storybook/react-vite";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { RichWorkProductCard } from "../../src/components/task-chat/RichWorkProductCard";

const meta = {
  title: "Task Chat/Rich Work Product Card",
  component: RichWorkProductCard,
  parameters: { layout: "centered" },
} satisfies Meta<typeof RichWorkProductCard>;

export default meta;
type Story = StoryObj<typeof meta>;

function product(overrides: Partial<IssueWorkProduct>): IssueWorkProduct {
  return {
    id: `work-product-${overrides.type}`,
    companyId: "company-storybook",
    projectId: null,
    issueId: "issue-storybook",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "artifact",
    provider: "paperclip",
    externalId: null,
    title: "Work product",
    url: "https://example.com/output",
    status: "approved",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "healthy",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    updatedAt: new Date("2026-09-02T00:00:00.000Z"),
    ...overrides,
  };
}

const inventory = [
  product({ type: "pull_request", provider: "github", title: "Add rich work-product cards", status: "active", url: "https://github.com/paperclipai/paperclip/pull/18217", metadata: { repo: "paperclipai/paperclip", number: 18217, baseRef: "master", headRef: "rich-cards", additions: 214, deletions: 18, changedFiles: 3, state: "open", draft: false } }),
  product({ type: "commit", provider: "github", title: "Render kind-specific work products", externalId: "9c12ae7b41e5", url: "https://github.com/paperclipai/paperclip/commit/9c12ae7b41e5", metadata: { repo: "paperclipai/paperclip", sha: "9c12ae7b41e5", branch: "rich-cards", additions: 194, deletions: 12, changedFiles: 2 } }),
  product({ type: "branch", provider: "github", title: "rich-cards", externalId: "rich-cards", url: "https://github.com/paperclipai/paperclip/tree/rich-cards", metadata: { repository: "paperclipai/paperclip", branch: "rich-cards" } }),
  product({ type: "artifact", title: "interaction-map.pdf", status: "pending", metadata: { contentType: "application/pdf", byteSize: 48120 } }),
  product({ type: "artifact", title: "thread-preview.png", status: "ready_for_review", url: "/android-chrome-512x512.png", metadata: { contentType: "image/png", byteSize: 204800 } }),
  product({ type: "document", title: "Implementation plan", status: "ready_for_review", url: "/PAP/issues/PAP-18213#document-plan", metadata: { revisionNumber: 4 } }),
  product({ type: "preview_url", provider: "custom", title: "Rich cards preview", url: "https://preview.paperclip.ing/rich-cards" }),
  product({ type: "runtime_service", provider: "paperclip", title: "Storybook", status: "active", url: "http://localhost:6006", metadata: { service: "storybook", port: 6006 } }),
];

export const Inventory: Story = {
  args: { workProduct: inventory[0], href: inventory[0].url },
  render: () => (
    <div className="flex w-(--container-md) flex-col gap-3">
      {inventory.map((workProduct) => (
        <RichWorkProductCard key={workProduct.id + workProduct.title} workProduct={workProduct} href={workProduct.url} />
      ))}
    </div>
  ),
};
