import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { piNativeTasks } from "./pi-native-cases.js";
import { runPiNativeFlow } from "./pi-native-flow.js";
const proof = vi.hoisted(() => ({ mutation: false, incomplete: false, live: false, target: "pi-human-denied.txt", prompt: "" }));
vi.mock("./user-actions.js", () => ({ createTaskThroughUi: vi.fn(async (input: { prompt: string }) => { proof.prompt = input.prompt; }) }));
vi.mock("./copilot-local-fixtures.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./copilot-local-fixtures.js")>();
  return { ...actual,
  createDeniedTargetFixture: async (workspace: string, name: string) => {
    const fixture = await actual.createDeniedTargetFixture(workspace, name); proof.target = fixture.targetRelativePath;
    return { ...fixture, watcher: { finish: () => ({ ...fixture.watcher.finish(), complete: !proof.incomplete && fixture.watcher.finish().complete, targetMutationCount: proof.mutation ? 1 : 0 }) } };
  },
  observeRunProcesses: () => ({ sample: () => ({ captured: true, live: proof.live ? [123] : [], journal: [] }) }),
}; });
vi.mock("@playwright/test", () => ({ expect: (actual: any, message?: string) => ({
  toBe: (value: unknown) => expect(actual, message).toBe(value), toBeVisible: async () => {}, toHaveCount: async (value: number) => expect(actual.count).toBe(value),
}) }));
const wrap = (eventType: string, seq: number, payload: unknown) => ({ runId: "run", protocolSchemaVersion: 1, eventType, seq, payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", runId: "run", turnId: "turn", eventType, payload } } });
async function exercise(mutation: boolean, remote = false, adapter = "acpx-runtime", incomplete = false) {
  proof.mutation = mutation; proof.incomplete = incomplete; proof.live = false; proof.target = "pi-human-denied.txt"; proof.prompt = "";
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-human-fixture-"));
  let declined = false, browserPosts = 0; const saved = new Map<string, any>(); const cleanup: Array<() => Promise<any>> = [];
  const task = piNativeTasks.find(row => row.id === "human-permission-denial")!;
  const issue = () => ({ id: "issue", identifier: "PI-1", title: task.buildTitle("fixture"), status: declined ? "done" : "in_progress" });
  const run = () => ({ id: "run", status: declined ? "succeeded" : "running", runtimeMode: "native", processPid: 123, processGroupId: 123, processStartedAt: "2026-09-29T00:00:00Z" });
  const request = { requestId: "request", turnId: "turn", type: "permission", status: "pending", details: { toolCallId: "pi-tool-1" }, origin: { adapter, provider: "pi", method: "session/request_permission" }, choices: [{ key: "decline", label: "Decline" }] };
  const events = () => [wrap("runtime_request.created", 1, { request }), ...(declined ? [wrap("runtime_request.resolved", 2, { requestId: "request", turnId: "turn", action: "decline" }), wrap("tool.execution.completed", 3, { schema: "paperclip.tool.execution.v1", transport: "builtin", operation: "edit", executionId: "pi-tool-1", name: "write", target: proof.target, status: "failed", output: "Pi operation was denied or cancelled" })] : [])];
  const api = {
    post: async () => ({ name: "Pi fixture project" }), patch: async (_path: string, value: any) => value,
    get: async (path: string) => {
      if (path === "/api/agents/agent") return { adapterConfig: {} };
      if (path.endsWith("/issues?limit=100")) return [issue()];
      if (path === "/api/issues/issue") return issue();
      if (path.endsWith("/heartbeat-runs?limit=100")) return [run()];
      if (path === "/api/heartbeat-runs/run") return run();
      if (path.endsWith("/interactions") || path.endsWith("/comments")) return [];
      if (path.includes("/events?")) return events();
      throw new Error(`Unexpected fixture API ${path}`);
    },
  };
  const browserRequest = { url: () => "http://fixture/api/heartbeat-runs/run/runtime-requests/request/resolve", method: () => "POST", postDataJSON: () => ({ turnId: "turn", requestKind: "permission_approval", resolution: { action: "decline" } }) };
  let resolvePost: ((value: typeof browserRequest) => void) | undefined;
  const page = { goto: async () => {}, reload: async () => {}, waitForRequest: (predicate: (v: typeof browserRequest) => boolean) => new Promise(resolve => { expect(predicate(browserRequest)).toBe(true); resolvePost = resolve; }),
    getByTestId: (id: string) => id === "issue-detail-header" ? { getByRole: () => ({}) } : { filter: () => ({ count: 1, getByRole: (_role: string, options: { name: string }) => ({ click: async () => { expect(options.name).toBe("Decline"); browserPosts++; declined = true; resolvePost!(browserRequest); } }) }) } };
  const nativeRoot = { pid: 456, ppid: 1, startTicks: "123", bootId: "remote-boot" };
  const snapshot = () => ({ observedAtMs: declined ? 2 : 1, complete: true, workspace: {}, targets: { "pi-human-denied.txt": { absent: true, sha256: null, parent: { dev: "1", ino: "2" }, mutationCount: mutation ? 1 : 0, complete: true } }, watcher: { complete: true, targetMutationCount: mutation ? 1 : 0, workspaceMutationCount: 0 }, processes: { captured: true, root: nativeRoot, journal: [nativeRoot], live: declined ? [] : [456] } });
  const fixture = { binding: { runId: "run" }, remoteCwd: "/remote", outsideTarget: null, snapshot: async () => snapshot(), finish: async () => snapshot(), close: async () => {} };
  const remoteBootstrap = remote ? { prompt: () => "Read bootstrap only", bindAndRelease: async (input: any) => { expect(input.targets).toEqual(["pi-human-denied.txt"]); expect(await input.actionPrompt(fixture)).toContain("native write exactly once"); return fixture; } } : undefined;
  try {
    if (remote) await writeFile(join(workspacePath, "pi-human-denied.txt"), "POISON HOST COPYBACK");
    const result = await runPiNativeFlow({ page, api, fixtures: { company: { id: "company", issuePrefix: "PI" }, agent: { id: "agent", name: "Pi" }, environment: { id: "environment" } }, execution: { task, environment: { id: remote ? "daytona" : "local" }, profile: { qualificationCandidate: "pi" } }, workspacePath, nonce: "fixture", deadlineAt: Date.now() + 2000, restart: async () => {}, observe: () => {}, capture: async () => {}, evidence: async (name: string, value: unknown) => { saved.set(name, value); }, remoteBootstrap, registerCleanupAssertion: (fn: () => Promise<any>) => cleanup.push(fn) } as any);
    if (!remote) { expect(proof.target).toMatch(/^pc-denied-[a-zA-Z0-9]+\/pi-human-denied\.txt$/); expect(proof.prompt).toContain(`relative path ${proof.target} and content forbidden`); }
    expect(browserPosts).toBe(1); expect(result.checks.every(check => check.passed)).toBe(true); expect(saved.has("api-state.json")).toBe(true);
    expect(cleanup).toHaveLength(1);
    if (mutation || incomplete) await expect(cleanup[0]!()).rejects.toThrow("no-effect");
    else expect((await cleanup[0]!())[0].passed).toBe(true);
    expect(saved.get(remote ? "pi-remote-1-retirement.json" : "pi-human-denial-retirement.json").passed).toBe(!mutation && !incomplete);
  } finally { await rm(workspacePath, { recursive: true, force: true }); }
}
it("drives actual browser-denial flow and independent retirement proof", async () => exercise(false));
it("rejects an observed create/delete even when final target is absent", async () => exercise(true));

it("proves browser denial against remote watcher and retirement without trusting a host file", async () => exercise(false, true));

it.each([false, true])("drives sidecar permission denial with remote=%s", async remote => exercise(false, remote, "acpx-runtime-sidecar"));

it("rejects incomplete local observation even with zero target mutations", async () => exercise(false, false, "acpx-runtime", true));
