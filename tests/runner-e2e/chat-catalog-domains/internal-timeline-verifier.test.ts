import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";

const port = vi.hoisted(() => ({ handler: undefined as any, providerToken: "", executed: [] as string[][], infrastructureFailure: false }));
vi.mock("node:http", () => ({ createServer: (handler: unknown) => {
  port.handler = handler;
  return { closeAllConnections: vi.fn(), close: (done: () => void) => done() };
} }));
vi.mock("../../e2e/fetch-allowed-port.js", () => ({ listenOnFetchAllowedPort: async () => 43123 }));
// Execute only the owning verifier's unchanged bounded Node command on synthetic
// HTML; no server, browser, application or native agent process is started.
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFile: (...args: any[]) => {
    port.executed.push(args[1]);
    if (port.infrastructureFailure) { queueMicrotask(() => args[3](Object.assign(Error("synthetic command unavailable"), { code: "ENOENT" }))); return; }
    return (actual.execFile as any)(...args);
  } };
});
import { startTimelineVerifier } from "./internal-timeline-verifier.js";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const broken = '<h1>Launch</h1><input id="email">';
const repaired = '<h1>Launch</h1><label for="email">Email</label><input id="email">';
type Options = { wrongTask?: boolean; foreignCompany?: boolean; wrongWorker?: boolean; wrongRun?: boolean;
  stopped?: boolean; infrastructureFailure?: boolean; changedAfterCommand?: boolean; missingFile?: boolean; wrongFile?: boolean; badEncoding?: boolean; oversized?: boolean; changedCheckout?: boolean };
function fixture(options: Options = {}) {
  port.executed.splice(0); port.providerToken = ""; port.infrastructureFailure = options.infrastructureFailure ?? false;
  let body = broken, reads = 0, taskReads = 0;
  const current = () => ({ id: options.wrongTask ? "other" : "task", companyId: options.foreignCompany ? "foreign" : "company",
    assigneeAgentId: options.wrongWorker ? "foreign-worker" : "worker", executionRunId: options.wrongRun || options.changedCheckout && reads > 0 || options.changedAfterCommand && taskReads > 2 ? "other-run" : "native" });
  const agentDenied = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: URL | string, init: RequestInit) => {
    if (String(url).includes("/file-resources/content")) { agentDenied(); return new Response("Board access required", { status: 403 }); }
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer synthetic-worker-key");
    taskReads++; return new Response(JSON.stringify(current()));
  }));
  const get = vi.fn(async (path: string) => {
    expect(path).toBe("/api/issues/task/file-resources/content?workspace=execution&path=launch.html");
    reads++;
    if (options.missingFile) throw Error("Owned file absent");
    return { resource: { kind: "file", title: options.wrongFile ? "foreign.html" : "launch.html", workspaceKind: "execution_workspace" },
      content: { encoding: options.badEncoding ? "unknown" : "utf8", data: options.oversized ? "x".repeat(262_145) : body } };
  });
  const postSensitive = vi.fn(async (path: string, value: any) => {
    if (path.includes("/keys")) return { id: "worker-key", token: "synthetic-worker-key" };
    port.providerToken = value.credentialValues["credentials.authorization"];
    return { connectionId: "connection", actions: { readOnly: [{ catalogEntryId: "verify" }] } };
  });
  const ctx = { input: { privateSecrets: [] as string[], fixtures: { company: { id: "company" } },
    api: { baseURL: "https://fixture.test", get, postSensitive, post: vi.fn(async () => {}), putSensitive: vi.fn(async () => {}), delete: vi.fn(async () => {}) } },
    allRuns: vi.fn(async () => [{ id: "native", companyId: "company", agentId: "worker", status: options.stopped ? "cancelled" : "running", runtimeMode: "native", contextSnapshot: { issueId: "task" } }]),
  } as unknown as ChatCatalogContext;
  async function call(token = port.providerToken, arguments_: Record<string, unknown> = {}) {
    let status = 0, response = "";
    const req = { headers: { authorization: `Bearer ${token}` }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "verify_launch_html", arguments: arguments_ } })); } };
    const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; }, end(text = "") { response = text; } };
    await port.handler(req, res);
    return { status, body: response ? JSON.parse(response) : null };
  }
  return { ctx, get, call, agentDenied, setBody: (value: string) => { body = value; } };
}
it("actual verifier uses only authorized fixture read and executes genuine failed-then-repaired file checks", async () => {
  const f = fixture(); const verifier = await startTimelineVerifier(f.ctx, "task", ["worker", "repair-worker"]);
  try {
    const failed = await f.call();
    expect(failed.status).toBe(200); expect(failed.body.result.isError).toBe(true);
    expect(verifier.receipts).toHaveLength(1); expect(verifier.receipts[0]!.exitCode).toBe(1);
    expect(verifier.receipts[0]!.sha256).toBe(createHash("sha256").update(broken).digest("hex"));
    f.setBody(repaired);
    const passed = await f.call();
    expect(passed.status).toBe(200); expect(passed.body.result.isError).toBe(false);
    expect(verifier.receipts.map(row => row.exitCode)).toEqual([1, 0]);
    expect(verifier.receipts[1]!.sha256).toBe(createHash("sha256").update(repaired).digest("hex"));
    expect(port.executed).toHaveLength(2); expect(port.executed.every(argv => argv[0] === "-e")).toBe(true);
    expect(f.get).toHaveBeenCalledTimes(2); expect(f.agentDenied).not.toHaveBeenCalled();
  } finally { await verifier.close(); }
});
it.each([{ wrongTask: true }, { foreignCompany: true }, { wrongWorker: true }, { wrongRun: true }, { stopped: true },
  { missingFile: true }, { wrongFile: true }, { badEncoding: true }, { oversized: true }, { changedCheckout: true }])("actual verifier refuses invalid scope/custody/content %j without a fabricated exit receipt", async options => {
  const f = fixture(options); const verifier = await startTimelineVerifier(f.ctx, "task", ["worker"]);
  try {
    expect((await f.call()).status).toBe(502);
    expect(verifier.receipts).toEqual([]);
    expect(port.executed).toHaveLength(0);
  } finally { await verifier.close(); }
});
it("provider authentication failure cannot invoke the fixture board reader", async () => {
  const f = fixture(); const verifier = await startTimelineVerifier(f.ctx, "task", ["worker"]);
  try { expect((await f.call("unrelated-token")).status).toBe(401); expect(f.get).not.toHaveBeenCalled(); expect(verifier.receipts).toEqual([]); }
  finally { await verifier.close(); }
});

it("requested fake exit and path cannot replace the real fixed-file command outcome", async () => {
  const f = fixture(); const verifier = await startTimelineVerifier(f.ctx, "task", ["worker"]);
  try {
    const result = await f.call(port.providerToken, { exitCode: 0, path: "foreign.html" });
    expect(result.status).toBe(200);
    expect(verifier.receipts).toHaveLength(1);
    expect(verifier.receipts[0]).toMatchObject({ taskId: "task", runId: "native", filename: "launch.html", exitCode: 1 });
    expect(f.get).toHaveBeenCalledExactlyOnceWith("/api/issues/task/file-resources/content?workspace=execution&path=launch.html");
    expect(JSON.stringify(result.body)).not.toContain("synthetic-worker-key");
    expect(JSON.stringify(result.body)).not.toContain(port.providerToken);
  } finally { await verifier.close(); }
});
it.each([{ infrastructureFailure: true }, { changedAfterCommand: true }])("command infrastructure or post-command custody failure never fabricates a result %j", async options => {
  const f = fixture(options); const verifier = await startTimelineVerifier(f.ctx, "task", ["worker"]);
  try {
    expect((await f.call()).status).toBe(502);
    expect(port.executed).toHaveLength(1);
    expect(verifier.receipts).toEqual([]);
  } finally { await verifier.close(); }
});
