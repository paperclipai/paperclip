import { describe, expect, it, vi } from "vitest";
import { HttpError, badRequest } from "../../errors.js";
import { SessionAuthorityEpoch } from "./native-session-executor.js";
import type { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { executeRunnerApi } from "./runner-api-client.js";
import { TOOL_CALL_LOOP_REFUSAL_LIMIT, TOOL_CALL_LOOP_RUN_REFUSAL_LIMIT, ToolCallLoopError } from "./repeated-tool-failure-guard.js";

const context = { companyId: "company-a", issueId: "issue-a", issueIdentifier: "API-1", runId: "run-a", workMode: "standard" };

function epochWith(execute: (call: { tool: string; callId: string; arguments: unknown }) => Promise<unknown>) {
  const authority = { execute: vi.fn(execute), close: () => {} };
  return { authority, epoch: new SessionAuthorityEpoch("run-a", authority as unknown as PaperclipRunnerToolAuthority) };
}

const failure = (epoch: SessionAuthorityEpoch, call: { tool: string; callId: string; arguments: unknown }) =>
  epoch.execute(call).then(() => null, (error: Error) => error);

describe("repeated identical failing tool calls", () => {
  // Recorded cohort run: a model host dropped `body`, and the model resent the
  // same body-less PATCH twelve times, each refused before sending.
  const dropped = { operationId: "PATCH /api/issues/{id}", pathParams: { id: "issue-a" }, query: {}, responseText: { limitBytes: 8192 } };

  it("corrects the second identical failure and does not run the third", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { authority, epoch } = epochWith(async call => executeRunnerApi(call.arguments as never, context,
      { apiUrl: "http://127.0.0.1:3100", token: "t", fetch: fetcher, readFile: async () => { throw new Error("unused"); }, saveResponse: async () => { throw new Error("unused"); } }));
    const call = (n: number) => ({ tool: "call_api", callId: `call-${n}`, arguments: dropped });

    const first = await failure(epoch, call(1));
    expect(first?.message).toMatch(/^This request was not sent: PATCH \/api\/issues\/\{id\} requires body/);
    expect(first?.message).not.toContain("failed 2 times");

    const second = await failure(epoch, call(2));
    expect(second).toBeInstanceOf(HttpError);
    expect((second as HttpError).status).toBe(400);
    // The original correction stays visible, followed by what arrived and what to do.
    expect(second?.message).toContain(first!.message);
    expect(second?.message).toContain("failed 2 times with the same arguments");
    expect(second?.message).toContain("Arguments received each time: operationId, pathParams, query, responseText.");
    expect(second?.message).toContain("Paperclip will not run this exact call again in this run");

    // Both the correction and the refusal name a call the model can copy.
    const example = '{"operationId":"PATCH /api/issues/{id}","pathParams":{"id":"issue-a"},"body":{"title":"<title>"}}';
    expect(first?.message).toContain(`for example: ${example}`);
    expect(second?.message).toContain(example);

    for (const n of [3, 4, 5]) {
      const blocked = await failure(epoch, call(n));
      expect(blocked?.message).toMatch(/^This call was not run: call_api already failed 2 times/);
      expect(blocked?.message).toContain(first!.message);
      expect(blocked?.message).toContain(example);
    }
    expect(authority.execute).toHaveBeenCalledTimes(2);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("after N refusals the guard raises a turn-stopping loop error", async () => {
    const { authority, epoch } = epochWith(async () => { throw badRequest("body is required"); });
    const call = (n: number) => ({ tool: "call_api", callId: `loop-${n}`, arguments: dropped });
    await failure(epoch, call(1));
    await failure(epoch, call(2));
    for (let n = 1; n < TOOL_CALL_LOOP_REFUSAL_LIMIT; n++) {
      const refused = await failure(epoch, call(2 + n));
      expect(refused).not.toBeInstanceOf(ToolCallLoopError);
      expect(refused?.message).toMatch(/^This call was not run/);
    }
    const stopped = await failure(epoch, call(2 + TOOL_CALL_LOOP_REFUSAL_LIMIT));
    expect(stopped).toBeInstanceOf(ToolCallLoopError);
    expect(stopped).toMatchObject({ code: "agent_tool_call_loop", tool: "call_api", refusals: TOOL_CALL_LOOP_REFUSAL_LIMIT,
      argumentNames: ["operationId", "pathParams", "query", "responseText"] });
    expect(authority.execute).toHaveBeenCalledTimes(2);
  });

  it("stops the turn once refusals across different calls reach the run limit", async () => {
    const { epoch } = epochWith(async () => { throw badRequest("body is required"); });
    let stopped: Error | null = null;
    let refusals = 0;
    for (let variant = 0; !stopped && variant < TOOL_CALL_LOOP_RUN_REFUSAL_LIMIT; variant++) {
      const args = { ...dropped, pathParams: { id: `issue-${variant}` } };
      for (let n = 0; n < 2 + TOOL_CALL_LOOP_REFUSAL_LIMIT - 1 && !stopped; n++) {
        const error = await failure(epoch, { tool: "call_api", callId: `v${variant}-${n}`, arguments: args });
        if (error instanceof ToolCallLoopError) stopped = error;
        else if (error?.message.startsWith("This call was not run")) refusals++;
      }
    }
    expect(stopped).toBeInstanceOf(ToolCallLoopError);
    expect(refusals + 1).toBe(TOOL_CALL_LOOP_RUN_REFUSAL_LIMIT);
  });

  it("runs the call again once its arguments change", async () => {
    const { authority, epoch } = epochWith(async call => {
      if (!(call.arguments as { body?: unknown }).body) throw badRequest("body is required");
      return { ok: true };
    });
    await failure(epoch, { tool: "call_api", callId: "a", arguments: dropped });
    await failure(epoch, { tool: "call_api", callId: "b", arguments: dropped });
    await expect(epoch.execute({ tool: "call_api", callId: "c", arguments: { ...dropped, body: { title: "x" } } })).resolves.toEqual({ ok: true });
    expect(authority.execute).toHaveBeenCalledTimes(3);
  });

  it("passes failures that may not repeat through unchanged and keeps running them", async () => {
    const outage = new HttpError(503, "Paperclip API unavailable");
    const { authority, epoch } = epochWith(async () => { throw outage; });
    for (const n of [1, 2, 3]) expect(await failure(epoch, { tool: "call_api", callId: `${n}`, arguments: dropped })).toBe(outage);
    expect(authority.execute).toHaveBeenCalledTimes(3);
  });

  it("passes the first failure through unchanged and counts only matching errors", async () => {
    let n = 0;
    const { authority, epoch } = epochWith(async () => { throw badRequest(`refusal ${++n}`); });
    const errors = [];
    for (const id of ["1", "2", "3"]) errors.push(await failure(epoch, { tool: "create_task", callId: id, arguments: { title: "t" } }));
    expect(errors.map(error => error?.message)).toEqual(["refusal 1", "refusal 2", "refusal 3"]);
    expect(authority.execute).toHaveBeenCalledTimes(3);
  });
  it("counts identical calls sent in parallel and runs at most two of them", async () => {
    const { authority, epoch } = epochWith(async () => { await new Promise(resolve => setTimeout(resolve, 5)); throw badRequest("body is required"); });
    const errors = await Promise.all([1, 2, 3, 4].map(n => failure(epoch, { tool: "call_api", callId: `p${n}`, arguments: dropped })));
    expect(authority.execute).toHaveBeenCalledTimes(2);
    expect(errors[0]?.message).toBe("body is required");
    expect(errors[1]?.message).toContain("failed 2 times with the same arguments");
    expect(errors[2]?.message).toMatch(/^This call was not run/);
    expect(errors[3]?.message).toMatch(/^This call was not run/);
  });

  it("does not hold back a different call while an identical one runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { epoch } = epochWith(async call => { if (call.callId === "slow") await gate; return call.callId; });
    const slow = epoch.execute({ tool: "list_agents", callId: "slow", arguments: {} });
    await expect(epoch.execute({ tool: "list_projects", callId: "other", arguments: {} })).resolves.toBe("other");
    release();
    await expect(slow).resolves.toBe("slow");
  });

  // A route's own validation rejection comes back as data, not as a thrown error.
  const rejected = (status: number | null, data: unknown = { error: "Validation error", details: [{ path: ["status"], message: "Invalid enum value" }] }) =>
    ({ ok: false, status, apiOperationId: "PATCH /api/issues/{id}", contentType: "application/json", data });
  const invalid = { operationId: "PATCH /api/issues/{id}", pathParams: { id: "issue-a" }, body: { status: "started" } };

  it("counts a route's validation rejection returned as ok:false, corrects the second and does not run the third", async () => {
    const { authority, epoch } = epochWith(async () => rejected(422));
    const call = (n: number) => ({ tool: "call_api", callId: `r${n}`, arguments: invalid });

    expect(await epoch.execute(call(1))).toEqual(rejected(422));
    const second = await epoch.execute(call(2)) as Record<string, unknown>;
    expect(second).toMatchObject({ ok: false, status: 422, data: rejected(422).data });
    expect(second.guidance).toContain("failed 2 times with the same arguments");
    expect(second.guidance).toContain("Arguments received each time: body, operationId, pathParams.");
    expect(second.guidance).toContain("Paperclip will not run this exact call again in this run");

    for (const n of [3, 4]) {
      const blocked = await failure(epoch, call(n));
      expect(blocked).toBeInstanceOf(HttpError);
      expect((blocked as HttpError).status).toBe(422);
      expect(blocked?.message).toMatch(/^This call was not run: call_api already failed 2 times/);
      expect(blocked?.message).toContain("The response each time was HTTP 422: ");
      expect(blocked?.message).toContain("Invalid enum value");
    }
    expect(authority.execute).toHaveBeenCalledTimes(2);
  });

  it("still runs a changed call after refusing a returned rejection", async () => {
    const { authority, epoch } = epochWith(async call => (call.arguments as typeof invalid).body.status === "started" ? rejected(400) : { ok: true, status: 200 });
    for (const n of [1, 2, 3]) await epoch.execute({ tool: "call_api", callId: `r${n}`, arguments: invalid }).catch(() => null);
    await expect(epoch.execute({ tool: "call_api", callId: "fixed", arguments: { ...invalid, body: { status: "in_progress" } } }))
      .resolves.toEqual({ ok: true, status: 200 });
    expect(authority.execute).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["server error", 500], ["unavailable", 503], ["rate limit", 429], ["timeout", 408], ["conflict", 409], ["not found", 404], ["no response", null],
  ] as const)("keeps retrying a returned %s (%s), which may succeed unchanged", async (_label, status) => {
    const { authority, epoch } = epochWith(async () => rejected(status, { error: "try again" }));
    for (const n of [1, 2, 3, 4]) {
      const result = await epoch.execute({ tool: "call_api", callId: `t${n}`, arguments: invalid }) as Record<string, unknown>;
      expect(result).toEqual(rejected(status, { error: "try again" }));
    }
    expect(authority.execute).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["rate limit", new HttpError(429, "Too many requests")],
    ["conflict", new HttpError(409, "Issue was updated by someone else")],
    ["timeout", Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })],
  ])("keeps retrying a thrown %s, which may succeed unchanged", async (_label, transient) => {
    const { authority, epoch } = epochWith(async () => { throw transient; });
    for (const n of [1, 2, 3]) expect(await failure(epoch, { tool: "call_api", callId: `${n}`, arguments: invalid })).toBe(transient);
    expect(authority.execute).toHaveBeenCalledTimes(3);
  });

  it("forgets a returned rejection once a different call succeeds, because the state it checked may have changed", async () => {
    let unblocked = false;
    const { authority, epoch } = epochWith(async call => call.tool === "call_api"
      ? (unblocked ? { ok: true, status: 200 } : rejected(422, { error: "Resolve the blockers first" }))
      : (unblocked = true, { ok: true }));
    const patch = (n: number) => ({ tool: "call_api", callId: `s${n}`, arguments: invalid });
    await epoch.execute(patch(1));
    await epoch.execute(patch(2));
    await expect(epoch.execute({ tool: "update_blockers", callId: "unblock", arguments: { blockedByIssueIds: [] } })).resolves.toEqual({ ok: true });
    await expect(epoch.execute(patch(3))).resolves.toEqual({ ok: true, status: 200 });
    expect(authority.execute).toHaveBeenCalledTimes(4);
  });

  it("keeps counting a returned rejection when unrelated calls in between fail transiently", async () => {
    const { authority, epoch } = epochWith(async call => call.tool === "call_api"
      ? rejected(422)
      : { ok: false, status: call.callId === "u1" ? 503 : call.callId === "u2" ? 429 : null, error: "try again" });
    const patch = (n: number) => ({ tool: "call_api", callId: `i${n}`, arguments: invalid });
    await epoch.execute(patch(1));
    await epoch.execute({ tool: "list_agents", callId: "u1", arguments: {} });
    const second = await epoch.execute(patch(2)) as Record<string, unknown>;
    expect(second.guidance).toContain("failed 2 times with the same arguments");
    await epoch.execute({ tool: "list_agents", callId: "u2", arguments: {} });
    await epoch.execute({ tool: "list_agents", callId: "u3", arguments: {} });
    expect((await failure(epoch, patch(3)))?.message).toMatch(/^This call was not run/);
    expect(authority.execute.mock.calls.filter(([call]) => call.tool === "call_api")).toHaveLength(2);
  });
});
