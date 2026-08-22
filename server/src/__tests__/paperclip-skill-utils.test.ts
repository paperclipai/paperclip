import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  listPaperclipSkillEntries,
  removeMaintainerOnlySkillSymlinks,
} from "@paperclipai/adapter-utils/server-utils";

// The installed skill files live at the REPO root (skills/, .agents/skills/),
// but vitest runs with cwd=server — anchor to this file instead of the cwd so
// the tests pass from either directory.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("paperclip skill utils", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("lists bundled runtime skills from ./skills without pulling in .agents/skills", async () => {
    const root = await makeTempDir("paperclip-skill-roots-");
    cleanupDirs.add(root);

    const moduleDir = path.join(root, "a", "b", "c", "d", "e");
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.mkdir(path.join(root, "skills", "paperclip"), { recursive: true });
    await fs.mkdir(path.join(root, "skills", "paperclip-create-agent"), { recursive: true });
    await fs.mkdir(path.join(root, ".agents", "skills", "diagnose-why-work-stopped"), { recursive: true });
    await fs.mkdir(path.join(root, ".agents", "skills", "paperclip-create-plugin"), { recursive: true });
    await fs.mkdir(path.join(root, ".agents", "skills", "release"), { recursive: true });
    await fs.mkdir(path.join(root, ".agents", "skills", "terminal-bench-loop"), { recursive: true });

    const entries = await listPaperclipSkillEntries(moduleDir);

    expect(entries.map((entry) => entry.key)).toEqual([
      "paperclipai/paperclip/paperclip",
      "paperclipai/paperclip/paperclip-create-agent",
    ]);
    expect(entries.map((entry) => entry.runtimeName)).toEqual([
      "paperclip",
      "paperclip-create-agent",
    ]);
    expect(entries[0]?.source).toBe(path.join(root, "skills", "paperclip"));
    expect(entries[1]?.source).toBe(path.join(root, "skills", "paperclip-create-agent"));
  });

  it("documents artifact uploads in the installed Paperclip skill", async () => {
    const skillBody = await fs.readFile(path.resolve(repoRoot, "skills/paperclip/SKILL.md"), "utf8");
    const referenceBody = await fs.readFile(path.resolve(repoRoot, "skills/paperclip/references/artifacts.md"), "utf8");

    expect(skillBody).toContain("Generated Artifacts and Work Products");
    expect(skillBody).toContain("references/artifacts.md");
    expect(skillBody).not.toContain("/api/companies/$PAPERCLIP_COMPANY_ID/issues/$PAPERCLIP_TASK_ID/attachments");
    expect(referenceBody).toContain("Generated Artifacts and Work Products");
    expect(referenceBody).toContain("scripts/paperclip-upload-artifact.sh");
    expect(referenceBody).toContain("POST");
    expect(referenceBody).toContain("/api/companies/$PAPERCLIP_COMPANY_ID/issues/$PAPERCLIP_TASK_ID/attachments");
    expect(referenceBody).toContain("/api/issues/$PAPERCLIP_TASK_ID/work-products");
    await expect(
      fs.access(path.resolve(repoRoot, "skills/paperclip/scripts/paperclip-upload-artifact.sh")),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.resolve(repoRoot, "scripts/paperclip-upload-artifact.sh"))).rejects.toThrow();
  });

  it("tightens the board-escalation gate to credential/account/spend/oauth in the installed Paperclip skill", async () => {
    const skillBody = await fs.readFile(path.resolve(repoRoot, "skills/paperclip/SKILL.md"), "utf8");
    const normalized = skillBody.replace(/\s+/g, " ");

    // The gate is anchored to rule #1 so agents read it in the same place.
    expect(skillBody).toContain("Board-escalation gate");
    expect(normalized).toContain("This sharpens rule #1");

    // Only the four genuine human-only blocker classes carry the board label.
    expect(skillBody).toMatch(/\*\*Credential \/ secret\*\*/);
    expect(skillBody).toMatch(/\*\*Account \/ identity\*\*/);
    expect(skillBody).toMatch(/\*\*Spend \/ money\*\*/);
    expect(skillBody).toMatch(/\*\*OAuth \/ third-party authorization\*\*/);

    // Agent-doable work must be explicitly excluded from the board path (rule #1 violations).
    expect(normalized).toContain("agent-doable — do NOT escalate it to a human");
    expect(normalized).toContain("these are NOT board gates");
    expect(normalized).toContain("Escalate sideways or up to an _agent_ first");
  });

  it("documents governed agent interaction resolution invariants", async () => {
    const apiReference = await fs.readFile(path.resolve("skills/paperclip/references/api-reference.md"), "utf8");
    const issueDocs = await fs.readFile(path.resolve("docs/api/issues.md"), "utf8");
    for (const body of [apiReference, issueDocs]) {
      expect(body).toContain('resolverPolicy: "anyone" | "not_creator" | "human_only"');
      expect(body).toContain("requestedResolverPolicy");
      expect(body).toContain("effectiveResolverPolicy");
      expect(body).toContain("toolAction");
      expect(body).toContain("watchdog");
      expect(body).toContain("low-trust");
      expect(body).toContain("addresseeAgentId");
      expect(body).toContain("interaction_pending");
      expect(body).toContain("attention feed");
    }
  });

  it("uses the authoritative PATCH response to confirm monitor scheduling", async () => {
    const skillBody = await fs.readFile(path.resolve("skills/paperclip/SKILL.md"), "utf8");

    expect(skillBody).toContain("Use that request's default full response");
    expect(skillBody).toContain("do not issue a confirming GET");
    expect(skillBody).toContain("`monitorNextCheckAt` is non-null");
    expect(skillBody).toContain("`assigneeAgentId` is set");
    expect(skillBody).toContain("`assigneeUserId` is null");
  });

  it("keeps the create-issue-interaction-ui guide as a maintainer-only skill", async () => {
    const skillPath = path.resolve(repoRoot, ".agents/skills/create-issue-interaction-ui/SKILL.md");
    const skillBody = await fs.readFile(skillPath, "utf8");
    const normalizedSkillBody = skillBody.replace(/\s+/g, " ");
    const normalizedLowerSkillBody = normalizedSkillBody.toLowerCase();

    expect(skillBody).toContain("name: create-issue-interaction-ui");
    expect(normalizedLowerSkillBody).toContain("developer/maintainer skill");
    expect(normalizedLowerSkillBody).toContain(
      "not the operational agents that run inside a deployed paperclip company",
    );
    expect(skillBody).toContain("packages/shared/src/constants.ts");
    expect(skillBody).toContain("server/src/services/issue-thread-interactions.ts");
    expect(skillBody).toContain("ui/src/components/IssueThreadInteractionCard.tsx");
    expect(skillBody).toContain("packages/plugins/sdk/src/testing.ts");
    await expect(fs.access(path.resolve(repoRoot, "skills/create-issue-interaction-ui/SKILL.md"))).rejects.toThrow();
  });

  it("removes stale maintainer-only symlinks from a shared skills home", async () => {
    const root = await makeTempDir("paperclip-skill-cleanup-");
    cleanupDirs.add(root);

    const skillsHome = path.join(root, "skills-home");
    const runtimeSkill = path.join(root, "skills", "paperclip");
    const customSkill = path.join(root, "custom", "release-notes");
    const staleMaintainerSkill = path.join(root, ".agents", "skills", "release");

    await fs.mkdir(skillsHome, { recursive: true });
    await fs.mkdir(runtimeSkill, { recursive: true });
    await fs.mkdir(customSkill, { recursive: true });

    await fs.symlink(runtimeSkill, path.join(skillsHome, "paperclip"));
    await fs.symlink(customSkill, path.join(skillsHome, "release-notes"));
    await fs.symlink(staleMaintainerSkill, path.join(skillsHome, "release"));

    const removed = await removeMaintainerOnlySkillSymlinks(skillsHome, ["paperclip"]);

    expect(removed).toEqual(["release"]);
    await expect(fs.lstat(path.join(skillsHome, "release"))).rejects.toThrow();
    expect((await fs.lstat(path.join(skillsHome, "paperclip"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, "release-notes"))).isSymbolicLink()).toBe(true);
  });
});
