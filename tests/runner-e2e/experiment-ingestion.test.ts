import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EVAL_EXPERIMENT_LIMITS, openExperimentIngestion } from "./experiment-ingestion.js";

const projectId = "11111111-1111-4111-8111-111111111111", experimentId = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [], meters: Array<Awaited<ReturnType<typeof openExperimentIngestion>>> = [];
afterEach(async () => { await Promise.allSettled(meters.splice(0).map(meter => meter.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(transport: typeof fetch = async () => Response.json({ ok: true })) {
  const root = await mkdtemp(path.join(tmpdir(), "experiment-ingestion-")); roots.push(root);
  const policy = { projectId, campaignId: "campaign", deadlineAt: Date.now() + 60_000, receiptPath: path.join(root, "receipts.jsonl"), transport };
  const meter = await openExperimentIngestion(policy); meters.push(meter);
  return { ...meter, policy, records: async () => (await readFile(policy.receiptPath, "utf8")).trim().split("\n").map(line => JSON.parse(line)),
    send: (payload: unknown, endpoint = "experiment") => meter.transport(`https://api.braintrust.dev/v1/${endpoint}`, {
      method: "POST", body: JSON.stringify(payload), headers: { authorization: "Bearer private-secret" },
    }) };
}

it("durably meters payloads and scores before dispatch while retaining body-free private evidence", async () => {
  const upstream = vi.fn<typeof fetch>(async (_url, init) => {
    expect((await f.records()).at(-1)).toMatchObject({ type: "admitted", bodyBytes: init?.body === undefined ? 0 : Buffer.byteLength(String(init.body)) });
    expect(init!.redirect).toBe("error");
    return Response.json({ ok: true });
  });
  const f = await fixture(upstream);
  const create = { project_id: projectId, name: "private-payload-canary" };
  const insert = { events: [{ scores: { product_pass: 0, cleanup_pass: 0 }, input: "private-input-canary" }] };
  await f.send(create); await f.send(insert, `experiment/${experimentId}/insert`);
  await f.transport(`https://api.braintrust.dev/v1/experiment/${experimentId}/summarize`, { method: "GET" });
  await f.close();
  const records = await f.records();
  expect(records.at(-1)).toMatchObject({ type: "closed", admittedRequests: 3, admittedScores: 2,
    admittedBytes: Buffer.byteLength(JSON.stringify(create)) + Buffer.byteLength(JSON.stringify(insert)), unresolvedRequests: 0 });
  const raw = await readFile(f.policy.receiptPath, "utf8");
  expect(raw).not.toMatch(/private-secret|private-payload-canary|private-input-canary/);
  expect((await stat(f.policy.receiptPath)).mode & 0o777).toBe(0o600);
  await expect(openExperimentIngestion(f.policy)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(f.policy.receiptPath, "utf8")).toBe(raw);
});

it("keeps failed forwarding charged to the finite allowance and records an unresolved outcome", async () => {
  const upstream = vi.fn<typeof fetch>(async () => { throw new Error("private-upstream-error"); });
  const f = await fixture(upstream);
  for (let i = 0; i < EVAL_EXPERIMENT_LIMITS.maxRequests; i++) {
    await expect(f.send({ project_id: projectId })).rejects.toThrow("unconfirmed");
  }
  await expect(f.send({ project_id: projectId })).rejects.toThrow("allowance exhausted");
  expect(upstream).toHaveBeenCalledTimes(3);
  await f.close();
  expect((await f.records()).at(-1)).toMatchObject({ admittedRequests: 3, responses: 0, unresolvedRequests: 3 });
});

it.each([6, 7])("exports both deterministic grades for every retained case in a %i-case qualification", async cases => {
  const upstream = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  const f = await fixture(upstream);
  await f.send({ project_id: projectId });
  await f.send({ events: Array.from({ length: cases }, (_, index) => ({
    id: `attempt-${index}`, scores: { product_pass: Number(index !== 0), cleanup_pass: 1 },
  })) }, `experiment/${experimentId}/insert`);
  await f.transport(`https://api.braintrust.dev/v1/experiment/${experimentId}/summarize`, { method: "GET" });
  await f.close();
  expect(upstream).toHaveBeenCalledTimes(3);
  expect((await f.records()).at(-1)).toMatchObject({ admittedRequests: 3, admittedScores: cases * 2, unresolvedRequests: 0 });
});

it("retains an unresolved allowance when response headers arrive but the body disconnects", async () => {
  const f = await fixture(async () => new Response(new ReadableStream({ pull(controller) {
    controller.error(new Error("private-disconnect-error"));
  } }), { status: 200 }));
  await expect(f.send({ project_id: projectId })).rejects.toThrow("unconfirmed");
  await f.close();
  const rows = await f.records();
  expect(rows[2]).toMatchObject({ type: "outcome", outcome: "unconfirmed" });
  expect(rows.at(-1)).toMatchObject({ admittedRequests: 1, responses: 0, unresolvedRequests: 1 });
  expect(JSON.stringify(rows)).not.toContain("private-disconnect-error");
});

it("keeps a pending response body unresolved until the whole response is read", async () => {
  let finish!: () => void;
  const f = await fixture(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"ok":'));
    finish = () => { controller.enqueue(new TextEncoder().encode('true}')); controller.close(); };
  } })));
  const pending = f.send({ project_id: projectId });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect((await f.records()).at(-1)).toMatchObject({ type: "admitted" });
  await expect(f.send({ project_id: projectId })).rejects.toThrow("unavailable");
  finish();
  expect(await (await pending).json()).toEqual({ ok: true });
  await f.close();
  expect((await f.records()).at(-1)).toMatchObject({ responses: 1, unresolvedRequests: 0 });
});

it("refuses excess bytes, scores, foreign project and unqualified endpoints before dispatch", async () => {
  const upstream = vi.fn<typeof fetch>(async () => Response.json({}));
  const f = await fixture(upstream);
  await expect(f.send({ project_id: experimentId })).rejects.toThrow("project mismatch");
  await expect(f.send({ project_id: projectId, data: "x".repeat(EVAL_EXPERIMENT_LIMITS.maxTotalBytes) })).rejects.toThrow("byte limit");
  await expect(f.send({ events: Array.from({ length: EVAL_EXPERIMENT_LIMITS.maxScores + 1 }, () => ({ scores: { pass: 1 } })) }, `experiment/${experimentId}/insert`))
    .rejects.toThrow("allowance exhausted");
  await expect(f.send({}, "project")).rejects.toThrow("Unqualified");
  expect(upstream).not.toHaveBeenCalled();
  await f.close();
  expect((await f.records()).at(-1)).toMatchObject({ admittedRequests: 0, admittedBytes: 0, admittedScores: 0 });
});

it("refuses concurrent requests and expired windows without resetting reservations", async () => {
  let release!: () => void;
  const upstream = vi.fn<typeof fetch>(async () => { await new Promise<void>(resolve => { release = resolve; }); return Response.json({}); });
  const f = await fixture(upstream);
  const pending = f.send({ project_id: projectId });
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce());
  await expect(f.send({ project_id: projectId })).rejects.toThrow("unavailable");
  release(); await pending;
  const now = vi.spyOn(Date, "now").mockReturnValue(f.policy.deadlineAt);
  try { await expect(f.send({ project_id: projectId })).rejects.toThrow("unavailable"); }
  finally { now.mockRestore(); }
  expect(upstream).toHaveBeenCalledOnce();
});
