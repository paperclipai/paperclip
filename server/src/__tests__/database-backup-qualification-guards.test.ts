import { describe, expect, it } from "vitest";
import { resolveBackupQualificationPair } from "../../scripts/lib/backup-qualification.js";

describe("backup qualification URL guard", () => {
  const source = "postgres://user:synthetic@localhost/source_test";
  const target = "postgres://user:synthetic@localhost/restore_test";
  it("accepts a complete distinct pair and leaves CI fallback explicit", () => {
    expect(resolveBackupQualificationPair("", "")).toBeUndefined();
    expect(resolveBackupQualificationPair(source, target)).toEqual({ sourceUrl: source, restoreUrl: target });
  });
  it.each([[source, ""], ["", target], [source, source], [source, source.replace("user:synthetic", "other:secret")],
    [source, source.replace("localhost", "LOCALHOST:5432")], [source, target.replace("restore_test", "production")],
    [source, `${target}?options=-csearch_path=public`]])("rejects unsafe configuration before opening clients", (a, b) => {
    expect(() => resolveBackupQualificationPair(a, b)).toThrow();
    try { resolveBackupQualificationPair(a, b); } catch (error) { expect(String(error)).not.toContain("synthetic"); }
  });
});
