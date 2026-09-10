import type { ExecutionWorkspace } from "@paperclipai/shared";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkspaceGitInspectionCache } from "../services/workspace-git-inspection-cache.js";

const workspace = { id: "workspace", companyId: "company", cwd: "/repo", baseRef: "master" } as ExecutionWorkspace;
afterEach(() => vi.useRealTimers());

it("coalesces concurrent display reads and expires after five seconds", async () => {
  vi.useFakeTimers();
  const inspect = vi.fn(async () => ({ dirty: false }));
  const read = createWorkspaceGitInspectionCache(inspect);
  await Promise.all(Array.from({ length: 100 }, () => read(workspace)));
  expect(inspect).toHaveBeenCalledTimes(1);
  await read(workspace);
  expect(inspect).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(5_000);
  await read(workspace);
  expect(inspect).toHaveBeenCalledTimes(2);
  // Callers that authorize cleanup retain the uncached inspector.
  await inspect();
  expect(inspect).toHaveBeenCalledTimes(3);
});

it("does not share results across companies, paths, base refs or workspace revisions", async () => {
  const inspect = vi.fn(async () => null);
  const read = createWorkspaceGitInspectionCache(inspect);
  await read(workspace);
  await read({ ...workspace, companyId: "other" });
  await read({ ...workspace, cwd: "/other" });
  await read({ ...workspace, baseRef: "other" });
  await read({ ...workspace, updatedAt: new Date() });
  expect(inspect).toHaveBeenCalledTimes(5);
});

it("retries failed inspections and bounds retained entries", async () => {
  const inspect = vi.fn(async () => null).mockRejectedValueOnce(new Error("failed"));
  const read = createWorkspaceGitInspectionCache(inspect);
  await expect(read(workspace)).rejects.toThrow("failed");
  await read(workspace);
  expect(inspect).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 256; i++) await read({ ...workspace, id: String(i) });
  await read(workspace);
  expect(inspect).toHaveBeenCalledTimes(259);
});
