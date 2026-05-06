import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listHermesProfileSkills, syncHermesProfileSkills } from "./skills.js";

function makeCtx(tmpRoot: string, extraConfig: Record<string, unknown> = {}) {
  return {
    config: { profile: "stella", env: { HOME: tmpRoot }, ...extraConfig },
    agent: { id: "agent-1", companyId: "company-1", name: "Stella", adapterType: "hermes_profile", adapterConfig: {} },
    context: {},
    runId: "run-1",
    runtime: { sessionParams: null, sessionId: "session-1", sessionDisplayId: null, taskKey: null },
    onLog: async () => {},
  } as any;
}

describe("hermes_profile skills sync", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeTmp(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-profile-skills-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("lists user-installed profile skills with no warnings", async () => {
    const tmpRoot = await makeTmp();
    const skillsHome = path.join(tmpRoot, ".hermes", "profiles", "stella", "skills");
    await fs.mkdir(path.join(skillsHome, "creative", "humanizer"), { recursive: true });
    await fs.writeFile(path.join(skillsHome, "creative", "humanizer", "SKILL.md"), "# humanizer\n");

    const listed = await listHermesProfileSkills(makeCtx(tmpRoot));

    expect(listed.warnings).toEqual([]);
    // Deep-walked profile skill appears with hermes-profile/ key prefix
    expect(listed.entries).toContainEqual(
      expect.objectContaining({ key: "hermes-profile/creative/humanizer", readOnly: true, state: "installed" }),
    );
  });

  it("sync installs desired Paperclip-managed skills via symlink", async () => {
    const tmpRoot = await makeTmp();
    const skillSource = path.join(tmpRoot, "fake-skill-src", "paperclip");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "# paperclip\n");

    const skillsHome = path.join(tmpRoot, ".hermes", "profiles", "stella", "skills");

    const ctx = makeCtx(tmpRoot, {
      paperclipRuntimeSkills: [{ key: "paperclip", runtimeName: "paperclip", source: skillSource }],
    });

    const synced = await syncHermesProfileSkills(ctx, ["paperclip"]);

    expect(synced.warnings).toEqual([]);
    expect(synced.desiredSkills).toContain("paperclip");

    const linkPath = path.join(skillsHome, "paperclip");
    const lstat = await fs.lstat(linkPath);
    expect(lstat.isSymbolicLink()).toBe(true);
    const linked = await fs.readlink(linkPath);
    expect(path.resolve(path.dirname(linkPath), linked)).toBe(skillSource);
  });

  it("sync removes stale managed skills that are no longer desired", async () => {
    const tmpRoot = await makeTmp();
    const skillSource = path.join(tmpRoot, "fake-skill-src", "paperclip");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "# paperclip\n");

    const skillsHome = path.join(tmpRoot, ".hermes", "profiles", "stella", "skills");
    await fs.mkdir(skillsHome, { recursive: true });
    await fs.symlink(skillSource, path.join(skillsHome, "paperclip"));

    const ctx = makeCtx(tmpRoot, {
      paperclipRuntimeSkills: [{ key: "paperclip", runtimeName: "paperclip", source: skillSource }],
    });

    await syncHermesProfileSkills(ctx, []);

    const exists = await fs.lstat(path.join(skillsHome, "paperclip")).catch(() => null);
    expect(exists).toBeNull();
  });
});
