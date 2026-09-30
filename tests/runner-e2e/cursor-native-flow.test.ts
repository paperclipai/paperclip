import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cursorNativeWorkspaceSnapshot } from "./cursor-native-flow.js";
import { cursorNativeCaseDesigns, cursorNativePlanArtifactGate, cursorNativeTasks } from "./cursor-native-cases.js";

it("keeps native mode/permission choices explicit and artifact export pending", () => {
  expect(cursorNativeTasks.map(task => task.id)).toEqual(cursorNativeCaseDesigns.map(design => design.id));
  for (const task of cursorNativeTasks) {
    expect(task.flow).toBe("cursor_native"); expect(task.expectedRunCount).toBe(1); expect(task.turnTimeoutMs).toBe(120_000);
  }
  expect(cursorNativeCaseDesigns.filter(row => row.method !== "session/request_permission").every(row => row.cursorMode === "plan")).toBe(true);
  expect(cursorNativeCaseDesigns.find(row => row.method === "session/request_permission")).toMatchObject({ cursorMode: "agent", permissionMode: "approve-reads" });
  expect(cursorNativeTasks.find(task => task.id === "native-write-deny-reconnect")!.expectedTerminalState).toEqual({ issue: "in_progress", run: "cancelled" });
  expect(cursorNativePlanArtifactGate.status).toBe("pending");
  expect(cursorNativePlanArtifactGate.nativePath).toContain("<private provider HOME>");
});
it("independently detects changed or newly created workspace bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-workspace-proof-"));
  try {
    await writeFile(join(root, "source.txt"), "before"); const before = await cursorNativeWorkspaceSnapshot(root);
    expect(await cursorNativeWorkspaceSnapshot(root)).toEqual(before);
    await writeFile(join(root, "source.txt"), "after"); expect(await cursorNativeWorkspaceSnapshot(root)).not.toEqual(before);
    await writeFile(join(root, "new.txt"), "effect"); expect(await cursorNativeWorkspaceSnapshot(root)).toHaveProperty("new.txt");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("fails closed on symlinks or oversized proof input", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-workspace-proof-"));
  try {
    await symlink("/", join(root, "escape")); await expect(cursorNativeWorkspaceSnapshot(root)).rejects.toThrow(/symlink/);
    await rm(join(root, "escape")); await writeFile(join(root, "oversized"), Buffer.alloc(4 * 1024 * 1024 + 1));
    await expect(cursorNativeWorkspaceSnapshot(root)).rejects.toThrow(/byte bound/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
