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

  it("emits a blocker when issue label references would break import", () => {
    const warnings = buildExportFidelityWarnings({ ...zeroCounts, labelDefinitions: 2, issueLabelReferences: 3 });
    expect(warnings).toEqual([
      {
        code: "labels_require_mapping",
        severity: "blocker",
        message:
          "Importing this export will fail because 3 issue label references refer to label " +
          "definitions that are not included in the export bundle.",
      },
    ]);
  });

  it("uses singular wording for a single label reference", () => {
    const warnings = buildExportFidelityWarnings({ ...zeroCounts, issueLabelReferences: 1 });
    expect(warnings[0]?.message).toContain("1 issue label reference refers");
  });

  it("warns about unreferenced label definitions without blocking", () => {
    const warnings = buildExportFidelityWarnings({ ...zeroCounts, labelDefinitions: 1 });
    expect(warnings).toEqual([
      {
        code: "label_definitions_not_exported",
        severity: "warning",
        message: "1 label definition is not included in the export bundle.",
      },
    ]);
  });

  it("emits one warning per unsupported data category with counts", () => {
    const warnings = buildExportFidelityWarnings({
      ...zeroCounts,
      issueBlockerRelations: 2,
      issueDocuments: 1,
      issueWorkProducts: 3,
      issueAttachments: 4,
      approvals: 5,
      costEvents: 6,
      activityLogEntries: 7,
      issueMonitors: 8,
    });
    expect(warnings.map((warning) => warning.code)).toEqual([
      "issue_blockers_not_exported",
      "issue_documents_not_exported",
      "work_products_not_exported",
      "attachments_not_exported",
      "approvals_not_exported",
      "cost_history_not_exported",
      "activity_history_not_exported",
      "monitors_not_exported",
    ]);
    expect(warnings.every((warning) => warning.severity === "warning")).toBe(true);
    expect(warnings[0]?.message).toBe("2 issue blocker relations are not included in the export bundle.");
    expect(warnings[1]?.message).toBe("1 issue document is not included in the export bundle.");
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
