import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeUnsafeCodexHomeEntries } from "./codex-home-cleanup.js";
import { stageCodexHomeForSync } from "./codex-home.js";

describe("removeUnsafeCodexHomeEntries", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("removes planted entries inside skills so staging never uploads what they point at", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-cleanup-"));
    cleanup.push(root);
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "id_rsa"), "host-owned");
    const home = path.join(root, "home");
    await fs.mkdir(path.join(home, "skills", "kept", "nested"), { recursive: true });
    await fs.writeFile(path.join(home, "skills", "kept", "SKILL.md"), "kept skill");
    await fs.writeFile(path.join(home, "config.toml"), "model = \"x\"\n");
    // What an earlier sandboxed run could leave behind in its own home.
    await fs.symlink(outside, path.join(home, "skills", "planted"));
    await fs.link(path.join(outside, "id_rsa"), path.join(home, "skills", "hardlinked"));
    await fs.writeFile(path.join(home, "skills", "stray"), "file");

    const removed = await removeUnsafeCodexHomeEntries(home);
    expect(removed.sort()).toEqual(["skills/hardlinked", "skills/planted", "skills/stray"]);
    expect(await fs.readFile(path.join(outside, "id_rsa"), "utf8")).toBe("host-owned");
    expect((await fs.readdir(path.join(home, "skills"))).sort()).toEqual(["kept"]);
    expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toBe("model = \"x\"\n");

    const staged = await stageCodexHomeForSync(home, { runId: "cleanup-test" });
    cleanup.push(staged);
    expect((await fs.readdir(path.join(staged, "skills"))).sort()).toEqual(["kept"]);
    expect(await fs.readFile(path.join(staged, "skills", "kept", "SKILL.md"), "utf8")).toBe("kept skill");
  });

  it("keeps a clean home untouched", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-cleanup-"));
    cleanup.push(home);
    await fs.mkdir(path.join(home, "skills", "kept"), { recursive: true });
    await fs.writeFile(path.join(home, "instructions.md"), "hi");
    expect(await removeUnsafeCodexHomeEntries(home)).toEqual([]);
    expect(await fs.readdir(path.join(home, "skills"))).toEqual(["kept"]);
  });
});
