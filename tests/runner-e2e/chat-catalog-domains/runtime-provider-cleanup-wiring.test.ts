import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const mocks = vi.hoisted(() => ({ verify: vi.fn(), events: vi.fn(), command: "", bytes: Buffer.from("actual synthetic build-owned bytes") }));
vi.mock("./runtime-native-fault.js", async importOriginal => ({ ...await importOriginal<typeof import("./runtime-native-fault.js")>(), verifyOwnedNativeRunner: mocks.verify }));
vi.mock("../run-observations.js", () => ({ collectRunEvents: mocks.events }));
vi.mock("../../../server/src/services/hot-restart.js", () => ({ readProcessStartedAt: async () => "2026-10-26T12:00:01Z" }));
vi.mock("node:fs/promises", () => ({ realpath: async (value: string) => value, readFile: async () => mocks.bytes }));
vi.mock("node:child_process", () => ({ execFile: (_file: string, args: string[], _options: unknown, callback: (error: null, value: { stdout: string }) => void) => {
  const values: Record<string, string> = { "uid=": "501", "ppid=": "987653", "comm=": process.execPath, "args=": mocks.command };
  callback(null, { stdout: values[args.at(-1)!] ?? "" });
} }));
import { releaseOwnedCleanupProvider, suspendOwnedProviderForCleanup } from "./runtime-provider-cleanup.js";
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const pid = 987654, start = "2026-10-26T12:00:01Z";
  const run = { id: "run", companyId: "company", nativeIssueId: "source", agentId: "lead", runnerInstanceId: "runner", nativeSessionId: "session", startedAt: "2026-10-26T12:00:00Z",
    runnerProfileJson: { sessionCheckpoint: { process: { providerPid: pid, providerProcessStartedAt: start } }, nativeExecutionInput: { provider: { kind: "opencode" } } } };
  mocks.verify.mockResolvedValue({ run, identity: { pid: 987653, uid: 501 } });
  mocks.events.mockResolvedValue([{ payload: { prpEvent: { runId: "run", normalizedSessionId: "session", sourceKind: "runner", sourceInstanceId: "runner", eventType: "session.started", payload: { processId: pid, providerSessionId: "provider-session" } } } }]);
  const script = new URL("../../../packages/paperclip-runner/dist/cli/opencode-app-server-proxy.cjs", import.meta.url).pathname;
  mocks.command = `${process.execPath} ${script}`;
  const evidence = vi.fn(async () => {}), kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const ctx = { scenario: { id: "recovery.post-stop-message" }, input: { evidence } } as unknown as ChatCatalogContext;
  return { ctx, evidence, kill, binding: { runId: "run", issueId: "source", agentId: "lead" } };
}
it("binds the actual checkpoint/event PID to the build-owned OpenCode proxy, never signalling the SDK server or a group", async () => {
  const f = fixture();
  try {
    await suspendOwnedProviderForCleanup(f.ctx, f.binding);
    expect(f.kill).toHaveBeenCalledExactlyOnceWith(987654, "SIGSTOP");
    expect(f.evidence).toHaveBeenCalledWith("runtime-cleanup-owned-provider.json", expect.objectContaining({ providerKind: "opencode", cleanupBoundary: "owned-protocol-proxy-retirement", sdkServerExitRequired: false, groupSignalled: false, proxyScriptSha256: createHash("sha256").update(mocks.bytes).digest("hex") }));
  } finally { await releaseOwnedCleanupProvider(f.ctx); }
  expect(f.kill.mock.calls).toEqual([[987654, "SIGSTOP"], [987654, 0], [987654, "SIGCONT"]]);
});
it("refuses a different proxy script, extra arguments or a missing same-session receipt before any signal", async () => {
  for (const change of [() => { mocks.command = `${process.execPath} /foreign/opencode-app-server-proxy.cjs`; }, () => { mocks.command += " --foreign"; }, () => { mocks.events.mockResolvedValue([]); }]) {
    const f = fixture(); change();
    await expect(suspendOwnedProviderForCleanup(f.ctx, f.binding)).rejects.toThrow(); expect(f.kill).not.toHaveBeenCalled(); f.kill.mockRestore();
  }
});
