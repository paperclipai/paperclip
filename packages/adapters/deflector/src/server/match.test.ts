import { describe, expect, it } from "vitest";
import { matchIssue, SEED_PATTERNS } from "./match.js";
import { openKb, seedKbIfEmpty, loadPatterns, upsertPatterns } from "./kb.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseDeflectorStdout } from "./parse.js";

describe("matchIssue", () => {
  it("matches stranded recovery when origin is already done", () => {
    const result = matchIssue(SEED_PATTERNS, {
      issue: {
        id: "rec-1",
        identifier: "AIP-1",
        title: "Recover stalled issue AIP-999",
        description: null,
        originKind: "stranded_issue_recovery",
        originId: "src-1",
        companyId: "co-1",
        status: "todo",
      },
      originStatus: "done",
    });
    expect(result.matched).toBe(true);
    expect(result.pattern?.id).toBe("stranded_issue_recovery_source_terminal");
  });

  it("does not match when origin is still open", () => {
    const result = matchIssue(SEED_PATTERNS, {
      issue: {
        id: "rec-2",
        identifier: "AIP-2",
        title: "Recover stalled issue AIP-888",
        description: null,
        originKind: "stranded_issue_recovery",
        originId: "src-2",
        companyId: "co-1",
        status: "todo",
      },
      originStatus: "blocked",
    });
    expect(result.matched).toBe(false);
  });

  it("does not match unrelated titles", () => {
    const result = matchIssue(SEED_PATTERNS, {
      issue: {
        id: "x",
        identifier: "AIP-3",
        title: "Fix CTR for fiverr vs upwork",
        description: null,
        originKind: "manual",
        originId: null,
        companyId: "co-1",
        status: "todo",
      },
      originStatus: null,
    });
    expect(result.matched).toBe(false);
  });

  it("matches recover missing next step when origin cancelled", () => {
    const result = matchIssue(SEED_PATTERNS, {
      issue: {
        id: "rec-3",
        identifier: "ONS-3",
        title: "Recover missing next step ONS-100",
        description: null,
        originKind: "stranded_issue_recovery",
        originId: "src-3",
        companyId: "co-2",
        status: "todo",
      },
      originStatus: "cancelled",
    });
    expect(result.matched).toBe(true);
  });
});

describe("kb sqlite", () => {
  it("seeds and loads patterns", () => {
    const dir = mkdtempSync(join(tmpdir(), "deflector-kb-"));
    const kbPath = join(dir, "kb.sqlite");
    try {
      const db = openKb(kbPath);
      expect(seedKbIfEmpty(db)).toBeGreaterThan(0);
      expect(seedKbIfEmpty(db)).toBe(0);
      const patterns = loadPatterns(db);
      expect(patterns.some((p) => p.id === "stranded_issue_recovery_source_terminal")).toBe(true);
      upsertPatterns(db, [
        {
          ...SEED_PATTERNS[0]!,
          enabled: false,
        },
      ]);
      expect(loadPatterns(db).some((p) => p.id === "stranded_issue_recovery_source_terminal")).toBe(
        false,
      );
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseDeflectorStdout", () => {
  it("parses resolved line", () => {
    const parsed = parseDeflectorStdout("Deflector: resolved via stranded_issue_recovery_source_terminal\n");
    expect(parsed.matched).toBe(true);
    expect(parsed.patternId).toBe("stranded_issue_recovery_source_terminal");
  });
});
