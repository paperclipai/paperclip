import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { secretTestEndpoint } from "./external-secret-endpoint.js";
import { personalSecretWorkerReceipt } from "./external-personal-secret.js";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function context() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "personal-receipt-"))); roots.push(root);
  vi.stubEnv("PAPERCLIP_RUNNER_E2E_TEMP_ROOT", root); vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home")); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "receipt-control");
  return { scenario: { id: "secrets.personal-secret" }, input: { nonce: "receipt-control", execution: { environment: { id: "local" } }, fixtures: { company: { id: "company" } } } } as unknown as ChatCatalogContext;
}
it("mints a sanitized personal receipt only after actual key-authenticated HTTP success without legacy identity env", async () => {
  const ctx = await context(), credential = "synthetic-personal-value";
  const endpoint = await secretTestEndpoint(ctx, "morgan", credential, "PUBLISHING_API_KEY", undefined, { personalWorkerReceipt: true });
  try {
    const startedAt = new Date().toISOString();
    const result = await execute(process.execPath, [endpoint.scriptPath], { env: { PATH: process.env.PATH, PUBLISHING_API_KEY: credential } });
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({ ok: true, status: 200, check: "publishing endpoint", receiptId: expect.stringMatching(/^[a-f0-9]{48}$/) });
    expect(result.stdout).not.toContain(credential);
    const f = delivery(); f.run.startedAt = startedAt; f.run.finishedAt = new Date().toISOString();
    Object.assign(f.evidence.calls[0]!, endpoint.calls[0]!);
    f.evidence.events[0]!.createdAt = f.run.finishedAt;
    f.evidence.events[0]!.payload.prpEvent.payload.output = result.stdout;
    expect(personalSecretWorkerReceipt(f.run, f.evidence, f.expected)).toMatchObject({ receiptId: output.receiptId });
    for (const [url, method, key] of [[endpoint.url, "GET", "wrong"], [endpoint.url + "/wrong", "GET", credential], [endpoint.url, "POST", credential]]) {
      const response = await fetch(url!, { method, headers: { authorization: `Bearer ${key}` } });
      expect(response.status).toBe(403); expect((await response.json()).receiptId).toBeUndefined();
    }
    const repeated = await fetch(endpoint.url, { headers: { authorization: `Bearer ${credential}` } });
    const second = await repeated.json(); expect(second.receiptId).not.toBe(output.receiptId);
    expect(endpoint.calls.filter(call => call.receiptId).map(call => call.receiptId)).toEqual([output.receiptId, second.receiptId]);
  } finally { await endpoint.close(); }
});
it("preserves the legacy header contract when the personal receipt mode is absent", async () => {
  const endpoint = await secretTestEndpoint(await context(), "morgan", "synthetic-personal-value", "PUBLISHING_API_KEY");
  try {
    const response = await fetch(endpoint.url, { headers: { authorization: "Bearer synthetic-personal-value", "x-paperclip-agent": "morgan", "x-paperclip-run": "11111111-1111-4111-8111-111111111111" } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, check: "publishing endpoint", status: 200 });
  } finally { await endpoint.close(); }
});

function delivery() {
  const expected = { companyId: "company", agentId: "morgan", taskId: "task", userId: "person" };
  const run = { id: "worker", companyId: "company", agentId: "morgan", responsibleUserId: "person", runtimeMode: "native", status: "succeeded",
    contextSnapshot: { issueId: "task" }, startedAt: "2026-11-04T00:00:00.000Z", finishedAt: "2026-11-04T00:00:10.000Z" };
  const output = JSON.stringify({ ok: true, status: 200, check: "publishing endpoint", receiptId: "a".repeat(48) });
  const evidence = { task: { id: "task", companyId: "company", assigneeAgentId: "morgan", responsibleUserId: "person", status: "done" },
    calls: [{ authorized: true, agentId: "", runId: "", method: "GET", pathname: "/publishing-check", status: 200,
      createdAt: "2026-11-04T00:00:05.000Z", receiptId: "a".repeat(48) }],
    events: [{ runId: "worker", companyId: "company", agentId: "morgan", seq: 1, eventType: "tool.execution.completed",
      createdAt: "2026-11-04T00:00:06.000Z", payload: { prpEvent: { runId: "worker", eventType: "tool.execution.completed",
        payload: { name: "bash", status: "completed", exitCode: 0, outputTruncated: false, output } } } }] };
  return { expected, run, evidence };
}
it("binds a receipt to successful native output and allows repeated verification of the same bound receipt", () => {
  const f = delivery(); expect(personalSecretWorkerReceipt(f.run, f.evidence, f.expected)).toMatchObject({ runId: "worker", agentId: "morgan", receiptId: "a".repeat(48) });
  f.evidence.events.push({ ...f.evidence.events[0]!, seq: 2 });
  expect(personalSecretWorkerReceipt(f.run, f.evidence, f.expected)).toBeDefined();
});
it.each(["wrong key", "wrong path", "wrong status", "missing receipt", "forged receipt", "replayed receipt", "foreign run", "foreign agent", "foreign task", "foreign human", "failed output", "non-tool output", "input-only receipt"])("rejects %s as personal worker proof", fault => {
  const f = delivery(), call = f.evidence.calls[0]!, event = f.evidence.events[0]!, tool = event.payload.prpEvent.payload;
  if (fault === "wrong key") call.authorized = false;
  if (fault === "wrong path") call.pathname = "/wrong";
  if (fault === "wrong status") call.status = 403;
  if (fault === "missing receipt") call.receiptId = "";
  if (fault === "forged receipt") call.receiptId = "b".repeat(48);
  if (fault === "replayed receipt") call.createdAt = "2026-11-03T23:59:59.000Z";
  if (fault === "foreign run") event.runId = "foreign";
  if (fault === "foreign agent") event.agentId = "foreign";
  if (fault === "foreign task") f.evidence.task.id = "foreign";
  if (fault === "foreign human") f.run.responsibleUserId = "foreign";
  if (fault === "failed output") tool.exitCode = 1;
  if (fault === "non-tool output") event.eventType = "item.completed";
  if (fault === "input-only receipt") tool.output = "";
  expect(personalSecretWorkerReceipt(f.run, f.evidence, f.expected)).toBeUndefined();
});
it("does not enable the personal receipt option for other credential cases", async () => {
  const ctx = await context(); ctx.scenario.id = "secrets.least-scope-delivery";
  await expect(secretTestEndpoint(ctx, "morgan", "synthetic-personal-value", "PUBLISHING_API_KEY", undefined, { personalWorkerReceipt: true })).rejects.toThrow("dedicated personal-secret endpoint");
});
