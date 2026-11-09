import { describe, expect, it, vi } from "vitest";

const scans = vi.hoisted(() => new Map<string, { commitSha: string; skills: Array<{ path: string; files: Array<{ path: string; content: string; encoding?: "utf8" | "base64" }> }> }>());
vi.mock("../services/github-skill-source.js", () => ({
  scanGitHubSkillsWithPackageFallback: vi.fn(async (input: { commitSha: string }) => scans.get(input.commitSha)),
}));
import { diffGitHubSkillUpdate, diffSkillPackageFiles, unifiedLineDiff } from "../services/skill-update-diff.js";

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
    const files = diffSkillPackageFiles(
      [{ path: "SKILL.md", content: installed }, { path: "old.md", content: "gone" }, { path: "same.md", content: "same" }, { path: "logo.png", content: "AAA=", encoding: "base64" }],
      [{ path: "SKILL.md", content: latest }, { path: "new.md", content: "fresh" }, { path: "same.md", content: "same" }, { path: "logo.png", content: "AAE=", encoding: "base64" }],
    );
    expect(files.map(file => [file.path, file.change, file.binary])).toEqual([
      ["SKILL.md", "modified", false], ["logo.png", "modified", true], ["new.md", "added", false], ["old.md", "removed", false],
    ]);
    expect(files.find(file => file.path === "new.md")!.diff).toContain("+fresh");
    expect(files.find(file => file.path === "old.md")!.diff).toContain("-gone");
    expect(files.find(file => file.path === "logo.png")!.diff).toBeNull();
  });

  it("compares the installed commit snapshot with the latest one for the selected skill", async () => {
    scans.set("a".repeat(40), { commitSha: "a".repeat(40), skills: [{ path: "accessibility/SKILL.md", files: [{ path: "SKILL.md", content: installed }] }] });
    scans.set("b".repeat(40), { commitSha: "b".repeat(40), skills: [{ path: "accessibility/SKILL.md", files: [{ path: "SKILL.md", content: latest }] }] });
    const files = await diffGitHubSkillUpdate({ repositoryUrl: "https://github.com/example/skills", skillPath: "accessibility/SKILL.md", installedCommitSha: "a".repeat(40), latestCommitSha: "b".repeat(40) }, {} as never);
    expect(files).toHaveLength(1);
    expect(files[0]!.diff).toContain("-Run checks so every build or release runs them.");
    scans.set("c".repeat(40), { commitSha: "d".repeat(40), skills: [] });
    await expect(diffGitHubSkillUpdate({ repositoryUrl: "https://github.com/example/skills", skillPath: "accessibility/SKILL.md", installedCommitSha: "a".repeat(40), latestCommitSha: "c".repeat(40) }, {} as never)).rejects.toThrow("did not match");
  });
});
