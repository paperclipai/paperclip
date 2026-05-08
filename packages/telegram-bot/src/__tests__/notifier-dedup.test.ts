import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotifierDedup } from "../notifier/dedup.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "notifier-dedup-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("NotifierDedup", () => {
  it("starts empty when file does not exist", async () => {
    const file = path.join(tmpDir, "missing.json");
    const d = new NotifierDedup({ filePath: file });
    await d.load();
    expect(d.has("interaction", "x")).toBe(false);
  });

  it("persists across instances (restart) without re-notifying", async () => {
    const file = path.join(tmpDir, "seen.json");
    const a = new NotifierDedup({ filePath: file });
    await a.load();
    a.remember("done", "done:i-1");
    a.remember("approval", "approval:ap-1");
    await a.flush();

    const b = new NotifierDedup({ filePath: file });
    await b.load();
    expect(b.has("done", "done:i-1")).toBe(true);
    expect(b.has("approval", "approval:ap-1")).toBe(true);
    expect(b.has("interaction", "interaction:x-1")).toBe(false);
  });

  it("flush is a no-op when nothing was added", async () => {
    const file = path.join(tmpDir, "noop.json");
    const d = new NotifierDedup({ filePath: file });
    await d.load();
    await d.flush();
    await expect(fs.access(file)).rejects.toBeTruthy();
  });

  it("evicts oldest entries when bucket exceeds maxPerType", async () => {
    const file = path.join(tmpDir, "cap.json");
    const d = new NotifierDedup({ filePath: file, maxPerType: 3 });
    await d.load();
    d.remember("done", "a");
    d.remember("done", "b");
    d.remember("done", "c");
    d.remember("done", "d"); // evicts "a"
    expect(d.has("done", "a")).toBe(false);
    expect(d.has("done", "d")).toBe(true);
    expect(d.snapshot().seen.done).toEqual(["b", "c", "d"]);
  });

  it("ignores re-adding same key (idempotent)", async () => {
    const file = path.join(tmpDir, "idem.json");
    const d = new NotifierDedup({ filePath: file });
    await d.load();
    d.remember("blocked", "blocked:i-1");
    d.remember("blocked", "blocked:i-1");
    expect(d.snapshot().seen.blocked).toEqual(["blocked:i-1"]);
  });

  it("survives a corrupt seen file by starting empty", async () => {
    const file = path.join(tmpDir, "corrupt.json");
    await fs.writeFile(file, "{not valid json", "utf8");
    const d = new NotifierDedup({ filePath: file });
    await expect(d.load()).rejects.toBeTruthy();
  });
});
