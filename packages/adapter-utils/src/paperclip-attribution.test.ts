import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyAttributionPreferenceToSkillMarkdown,
  materializePaperclipSkill,
  readPaperclipAttributionPreferenceFromEnv,
} from "./server-utils.js";

describe("readPaperclipAttributionPreferenceFromEnv", () => {
  it("defaults to commit and pr enabled when env vars are unset", () => {
    expect(readPaperclipAttributionPreferenceFromEnv({})).toEqual({ commit: true, pr: true });
  });

  it("disables commit when PAPERCLIP_ATTRIBUTION_COMMIT is false-like", () => {
    for (const raw of ["false", "FALSE", "0", "off", "no", "disabled"]) {
      expect(
        readPaperclipAttributionPreferenceFromEnv({ PAPERCLIP_ATTRIBUTION_COMMIT: raw }).commit,
      ).toBe(false);
    }
  });

  it("keeps commit enabled for true-like values", () => {
    for (const raw of ["true", "TRUE", "1", "on", "yes", "anything-else"]) {
      expect(
        readPaperclipAttributionPreferenceFromEnv({ PAPERCLIP_ATTRIBUTION_COMMIT: raw }).commit,
      ).toBe(true);
    }
  });

  it("disables pr independently of commit", () => {
    expect(
      readPaperclipAttributionPreferenceFromEnv({ PAPERCLIP_ATTRIBUTION_PR: "false" }),
    ).toEqual({ commit: true, pr: false });
  });
});

describe("applyAttributionPreferenceToSkillMarkdown", () => {
  const sourceWithTrailer = [
    "# Heading",
    "",
    "- Some unrelated bullet",
    "- **Commit Co-author**: if you make a git commit you MUST add EXACTLY `Co-Authored-By: Paperclip <noreply@paperclip.ing>` to the end of each commit message.",
    "- Another bullet",
    "",
  ].join("\n");

  it("returns the source unchanged when commit attribution is enabled", () => {
    const result = applyAttributionPreferenceToSkillMarkdown(sourceWithTrailer, {
      commit: true,
      pr: true,
    });
    expect(result).toBe(sourceWithTrailer);
  });

  it("strips the Co-Authored-By bullet when commit attribution is disabled", () => {
    const result = applyAttributionPreferenceToSkillMarkdown(sourceWithTrailer, {
      commit: false,
      pr: true,
    });
    expect(result).not.toContain("Co-Authored-By");
    expect(result).toContain("Some unrelated bullet");
    expect(result).toContain("Another bullet");
  });

  it("preserves source line endings", () => {
    const crlfSource = sourceWithTrailer.replaceAll("\n", "\r\n");
    const result = applyAttributionPreferenceToSkillMarkdown(crlfSource, {
      commit: false,
      pr: true,
    });
    expect(result).toContain("\r\n");
    expect(result).not.toContain("Co-Authored-By");
  });

  it("is a no-op when no trailer is present", () => {
    const noTrailer = "# Heading\n\n- Just a bullet\n";
    expect(
      applyAttributionPreferenceToSkillMarkdown(noTrailer, { commit: false, pr: true }),
    ).toBe(noTrailer);
  });
});

describe("materializePaperclipSkill", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "paperclip-attribution-"));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  async function makeSourceSkill(): Promise<string> {
    const source = path.join(workspace, "source");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(
      path.join(source, "SKILL.md"),
      [
        "---",
        "name: paperclip",
        "---",
        "",
        "- A bullet",
        "- **Commit Co-author**: add `Co-Authored-By: Paperclip <noreply@paperclip.ing>`.",
        "- Another bullet",
      ].join("\n"),
      "utf8",
    );
    await fs.mkdir(path.join(source, "references"), { recursive: true });
    await fs.writeFile(path.join(source, "references", "x.md"), "ref body", "utf8");
    return source;
  }

  it("symlinks the source directory when commit attribution is enabled", async () => {
    const source = await makeSourceSkill();
    const target = path.join(workspace, "target");

    const result = await materializePaperclipSkill(source, target, { commit: true, pr: true });

    expect(result).toBe("created");
    const stat = await fs.lstat(target);
    expect(stat.isSymbolicLink()).toBe(true);
    const linked = await fs.readlink(target);
    expect(path.resolve(path.dirname(target), linked)).toBe(source);
  });

  it("creates a directory with rewritten SKILL.md when commit attribution is disabled", async () => {
    const source = await makeSourceSkill();
    const target = path.join(workspace, "target");

    const result = await materializePaperclipSkill(source, target, { commit: false, pr: true });

    expect(result).toBe("created");
    const targetStat = await fs.lstat(target);
    expect(targetStat.isDirectory()).toBe(true);

    const skill = await fs.readFile(path.join(target, "SKILL.md"), "utf8");
    expect(skill).not.toContain("Co-Authored-By");
    expect(skill).toContain("A bullet");
    expect(skill).toContain("Another bullet");

    const referencesStat = await fs.lstat(path.join(target, "references"));
    expect(referencesStat.isSymbolicLink()).toBe(true);
    const referencesLink = await fs.readlink(path.join(target, "references"));
    expect(path.resolve(target, referencesLink)).toBe(path.join(source, "references"));
  });

  it("returns 'skipped' on a no-op materialization (idempotent)", async () => {
    const source = await makeSourceSkill();
    const target = path.join(workspace, "target");

    const first = await materializePaperclipSkill(source, target, { commit: false, pr: true });
    expect(first).toBe("created");

    const second = await materializePaperclipSkill(source, target, { commit: false, pr: true });
    expect(second).toBe("skipped");
  });

  it("repairs a stale symlink when transitioning to disabled attribution", async () => {
    const source = await makeSourceSkill();
    const target = path.join(workspace, "target");
    await fs.symlink(source, target);

    const result = await materializePaperclipSkill(source, target, { commit: false, pr: true });

    expect(result).toBe("repaired");
    const targetStat = await fs.lstat(target);
    expect(targetStat.isDirectory()).toBe(true);
  });

  it("rebuilds when source has lost a file since the last materialization", async () => {
    const source = await makeSourceSkill();
    const target = path.join(workspace, "target");
    const first = await materializePaperclipSkill(source, target, { commit: false, pr: true });
    expect(first).toBe("created");

    // Source loses the references/ subdirectory — target still has a stale symlink for it.
    await fs.rm(path.join(source, "references"), { recursive: true, force: true });
    expect(await fs.readdir(target)).toContain("references");

    const second = await materializePaperclipSkill(source, target, { commit: false, pr: true });

    expect(second).toBe("repaired");
    expect(await fs.readdir(target)).not.toContain("references");
  });

  it("throws when target exists as a regular file and attribution is disabled", async () => {
    const source = await makeSourceSkill();
    const target = path.join(workspace, "target");
    await fs.writeFile(target, "operator-placed content", "utf8");

    await expect(
      materializePaperclipSkill(source, target, { commit: false, pr: true }),
    ).rejects.toThrow(/regular file/);
  });
});
