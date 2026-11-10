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
