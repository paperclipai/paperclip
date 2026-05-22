import { describe, expect, it } from "vitest";
import {
  BYPASS_REASON_DENYLIST_RE,
  extractCitedPaths,
  extractShas,
  isProcessOnlyDeclared,
  validate,
} from "../services/closureGate.js";

describe("extractShas", () => {
  it("returns the first sha as headSha for canonical git log -1 output", () => {
    const text = "f7226dc fix(UPG-808): allow ESLint to lint test files";
    const { headSha, subShas } = extractShas(text);
    expect(headSha).toBe("f7226dc");
    expect(subShas).toHaveLength(0);
  });

  it("returns headSha and subShas for multi-sha comment", () => {
    const text = [
      "f7226dc fix(UPG-808): allow ESLint",
      "git log master --oneline -- server/src/services/closureGate.ts",
      "3ba1a8e fix(UPG-807): organizer-transfer endpoint",
    ].join("\n");
    const { headSha, subShas } = extractShas(text);
    expect(headSha).toBe("f7226dc");
    expect(subShas).toHaveLength(1);
    expect(subShas[0].sha).toBe("3ba1a8e");
  });

  it("deduplicates repeated shas and keeps first occurrence", () => {
    const text = "abc1234 commit one\nabc1234 same sha again\ndef5678 another";
    const { headSha, subShas } = extractShas(text);
    expect(headSha).toBe("abc1234");
    expect(subShas).toHaveLength(1);
    expect(subShas[0].sha).toBe("def5678");
  });

  it("returns null headSha when no sha found", () => {
    const { headSha } = extractShas("no sha here at all");
    expect(headSha).toBeNull();
  });

  it("requires sha to be at start of line", () => {
    const text = "some prefix f7226dc not-at-start";
    const { headSha } = extractShas(text);
    expect(headSha).toBeNull();
  });
});

describe("extractCitedPaths", () => {
  it("extracts path after -- in git log command", () => {
    const text = "git log master --oneline -- server/src/services/closureGate.ts";
    expect(extractCitedPaths(text)).toEqual(["server/src/services/closureGate.ts"]);
  });

  it("extracts multiple paths from multiple git log lines", () => {
    const text = [
      "git log master --oneline -- server/src/routes/issues.ts",
      "git log master --oneline -- packages/shared/src/validators/issue.ts",
    ].join("\n");
    expect(extractCitedPaths(text)).toEqual([
      "server/src/routes/issues.ts",
      "packages/shared/src/validators/issue.ts",
    ]);
  });

  it("deduplicates identical paths", () => {
    const text = [
      "git log main --oneline -- foo/bar.ts",
      "git log main --oneline -- foo/bar.ts",
    ].join("\n");
    expect(extractCitedPaths(text)).toEqual(["foo/bar.ts"]);
  });

  it("returns empty array when no paths found", () => {
    expect(extractCitedPaths("f7226dc commit without any paths")).toEqual([]);
  });
});

describe("isProcessOnlyDeclared", () => {
  it("matches 'cites no in-repo artifact' (hyphen)", () => {
    expect(isProcessOnlyDeclared("This ticket cites no in-repo artifact")).toBe(true);
  });

  it("matches 'cites no in repo artifact' (space)", () => {
    expect(isProcessOnlyDeclared("cites no in repo artifact")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isProcessOnlyDeclared("Cites No In-Repo Artifact")).toBe(true);
  });

  it("does not match partial string", () => {
    expect(isProcessOnlyDeclared("cites no artifact")).toBe(false);
  });
});

describe("validate", () => {
  const REPO_PATH = "/tmp/fake-repo";

  function makeRunGit(responses: Record<string, { stdout: string; exit?: number }>) {
    return async (args: string[], _cwd: string) => {
      const key = args.join(" ");
      const response = responses[key];
      if (!response) {
        throw new Error(`Unexpected git call: git ${args.join(" ")}`);
      }
      if (response.exit && response.exit !== 0) {
        throw Object.assign(new Error("git error"), { code: response.exit });
      }
      return { stdout: response.stdout, stderr: "" };
    };
  }

  it("rejects with NO_TEXT when text is empty", async () => {
    const result = await validate(
      { text: "", isProcessOnly: false, defaultBranch: "master" },
      REPO_PATH,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejections[0].code).toBe("NO_TEXT");
    }
  });

  it("rejects with NO_TEXT when text is whitespace only", async () => {
    const result = await validate(
      { text: "   \n   ", isProcessOnly: false, defaultBranch: "master" },
      REPO_PATH,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejections[0].code).toBe("NO_TEXT");
  });

  it("rejects with NO_HEAD_SHA when no sha found in text", async () => {
    const result = await validate(
      {
        text: "This is a closing comment with no SHA reference.",
        isProcessOnly: true,
        defaultBranch: "master",
      },
      REPO_PATH,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.rejections.map((r) => r.code);
      expect(codes).toContain("NO_HEAD_SHA");
    }
  });

  it("rejects with INVALID_HEAD_SHA when cat-file returns non-commit type", async () => {
    const runGit = makeRunGit({
      "cat-file -t deadbeef": { stdout: "blob\n" },
    });
    const result = await validate(
      { text: "deadbeef some commit message", isProcessOnly: true, defaultBranch: "master" },
      REPO_PATH,
      { runGit },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejections[0].code).toBe("INVALID_HEAD_SHA");
  });

  it("rejects with INVALID_HEAD_SHA when cat-file throws (sha not found)", async () => {
    const runGit = makeRunGit({
      "cat-file -t cafebabe": { stdout: "", exit: 128 },
    });
    const result = await validate(
      { text: "cafebabe fabricated sha", isProcessOnly: true, defaultBranch: "master" },
      REPO_PATH,
      { runGit },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejections[0].code).toBe("INVALID_HEAD_SHA");
  });

  it("rejects with PROCESS_ONLY_UNDECLARED for impl ticket with no cited paths", async () => {
    const runGit = makeRunGit({
      "cat-file -t f7226dc": { stdout: "commit\n" },
    });
    const result = await validate(
      {
        text: "f7226dc commit with no paths cited",
        isProcessOnly: false,
        defaultBranch: "master",
      },
      REPO_PATH,
      { runGit },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.rejections.map((r) => r.code);
      expect(codes).toContain("PROCESS_ONLY_UNDECLARED");
    }
  });

  it("accumulates multiple rejections (mixed-sha rejection list)", async () => {
    const runGit = makeRunGit({
      "cat-file -t abc1234": { stdout: "commit\n" },
      "log master --oneline -- missing/path.ts": { stdout: "" },
      "log master --oneline -- also/missing.ts": { stdout: "" },
    });
    const text = [
      "abc1234 real commit",
      "git log master --oneline -- missing/path.ts",
      "git log master --oneline -- also/missing.ts",
    ].join("\n");
    const result = await validate(
      { text, isProcessOnly: false, defaultBranch: "master" },
      REPO_PATH,
      { runGit },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejections.length).toBeGreaterThanOrEqual(2);
      const codes = result.rejections.map((r) => r.code);
      expect(codes.filter((c) => c === "PATH_PROOF_MISMATCH")).toHaveLength(2);
    }
  });

  it("accepts process-only ticket with only HEAD sha and no cited paths", async () => {
    const runGit = makeRunGit({
      "cat-file -t f7226dc": { stdout: "commit\n" },
    });
    const result = await validate(
      {
        text: "f7226dc commit message here",
        isProcessOnly: true,
        defaultBranch: "master",
      },
      REPO_PATH,
      { runGit },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verifiedHeadSha).toBe("f7226dc");
  });

  it("accepts process-only when text says 'cites no in-repo artifact'", async () => {
    const runGit = makeRunGit({
      "cat-file -t f7226dc": { stdout: "commit\n" },
    });
    const result = await validate(
      {
        text: "f7226dc commit\n\nThis ticket cites no in-repo artifact.",
        isProcessOnly: false,
        defaultBranch: "master",
      },
      REPO_PATH,
      { runGit },
    );
    expect(result.ok).toBe(true);
  });

  it("accepts implementation ticket with valid sha and path proofs", async () => {
    const runGit = makeRunGit({
      "cat-file -t f7226dc": { stdout: "commit\n" },
      "log master --oneline -- server/src/services/closureGate.ts": {
        stdout: "f7226dc feat: add closure gate\n",
      },
    });
    const text = [
      "f7226dc feat: add closure gate",
      "git log master --oneline -- server/src/services/closureGate.ts",
      "f7226dc feat: add closure gate",
    ].join("\n");
    const result = await validate(
      { text, isProcessOnly: false, defaultBranch: "master" },
      REPO_PATH,
      { runGit },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verifiedHeadSha).toBe("f7226dc");
      expect(result.citedPathsVerified).toContain("server/src/services/closureGate.ts");
    }
  });

  it("rejects PATH_PROOF_MISMATCH when path has no commits on branch", async () => {
    const runGit = makeRunGit({
      "cat-file -t f7226dc": { stdout: "commit\n" },
      "log master --oneline -- src/unmerged.ts": { stdout: "" },
    });
    const text = [
      "f7226dc some commit",
      "git log master --oneline -- src/unmerged.ts",
    ].join("\n");
    const result = await validate(
      { text, isProcessOnly: false, defaultBranch: "master" },
      REPO_PATH,
      { runGit },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejections[0].code).toBe("PATH_PROOF_MISMATCH");
  });
});

describe("BYPASS_REASON_DENYLIST_RE", () => {
  it("matches D1 (PR not merged) patterns", () => {
    expect(BYPASS_REASON_DENYLIST_RE.test("PR not yet merged")).toBe(true);
    expect(BYPASS_REASON_DENYLIST_RE.test("PR is pending review")).toBe(true);
  });

  it("matches D2 (locally-merged) patterns", () => {
    expect(BYPASS_REASON_DENYLIST_RE.test("local merge to main")).toBe(true);
    expect(BYPASS_REASON_DENYLIST_RE.test("Merged to local master, GitHub push blocked")).toBe(true);
  });

  it("does NOT match 'localization of main module' (false positive fixed by \\blocal\\b)", () => {
    expect(BYPASS_REASON_DENYLIST_RE.test("localization of main module")).toBe(false);
  });

  it("matches D3 (no upstream access) patterns", () => {
    expect(BYPASS_REASON_DENYLIST_RE.test("merged locally")).toBe(true);
    expect(BYPASS_REASON_DENYLIST_RE.test("no upstream maintainer access to merge")).toBe(true);
  });

  it("does NOT match unrelated reasons", () => {
    expect(BYPASS_REASON_DENYLIST_RE.test("CEO approved override")).toBe(false);
    expect(BYPASS_REASON_DENYLIST_RE.test("emergency hotfix for prod outage")).toBe(false);
  });
});
