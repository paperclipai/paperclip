import { readFile } from "node:fs/promises";
import path from "node:path";
import { exportBraintrustAttemptParent, type EvalTraceReceipt } from "./braintrust.js";

export async function readInterruptedAttemptTrace(caseDirectory: string, expected: {
  projectId: string; executionId: string;
}): Promise<EvalTraceReceipt | undefined> {
  try {
    const snapshots = path.join(caseDirectory, "snapshots");
    const [fixture, trace] = await Promise.all(["fixtures.json", "braintrust-trace.json"].map(async name =>
      JSON.parse(await readFile(path.join(snapshots, name), "utf8"))));
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (fixture.executionId !== expected.executionId || !uuid.test(fixture.companyId)
      || trace.projectId !== expected.projectId || trace.companyId !== fixture.companyId
      || trace.revision !== undefined && !uuid.test(trace.revision)
      || !["pending", "accepted", "failed"].includes(trace.status)
      || !["not_started", "configured", "failed"].includes(trace.nativeConfiguration)) return;
    exportBraintrustAttemptParent(trace);
    return { projectId: trace.projectId, traceId: trace.traceId, spanId: trace.spanId,
      companyId: trace.companyId, ...(trace.revision ? { revision: trace.revision } : {}),
      status: trace.status, nativeConfiguration: trace.nativeConfiguration, verification: "unverified" };
  } catch { return; }
}
