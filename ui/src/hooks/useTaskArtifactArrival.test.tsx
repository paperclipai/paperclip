// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IssueAttachment, IssueDocumentSummary, IssueWorkProduct } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTaskArtifactArrival } from "./useTaskArtifactArrival";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fileId = "00000000-0000-4000-8000-000000000001";
const attachment = (id = fileId, userUpload = false) => ({
  id, createdByAgentId: userUpload ? null : "agent-1", createdByUserId: userUpload ? "user-1" : null,
} as IssueAttachment);
const document = (key = "report") => ({ id: `doc-${key}`, key } as IssueDocumentSummary);
const product = (attachmentId = fileId) => ({
  id: `product-${attachmentId}`, companyId: "company-1", issueId: "task-1",
  projectId: null, executionWorkspaceId: null, runtimeServiceId: null,
  externalId: null, title: "Image", url: null, status: "active", reviewState: "none",
  isPrimary: false, healthStatus: "unknown", summary: null, createdByRunId: null,
  createdAt: new Date(), updatedAt: new Date(),
  type: "artifact", provider: "paperclip", metadata: {
    attachmentId, contentType: "image/png", byteSize: 123,
    contentPath: `/api/attachments/${attachmentId}/content`,
    openPath: `/api/attachments/${attachmentId}/content`,
    downloadPath: `/api/attachments/${attachmentId}/content?download=1`,
  },
} as IssueWorkProduct);

function Watch(props: Parameters<typeof useTaskArtifactArrival>[0]) {
  useTaskArtifactArrival(props);
  return null;
}

describe("new task artifacts", () => {
  let root: Root;
  let container: HTMLDivElement;
  let props: ComponentProps<typeof Watch>;
  const onArrival = vi.fn();
  beforeEach(() => {
    container = window.document.createElement("div");
    root = createRoot(container);
    onArrival.mockReset();
    props = { issueId: "task-1", attachments: [], workProducts: [], documents: [], onArrival };
  });
  afterEach(() => act(() => root.unmount()));
  async function render(update: Partial<typeof props> = {}) {
    props = { ...props, ...update };
    await act(async () => root.render(<Watch {...props} />));
  }

  it("baselines independently loaded history without opening the panel", async () => {
    await render({ attachments: undefined, workProducts: undefined, documents: undefined });
    await render({ attachments: [attachment()] });
    await render({ documents: [document()] });
    await render({ workProducts: [product()] });
    expect(onArrival).not.toHaveBeenCalled();
  });

  it.each(["attachments", "workProducts", "documents"] as const)("reveals new %s after the initial load", async (source) => {
    await render();
    await render({ [source]: { attachments: [attachment()], workProducts: [product()], documents: [document()] }[source] });
    expect(onArrival).toHaveBeenCalledOnce();
  });

  it("does not reopen for upload promotion, revisions, removals, or retry snapshots", async () => {
    await render();
    await render({ attachments: [attachment()] });
    await render({ workProducts: [product()] });
    await render({ workProducts: [{ ...product(), title: "Updated title" }] });
    await render({ attachments: undefined });
    await render({ attachments: [] });
    await render({ attachments: [attachment()] });
    expect(onArrival).toHaveBeenCalledOnce();
  });

  it("deduplicates a file when its work product arrives before its attachment", async () => {
    await render();
    await render({ workProducts: [product()] });
    await render({ attachments: [attachment()] });
    expect(onArrival).toHaveBeenCalledOnce();
  });

  it("opens again for a later, different artifact", async () => {
    await render();
    await render({ attachments: [attachment()] });
    await render({ attachments: [attachment(), attachment("second-file")] });
    expect(onArrival).toHaveBeenCalledTimes(2);
  });

  it("baselines a newly navigated task and detects its subsequent additions", async () => {
    await render();
    await render({ issueId: "task-2", attachments: undefined, documents: undefined, workProducts: undefined });
    await render({ attachments: [attachment()], documents: [], workProducts: [] });
    expect(onArrival).not.toHaveBeenCalled();
    await render({ documents: [document()] });
    expect(onArrival).toHaveBeenCalledOnce();
  });

  it("leaves Plan handling and user input uploads alone, but reveals a published user file", async () => {
    await render();
    await render({ attachments: [attachment(fileId, true)], documents: [document("plan"), document(`artifact-review-${fileId}`)] });
    expect(onArrival).not.toHaveBeenCalled();
    await render({ workProducts: [product()] });
    expect(onArrival).toHaveBeenCalledOnce();
  });

  it("ignores document revision changes and watches non-file work products", async () => {
    await render({ documents: [document()] });
    await render({ documents: [{ ...document(), latestRevisionNumber: 2 }] });
    expect(onArrival).not.toHaveBeenCalled();
    await render({ workProducts: [{ id: "pr-1", type: "pull_request", provider: "github" } as IssueWorkProduct] });
    expect(onArrival).toHaveBeenCalledOnce();
  });
});
