import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cursorNativeWorkspaceSnapshot, hasCursorAcceptedPlanWait } from "./cursor-native-flow.js";
import { cursorNativeCaseDesigns, cursorNativePlanArtifactGate, cursorNativeTasks } from "./cursor-native-cases.js";

it("keeps native mode/permission choices explicit and artifact export pending", () => {
  expect(cursorNativeTasks.map(task => task.id)).toEqual(cursorNativeCaseDesigns.map(design => design.id));
  for (const task of cursorNativeTasks) {
    expect(task.flow).toBe("cursor_native"); expect(task.expectedRunCount).toBe(1); expect(task.turnTimeoutMs).toBe(120_000);
  }
  expect(cursorNativeCaseDesigns.filter(row => row.method !== "session/request_permission").every(row => row.mode === "plan")).toBe(true);
  expect(cursorNativeCaseDesigns.find(row => row.method === "session/request_permission")).toMatchObject({ mode: "agent", permissionMode: "approve-reads" });
  expect(cursorNativeTasks.find(task => task.id === "native-write-deny-reconnect")!.expectedTerminalState).toEqual({ issue: "in_progress", run: "failed" });
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

it("awaits owned remote baseline before returning the exact remote denial command", async () => {
  const { prepareCursorRemoteAction } = await import("./cursor-native-flow.js");
  const binding = { companyId: "company", environmentId: "environment", runId: "run", leaseId: "lease", sandboxId: "sandbox", remoteCwd: "/home/daytona/paperclip-workspace", image: `runner@sha256:${"a".repeat(64)}` };
  const snapshot = { binding, observedAtMs: 50, complete: true, workspace: {}, targets: { "denied.txt": { absent: true, sha256: null, parent: { dev: "1", ino: "2" }, mutationCount: 0, complete: true } }, watcher: { complete: true, targetMutationCount: 0, workspaceMutationCount: 0 }, processes: { captured: true, root: { pid: 51, startTicks: "3021", bootId: "12345678-1234-1234-1234-123456789abc" }, journal: [], live: [51] } };
  const order: string[] = [];
  const fixture = { binding, actionFile: `.paperclip-eval-action-${"a".repeat(36)}.txt`, remoteCwd: binding.remoteCwd, snapshot: async (label: string) => { order.push(label); await Promise.resolve(); order.push("baseline-ready"); return snapshot; }, finish: async () => snapshot, close: async () => {} };
  const prepared = await prepareCursorRemoteAction({ fixture, ...binding, deniedRelative: "denied.txt", prompt: "Perform the actual test" });
  order.push("publish-action");
  expect(order).toEqual(["before-action-publication", "baseline-ready", "publish-action"]);
  expect(prepared.prompt).toContain("printf 'MUST-NOT-EXIST' > '/home/daytona/paperclip-workspace/denied.txt'");
  expect(prepared.initial).toMatchObject({ phase: "before-request", absent: true });
  expect(prepared.command?.commandSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  await expect(prepareCursorRemoteAction({ fixture, ...binding, runId: "wrong-run", deniedRelative: "denied.txt", prompt: "test" })).rejects.toThrow(/another run/);
  snapshot.targets["denied.txt"].absent = false;
  await expect(prepareCursorRemoteAction({ fixture, ...binding, deniedRelative: "denied.txt", prompt: "test" })).rejects.toThrow(/present before/);
});

it("refuses remote native execution before touching API when bootstrap or cleanup authority is missing", async () => {
  const { runCursorNativeFlow } = await import("./cursor-native-flow.js");
  let apiCalls = 0;
  await expect(runCursorNativeFlow({
    execution: { task: { id: "native-question-reconnect" }, profile: { qualificationCandidate: "cursor" }, environment: { id: "daytona" } },
    api: { get: async () => { apiCalls++; throw new Error("must not call"); } },
  } as any)).rejects.toThrow(/owned pre-action observer/);
  expect(apiCalls).toBe(0);
});

it("requires the exact passive accepted-plan disposition without mode promotion or extra work", () => {
  const state = { issue: { id: "issue", status: "in_progress" }, interactions: [{ status: "answered" }], runs: [{ id: "run", nativeIssueId: "issue", runtimeMode: "native", status: "succeeded", runnerProfileJson: { nativeExecutionInput: { provider: { mode: "plan" } } }, resultJson: { finalizationPhase: "committed", finalizationReasonCode: "native_plan_accepted_waiting_for_continuation", authoritativeDecision: "in_progress" } }] };
  expect(hasCursorAcceptedPlanWait(state)).toBe(true);
  const mutations = [
    (s: typeof state) => { s.issue.status = "done"; },
    (s: typeof state) => { s.runs[0]!.status = "failed"; },
    (s: typeof state) => { s.runs[0]!.nativeIssueId = "foreign"; },
    (s: typeof state) => { s.runs[0]!.runnerProfileJson.nativeExecutionInput.provider.mode = "agent"; },
    (s: typeof state) => { s.runs[0]!.resultJson.finalizationReasonCode = "live_continuation_registered"; },
    (s: typeof state) => { s.runs[0]!.resultJson.finalizationPhase = "pending"; },
    (s: typeof state) => { s.runs.push(structuredClone(s.runs[0]!)); },
    (s: typeof state) => { s.interactions[0]!.status = "pending"; },
  ];
  for (const mutate of mutations) { const changed = structuredClone(state); mutate(changed); expect(hasCursorAcceptedPlanWait(changed)).toBe(false); }
  expect(cursorNativeTasks.find(task => task.id === "native-plan-reject-revise-accept")!.expectedTerminalState).toEqual({ issue: "in_progress", run: "succeeded" });
  const prompt = cursorNativeTasks.find(task => task.id === "native-plan-reject-revise-accept")!.buildPrompt("test");
  expect(prompt).toContain("do not implement, change modes, call paperclip_finish, or start another turn");
});
