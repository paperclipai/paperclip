import { expect, it } from "vitest";
import { fitNativeTaskContext, nativeChildTaskContext } from "./native-task-context.js";

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
    readWith: [{ tool: "get_task", arguments: { taskId: "task" } }, { tool: "get_task_history" }, { tool: "search_tasks" }] });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(500_000);
  expect(JSON.stringify(result)).not.toContain("private-source-content");
  expect(source.activeTask.description).toHaveLength(880_000);
});
