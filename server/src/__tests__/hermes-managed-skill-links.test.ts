import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { reconcileHermesPaperclipSkills } from "../../../packages/adapters/hermes/src/server/skills.js";

const key = "paperclipai/paperclip/paperclip";
const suffix = path.join("node_modules", "@paperclipai", "server", "skills", "paperclip");

describe("Hermes retained CLI payload skill links", () => {
  let home: string;
  let cliRoot: string;
  let oldPayload: string;
  let newPayload: string;
  let oldSource: string;
  let newSource: string;
  let target: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-payload-"));
    cliRoot = path.join(home, ".paperclip", "cli");
    oldPayload = path.join(cliRoot, "installs", "npm", "v1");
    newPayload = path.join(cliRoot, "installs", "npm", "v2");
    oldSource = path.join(oldPayload, suffix);
    newSource = path.join(newPayload, suffix);
    target = path.join(home, ".hermes", "skills", "paperclip");
    for (const source of [oldSource, newSource]) {
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, "SKILL.md"), "# Paperclip\n");
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(path.join(cliRoot, ".managed-install"), "paperclipai managed install store v1\n", { mode: 0o600 });
    await writeManifest(newPayload, [oldPayload]);
    await fs.symlink(oldSource, target);
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  async function writeManifest(current: string, previous: string[]): Promise<void> {
    const record = (payloadPath: string): Record<string, unknown> => ({
      source: path.basename(path.dirname(payloadPath)), version: path.basename(payloadPath), channel: "latest",
      payloadPath, installedAt: "2026-10-05T00:00:00.000Z",
    });
    await fs.writeFile(path.join(cliRoot, "install.json"), JSON.stringify({
      schemaVersion: 1, ...record(current), previous: previous.map(record),
    }), { mode: 0o600 });
  }

  function config(source = newSource): Record<string, unknown> {
    return {
      env: { HOME: home },
      paperclipRuntimeSkills: [{ key, runtimeName: "paperclip", source }],
      paperclipSkillSync: { desiredSkills: [key] },
    };
  }

  async function expectPreserved(source = oldSource): Promise<void> {
    await expect(reconcileHermesPaperclipSkills(config())).rejects.toThrow("occupied by another installation");
    expect(await fs.readlink(target)).toBe(source);
  }

  test("updates a live link from a retained previous payload", async () => {
    await expect(reconcileHermesPaperclipSkills(config())).resolves.toContain(key);
    expect(await fs.readlink(target)).toBe(newSource);
    expect((await fs.stat(oldSource)).isDirectory()).toBe(true);
  });

  test("rolls a live link back to a retained payload", async () => {
    await fs.unlink(target);
    await fs.symlink(newSource, target);
    await writeManifest(oldPayload, [newPayload]);
    await expect(reconcileHermesPaperclipSkills(config(oldSource))).resolves.toContain(key);
    expect(await fs.readlink(target)).toBe(oldSource);
    expect((await fs.stat(newSource)).isDirectory()).toBe(true);
  });

  test("repairs a registered previous payload link after the old payload disappears", async () => {
    await fs.rm(oldPayload, { recursive: true });
    await expect(reconcileHermesPaperclipSkills(config())).resolves.toContain(key);
    expect(await fs.readlink(target)).toBe(newSource);
  });

  test("updates from an npm package skill to a registered git root skill", async () => {
    const gitPayload = path.join(cliRoot, "installs", "git", "revision");
    await fs.mkdir(path.dirname(gitPayload));
    const gitSource = path.join(gitPayload, "skills", "paperclip");
    await fs.mkdir(gitSource, { recursive: true });
    await fs.writeFile(path.join(gitSource, "SKILL.md"), "# Paperclip\n");
    newPayload = gitPayload;
    newSource = gitSource;
    await writeManifest(newPayload, [oldPayload]);
    await expect(reconcileHermesPaperclipSkills(config())).resolves.toContain(key);
    expect(await fs.readlink(target)).toBe(newSource);
  });

  test("rolls a git root skill back to its retained npm package skill", async () => {
    const gitPayload = path.join(cliRoot, "installs", "git", "revision");
    const gitSource = path.join(gitPayload, "skills", "paperclip");
    await fs.mkdir(gitSource, { recursive: true });
    await fs.writeFile(path.join(gitSource, "SKILL.md"), "# Paperclip\n");
    await fs.unlink(target);
    await fs.symlink(gitSource, target);
    await writeManifest(newPayload, [gitPayload]);
    await expect(reconcileHermesPaperclipSkills(config())).resolves.toContain(key);
    expect(await fs.readlink(target)).toBe(newSource);
  });

  test("does not equate git root skills with another package's skill", async () => {
    const gitPayload = path.join(cliRoot, "installs", "git", "revision");
    const gitSource = path.join(gitPayload, "skills", "paperclip");
    await fs.mkdir(gitSource, { recursive: true });
    await fs.writeFile(path.join(gitSource, "SKILL.md"), "# Paperclip\n");
    const other = path.join(newPayload, "node_modules", "@paperclipai", "other", "skills", "paperclip");
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, "SKILL.md"), "# Other\n");
    await writeManifest(newPayload, [gitPayload]);
    await fs.unlink(target);
    await fs.symlink(gitSource, target);
    await expect(reconcileHermesPaperclipSkills(config(other))).rejects.toThrow("occupied by another installation");
    expect(await fs.readlink(target)).toBe(gitSource);
  });

  test("requires the canonical runtime key for git root skill identity", async () => {
    const gitPayload = path.join(cliRoot, "installs", "git", "revision");
    const gitSource = path.join(gitPayload, "skills", "paperclip");
    await fs.mkdir(gitSource, { recursive: true });
    await fs.writeFile(path.join(gitSource, "SKILL.md"), "# Paperclip\n");
    await writeManifest(newPayload, [gitPayload]);
    await fs.unlink(target);
    await fs.symlink(gitSource, target);
    const customKey = "company/custom/paperclip";
    await expect(reconcileHermesPaperclipSkills({
      env: { HOME: home },
      paperclipRuntimeSkills: [{ key: customKey, runtimeName: "paperclip", source: newSource }],
      paperclipSkillSync: { desiredSkills: [customKey] },
    })).rejects.toThrow("occupied by another installation");
    expect(await fs.readlink(target)).toBe(gitSource);
  });

  test("accepts canonical aliases above the same CLI store", async () => {
    const alias = path.join(home, "home-alias");
    await fs.symlink(home, alias, "dir");
    const aliasedSource = path.join(alias, path.relative(home, newSource));
    await expect(reconcileHermesPaperclipSkills(config(aliasedSource))).resolves.toContain(key);
    expect(await fs.readlink(target)).toBe(aliasedSource);
  });

  test.skipIf(typeof process.getuid !== "function")("preserves a store owned by a different user", async () => {
    const uid = process.getuid?.() ?? 0;
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      await expectPreserved();
    } finally {
      getuid.mockRestore();
    }
  });

  test.each([false, true])("preserves a foreign link (dangling: %s)", async (dangling) => {
    const foreign = path.join(home, "user-skills", "paperclip");
    if (!dangling) await fs.mkdir(foreign, { recursive: true });
    await fs.unlink(target);
    await fs.symlink(foreign, target);
    await expectPreserved(foreign);
  });

  test("preserves a real user skill directory", async () => {
    await fs.unlink(target);
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "SKILL.md"), "user skill");
    await expect(reconcileHermesPaperclipSkills(config())).rejects.toThrow("occupied by another installation");
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("user skill");
  });

  test("preserves an unregistered old payload link", async () => {
    await writeManifest(newPayload, []);
    await expectPreserved();
  });

  test("preserves the link when the desired payload is not registered", async () => {
    await writeManifest(oldPayload, []);
    await expectPreserved();
  });

  test("preserves a link into a different install store", async () => {
    const otherPayload = path.join(home, "other", "cli", "installs", "npm", "v1");
    const otherSource = path.join(otherPayload, suffix);
    await fs.mkdir(otherSource, { recursive: true });
    await fs.writeFile(path.join(home, "other", "cli", ".managed-install"), "paperclipai managed install store v1\n");
    await fs.writeFile(path.join(home, "other", "cli", "install.json"), JSON.stringify({
      schemaVersion: 1, source: "npm", payloadPath: otherPayload, previous: [],
    }));
    await fs.unlink(target);
    await fs.symlink(otherSource, target);
    await expectPreserved(otherSource);
  });

  test.each(["package", "runtime"])("preserves a link with a different %s suffix", async (kind) => {
    const other = kind === "package"
      ? path.join(oldPayload, "node_modules", "@paperclipai", "other", "skills", "paperclip")
      : path.join(oldPayload, "node_modules", "@paperclipai", "server", "skills", "other");
    await fs.mkdir(other, { recursive: true });
    await fs.unlink(target);
    await fs.symlink(other, target);
    await expectPreserved(other);
  });

  test.each(["missing", "wrong", "symlink", "hardlink"])("rejects a %s store marker", async (kind) => {
    const marker = path.join(cliRoot, ".managed-install");
    if (kind === "wrong") await fs.writeFile(marker, "not a Paperclip store\n");
    if (kind === "missing") await fs.unlink(marker);
    if (kind === "symlink") {
      const copy = path.join(home, "marker-copy");
      await fs.rename(marker, copy);
      await fs.symlink(copy, marker);
    }
    if (kind === "hardlink") await fs.link(marker, path.join(home, "marker-copy"));
    await expectPreserved();
  });

  test.each(["invalid", "schema", "symlink", "hardlink"])("rejects a %s install manifest", async (kind) => {
    const manifest = path.join(cliRoot, "install.json");
    if (kind === "invalid") await fs.writeFile(manifest, "not JSON");
    if (kind === "schema") await fs.writeFile(manifest, JSON.stringify({ schemaVersion: 2, payloadPath: newPayload, previous: [oldPayload] }));
    if (kind === "symlink") {
      const copy = path.join(home, "manifest-copy");
      await fs.rename(manifest, copy);
      await fs.symlink(copy, manifest);
    }
    if (kind === "hardlink") await fs.link(manifest, path.join(home, "manifest-copy"));
    await expectPreserved();
  });

  test.each(["malformed", "relative", "outside"])("rejects %s payload registration", async (kind) => {
    const previous = kind === "malformed" ? [oldPayload] : [{
      source: "npm",
      payloadPath: kind === "relative" ? "installs/npm/v1" : path.join(home, "other-payload"),
    }];
    await fs.writeFile(path.join(cliRoot, "install.json"), JSON.stringify({
      schemaVersion: 1, source: "npm", payloadPath: newPayload, previous,
    }));
    await expectPreserved();
  });

  test("rejects a registered payload directory replaced by a symlink", async () => {
    const moved = path.join(cliRoot, "installs", "npm", "moved");
    await fs.rename(oldPayload, moved);
    await fs.symlink(moved, oldPayload, "dir");
    await expectPreserved();
  });

  test.each(["old", "new"])("rejects %s skill paths that escape their payload via a symlink", async (which) => {
    const source = which === "old" ? oldSource : newSource;
    const foreign = path.join(home, "foreign-skill");
    await fs.mkdir(foreign);
    await fs.writeFile(path.join(foreign, "SKILL.md"), "foreign");
    await fs.rm(source, { recursive: true });
    await fs.symlink(foreign, source);
    await expectPreserved();
  });

  test.each(["skill", "parent"])("preserves a dangling foreign %s directory inside a registered payload", async (which) => {
    const prefix = which === "skill" ? oldSource : path.dirname(oldSource);
    const foreign = path.join(home, "missing-foreign-skill");
    await fs.rm(prefix, { recursive: true });
    await fs.symlink(foreign, prefix, "dir");

    await expectPreserved();
    expect(await fs.readlink(prefix)).toBe(foreign);
  });
});
