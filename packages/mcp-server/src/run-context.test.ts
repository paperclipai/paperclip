import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperclipApiClient } from "./client.js";
import { createToolDefinitions } from "./tools.js";

const R1 = "11111111-1111-4111-8111-111111111111";
const R2 = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT_RUN = "33333333-3333-4333-8333-333333333333";
const STALE = "44444444-4444-4444-8444-444444444444";
const ISSUE = "55555555-5555-4555-8555-555555555555";
const AGENT = "66666666-6666-4666-8666-666666666666";
const COMPANY = "77777777-7777-4777-8777-777777777777";
const writes: Array<[string, Record<string, unknown>]> = [
  ["paperclipCreateIssue", { title: "Synthetic child", parentId: ISSUE, assigneeAgentId: AGENT, status: "todo" }],
  ["paperclipUpdateIssue", { issueId: ISSUE, status: "done" }],
  ["paperclipAddComment", { issueId: ISSUE, body: "Synthetic result" }],
  ["paperclipCheckoutIssue", { issueId: ISSUE, agentId: AGENT }],
];
function client() { return new PaperclipApiClient({ apiUrl: "http://paperclip.invalid/api", apiKey: "synthetic-agent-key", companyId: COMPANY, agentId: AGENT, runId: STALE }); }
function tool(api: PaperclipApiClient, name: string) { const value = createToolDefinitions(api).find(t => t.name === name); if (!value) throw new Error(name); return value; }
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }); }
function body(value: { content: Array<{ text: string }> }) { return JSON.parse(value.content[0]!.text); }

describe("request-local Paperclip run context", () => {
  let seen: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }>;
  beforeEach(() => {
    seen = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const runId = headers["X-Paperclip-Run-Id"];
      seen.push({ url: String(url), method: init.method!, headers, body: init.body ? JSON.parse(String(init.body)) : null });
      if (runId === OTHER_AGENT_RUN) return response({ error: "run belongs to another agent" }, 403);
      if (String(url).includes("/foreign-checkout") && runId !== R1) return response({ error: "checkout belongs to another run" }, 409);
      await new Promise(resolve => setTimeout(resolve, runId === R1 ? 5 : 0));
      return response({ ok: true, runId });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  for (const [name, args] of writes) {
    it(`${name} requires a UUID before any API request`, async () => {
      for (const value of [undefined, "", "not-a-uuid"]) {
        const result = await tool(client(), name).execute({ ...args, ...(value === undefined ? {} : { paperclipRunId: value }) });
        expect(body(result).error).toBeTruthy();
      }
      expect(seen).toHaveLength(0);
    });
    it(`${name} forwards per-call header and strips the control argument from JSON`, async () => {
      const result = await tool(client(), name).execute({ ...args, paperclipRunId: R2 });
      expect(body(result).ok).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.headers["X-Paperclip-Run-Id"]).toBe(R2);
      expect(seen[0]!.headers.Authorization).toBe("Bearer synthetic-agent-key");
      expect(seen[0]!.body).not.toHaveProperty("paperclipRunId");
      expect(seen[0]!.body).not.toHaveProperty("runId");
      if (name === "paperclipCreateIssue") {
        expect(seen[0]!.body).toMatchObject({ parentId: ISSUE, assigneeAgentId: AGENT });
      }
    });
  }
  it("supports successive runs without a stale startup env fallback", async () => {
    const api = client(), update = tool(api, "paperclipUpdateIssue");
    await update.execute({ issueId: ISSUE, status: "done", paperclipRunId: R1 });
    await update.execute({ issueId: ISSUE, status: "done", paperclipRunId: R2 });
    expect(seen.map(x => x.headers["X-Paperclip-Run-Id"])).toEqual([R1, R2]);
    await update.execute({ issueId: ISSUE, status: "done" });
    expect(seen).toHaveLength(2);
    expect(api.defaults.runId).toBe(STALE);
  });
  it("isolates parallel calls and cleans the context on completion", async () => {
    const api = client(), update = tool(api, "paperclipUpdateIssue");
    const values = await Promise.all([R1, R2, R1, R2].map(paperclipRunId => update.execute({ issueId: ISSUE, status: "done", paperclipRunId })));
    expect(values.map(x => body(x).runId)).toEqual([R1, R2, R1, R2]);
    expect(seen.map(x => x.headers["X-Paperclip-Run-Id"])).toEqual([R1, R2, R1, R2]);
    await expect(api.requestJson("PATCH", "/issues/synthetic", { body: { status: "done" } })).rejects.toThrow(/run id/i);
    expect(seen).toHaveLength(4);
  });
  it("keeps each run ID after overlapping helpers await reads before writing", async () => {
    const api = client(), control = tool(api, "paperclipControlIssueWorkspaceServices");
    const pendingReads: Array<() => void> = [];
    let bothReading!: () => void;
    const readsStarted = new Promise<void>(resolve => { bothReading = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      seen.push({ url: String(url), method: init.method!, headers, body: init.body ? JSON.parse(String(init.body)) : null });
      if (init.method === "GET") {
        await new Promise<void>(resolve => {
          pendingReads.push(resolve);
          if (pendingReads.length === 2) bothReading();
        });
        return response({ currentExecutionWorkspace: { id: "synthetic-workspace", runtimeServices: [] } });
      }
      return response({ ok: true, runId: headers["X-Paperclip-Run-Id"] });
    }));
    const first = control.execute({ issueId: ISSUE, action: "restart", paperclipRunId: R1 });
    const second = control.execute({ issueId: ISSUE, action: "restart", paperclipRunId: R2 });
    await readsStarted;
    expect(seen.map(x => x.method)).toEqual(["GET", "GET"]);
    pendingReads[1]!();
    expect(body(await second).runId).toBe(R2);
    pendingReads[0]!();
    expect(body(await first).runId).toBe(R1);
    expect(seen.filter(x => x.method === "POST").map(x => x.headers["X-Paperclip-Run-Id"])).toEqual([R2, R1]);
    expect(api.defaults.runId).toBe(STALE);
    await expect(api.requestJson("PATCH", "/issues/synthetic", { body: {} })).rejects.toThrow(/run id/i);
  });
  it("does not let includeRunId=false bypass write validation", async () => {
    await expect(client().requestJson("POST", "/issues/synthetic", { body: {}, includeRunId: false })).rejects.toThrow(/run id/i);
    expect(seen).toHaveLength(0);
  });
  it("leaves reads usable without a run ID and sends no startup header", async () => {
    const result = await tool(client(), "paperclipGetIssue").execute({ issueId: ISSUE });
    expect(body(result).ok).toBe(true); expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.headers).not.toHaveProperty("X-Paperclip-Run-Id");
  });
  it("propagates wrong-agent backend rejection without retry", async () => {
    const result = await tool(client(), "paperclipUpdateIssue").execute({ issueId: ISSUE, status: "done", paperclipRunId: OTHER_AGENT_RUN });
    expect(body(result).status).toBe(403); expect(seen).toHaveLength(1);
  });
  it("propagates a foreign checkout rejection without retry", async () => {
    const result = await tool(client(), "paperclipCheckoutIssue").execute({ issueId: "foreign-checkout", paperclipRunId: R2 });
    expect(body(result).status).toBe(409); expect(seen).toHaveLength(1);
  });
  it("supports remaining write helpers through the same explicit context", async () => {
    const release = tool(client(), "paperclipReleaseIssue");
    const missing = await release.execute({ issueId: ISSUE });
    expect(body(missing).error).toMatch(/run id/i); expect(seen).toHaveLength(0);
    const ok = await release.execute({ issueId: ISSUE, paperclipRunId: R2 });
    expect(body(ok).ok).toBe(true); expect(seen[0]!.body).toEqual({});
  });
});
