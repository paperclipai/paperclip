import { describe, expect, it } from "vitest";
import {
  READINESS_RECORDS_DOCUMENT_KEY,
  readinessRecordsDocumentSchema,
  formatReadinessRecordsDocumentBody,
  parseReadinessRecordsDocumentBody,
} from "../index.js";

describe("readiness records validators", () => {
  const validDocument = {
    version: 1,
    records: [
      {
        id: "fixer-canary-1",
        agentName: "fixer",
        status: "passed",
        timestamp: "2026-05-06T00:00:00.000Z",
        expiresAt: "2026-05-07T00:00:00.000Z",
        issueId: "11111111-1111-4111-8111-111111111111",
        runId: "22222222-2222-4222-8222-222222222222",
        checks: [
          {
            type: "issue_scoped_wake",
            status: "passed",
            message: "PAPERCLIP_TASK_ID and PAPERCLIP_WAKE_PAYLOAD_JSON were present.",
          },
          {
            type: "workspace_preflight",
            status: "passed",
            message: "Resolved per-issue git worktree.",
          },
        ],
      },
    ],
  } as const;

  it("parses strict readiness record documents", () => {
    const parsed = readinessRecordsDocumentSchema.parse(validDocument);

    expect(READINESS_RECORDS_DOCUMENT_KEY).toBe("readiness_records");
    expect(parsed.records[0]?.checks.map((check) => check.type)).toEqual([
      "issue_scoped_wake",
      "workspace_preflight",
    ]);
  });

  it("rejects duplicate record ids and records without checks", () => {
    const duplicateIds = readinessRecordsDocumentSchema.safeParse({
      version: 1,
      records: [
        { id: "same", status: "passed", timestamp: "2026-05-06T00:00:00.000Z", checks: [{ type: "api", status: "passed" }] },
        { id: "same", status: "passed", timestamp: "2026-05-06T00:01:00.000Z", checks: [{ type: "api", status: "passed" }] },
      ],
    });
    const noChecks = readinessRecordsDocumentSchema.safeParse({
      version: 1,
      records: [
        { id: "agent-1", status: "passed", timestamp: "2026-05-06T00:00:00.000Z", checks: [] },
      ],
    });

    expect(duplicateIds.success).toBe(false);
    expect(noChecks.success).toBe(false);
  });

  it("formats and parses readiness records deterministically", () => {
    const body = formatReadinessRecordsDocumentBody(validDocument);
    const parsed = parseReadinessRecordsDocumentBody(body);

    expect(body).toContain("\"version\": 1");
    expect(body.endsWith("\n")).toBe(true);
    expect(parsed).toEqual(readinessRecordsDocumentSchema.parse(validDocument));
  });
});
