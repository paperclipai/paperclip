import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { piNativeTasks } from "./pi-native-cases.js";
import { runPiNativeFlow } from "./pi-native-flow.js";
const browser = vi.hoisted(() => ({ create: (_value: any) => {} }));
vi.mock("./user-actions.js", () => ({ createTaskThroughUi: async (value: unknown) => browser.create(value) }));
vi.mock("@playwright/test", () => ({ expect: (value: unknown, message?: string) => ({ toBe: (expected: unknown) => expect(value, message).toBe(expected), toBeVisible: async () => {} }) }));

it("rebinds both remote runs, saves managed bytes, and reads sealed sandbox bytes after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-memory-"));
  const task = piNativeTasks.find(row => row.id === "agent-files-fresh-run")!;
  const issues: any[] = [], runs: any[] = [], cleanup: Array<() => Promise<any>> = []; const captures: any[] = [], evidence = new Map<string, any>();
  let personal = "", restarted = false, readAfterFinish = false;
  browser.create = value => {
    expect(value.prompt).toMatch(/^Read only bootstrap-/); expect(value.prompt).not.toContain("forbidden");
    const n = issues.length + 1; issues.push({ id: `issue-${n}`, title: value.title, status: "in_progress" }); runs.push({ id: `run-${n}`, status: "running", runtimeMode: "native", createdAt: `2026-09-29T00:00:0${n}Z` });
  };
  const api = { post: async () => ({ name: "Pi remote project" }), get: async (path: string) => {
    if (path.endsWith("/issues?limit=100")) return issues;
    if (path.endsWith("/heartbeat-runs?limit=100")) return runs;
    if (/\/api\/issues\/issue-[12]$/.test(path)) return issues.find(row => path.endsWith(row.id));
    if (/\/api\/heartbeat-runs\/run-[12]$/.test(path)) return runs.find(row => path.endsWith(row.id));
    if (path.endsWith("/interactions") || path.endsWith("/comments")) return [];
    if (path.includes("instructions-bundle/file?")) return { content: personal };
    if (path.includes("/events?")) return path.includes("run-1/") ? [{ eventType: "instruction_save", seq: 1, payload: { state: "saved" } }, { eventType: "tool.execution.completed", seq: 2, payload: { prpEvent: { payload: { schema: "paperclip.tool.execution.v1", transport: "builtin", operation: "edit", name: "write", status: "failed", target: null, executionId: "tool-1", output: "Pi tool path is outside its assigned workspace and agent files" } } } }] : [];
    throw new Error(`Unexpected fixture path ${path}`);
  } };
  const remoteBootstrap = { prompt: (nonce: string) => `Read only bootstrap-${nonce}`, bindAndRelease: async (input: any) => {
    const ordinal = runs.length; expect(input.runId).toBe(`run-${ordinal}`);
    const identity = { pid: 100 + ordinal, ppid: 1, startTicks: String(ordinal), bootId: `boot-${ordinal}` };
    const targets: any = ordinal === 1 ? { "@cross-root": { absent: false, sha256: `sha256:${createHash("sha256").update(input.crossRoot.initialText).digest("hex")}`, parent: { dev: "1", ino: "2" }, mutationCount: 0, complete: true } } : {};
    const snapshot = { observedAtMs: ordinal, complete: true, targets, workspace: {}, watcher: { complete: true, targetMutationCount: 0, workspaceMutationCount: 0 }, processes: { captured: true, root: identity, journal: [identity], live: [] } };
    let armed = false, finished = false;
    const fixture = { binding: { runId: input.runId }, remoteCwd: `/remote/run-${ordinal}`, outsideTarget: ordinal === 1 ? `/tmp/owned-${ordinal}/cross-root-target` : null,
      snapshot: async () => { armed = true; return snapshot; }, finish: async () => { finished = true; return snapshot; }, close: async () => {},
      readFile: async (path: string) => { expect(finished).toBe(true); expect(restarted).toBe(true); expect(path).toBe("pi-agent-memory-proof.txt"); readAfterFinish = true; return Buffer.from(personal); },
    };
    const action = await input.actionPrompt(fixture); expect(armed).toBe(true);
    if (ordinal === 1) {
      expect(action).toContain(fixture.outsideTarget); const literal = /Write exactly (".*?") to memory\/pi-native.txt/.exec(action)?.[1]; expect(literal).toBeDefined(); personal = JSON.parse(literal!); expect(personal).toMatch(/^[a-f0-9]{32}\n$/);
    } else { expect(action).not.toContain(personal.trim()); expect(input.targets).toEqual(["pi-agent-memory-proof.txt"]); }
    issues.at(-1).status = "done"; runs.at(-1).status = "succeeded"; captures.push(fixture.binding); return fixture;
  } };
  try {
    await writeFile(join(root, "pi-agent-memory-proof.txt"), "WRONG HOST COPYBACK");
    const result = await runPiNativeFlow({ page: { goto: async () => {}, reload: async () => {}, getByTestId: () => ({ getByRole: () => ({}) }) }, api, fixtures: { company: { id: "company", issuePrefix: "PI" }, agent: { id: "agent", name: "Pi" }, environment: { id: "daytona-env" } }, execution: { task, environment: { id: "daytona" }, profile: { qualificationCandidate: "pi" } }, nonce: "fixture", workspacePath: root, deadlineAt: Date.now() + 2000,
      restart: async () => { expect(evidence.has("pi-remote-1-cross-root-final.json")).toBe(true); restarted = true; }, observe: () => {}, capture: async () => {}, evidence: async (name: string, value: unknown) => { evidence.set(name, value); }, remoteBootstrap, registerCleanupAssertion: (fn: () => Promise<any>) => cleanup.push(fn) } as any);
    expect(result.checks.every(check => check.passed)).toBe(true); expect(captures).toEqual([{ runId: "run-1" }, { runId: "run-2" }]); expect(readAfterFinish).toBe(true); expect(cleanup).toHaveLength(2); for (const fn of cleanup) await fn();
  } finally { await rm(root, { recursive: true, force: true }); }
});
