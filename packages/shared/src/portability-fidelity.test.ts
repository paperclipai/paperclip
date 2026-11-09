import { describe, expect, it } from "vitest";
import {
  buildExportFidelityWarnings,
  normalizeExportFidelityCounts,
  type ExportFidelityCounts,
} from "./portability-fidelity.js";

const zeroCounts: ExportFidelityCounts = {
  labelDefinitions: 0,
  issueLabelReferences: 0,
  issueBlockerRelations: 0,
  issueDocuments: 0,
  issueWorkProducts: 0,
  issueAttachments: 0,
  approvals: 0,
  costEvents: 0,
  activityLogEntries: 0,
  issueMonitors: 0,
};

describe("buildExportFidelityWarnings", () => {
  it("returns no warnings when the export carries everything", () => {
    expect(buildExportFidelityWarnings(zeroCounts)).toEqual([]);
  });

  it("emits no warnings for data the bundle now carries", () => {
    expect(buildExportFidelityWarnings({
      ...zeroCounts,
      labelDefinitions: 2,
      issueLabelReferences: 3,
      issueBlockerRelations: 2,
      issueDocuments: 1,
      issueWorkProducts: 3,
      issueAttachments: 4,
      issueMonitors: 8,
    })).toEqual([]);
  });

  it("emits one warning per unsupported data category with counts", () => {
    const warnings = buildExportFidelityWarnings({
      ...zeroCounts,
      approvals: 5,
      costEvents: 6,
      activityLogEntries: 7,
    });
    expect(warnings.map((warning) => warning.code)).toEqual([
      "approvals_not_exported",
      "cost_history_not_exported",
      "activity_history_not_exported",
    ]);
    expect(warnings.every((warning) => warning.severity === "warning")).toBe(true);
    expect(warnings[0]?.message).toBe("5 approvals are not included in the export bundle.");
    expect(warnings[1]?.message).toBe("6 cost events are not included in the export bundle.");
  });
});

describe("normalizeExportFidelityCounts", () => {
  it("round-trips a valid counts object", () => {
    const counts = { ...zeroCounts, issueAttachments: 12 };
    expect(normalizeExportFidelityCounts(counts)).toEqual(counts);
  });

  it("rejects non-objects, arrays, and missing keys", () => {
    expect(normalizeExportFidelityCounts(null)).toBeNull();
    expect(normalizeExportFidelityCounts([])).toBeNull();
    expect(normalizeExportFidelityCounts("counts")).toBeNull();
    const { issueMonitors: _dropped, ...partial } = zeroCounts;
    expect(normalizeExportFidelityCounts(partial)).toBeNull();
  });

  it("rejects negative and non-finite values", () => {
    expect(normalizeExportFidelityCounts({ ...zeroCounts, approvals: -1 })).toBeNull();
    expect(normalizeExportFidelityCounts({ ...zeroCounts, approvals: Number.NaN })).toBeNull();
    expect(normalizeExportFidelityCounts({ ...zeroCounts, approvals: Number.POSITIVE_INFINITY })).toBeNull();
  });
});
