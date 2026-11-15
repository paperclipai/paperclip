import { describe, expect, it } from "vitest";
import { STORAGE_FAILURE_CLEANUP_MS } from "../storage/failure-cleanup.js";
import type { StorageService } from "../storage/types.js";
import { abortSnapshotAttemptUploads } from "../services/remote-workspace-snapshot-retention.js";

describe("aborting a snapshot's attempt uploads", () => {
  it("shares one deadline across every attempt key of a hanging store", async () => {
    const started: string[] = [];
    const storage = {
      abortIncompleteUploads: (_companyId: string, key: string, options?: { signal?: AbortSignal }) => {
        started.push(key);
        return new Promise<number>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
        });
      },
    } as unknown as StorageService;
    const keys = Array.from({ length: 20 }, (_, index) => `company/workspace-snapshots/ws/s/${index}.pcws`);
    const begun = Date.now();
    expect(await abortSnapshotAttemptUploads(storage, "company", keys)).toBe(0);
    const elapsed = Date.now() - begun;
    expect(elapsed).toBeGreaterThanOrEqual(STORAGE_FAILURE_CLEANUP_MS - 100);
    expect(elapsed).toBeLessThan(2 * STORAGE_FAILURE_CLEANUP_MS);
    expect(started).toHaveLength(8);
  }, 3 * STORAGE_FAILURE_CLEANUP_MS);

  it("aborts every key of a responsive store and counts each abort", async () => {
    const seen: string[] = [];
    const storage = { abortIncompleteUploads: async (_companyId: string, key: string) => { seen.push(key); return 1; } } as unknown as StorageService;
    const keys = Array.from({ length: 20 }, (_, index) => `k${index}`);
    expect(await abortSnapshotAttemptUploads(storage, "company", keys)).toBe(20);
    expect(seen.sort()).toEqual([...keys].sort());
  });
});
