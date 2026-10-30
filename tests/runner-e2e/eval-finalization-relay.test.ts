import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { EVAL_FINALIZATION_LIMITS, finalizeEvalAttemptThroughRelay } from "./eval-finalization-relay.js";

it("meters finalization after the worker has closed without changing the original trace or failed outcome", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eval-finalization-ingestion-"));
  try {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const input = { receipt: { projectId, traceId: "a".repeat(32), spanId: "b".repeat(16), status: "pending" as const,
      verification: "unverified" as const, nativeConfiguration: "configured" as const },
      identity: { campaignId: "campaign", attemptId: "attempt", executionId: "fixture.local", provider: "fixture", model: "fixture", environment: "local" },
      provenance: { suiteId: "fixture", suiteDefinitionHash: "c".repeat(64), profileId: "fixture", caseId: "case", sourceRevision: "d".repeat(40) },
      result: { startedAt: new Date(Date.now() - 60_000).toISOString(), status: "failed" as const, cleanup: "failed" as const } };
    const before = structuredClone(input);
    let sentBytes = 0;
    const upstream = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://api.braintrust.dev/otel/v1/traces");
      expect(init!.headers).toMatchObject({ authorization: "Bearer upstream-private" });
      const body = Buffer.from(init!.body as Uint8Array); sentBytes = body.length;
      expect(body.toString()).toContain("paperclip.eval.finalization");
      expect(body.includes(Buffer.from(input.receipt.traceId, "hex"))).toBe(true);
      return new Response(null, { status: 200, headers: { "content-type": "application/x-protobuf" } });
    });
    const file = path.join(root, "finalization.jsonl");
    const result = await finalizeEvalAttemptThroughRelay({ projectId, apiKey: "upstream-private" }, input, file, upstream);
    expect(result).toMatchObject({ status: "accepted", outcome: "failed" });
    expect(input).toEqual(before);
    const raw = await readFile(file, "utf8"), records = raw.trim().split("\n").map(line => JSON.parse(line));
    expect(records[0]).toMatchObject({ campaignId: "campaign", attemptId: "attempt", limits: EVAL_FINALIZATION_LIMITS });
    expect(records.at(-1)).toMatchObject({ type: "closed", admittedRequests: 1, admittedBytes: sentBytes, acceptedRequests: 1 });
    expect(raw).not.toContain("upstream-private");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await finalizeEvalAttemptThroughRelay({ projectId, apiKey: "upstream-private" }, input, file, upstream))
      .toMatchObject({ status: "failed", errorCode: "finalization_ingestion_unavailable" });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await readFile(file, "utf8")).toBe(raw);
  } finally { await rm(root, { recursive: true, force: true }); }
});
