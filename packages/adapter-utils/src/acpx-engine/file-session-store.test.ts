import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const nativeFs = createRequire(import.meta.url)("node:fs/promises") as typeof fs;

const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const runtimePaths = [
  createRequire(path.join(repositoryRoot, "packages/adapter-utils/package.json")).resolve("acpx/runtime"),
  createRequire(path.join(repositoryRoot, "server/package.json")).resolve("acpx/runtime"),
];

function record(root: string, lastSeq: number) {
  return {
    schema: "acpx.session.v1" as const, acpxRecordId: "shared-record", acpSessionId: "provider-session",
    agentName: "custom", agentCommand: "fixture-provider", cwd: root, name: "fixture",
    createdAt: "2026-10-03T00:00:00.000Z", lastUsedAt: "2026-10-03T00:00:01.000Z", lastSeq,
    eventLog: { active_path: path.join(root, "fixture.jsonl"), segment_count: 1, max_segment_bytes: 1024, max_segments: 2 },
    messages: [], updated_at: "2026-10-03T00:00:01.000Z", cumulative_token_usage: {}, request_token_usage: {},
  };
}

for (const runtimePath of runtimePaths) {
  describe(`file session store (${runtimePath.includes("0.13.1") ? "0.13.1" : "0.12.0"})`, () => {
    it("serializes overlapping writers across store instances and preserves the last snapshot", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-save-race-"));
      const runtime = await import(pathToFileURL(runtimePath).href);
      const stores = [runtime.createFileSessionStore({ stateDir: root }), runtime.createFileSessionStore({ stateDir: root })];
      const rename = nativeFs.rename.bind(nativeFs);
      const active = new Set<string>();
      const renameSpy = vi.spyOn(nativeFs, "rename").mockImplementation(async (from, to) => {
        const target = String(to);
        if (active.has(target)) throw Object.assign(new Error("concurrent Windows rename"), { code: "EPERM" });
        active.add(target);
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          await rename(from, to);
        } finally { active.delete(target); }
      });
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
      try {
        await Promise.all(Array.from({ length: 20 }, (_, index) => stores[index % 2].save(record(root, index))));
        expect(renameSpy).toHaveBeenCalledTimes(20);
        expect((await stores[0].load("shared-record"))?.lastSeq).toBe(19);
        expect((await fs.readdir(path.join(root, "sessions"))).filter((file) => file.endsWith(".tmp"))).toEqual([]);
      } finally {
        clock.mockRestore(); renameSpy.mockRestore();
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it("continues the queue after a failed write and removes its temporary file", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-save-recovery-"));
      const runtime = await import(pathToFileURL(runtimePath).href);
      const store = runtime.createFileSessionStore({ stateDir: root });
      const rename = nativeFs.rename.bind(nativeFs);
      const renameSpy = vi.spyOn(nativeFs, "rename").mockRejectedValueOnce(new Error("first write failed")).mockImplementation(rename);
      try {
        const first = store.save(record(root, 1));
        const second = store.save(record(root, 2));
        const results = await Promise.allSettled([first, second]);
        expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
        expect((await store.load("shared-record"))?.lastSeq).toBe(2);
        expect((await fs.readdir(path.join(root, "sessions"))).filter((file) => file.endsWith(".tmp"))).toEqual([]);
      } finally {
        renameSpy.mockRestore();
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });
}
