import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { piNativeTasks, PI_NATIVE_MEMORY_PARENT_SEED_PATH, PI_NATIVE_MEMORY_PARENT_SEED_CONTENT } from "./pi-native-cases.js";
import { runPiNativeFlow } from "./pi-native-flow.js";
import * as remoteFixtures from "./remote-native-fixtures.js";
const browser = vi.hoisted(() => ({ create: (_value: any) => ({ submittedAtMs: Date.now(), issueId: "issue-fixture" }) }));
vi.mock("./user-actions.js", () => ({ createTaskThroughUi: async (value: unknown) => browser.create(value) }));
vi.mock("@playwright/test", () => ({ expect: (value: unknown, message?: string) => ({ toBe: (expected: unknown) => expect(value, message).toBe(expected), toBeVisible: async () => {} }) }));

it.each([
  { missingLF: false, incomplete: false, diagnosticSaveFails: false },
  { missingLF: true, incomplete: false, diagnosticSaveFails: false },
  { missingLF: false, incomplete: true, diagnosticSaveFails: false },
  { missingLF: false, incomplete: true, diagnosticSaveFails: true },
])("preserves remote memory and terminal failures ($missingLF, $incomplete, $diagnosticSaveFails)", async ({ missingLF, incomplete, diagnosticSaveFails }) => {
  const agentId = "11111111-1111-4111-8111-111111111111";
  const runIds = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  const root = await mkdtemp(join(tmpdir(), "pi-remote-memory-"));
  const task = piNativeTasks.find(row => row.id === "agent-files-fresh-run")!;
  const issues: any[] = [], runs: any[] = [], cleanup: Array<() => Promise<any>> = []; const captures: any[] = [], evidence = new Map<string, any>();
  let personal = "", restarted = false, readAfterFinish = false, parentSeeded = false, closed = 0, diagnosticAttempts = 0;
  const terminalError = new Error("remote_native_fixture:terminal_evidence_incomplete");
  const originalDiagnostic = remoteFixtures.remoteNativeIncompleteTerminalEvidence;
  const diagnostic = vi.spyOn(remoteFixtures, "remoteNativeIncompleteTerminalEvidence").mockImplementation(error => error === terminalError
    ? { complete: false, incompleteReasons: ["unwatched_directory"] } as any : originalDiagnostic(error));
  browser.create = value => {
    expect(parentSeeded).toBe(true);
    expect(value.requireExplicitTitle).toBe(true);
    expect(value.prompt).toMatch(/^Read only bootstrap-/); expect(value.prompt).not.toContain("forbidden");
    const n = issues.length + 1; issues.push({ id: `issue-${n}`, title: "Provider-generated task name", companyId: "company", assigneeAgentId: agentId, status: "in_progress" }); runs.push({ id: runIds[n - 1], status: "running", runtimeMode: "native", createdAt: `2026-09-29T00:00:0${n}Z` });
    return { submittedAtMs: Date.now(), issueId: `issue-${n}` };
  };
  const api = { request: { put: async (path: string, input: any) => {
    expect(path).toBe(`/api/agents/${agentId}/instructions-bundle/file`);
    expect(input.data).toEqual({ path: PI_NATIVE_MEMORY_PARENT_SEED_PATH, content: PI_NATIVE_MEMORY_PARENT_SEED_CONTENT, baseHash: null });
    expect(issues).toHaveLength(0); expect(personal).toBe(""); parentSeeded = true;
    return { ok: () => true, json: async () => ({ content: PI_NATIVE_MEMORY_PARENT_SEED_CONTENT }) };
  } }, post: async () => ({ name: "Pi remote project" }), get: async (path: string) => {
    if (path.endsWith("/issues?limit=100")) return issues;
    if (path.endsWith("/heartbeat-runs?limit=100")) return runs;
    if (/\/api\/issues\/issue-[12]$/.test(path)) return issues.find(row => path.endsWith(row.id));
    if (runs.some(row => path === `/api/heartbeat-runs/${row.id}`)) return runs.find(row => path.endsWith(row.id));
    if (path.endsWith("/interactions") || path.endsWith("/comments")) return [];
    if (path.includes("instructions-bundle/file?")) return { content: decodeURIComponent(path.split("?path=")[1]!) === PI_NATIVE_MEMORY_PARENT_SEED_PATH ? PI_NATIVE_MEMORY_PARENT_SEED_CONTENT : personal };
    if (path.includes("/events?")) {
      const runId = runIds.find(id => path.includes(`${id}/`))!;
      const nativeRead = { eventType: "tool.execution.completed", seq: 3, payload: { prpEvent: { payload: {
        schema: "paperclip.tool.execution.v1", transport: "builtin", name: "read", operation: "read", status: "completed",
        target: `.paperclip-runtime/agent-files/${agentId}/${runId}/memory/pi-native.txt`, readOnly: true, outputTruncated: false, executionId: path.includes(`${runIds[0]}/`) ? "read-1" : "read-2",
        // Missing-LF controls still model the intended complete native read;
        // their independent persisted bytes fail the existing byte assertion.
        output: JSON.stringify({ content: [{ type: "text", text: personal.endsWith("\n") ? personal : `${personal}\n` }] }),
      } } } };
      return path.includes(`${runIds[0]}/`) ? [{ eventType: "instruction_save", seq: 1, payload: { state: "saved" } }, { eventType: "tool.execution.completed", seq: 2, payload: { prpEvent: { payload: { schema: "paperclip.tool.execution.v1", transport: "builtin", operation: "edit", name: "write", status: "failed", target: null, executionId: "tool-1", output: "Pi tool path is outside its assigned workspace and agent files" } } } }, nativeRead] : [nativeRead];
    }
    throw new Error(`Unexpected fixture path ${path}`);
  } };
  const remoteBootstrap = { prompt: (nonce: string) => `Read only bootstrap-${nonce}`, bindAndRelease: async (input: any) => {
    const ordinal = runs.length; expect(input.runId).toBe(runIds[ordinal - 1]);
    const identity = { pid: 100 + ordinal, ppid: 1, startTicks: String(ordinal), bootId: `boot-${ordinal}` };
    const targets: any = ordinal === 1 ? { "@cross-root": { absent: false, sha256: `sha256:${createHash("sha256").update(input.crossRoot.initialText).digest("hex")}`, parent: { dev: "1", ino: "2" }, mutationCount: 0, complete: true } } : {};
    const snapshot = { observedAtMs: ordinal, complete: true, targets, workspace: {}, watcher: { complete: true, targetMutationCount: 0, workspaceMutationCount: 0 }, processes: { captured: true, root: identity, journal: [identity], live: [] } };
    let armed = false, finished = false;
    const fixture = { binding: { runId: input.runId }, remoteCwd: `/remote/run-${ordinal}`, outsideTarget: ordinal === 1 ? `/tmp/owned-${ordinal}/cross-root-target` : null,
      snapshot: async () => { armed = true; return snapshot; }, finish: async () => { if (incomplete) throw terminalError; finished = true; return snapshot; }, close: async () => { closed++; },
      readFile: async (path: string) => { expect(finished).toBe(true); expect(restarted).toBe(true); expect(path).toBe("pi-agent-memory-proof.txt"); readAfterFinish = true; return Buffer.from(personal); },
    };
    const action = await input.actionPrompt(fixture); expect(armed).toBe(true);
    if (ordinal === 1) {
      expect(action).toContain(fixture.outsideTarget);
      const content = /```json\n(.*?)\n```/s.exec(action)?.[1];
      expect(content).toBeDefined();
      personal = JSON.parse(content!).content;
      expect(personal).toMatch(/^[a-f0-9]{32}\n$/);
      expect(Buffer.byteLength(personal, "utf8")).toBe(33);
      if (missingLF) personal = personal.slice(0, -1);
    } else { expect(action).not.toContain(personal.trim()); expect(input.targets).toEqual(["pi-agent-memory-proof.txt"]); }
    issues.at(-1).status = "done"; runs.at(-1).status = "succeeded"; captures.push(fixture.binding); return fixture;
  } };
  try {
    await writeFile(join(root, "pi-agent-memory-proof.txt"), "WRONG HOST COPYBACK");
    const call = runPiNativeFlow({ page: { goto: async () => {}, reload: async () => {}, getByTestId: () => ({ getByRole: () => ({}) }) }, api, fixtures: { company: { id: "company", issuePrefix: "PI" }, agent: { id: agentId, name: "Pi" }, environment: { id: "daytona-env" } }, execution: { task, environment: { id: "daytona" }, profile: { qualificationCandidate: "pi" } }, nonce: "fixture", workspacePath: root, deadlineAt: Date.now() + 2000,
      restart: async () => { expect(evidence.has("pi-remote-1-cross-root-final.json")).toBe(true); restarted = true; }, observe: () => {}, capture: async () => {}, evidence: async (name: string, value: unknown) => { if (name.endsWith("incomplete-terminal.json")) { diagnosticAttempts++; if (diagnosticSaveFails) throw new Error("diagnostic storage unavailable"); } evidence.set(name, value); }, remoteBootstrap, registerCleanupAssertion: (fn: () => Promise<any>) => cleanup.push(fn) } as any);
    if (missingLF) {
      await expect(call).rejects.toThrow("Public managed-file API contains the exact native-write bytes");
      expect(evidence.get("pi-agent-files-first-save.json").personal.content).toBe(personal);
      expect(Buffer.byteLength(personal)).toBe(32);
      expect(restarted).toBe(false); expect(runs).toHaveLength(1);
      return;
    }
    if (incomplete) {
      await expect(call).rejects.toBe(terminalError);
      expect(cleanup).toHaveLength(1);
      await expect(cleanup[0]!()).rejects.toBe(terminalError);
      expect(closed).toBe(1); expect(restarted).toBe(false);
      expect(evidence.has("pi-remote-1-incomplete-terminal.json")).toBe(!diagnosticSaveFails);
      expect(diagnosticAttempts).toBe(diagnosticSaveFails ? 2 : 1);
      return;
    }
    const result = await call;
    expect(result.checks.every(check => check.passed)).toBe(true); expect(captures).toEqual(runIds.map(runId => ({ runId }))); expect(readAfterFinish).toBe(true); expect(cleanup).toHaveLength(2); for (const fn of cleanup) await fn();
  } finally { diagnostic.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
