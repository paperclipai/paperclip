import { describe, expect, it, vi } from "vitest";

type ScanFile = { path: string; content: string; encoding?: "utf8" | "base64"; executable?: boolean };
type Scan = { commitSha: string; packageMode?: "skills" | "repository"; repositorySubset?: boolean; repositoryFiles?: ScanFile[];
  repositoryPackage?: { warnings: string[] }; warnings?: string[]; skills: Array<{ path: string; files: ScanFile[]; warnings?: string[] }> };
const scans = vi.hoisted(() => new Map<string, Scan>());
const scanSignals = vi.hoisted(() => [] as Array<AbortSignal | undefined>);
vi.mock("../services/github-skill-source.js", () => ({
  scanGitHubSkillsWithPackageFallback: vi.fn(async (input: { commitSha: string }, _read: unknown, options: { signal?: AbortSignal } = {}) => {
    scanSignals.push(options.signal);
    return { warnings: [], ...scans.get(input.commitSha) };
  }),
}));
import { diffGitHubSkillUpdate, diffSkillPackageFiles, MAX_UPDATE_DIFF_CHARS, MAX_UPDATE_DIFF_FILES, unifiedLineDiff } from "../services/skill-update-diff.js";

const installed = ["---", "version: \"0.4\"", "---", "", "Run checks so every build or release runs them.", "", "## Notes", "Keep it short."].join("\n");
const latest = ["---", "version: \"0.5\"", "---", "", "Run checks so every new build runs them.", "", "## Design", "Breathable layouts.", "", "## Notes", "Keep it short."].join("\n");

describe("skill update diff", () => {
  it("marks installed-only lines with - and latest-only lines with +", () => {
    const diff = unifiedLineDiff(installed, latest)!;
    const lines = diff.split("\n");
    expect(lines).toContain("-version: \"0.4\"");
    expect(lines).toContain("+version: \"0.5\"");
    expect(lines).toContain("-Run checks so every build or release runs them.");
    expect(lines).toContain("+Run checks so every new build runs them.");
    expect(lines).toContain("+## Design");
    expect(lines).toContain("+Breathable layouts.");
    expect(lines).not.toContain("-## Notes");
    expect(lines.filter(line => line.startsWith("@@"))).toEqual(["@@ -1,8 +1,11 @@"]);
    expect(unifiedLineDiff(installed, installed)).toBe("");
  });

  it("keeps distant changes in separate hunks with bounded context", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const after = [...before]; after[1] = "changed 2"; after[27] = "changed 28";
    const diff = unifiedLineDiff(before.join("\n"), after.join("\n"))!;
    expect(diff.split("\n").filter(line => line.startsWith("@@"))).toEqual(["@@ -1,5 +1,5 @@", "@@ -25,6 +25,6 @@"]);
    expect(diff).not.toContain(" line 15");
  });

  it("lists added, removed, modified and binary files and skips unchanged ones", () => {
    const { files, truncated } = diffSkillPackageFiles(
      [{ path: "SKILL.md", content: installed }, { path: "old.md", content: "gone\n" }, { path: "same.md", content: "same" }, { path: "logo.png", content: "AAA=", encoding: "base64" }],
      [{ path: "SKILL.md", content: latest }, { path: "new.md", content: "fresh\n" }, { path: "same.md", content: "same" }, { path: "logo.png", content: "AAE=", encoding: "base64" }],
    );
    expect(truncated).toBe(false);
    expect(files.map(file => [file.path, file.change, file.binary, file.diffUnavailable])).toEqual([
      ["SKILL.md", "modified", false, null], ["logo.png", "modified", true, "binary"], ["new.md", "added", false, null], ["old.md", "removed", false, null],
    ]);
    // An absent side has no lines, so an added or removed file shows only its own lines.
    expect(files.find(file => file.path === "new.md")!.diff).toBe("@@ -0,0 +1,1 @@\n+fresh");
    expect(files.find(file => file.path === "old.md")!.diff).toBe("@@ -1,1 +0,0 @@\n-gone");
    expect(files.find(file => file.path === "logo.png")!.diff).toBeNull();
  });

  it("does not count a final newline as a line and shows when only the final newline changes", () => {
    expect(unifiedLineDiff("a\nb\n", "a\nc\n")).toBe("@@ -1,2 +1,2 @@\n a\n-b\n+c");
    expect(unifiedLineDiff("a\n", "a")).toBe("@@ -1,1 +1,1 @@\n-a\n+a\n\\ No newline at end of file");
  });

  it("reports a change to only the executable bit", () => {
    const { files } = diffSkillPackageFiles([{ path: "run.sh", content: "echo hi\n" }], [{ path: "run.sh", content: "echo hi\n", executable: true }]);
    expect(files).toEqual([{ path: "run.sh", change: "modified", binary: false, executableChanged: true, diff: "", diffUnavailable: null }]);
  });

  it("does not call a file the scan left out of one revision added or removed", () => {
    const { files } = diffSkillPackageFiles([{ path: "SKILL.md", content: "a" }], [{ path: "SKILL.md", content: "a" }, { path: "assets/logo.svg", content: "<svg/>" }],
      { installed: new Set(["assets/logo.svg"]), latest: new Set() });
    expect(files).toEqual([{ path: "assets/logo.svg", change: "not_compared", binary: false, executableChanged: false, diff: null, diffUnavailable: "omitted" }]);
  });

  it("bounds the diff text and the file count of one response", () => {
    const big = Array.from({ length: 400 }, (_, i) => ({ path: `f${String(i).padStart(3, "0")}.md`, content: `${"x".repeat(5_000)}\n` }));
    const { files, truncated } = diffSkillPackageFiles(big.map(file => ({ ...file, content: "" })), big);
    expect(truncated).toBe(true);
    expect(files.reduce((sum, file) => sum + (file.diff?.length ?? 0), 0)).toBeLessThanOrEqual(MAX_UPDATE_DIFF_CHARS);
    expect(files.at(-1)!.diffUnavailable).toBe("budget");
    const many = Array.from({ length: MAX_UPDATE_DIFF_FILES + 5 }, (_, i) => ({ path: `m${i}.md`, content: "x" }));
    const listed = diffSkillPackageFiles([], many);
    expect([listed.files.length, listed.truncated]).toEqual([MAX_UPDATE_DIFF_FILES, true]);
  });

  it("compares the installed commit snapshot with the latest one for the selected skill", async () => {
    scans.set("a".repeat(40), { commitSha: "a".repeat(40), skills: [{ path: "accessibility/SKILL.md", files: [{ path: "SKILL.md", content: installed }] }] });
    scans.set("b".repeat(40), { commitSha: "b".repeat(40), skills: [{ path: "accessibility/SKILL.md", files: [{ path: "SKILL.md", content: latest }] }] });
    const controller = new AbortController();
    scanSignals.length = 0;
    const result = await diffGitHubSkillUpdate({ repositoryUrl: "https://github.com/example/skills", skillPath: "accessibility/SKILL.md", installedCommitSha: "a".repeat(40), latestCommitSha: "b".repeat(40) }, {} as never, controller.signal);
    if (!result.supported) throw new Error(result.reason);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.diff).toContain("-Run checks so every build or release runs them.");
    expect(scanSignals).toEqual([controller.signal, controller.signal]);
    scans.set("c".repeat(40), { commitSha: "d".repeat(40), skills: [] });
    await expect(diffGitHubSkillUpdate({ repositoryUrl: "https://github.com/example/skills", skillPath: "accessibility/SKILL.md", installedCommitSha: "a".repeat(40), latestCommitSha: "c".repeat(40) }, {} as never)).rejects.toThrow("did not match");
  });

  it("marks files the scan left out of a skill folder as not compared", async () => {
    scans.set("e".repeat(40), { commitSha: "e".repeat(40), skills: [{ path: "design/SKILL.md", files: [{ path: "SKILL.md", content: "a" }],
      warnings: ["design/assets/hero.png — Exceeds the 1 MB file limit; not included."] }] });
    scans.set("f".repeat(40), { commitSha: "f".repeat(40), skills: [{ path: "design/SKILL.md", files: [{ path: "SKILL.md", content: "a" }, { path: "assets/hero.png", content: "AAA=", encoding: "base64" }] }] });
    const result = await diffGitHubSkillUpdate({ repositoryUrl: "https://github.com/example/skills", skillPath: "design/SKILL.md", installedCommitSha: "e".repeat(40), latestCommitSha: "f".repeat(40) }, {} as never);
    expect(result).toEqual({ supported: true, truncated: false, files: [{ path: "assets/hero.png", change: "not_compared", binary: false, executableChanged: false, diff: null, diffUnavailable: "omitted" }] });
  });

  it("refuses to compare a repository package that a scan could only include in part", async () => {
    const full = { commitSha: "1".repeat(40), packageMode: "repository" as const, repositoryFiles: [{ path: "README.md", content: "a" }], skills: [] };
    const input = { repositoryUrl: "https://github.com/example/skills", packageMode: "repository" as const, skillPath: "x/SKILL.md", installedCommitSha: "1".repeat(40), latestCommitSha: "2".repeat(40) };
    scans.set("1".repeat(40), full);
    for (const partial of [
      { commitSha: "2".repeat(40), packageMode: "repository" as const, repositorySubset: true, repositoryFiles: [], skills: [] },
      { commitSha: "2".repeat(40), packageMode: "skills" as const, skills: [] },
    ]) {
      scans.set("2".repeat(40), partial);
      const result = await diffGitHubSkillUpdate(input, {} as never);
      expect(result.supported).toBe(false);
    }
    scans.set("2".repeat(40), { ...full, commitSha: "2".repeat(40), repositoryFiles: [{ path: "README.md", content: "b" }] });
    const result = await diffGitHubSkillUpdate(input, {} as never);
    expect(result.supported && result.files.map(file => file.path)).toEqual(["README.md"]);
  });
});
