import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const activeRead = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
  entered: null as (() => void) | null,
  started: 0,
  settled: 0,
}));
const activeStat = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
  entered: null as (() => void) | null,
  started: 0,
  settled: 0,
  readCalls: 0,
  tasks: [] as Promise<unknown>[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]).includes("paperclip-workspace-active-stat-")) activeStat.readCalls += 1;
      if (!String(args[0]).includes("paperclip-workspace-active-cancel-") || activeRead.gate === null) {
        return actual.readFile(...args);
      }
      activeRead.started += 1;
      activeRead.entered?.();
      try {
        await activeRead.gate;
        return await actual.readFile(...args);
      } finally {
        activeRead.settled += 1;
      }
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (!String(args[0]).includes("paperclip-workspace-active-stat-") || activeStat.gate === null) {
        return actual.stat(...args);
      }
      activeStat.started += 1;
      activeStat.entered?.();
      const task = (async () => {
        try {
          await activeStat.gate;
          return await actual.stat(...args);
        } finally {
          activeStat.settled += 1;
        }
      })();
      activeStat.tasks.push(task);
      return task;
    },
  };
});

import { capturePaperclipWorkspace, diffPaperclipWorkspace } from "./workspace-diff.js";

describe("runner-verified workspace diffs", () => {
  it("rejects an aborted snapshot before scanning", async () => {
    await expect(capturePaperclipWorkspace("/unused", { signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("waits for active reads to settle when cancelled during capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-workspace-active-cancel-"));
    let release: () => void = () => {};
    activeRead.gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { activeRead.entered = resolve; });
    activeRead.started = 0;
    activeRead.settled = 0;
    try {
      for (let file = 0; file < 16; file += 1) {
        await writeFile(join(root, `file-${file}.txt`), "content\n");
      }
      const controller = new AbortController();
      const capture = capturePaperclipWorkspace(root, { signal: controller.signal });
      await entered;
      controller.abort();
      release();
      await expect(capture).rejects.toMatchObject({ name: "AbortError" });
      expect(activeRead.started).toBeGreaterThan(0);
      expect(activeRead.started).toBeLessThanOrEqual(16);
      expect(activeRead.settled).toBe(activeRead.started);
    } finally {
      release();
      activeRead.gate = null;
      activeRead.entered = null;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops scheduling reads after cancellation during metadata preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-workspace-active-stat-"));
    let release: () => void = () => {};
    activeStat.gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { activeStat.entered = resolve; });
    activeStat.started = 0;
    activeStat.settled = 0;
    activeStat.readCalls = 0;
    activeStat.tasks = [];
    try {
      for (let file = 0; file < 16; file += 1) {
        await writeFile(join(root, `file-${file}.txt`), "content\n");
      }
      const controller = new AbortController();
      const capture = capturePaperclipWorkspace(root, { signal: controller.signal });
      await entered;
      controller.abort();
      release();
      await expect(capture).rejects.toMatchObject({ name: "AbortError" });
      await Promise.allSettled(activeStat.tasks);
      expect(activeStat.started).toBeGreaterThan(0);
      expect(activeStat.started).toBeLessThanOrEqual(16);
      expect(activeStat.settled).toBe(activeStat.started);
      expect(activeStat.readCalls).toBe(0);
    } finally {
      release();
      activeStat.gate = null;
      activeStat.entered = null;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures create, modify, delete, and rename without runner-owned noise", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-workspace-diff-"));
    await mkdir(join(root, ".paperclip-runner-prp"));
    await writeFile(join(root, ".paperclip-runner-prp", "state.json"), "before");
    await writeFile(join(root, "modify.txt"), "old\n");
    await writeFile(join(root, "delete.txt"), "gone\n");
    await writeFile(join(root, "rename.txt"), "same\n");
    const before = await capturePaperclipWorkspace(root);

    await writeFile(join(root, ".paperclip-runner-prp", "state.json"), "after");
    await writeFile(join(root, "modify.txt"), "new\n");
    await writeFile(join(root, "create.txt"), "created\n");
    await writeFile(join(root, "delete.txt"), "");
    await rename(join(root, "rename.txt"), join(root, "renamed.txt"));
    const after = await capturePaperclipWorkspace(root);
    const diff = diffPaperclipWorkspace(before, after, "turn-1:workspace");

    expect(diff?.schema).toBe("paperclip.workspace.diff.v1");
    expect(diff?.source).toBe("runner_verified");
    expect(diff?.files.map((file) => [file.path, file.operation])).toEqual([
      ["create.txt", "create"],
      ["delete.txt", "modify"],
      ["modify.txt", "modify"],
      ["renamed.txt", "rename"],
    ]);
    expect(diff?.files.find((file) => file.path === "renamed.txt")?.previousPath).toBe("rename.txt");
    expect(JSON.stringify(diff)).not.toContain(".paperclip-runner-prp");
  });

  it("returns no record when the workspace did not change", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-workspace-stable-"));
    await writeFile(join(root, "stable.txt"), "same\n");
    const before = await capturePaperclipWorkspace(root);
    const after = await capturePaperclipWorkspace(root);
    expect(diffPaperclipWorkspace(before, after, "turn-1:workspace")).toBeNull();
  });

  it("retains normalized relative paths through nested directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-workspace-paths-"));
    try {
      await mkdir(join(root, "nested", "deep"), { recursive: true });
      await writeFile(join(root, "nested", "deep", "éclair.txt"), "nested\n");
      const snapshot = await capturePaperclipWorkspace(root);
      expect([...snapshot.keys()]).toEqual(["nested/deep/éclair.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves file order, byte caps, and oversized-file handling with read-ahead", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-workspace-read-ahead-"));
    try {
      await writeFile(join(root, "file-00.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
      const content = Buffer.alloc(1024 * 1024, 65);
      for (let file = 1; file <= 33; file += 1) {
        await writeFile(join(root, `file-${String(file).padStart(2, "0")}.txt`), content);
      }
      await symlink(join(root, "file-01.txt"), join(root, "file-00-link.txt"));

      const snapshot = await capturePaperclipWorkspace(root);
      expect([...snapshot.keys()]).toEqual([
        "file-00.bin",
        ...Array.from({ length: 32 }, (_, index) => `file-${String(index + 1).padStart(2, "0")}.txt`),
      ]);
      expect(snapshot.get("file-00.bin")?.content).toBeNull();
      expect(snapshot.get("file-00.bin")?.binary).toBe(true);
      expect([...snapshot.values()].reduce((sum, file) => sum + (file.content?.length ?? 0), 0)).toBe(32 * 1024 * 1024);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
