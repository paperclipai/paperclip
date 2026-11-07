import { expect, it } from "vitest";
import { readSavedTaskTimeline } from "./internal-work-timeline.js";

const taskId = "77ca2c1f-1aab-4acc-aca2-80d8057a1900";
const toolRow = (name: string, output: string, status = "completed", eventType = "tool.execution.completed", sourceKind = "runner") => ({
  eventType, payload: { prpEvent: { sourceKind, eventType, payload: { name, status, output } } },
});
const activity = (id: string) => JSON.stringify({ result: { apiOperationId: "GET /api/issues/{id}/activity", data: [{ entityId: id, action: "issue.updated" }] } });

it("accepts a completed product read of the launch task's saved activity, comments or history", () => {
  expect(readSavedTaskTimeline([toolRow("paperclip_call_api", activity(taskId))], taskId)).toBe(true);
  expect(readSavedTaskTimeline([toolRow("paperclip_call_api", JSON.stringify({ result: { apiOperationId: "GET /api/issues/{id}/comments", data: [{ issueId: taskId }] } }))], taskId)).toBe(true);
  expect(readSavedTaskTimeline([toolRow("paperclip_get_task_history", JSON.stringify({ taskId, entries: [] }))], taskId)).toBe(true);
});

it("rejects an answer that never read this task's saved events", () => {
  expect(readSavedTaskTimeline([], taskId)).toBe(false);
  // Another task's activity, a failed read, an unfinished read, or a non-runner frame are not grounding.
  expect(readSavedTaskTimeline([toolRow("paperclip_call_api", activity("other-task"))], taskId)).toBe(false);
  expect(readSavedTaskTimeline([toolRow("paperclip_call_api", activity(taskId), "failed")], taskId)).toBe(false);
  expect(readSavedTaskTimeline([toolRow("paperclip_call_api", activity(taskId), "completed", "tool.execution.started")], taskId)).toBe(false);
  expect(readSavedTaskTimeline([toolRow("paperclip_call_api", activity(taskId), "completed", "tool.execution.completed", "provider")], taskId)).toBe(false);
  // Reading only the task record is not reading its saved timeline.
  expect(readSavedTaskTimeline([toolRow("paperclip_get_task", JSON.stringify({ result: { apiOperationId: "GET /api/issues/{id}", data: { id: taskId } } }))], taskId)).toBe(false);
});
