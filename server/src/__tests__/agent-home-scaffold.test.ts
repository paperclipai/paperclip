import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAgentHomeScaffold } from "../agent-home-scaffold.js";

const tempDirs = new Set<string>();

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-agent-home-"));
  tempDirs.add(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    Array.from(tempDirs, (dir) =>
      fs.rm(dir, { recursive: true, force: true }).catch(() => {}),
    ),
  );
  tempDirs.clear();
});

describe("ensureAgentHomeScaffold", () => {
  it("creates the OMX memory and state scaffold for a fresh agent home", async () => {
    const dir = await makeTempDir();

    await ensureAgentHomeScaffold(dir);

    await expect(fs.stat(path.join(dir, ".omx"))).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(fs.stat(path.join(dir, ".omx", "logs"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    await expect(fs.stat(path.join(dir, ".omx", "plans"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    await expect(fs.stat(path.join(dir, ".omx", "state"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    await expect(fs.readFile(path.join(dir, ".omx", "notepad.md"), "utf8")).resolves.toContain(
      "## Priority Context",
    );
    await expect(fs.readFile(path.join(dir, ".omx", "project-memory.json"), "utf8")).resolves.toBe("{}\n");
  });

  it("does not overwrite existing memory files", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, ".omx"), { recursive: true });
    await fs.writeFile(path.join(dir, ".omx", "notepad.md"), "custom notepad\n");
    await fs.writeFile(path.join(dir, ".omx", "project-memory.json"), "{\"saved\":true}\n");

    await ensureAgentHomeScaffold(dir);

    await expect(fs.readFile(path.join(dir, ".omx", "notepad.md"), "utf8")).resolves.toBe("custom notepad\n");
    await expect(fs.readFile(path.join(dir, ".omx", "project-memory.json"), "utf8")).resolves.toBe(
      "{\"saved\":true}\n",
    );
  });
});
