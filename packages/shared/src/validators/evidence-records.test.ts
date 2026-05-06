import { describe, expect, it } from "vitest";
import {
  EVIDENCE_RECORDS_DOCUMENT_KEY,
  evidenceRecordsDocumentSchema,
  formatEvidenceRecordsDocumentBody,
  parseEvidenceRecordsDocumentBody,
} from "../index.js";

describe("evidence records validators", () => {
  const validDocument = {
    version: 1,
    records: [
      {
        id: "impl-1",
        gateId: "implementation",
        gateType: "implementation",
        status: "passed",
        timestamp: "2026-05-06T00:00:00.000Z",
        issueId: "11111111-1111-4111-8111-111111111111",
        agentName: "fixer",
        runId: "22222222-2222-4222-8222-222222222222",
        repo: "paperclipai/paperclip",
        branch: "paperclip/codex-auto-001-org-config",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        commands: [
          {
            command: "pnpm exec vitest run packages/shared/src/validators/mission.test.ts",
            cwd: "/tmp/paperclip-control-plane",
            exitCode: 0,
            status: "passed",
          },
        ],
        urls: [{ label: "PR", url: "https://github.com/paperclipai/paperclip/pull/1" }],
        screenshots: [],
        artifacts: [{ label: "snapshot", path: ".paperclip/agent-snapshot.json" }],
        notes: "Focused validator passed.",
      },
    ],
  } as const;

  it("parses strict evidence record documents", () => {
    const parsed = evidenceRecordsDocumentSchema.parse(validDocument);

    expect(EVIDENCE_RECORDS_DOCUMENT_KEY).toBe("evidence_records");
    expect(parsed.records[0]?.commands[0]?.exitCode).toBe(0);
  });

  it("rejects duplicate record ids and command records without status", () => {
    const duplicateIds = evidenceRecordsDocumentSchema.safeParse({
      version: 1,
      records: [
        { id: "same", gateId: "qa", gateType: "qa", status: "passed", timestamp: "2026-05-06T00:00:00.000Z" },
        { id: "same", gateId: "qa", gateType: "qa", status: "passed", timestamp: "2026-05-06T00:01:00.000Z" },
      ],
    });
    const badCommand = evidenceRecordsDocumentSchema.safeParse({
      version: 1,
      records: [
        {
          id: "qa-1",
          gateId: "qa",
          gateType: "qa",
          status: "passed",
          timestamp: "2026-05-06T00:00:00.000Z",
          commands: [{ command: "pnpm test" }],
        },
      ],
    });

    expect(duplicateIds.success).toBe(false);
    expect(badCommand.success).toBe(false);
  });

  it("formats and parses evidence record documents deterministically", () => {
    const body = formatEvidenceRecordsDocumentBody(validDocument);
    const parsed = parseEvidenceRecordsDocumentBody(body);

    expect(body).toMatch(/"version": 1/);
    expect(body.endsWith("\n")).toBe(true);
    expect(parsed).toEqual(evidenceRecordsDocumentSchema.parse(validDocument));
  });
});
