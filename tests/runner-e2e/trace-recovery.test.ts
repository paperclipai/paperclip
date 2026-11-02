import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { EvalAttemptTrace, finalizeEvalAttemptTrace } from "./braintrust.js";
import { readInterruptedAttemptTrace } from "./trace-recovery.js";

it("finalizes a lost worker's original trace while rejecting unrelated or malformed snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eval-trace-recovery-"));
  const projectId = "11111111-1111-4111-8111-111111111111";
  const companyId = "22222222-2222-4222-8222-222222222222";
  const identity = { campaignId: "campaign", attemptId: "attempt", executionId: "execution", provider: "acpx", model: "claude", environment: "local" };
  const config = { projectId, apiKey: "synthetic-canary" };
  const trace = new EvalAttemptTrace(config, identity).snapshot();
  const saved = { ...trace, companyId, nativeConfiguration: "configured", privateCanary: "must-not-copy", finalization: { status: "accepted" } };
  const fixture = { companyId, executionId: identity.executionId };
  const snapshot = path.join(root, "snapshots/braintrust-trace.json");
  try {
    await mkdir(path.join(root, "snapshots"));
    await writeFile(path.join(root, "snapshots/fixtures.json"), JSON.stringify(fixture));
    await writeFile(snapshot, JSON.stringify(saved));
    const recovered = await readInterruptedAttemptTrace(root, { projectId, executionId: identity.executionId });
    expect(recovered).toMatchObject({ traceId: trace.traceId, spanId: trace.spanId, status: "pending", verification: "unverified" });
    expect(recovered).not.toHaveProperty("privateCanary");
    expect(recovered).not.toHaveProperty("finalization");
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const body = init!.body as Buffer;
      expect(body.includes(Buffer.from(trace.traceId, "hex"))).toBe(true);
      expect(body.includes(Buffer.from(trace.spanId, "hex"))).toBe(true);
      expect(body.toString()).not.toContain("must-not-copy");
      return new Response(null, { status: 200 });
    });
    expect(await finalizeEvalAttemptTrace(config, { receipt: recovered!, identity,
      provenance: { suiteId: "suite", suiteDefinitionHash: "a".repeat(64), profileId: "profile", caseId: "case", sourceRevision: "b".repeat(40) },
      result: { startedAt: new Date(Date.now() - 1000).toISOString(), status: "failed", cleanup: "failed", failureClass: "cleanup_failure" },
    }, transport)).toMatchObject({ status: "accepted", outcome: "failed", verification: "unverified" });
    expect(transport).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(snapshot, "utf8"))).toEqual(saved);
    expect(await readInterruptedAttemptTrace(root, { projectId: companyId, executionId: identity.executionId })).toBeUndefined();
    expect(await readInterruptedAttemptTrace(root, { projectId, executionId: "other" })).toBeUndefined();
    for (const delta of [{ companyId: projectId }, { spanId: "0".repeat(16) }, { traceId: "invalid" }, { revision: "invalid" }, { nativeConfiguration: "unknown" }]) {
      await writeFile(snapshot, JSON.stringify({ ...saved, ...delta }));
      expect(await readInterruptedAttemptTrace(root, { projectId, executionId: identity.executionId })).toBeUndefined();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
