import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import opened from "../fixtures/issue-opened.json" with { type: "json" };
import edited from "../fixtures/issue-edited.json" with { type: "json" };
import closed from "../fixtures/issue-closed.json" with { type: "json" };
import { handleWebhook } from "../../src/worker.js";

const SECRET = "topsecret";
const config = {
  hmacSecret: SECRET, ceoAgentId: "agent-ceo", labelGate: "agent-eligible",
  repoToProject: { "acme/sample-repo": "project-1" }, companyId: "company-1",
};

function sign(body: string) {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

function makeCtx() {
  const issues = new Map<string, any>();
  return {
    config,
    state: {
      _store: new Map<string,string>(),
      get: async function (s: any) { return this._store.get(s.stateKey) ?? null; },
      set: async function (s: any, v: string) { this._store.set(s.stateKey, v); },
    },
    issues: {
      list: vi.fn(async (q: any) => {
        const out: any[] = [];
        for (const v of issues.values()) if (v.originKind === q.originKind && v.originId === q.originId) out.push({ id: v.id });
        return out;
      }),
      create: vi.fn(async (input: any) => {
        const v = { id: `i-${issues.size+1}`, ...input, status: input.status ?? "todo" };
        issues.set(v.id, v);
        return v;
      }),
      update: vi.fn(async (issueId: string, patch: any, _companyId: string) => {
        const e = issues.get(issueId); if (e) Object.assign(e, patch);
        return e;
      }),
      createComment: vi.fn(async () => undefined),
      requestWakeup: vi.fn(async () => undefined),
    },
    _issues: issues,
  };
}

async function deliver(ctx: any, event: string, payload: unknown, deliveryId: string) {
  const body = JSON.stringify(payload);
  await handleWebhook({
    endpointKey: "github",
    headers: {
      "x-hub-signature-256": sign(body),
      "x-github-event": event,
      "x-github-delivery": deliveryId,
    },
    rawBody: body,
    parsedBody: payload,
    requestId: deliveryId,
  } as any, ctx as any, config);
}

describe("full lifecycle", () => {
  it("opened -> edited -> closed", async () => {
    const ctx = makeCtx();
    await deliver(ctx, "issues", opened, "d1");
    expect(ctx._issues.size).toBe(1);
    await deliver(ctx, "issues", edited, "d2");
    expect(ctx.issues.createComment).toHaveBeenCalled();
    expect(ctx.issues.requestWakeup).toHaveBeenCalled();
    await deliver(ctx, "issues", closed, "d3");
    const [created] = [...ctx._issues.values()];
    expect(created.status).toBe("done");
  });

  it("rejects bad signature without side effects", async () => {
    const ctx = makeCtx();
    const body = JSON.stringify(opened);
    await handleWebhook({
      endpointKey: "github",
      headers: { "x-hub-signature-256": "sha256=00", "x-github-event": "issues", "x-github-delivery": "d-bad" },
      rawBody: body, parsedBody: opened, requestId: "d-bad",
    } as any, ctx as any, config);
    expect(ctx._issues.size).toBe(0);
  });

  it("redelivery (same deliveryId) is no-op", async () => {
    const ctx = makeCtx();
    await deliver(ctx, "issues", opened, "d-same");
    await deliver(ctx, "issues", opened, "d-same");
    await deliver(ctx, "issues", opened, "d-same");
    expect(ctx._issues.size).toBe(1);
    expect(ctx.issues.create).toHaveBeenCalledOnce();
  });
});
