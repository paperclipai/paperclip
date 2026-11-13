import { describe, expect, it, vi } from "vitest";
import { HttpError, badRequest } from "../../errors.js";
import { SessionAuthorityEpoch } from "./native-session-executor.js";
import type { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { executeRunnerApi } from "./runner-api-client.js";

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

    for (const n of [3, 4, 5]) {
      const blocked = await failure(epoch, call(n));
      expect(blocked?.message).toMatch(/^This call was not run: call_api already failed 2 times/);
      expect(blocked?.message).toContain(first!.message);
    }
    expect(authority.execute).toHaveBeenCalledTimes(2);
    expect(fetcher).not.toHaveBeenCalled();
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
});
