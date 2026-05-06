import { describe, expect, it } from "vitest";
import {
  appendEvidenceRecordDocument,
  buildEvidenceRecordFromOptions,
  collectRepeatableOption,
} from "../commands/client/issue-evidence.js";

describe("issue evidence helpers", () => {
  it("builds a structured evidence record from CLI options", () => {
    const record = buildEvidenceRecordFromOptions({
      id: "prod-smoke-1",
      gateId: "production-smoke",
      gateType: "production_smoke",
      status: "passed",
      timestamp: "2026-05-06T00:00:00.000Z",
      command: ["node scripts/smoke.mjs https://app.example.com/trips"],
      url: ["Production /trips=https://app.example.com/trips"],
      screenshot: ["desktop=.paperclip/artifacts/prod-trips.png"],
      artifact: ["log=.paperclip/artifacts/prod-trips.json"],
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      notes: "Production false-empty route passed.",
    });

    expect(record.gateType).toBe("production_smoke");
    expect(record.commands[0]).toEqual(expect.objectContaining({
      command: "node scripts/smoke.mjs https://app.example.com/trips",
      status: "passed",
    }));
    expect(record.urls[0]).toEqual({
      label: "Production /trips",
      url: "https://app.example.com/trips",
    });
  });

  it("appends evidence records to an existing document", () => {
    const record = buildEvidenceRecordFromOptions({
      id: "release-1",
      gateId: "release",
      gateType: "release",
      status: "passed",
      timestamp: "2026-05-06T00:00:00.000Z",
      url: ["Deploy run=https://github.com/paperclipai/paperclip/actions/runs/1"],
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    });
    const document = appendEvidenceRecordDocument(null, record);

    expect(document.key).toBe("evidence_records");
    expect(JSON.parse(document.body).records).toHaveLength(1);
    expect(() => appendEvidenceRecordDocument(document.body, record)).toThrow(/already exists/);
  });

  it("collects repeatable options", () => {
    expect(collectRepeatableOption("a", ["b"])).toEqual(["b", "a"]);
  });
});
