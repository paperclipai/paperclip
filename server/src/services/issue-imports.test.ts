import { describe, expect, it } from "vitest";
import {
  canonicalizeIssueImportManifest,
  computeLinearIssueFingerprint,
  mapLinearIssueStatus,
  sanitizeImportFailure,
} from "./issue-imports.js";

describe("issue import provider boundary", () => {
  it("computes immutable Linear fingerprints from the provider and source UUID", () => {
    expect(computeLinearIssueFingerprint("4cb17a88-0e12-4cdb-86fb-b15b40f34ad8"))
      .toBe("adb12f5ce829e36b6929b4848fcab7b25695116de27a75f91ffc465f798597ab");
  });

  it("canonicalizes manifests independently of object key insertion order", () => {
    const left = { provider: "linear", projectMappings: { b: "2", a: "1" }, items: [{ sourceId: "x", title: "T" }] };
    const right = { items: [{ title: "T", sourceId: "x" }], projectMappings: { a: "1", b: "2" }, provider: "linear" };
    expect(canonicalizeIssueImportManifest(left)).toBe(canonicalizeIssueImportManifest(right));
  });

  it("stages active Linear states instead of fabricating execution", () => {
    expect(mapLinearIssueStatus("Backlog")).toEqual({ status: "backlog", conflict: null });
    expect(mapLinearIssueStatus("Todo")).toEqual({ status: "todo", conflict: null });
    expect(mapLinearIssueStatus("In Progress")).toEqual({
      status: "backlog",
      conflict: "source_status_requires_accountable_execution_path",
    });
    expect(mapLinearIssueStatus("In Review")).toEqual({
      status: "backlog",
      conflict: "source_status_requires_accountable_execution_path",
    });
  });

  it("persists bounded failures without credentials", () => {
    expect(sanitizeImportFailure(new Error("Linear token sk-secret failed Authorization: Bearer abc")))
      .toBe("Issue import failed");
  });
});
