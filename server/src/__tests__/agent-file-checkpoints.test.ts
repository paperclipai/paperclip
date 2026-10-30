import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureAgentFiles } from "../services/scripts/agent-file-checkpoint.mjs";
import { captureAgentFileCheckpoint, validateAgentFileCheckpoint } from "../services/agent-file-checkpoints.js";

describe("incremental managed file checkpoints", () => {
  let root: string;
  beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-checkpoint-"))); await fs.mkdir(path.join(root, "live")); });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
  const live = () => path.join(root, "live");
  it("does not read or copy a large unchanged binary when only a note changes", async () => {
    const image = Buffer.alloc(64 * 1024 * 1024, 0x93);
    await fs.writeFile(path.join(live(), "image.bin"), image);
    await fs.writeFile(path.join(live(), "note.txt"), "one");
    const first = await captureAgentFiles(live());
    await fs.writeFile(path.join(live(), "note.txt"), "two");
    const delta = await captureAgentFileCheckpoint({ runId: "fixture", localRoot: live(), executionRoot: live(), previous: first.manifest });
    try {
      expect(delta.stats.hashedBytes).toBe(3);
      expect(delta.stats.copiedBytes).toBe(3);
      expect(delta.stats.copiedFiles).toBe(1);
      expect(await fs.readFile(path.join(delta.directory, "files", "note.txt"), "utf8")).toBe("two");
      await expect(fs.stat(path.join(delta.directory, "files", "image.bin"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(delta.manifest.entries.find(([p]) => p === "image.bin")?.[1].hash).toBe(first.manifest.entries.find(([p]) => p === "image.bin")?.[1].hash);
    } finally { await delta.cleanup(); }
  });
  it("records deletions and empty directories without resending unchanged data", async () => {
    await fs.writeFile(path.join(live(), "deleted"), "gone");
    await fs.writeFile(path.join(live(), "kept"), "keep");
    const first = await captureAgentFiles(live());
    await fs.rm(path.join(live(), "deleted"));
    await fs.mkdir(path.join(live(), "empty"));
    const next = await captureAgentFiles(live(), first.manifest, path.join(root, "delta"));
    expect(next.stats.hashedBytes).toBe(0);
    expect(next.stats.copiedBytes).toBe(0);
    expect(next.manifest.entries.map(([p]) => p)).toEqual(["empty", "kept"]);
  });
  it("detects same-size writes with a restored mtime", async () => {
    const file = path.join(live(), "note");
    await fs.writeFile(file, "aaaa");
    const before = await fs.stat(file);
    const first = await captureAgentFiles(live());
    await fs.writeFile(file, "bbbb");
    await fs.utimes(file, before.atime, before.mtime);
    const next = await captureAgentFiles(live(), first.manifest, path.join(root, "delta"));
    expect(next.stats.copiedBytes).toBe(4);
    expect(next.manifest.entries[0]![1].hash).not.toBe(first.manifest.entries[0]![1].hash);
  });
  it.each(["symlink", "hardlink"])("refuses a %s without publishing a manifest", async kind => {
    const outside = path.join(root, "outside"); await fs.writeFile(outside, "private");
    if (kind === "symlink") await fs.symlink(outside, path.join(live(), "link"));
    else await fs.link(outside, path.join(live(), "link"));
    await expect(captureAgentFiles(live(), undefined, path.join(root, "delta"))).rejects.toMatchObject({ code: "AGENT_FILES_UNSAFE_PATH" });
    await expect(fs.stat(path.join(root, "delta", "checkpoint.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a sparse oversized file before reading its bytes", async () => {
    const f = await fs.open(path.join(live(), "large"), "w"); await f.truncate(256 * 1024 * 1024 + 1); await f.close();
    await expect(captureAgentFiles(live())).rejects.toMatchObject({ code: "AGENT_FILES_LIMIT_EXCEEDED" });
  });
  it("validates received contents independently of the remote manifest", async () => {
    await fs.writeFile(path.join(live(), "note"), "expected");
    const output = path.join(root, "delta");
    await captureAgentFiles(live(), undefined, output);
    await fs.writeFile(path.join(output, "files", "note"), "tampered");
    await expect(validateAgentFileCheckpoint(output, { entries: [] })).rejects.toThrow("payload mismatch");
  });
  it.each(["../escape", "/absolute", "nested/.paperclip-runtime/secret"])("rejects a forged checkpoint path %s", async name => {
    const output = path.join(root, "delta"); await fs.mkdir(output);
    await fs.writeFile(path.join(output, "checkpoint.json"), JSON.stringify({ version: 1, entries: [[name, { kind: "dir" }]] }));
    await expect(validateAgentFileCheckpoint(output, { entries: [] })).rejects.toThrow("AGENT_FILES_UNSAFE_PATH");
  });
  it.skipIf(process.platform !== "darwin")("accepts root-owned macOS temp aliases while rejecting user symlink roots", async () => {
    await fs.writeFile(path.join(live(), "note"), "one");
    const alias = live().replace(/^\/private(?=\/(var|tmp)\/)/, "");
    expect((await captureAgentFiles(alias)).manifest.entries).toHaveLength(1);
    await fs.symlink(live(), path.join(root, "user-link"));
    await expect(captureAgentFiles(path.join(root, "user-link"))).rejects.toThrow("AGENT_FILES_UNSAFE_PATH");
  });
  it("rejects a file growing while its bytes are streamed", async () => {
    const filename = path.join(live(), "writer");
    await fs.writeFile(filename, Buffer.alloc(1024 * 1024, 1));
    const original = fs.open.bind(fs);
    let inject = true;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await original(...args);
      if (String(args[0]) === filename && inject) {
        inject = false;
        const stream = handle.createReadStream.bind(handle);
        handle.createReadStream = ((options: Parameters<typeof stream>[0]) => (async function* () {
          let first = true;
          for await (const chunk of stream(options)) {
            if (first) { first = false; await fs.appendFile(filename, Buffer.alloc(1024 * 1024, 2)); }
            yield chunk;
          }
        })()) as typeof handle.createReadStream;
      }
      return handle;
    });
    await expect(captureAgentFiles(live(), undefined, path.join(root, "delta"))).rejects.toMatchObject({ code: "AGENT_FILES_CHANGED_DURING_CHECKPOINT" });
    await expect(fs.stat(path.join(root, "delta", "checkpoint.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("detects mode changes and renames without retransferring unrelated files", async () => {
    await fs.writeFile(path.join(live(), "script"), "execute");
    await fs.writeFile(path.join(live(), "rename"), "move");
    const first = await captureAgentFiles(live());
    await fs.chmod(path.join(live(), "script"), 0o755);
    await fs.rename(path.join(live(), "rename"), path.join(live(), "renamed"));
    const next = await captureAgentFiles(live(), first.manifest, path.join(root, "delta"));
    expect(next.stats.copiedFiles).toBe(2);
    expect(next.manifest.entries.map(([name]) => name)).toEqual(["renamed", "script"]);
    expect((await fs.stat(path.join(root, "delta", "files", "script"))).mode & 0o777).toBe(0o755);
  });
  it("excludes only the remote transport's reserved root, never user file paths", async () => {
    await fs.mkdir(path.join(live(), ".paperclip-runtime"));
    await fs.symlink("/missing", path.join(live(), ".paperclip-runtime", "transport-only"));
    await fs.writeFile(path.join(live(), "note"), "saved");
    await expect(captureAgentFiles(live())).rejects.toThrow("AGENT_FILES_UNSAFE_PATH");
    const captured = await captureAgentFiles(live(), undefined, undefined, true, true);
    expect(captured.manifest.entries.map(([name]) => name)).toEqual(["note"]);
  });
  it("does not acknowledge a write made after the captured generation", async () => {
    await fs.writeFile(path.join(live(), "note"), "one");
    const first = await captureAgentFiles(live(), undefined, path.join(root, "first"));
    await fs.writeFile(path.join(live(), "note"), "two");
    const second = await captureAgentFiles(live(), first.manifest, path.join(root, "second"));
    expect(second.stats.copiedFiles).toBe(1);
    expect(await fs.readFile(path.join(root, "first", "files", "note"), "utf8")).toBe("one");
    expect(await fs.readFile(path.join(root, "second", "files", "note"), "utf8")).toBe("two");
  });
});
