import { expect, it } from "vitest";
import { fitNativeTaskContext, nativeChildTaskContext, nativeTaskContextPage } from "./native-task-context.js";

it("keeps child text excerpts valid and leaves complete source records unchanged", () => {
  const source = { id: "child", title: "💊".repeat(1000), description: '💊"\\\n'.repeat(2000) };
  const saved = structuredClone(source);
  const result = nativeChildTaskContext([source]);
  expect(result.tasks[0]).toMatchObject({ id: "child", titleTruncated: true, descriptionTruncated: true });
  expect(JSON.stringify(result)).not.toContain("�");
  expect(result.truncated).toBe(false);
  expect(source).toEqual(saved);
});

it("marks omitted rows when encoded child metadata exhausts the context budget", () => {
  const rows = Array.from({ length: 101 }, (_, id) => ({ id, title: "child", description: null, metadata: '"\\\n'.repeat(3000) }));
  const result = nativeChildTaskContext(rows);
  expect(result.tasks.length).toBeGreaterThan(0);
  expect(result.tasks.length).toBeLessThan(100);
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result.tasks))).toBeLessThanOrEqual(128 * 1024);
});

it("preserves ordinary context and gives an oversized context a deliverable named failure", () => {
  const small = { activeTask: { id: "task", description: "Keep the complete approval scope" } };
  expect(fitNativeTaskContext(small)).toBe(small);
  const source = { activeTask: { id: "task", description: "private-source-content".repeat(40_000) } };
  const result = fitNativeTaskContext(source);
  expect(result).toMatchObject({ outcome: "failed", code: "paperclip_runner_task_context_too_large",
    readWith: [{ tool: "get_task_context", arguments: { view: "full", offset: 0 } }] });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(500_000);
  expect(JSON.stringify(result)).not.toContain("private-source-content");
  expect(source.activeTask.description).toHaveLength(880_000);
});

it("preserves exact accepted and source plan references while paging their complete approved text", () => {
  const source = { activeTask: { id: "task" }, acceptedPlan: { revisionId: "accepted", documentId: "doc",
    approvedOptions: [{ id: "required", checked: true }], markdown: "💊".repeat(200_000) },
    sourcePlanApproval: { sourceIssueId: "source", interactionId: "approval", revisionId: "source-revision", markdown: "approved" } };
  expect(fitNativeTaskContext(source)).toMatchObject({ acceptedPlan: { revisionId: "accepted", approvedOptions: source.acceptedPlan.approvedOptions },
    sourcePlanApproval: { sourceIssueId: "source", interactionId: "approval", revisionId: "source-revision" } });
  let page = nativeTaskContextPage(source, {});
  let text = "";
  while ("jsonText" in page) {
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(500_000);
    expect(page.jsonText).not.toMatch(/[\uD800-\uDBFF]$/);
    text += page.jsonText;
    if (page.nextOffset === null) break;
    page = nativeTaskContextPage(source, { offset: page.nextOffset, contextDigest: page.contextDigest });
  }
  expect(JSON.parse(text)).toEqual(source);
  const first = nativeTaskContextPage(source, {});
  expect(nativeTaskContextPage({ ...source, activeTask: { id: "changed" } }, { offset: 32_000, contextDigest: "contextDigest" in first ? first.contextDigest : "" }))
    .toMatchObject({ code: "paperclip_runner_context_changed" });
  expect(nativeTaskContextPage(source, { offset: 10 })).toMatchObject({ code: "paperclip_runner_context_page_invalid" });
});
