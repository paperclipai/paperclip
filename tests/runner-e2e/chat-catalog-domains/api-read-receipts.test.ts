import { expect, it } from "vitest";
import { apiReadStatuses, apiReadDigests, readRecord, recordParams } from "./api-read-receipts.js";
import { savedCall } from "./api-read-receipts.test-fixtures.js";

const activity = (pathParams: Record<string, string>, query?: Record<string, unknown>) => ({ operationId: "GET /api/issues/{id}/activity", pathParams, ...(query ? { query } : {}) });
const reads = [{ operationId: "GET /api/issues/{id}/activity", pathParams: recordParams("id", "task-uuid", "COM-1"), paged: true }];

it("the redactor removes the response body and the task id, keeping only the input digest", () => {
  const saved = JSON.stringify(savedCall(activity({ id: "task-uuid" }), 200, "1", "run-1", [{ entityId: "task-uuid" }]));
  expect(saved).not.toContain("task-uuid");
  expect(saved).toContain("apiPayloadSha256");
});

it("binds a successful saved read to the record by id, identifier and paging query", () => {
  expect(readRecord(savedCall(activity({ id: "task-uuid" }), 200), reads)).toBe(true);
  expect(readRecord(savedCall(activity({ id: "COM-1" }), 200), reads)).toBe(true);
  expect(readRecord(savedCall(activity({ id: "COM-1" }, { limit: 50 }), 200), reads)).toBe(true);
  expect(readRecord(savedCall(activity({ id: "COM-1" }, { limit: "50" }), 200), reads)).toBe(true);
});

it("rejects other records, other operations, failures and unpaired results", () => {
  expect(readRecord(savedCall(activity({ id: "other-task" }), 200), reads)).toBe(false);
  expect(readRecord(savedCall({ operationId: "GET /api/issues/{id}", pathParams: { id: "task-uuid" } }, 200), reads)).toBe(false);
  expect(readRecord(savedCall(activity({ id: "task-uuid" }), 403), reads)).toBe(false);
  expect(readRecord(savedCall(activity({ id: "task-uuid" }), 200).slice(0, 1), reads)).toBe(false);
  expect(readRecord([...savedCall(activity({ id: "task-uuid" }), 200, "1", "run-a").slice(0, 1), ...savedCall(activity({ id: "other" }), 200, "1", "run-b").slice(1)], reads)).toBe(false);
});

it("reports the status of a bound read so a 404 can prove an unavailable record", () => {
  expect(apiReadStatuses(savedCall(activity({ id: "task-uuid" }), 404), apiReadDigests(reads))).toEqual([{ operationId: "GET /api/issues/{id}/activity", ok: false, status: 404 }]);
});

const getTask = (taskId: string, status: number, tool = "get_task", runId = "run-1") => savedCall({ taskId }, status, "2", runId, { id: taskId }, tool, "GET /api/issues/{id}");
const issueRead = [{ operationId: "GET /api/issues/{id}", pathParams: recordParams("id", "task-uuid", "COM-1") }];

it("the redactor keeps a dedicated get_task input in plaintext and its result as a receipt", () => {
  const [use, result] = getTask("task-uuid", 404);
  expect(JSON.stringify(use)).toContain("task-uuid");
  expect(JSON.stringify(result)).not.toContain("task-uuid");
  expect(JSON.stringify(result)).toContain("apiPayloadSha256");
});

it("binds dedicated task read tools to the record like the call_api input the server builds", () => {
  expect(apiReadStatuses(getTask("task-uuid", 404), apiReadDigests(issueRead))).toEqual([{ operationId: "GET /api/issues/{id}", ok: false, status: 404 }]);
  expect(readRecord(getTask("COM-1", 200), issueRead)).toBe(true);
  for (const tool of ["paperclip_get_task", "mcp__paperclip__get_task"]) expect(readRecord(getTask("task-uuid", 200, tool), issueRead)).toBe(true);
  const docs = [{ operationId: "GET /api/issues/{id}/documents/{key}", pathParams: [{ id: "task-uuid", key: "plan" }] }];
  expect(readRecord(savedCall({ taskId: "task-uuid", key: "plan" }, 200, "3", "run-1", {}, "read_task_document", "GET /api/issues/{id}/documents/{key}"), docs)).toBe(true);
});

it("rejects dedicated reads of other records, other tools, mismatched receipts and unpaired results", () => {
  expect(readRecord(getTask("other-task", 200), issueRead)).toBe(false);
  expect(readRecord(getTask("task-uuid", 200, "comment_on_task"), issueRead)).toBe(false);
  expect(readRecord(getTask("task-uuid", 200, "get_task_context"), issueRead)).toBe(false);
  expect(readRecord(savedCall({ taskId: "task-uuid" }, 200, "2", "run-1", {}, "get_task", "GET /api/issues/{id}/comments"), issueRead)).toBe(false);
  expect(readRecord(getTask("task-uuid", 200).slice(0, 1), issueRead)).toBe(false);
  expect(readRecord([...getTask("task-uuid", 200, "get_task", "run-a").slice(0, 1), ...getTask("task-uuid", 200, "get_task", "run-b").slice(1)], issueRead)).toBe(false);
});
// Full cohort 3 (cases.close-case): the chat read the closed case with the dedicated read_case tool,
// whose saved input is redacted to the digest of `{ caseId }`.
it("binds a dedicated read_case to the case by id, and rejects other cases and failures", () => {
  const id = "c80a5b89-41a8-4e97-b812-e4081d92d53b", other = "d80a5b89-41a8-4e97-b812-e4081d92d53b";
  const reads = [{ operationId: "GET /api/cases/{id}", pathParams: recordParams("id", id, "COM-C1") }];
  const read = (caseId: string, status = 200, tool = "read_case") => savedCall({ caseId }, status, "2", "run-1", { id: caseId }, tool, "GET /api/cases/{id}");
  expect(readRecord(read(id), reads)).toBe(true);
  // Paid run 43143392360: the result turn read the case record page, `{ caseId, section: "case" }`.
  const page = (input: Record<string, unknown>) => savedCall(input, 200, "2", "run-1", { id }, "read_case", "GET /api/cases/{id}");
  for (const input of [{ caseId: id, section: "case" }, { caseId: id, section: "case", offsetBytes: 0 }, { caseId: id, section: "case", limitBytes: 8192 }])
    expect(readRecord(page(input), reads), JSON.stringify(input)).toBe(true);
  // Pages that may omit the case's status and completion do not count.
  for (const input of [{ caseId: other, section: "case" }, { caseId: id, section: "document", documentKey: "review" },
    { caseId: id, section: "fields" }, { caseId: id, section: "case", limitBytes: 4 }])
    expect(readRecord(page(input), reads), JSON.stringify(input)).toBe(false);
  expect(readRecord(read(id, 200, "mcp__paperclip__read_case"), reads)).toBe(true);
  expect(readRecord(read(other), reads)).toBe(false);
  expect(readRecord(read(id, 404), reads)).toBe(false);
  expect(readRecord(read(id, 200, "update_case"), reads)).toBe(false);
});
