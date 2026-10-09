import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { runCopilotProtectionFlow } from "./copilot-protection-flow.js";
import { runCursorNativeFlow } from "./cursor-native-flow.js";
import { cursorDeniedCommand } from "./cursor-native-evidence.js";

const dispatch = vi.hoisted(() => ({ inspect: async (_input: { prompt: string }) => {} }));
vi.mock("./user-actions.js", () => ({ createTaskThroughUi: async (input: { prompt: string }) => {
  await dispatch.inspect(input); throw new Error("stop-before-provider-dispatch");
} }));
vi.mock("@playwright/test", () => ({ expect: (actual: unknown, message?: string) => ({ toBe: (expected: unknown) => expect(actual, message).toBe(expected) }) }));

it.each(["copilot", "cursor"] as const)("arms an isolated %s target before dispatch and binds the exact native operation", async candidate => {
  const workspacePath = await mkdtemp(join(tmpdir(), "denial-dispatch-"));
  const taskId = candidate === "copilot" ? "native-permission-deny-write" : "native-write-deny-reconnect";
  const execution = runnerMatrix.find(row => row.profile.qualificationCandidate === candidate && row.environment.id === "local" && row.task.id === taskId)!;
  const receipts = new Map<string, any>(); const cleanup: Array<() => Promise<unknown>> = [];
  let target: string | undefined;
  dispatch.inspect = async ({ prompt }) => {
    const parents = (await readdir(workspacePath)).filter(name => name.startsWith("pc-denied-"));
    expect(parents).toHaveLength(1);
    expect(await readdir(join(workspacePath, parents[0]!))).toEqual([]);
    target = `${parents[0]}/${candidate}-denied-nonce.txt`;
    if (candidate === "copilot") expect(prompt).toContain(`creating ${target} with DENIED-nonce`);
    else expect(prompt).toContain(cursorDeniedCommand(join(workspacePath, target)).command);
    await writeFile(join(workspacePath, "unrelated-startup-file"), "runtime setup");
  };
  const api = { get: async (path: string) => {
    if (path === "/api/agents/agent") return { adapterConfig: { lifecycleMode: "per_turn" } };
    throw new Error(`Unexpected API call ${path}`);
  }, patch: async (_path: string, value: unknown) => value, post: async () => ({ name: "fixture project" }) };
  const input = { page: {}, api, fixtures: { company: { id: "company", issuePrefix: "FIX" }, agent: { id: "agent", name: "Fixture" }, environment: { id: "environment" } }, execution, nonce: "nonce", workspacePath, deadlineAt: Date.now() + 2000,
    observe: () => {}, capture: async () => {}, evidence: async (name: string, value: unknown) => { receipts.set(name, value); }, registerCleanupAssertion: (callback: () => Promise<unknown>) => cleanup.push(callback) };
  try {
    await expect((candidate === "copilot" ? runCopilotProtectionFlow : runCursorNativeFlow)(input as any)).rejects.toThrow("stop-before-provider-dispatch");
    if (candidate === "cursor") await expect(cleanup[0]!()).rejects.toThrow(/cleanup proof/);
    const receipt = candidate === "copilot" ? receipts.get("copilot-protection-checks.json").watchReceipt : receipts.get("cursor-native-denial-cleanup-attempt.json").watcher;
    expect(receipt).toMatchObject({ complete: true, targetMutationCount: 0, reasons: [] });
    expect(target).toBeDefined();
  } finally { await rm(workspacePath, { recursive: true, force: true }); }
});
