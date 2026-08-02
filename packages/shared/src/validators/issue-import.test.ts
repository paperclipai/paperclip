import { describe, expect, it } from "vitest";
import { applyLinearIssueImportSchema, previewLinearIssueImportSchema } from "./issue-import.js";

function validManifest() {
  return {
    provider: "linear",
    manifestVersion: 1,
    sourceSnapshot: { retrievedAt: "2026-07-31T19:00:00.000Z", version: "snapshot-1" },
    options: { stageUnassigned: true, suppressWakes: true, conflictPolicy: "record" },
    projectMappings: {},
    items: [{
      sourceId: "4cb17a88-0e12-4cdb-86fb-b15b40f34ad8",
      sourceIdentifier: "EXT-384",
      sourceVersion: "2026-07-31T18:00:00.000Z",
      sourceUpdatedAt: "2026-07-31T18:00:00.000Z",
      sourceUrl: "https://linear.app/example/issue/EXT-384/example",
      title: "Disable dynamic plugin registration",
      sourceStatus: "Backlog",
      priority: "critical",
      blockedBySourceIds: [],
      comments: [],
    }],
  };
}

describe("Linear issue import validators", () => {
  it("accepts only the staged, wake-suppressed Linear contract", () => {
    expect(previewLinearIssueImportSchema.safeParse(validManifest()).success).toBe(true);
    expect(previewLinearIssueImportSchema.safeParse({ ...validManifest(), provider: "github" }).success).toBe(false);
    expect(previewLinearIssueImportSchema.safeParse({
      ...validManifest(),
      options: { stageUnassigned: true, suppressWakes: false, conflictPolicy: "record" },
    }).success).toBe(false);
  });

  it("rejects duplicate sources, credential-like extra fields, and non-Linear links", () => {
    const manifest = validManifest();
    expect(previewLinearIssueImportSchema.safeParse({ ...manifest, items: [...manifest.items, manifest.items[0]] }).success)
      .toBe(false);
    expect(previewLinearIssueImportSchema.safeParse({ ...manifest, linearToken: "secret" }).success).toBe(false);
    expect(previewLinearIssueImportSchema.safeParse({
      ...manifest,
      items: [{ ...manifest.items[0], sourceUrl: "https://example.com/issue/EXT-384" }],
    }).success).toBe(false);
  });

  it("keeps activation outside this boundary", () => {
    const base = {
      previewRunId: "4cb17a88-0e12-4cdb-86fb-b15b40f34ad8",
      previewDigest: "a".repeat(64),
      activate: false,
    };
    expect(applyLinearIssueImportSchema.safeParse(base).success).toBe(true);
    expect(applyLinearIssueImportSchema.safeParse({ ...base, activate: true }).success).toBe(false);
  });
});
