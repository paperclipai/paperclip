import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureCodexSkillsInjected } from "./execute.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-resolver-test-"));
  roots.push(root);
  const skillsHome = path.join(root, "skills");
  await mkdir(skillsHome);
  return { root, skillsHome, resolver: path.join(skillsHome, "RESOLVER.md") };
}
const heading = "# Paperclip Codex host skill routes\n\n| Trigger | Skill |\n|---|---|\n";
const missing = "| Missing | `skills/missing/SKILL.md` |\n";

describe("native Codex skill resolver", () => {
  it.each([false, true])("removes missing routes after materialization (empty=%s)", async (empty) => {
    const { root, skillsHome, resolver } = await fixture();
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "SKILL.md"), "# Present skill\n");
    const present = "| Present | `skills/present/SKILL.md` |\n";
    await writeFile(resolver, heading + missing + (empty ? "" : present));
    await ensureCodexSkillsInjected(vi.fn(async () => undefined), {
      skillsHome,
      skillsEntries: empty ? [] : [{ key: "present", runtimeName: "present", source }],
      desiredSkillNames: empty ? [] : ["present"],
    });
    expect(await readFile(resolver, "utf8")).toBe(heading + (empty ? "" : present));
  });

  it.each(["# User resolver\n", "# Paperclip Codex host skill routes - user copy\n"])("preserves unrelated heading %s", async (prefix) => {
    const { skillsHome, resolver } = await fixture();
    const original = prefix + missing;
    await writeFile(resolver, original);
    await ensureCodexSkillsInjected(vi.fn(async () => undefined), { skillsHome, skillsEntries: [] });
    expect(await readFile(resolver, "utf8")).toBe(original);
  });

  it.skipIf(process.platform === "win32")("does not follow a resolver symlink", async () => {
    const { root, skillsHome, resolver } = await fixture();
    const userFile = path.join(root, "user.md");
    await writeFile(userFile, heading + missing);
    await symlink(userFile, resolver);
    await ensureCodexSkillsInjected(vi.fn(async () => undefined), { skillsHome, skillsEntries: [] });
    expect(await readFile(userFile, "utf8")).toBe(heading + missing);
  });
});
