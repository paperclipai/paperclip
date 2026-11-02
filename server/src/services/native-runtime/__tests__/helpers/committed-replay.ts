import { heartbeatRuns, type Db } from "@paperclipai/db";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "@paperclipai/db/response-capture";
import { eq } from "drizzle-orm";
import { expect } from "vitest";

export async function verifyCommittedReplayPayloadReads(
  db: Db,
  binding: { runId: string; companyId: string; agentId: string },
  replay: () => Promise<void>,
) {
  const { runId, companyId, agentId } = binding;
  const bulk = "saved-native-input-sentinel🙂".repeat(40_000);
  const [original] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  await db.update(heartbeatRuns).set({
    contextSnapshot: { ...original.contextSnapshot, savedInput: bulk },
    runnerProfileJson: { savedInput: bulk, nativeExecutionInput: {
      schema: "paperclip.native-execution-input.v8", savedInput: bulk,
      provider: { kind: "muse", binding: { companyId, agentId, bindingId: runId } },
    } }, stdoutExcerpt: bulk, stderrExcerpt: bulk,
  }).where(eq(heartbeatRuns.id, runId));
  const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  const events: Array<Record<string, unknown>> = [];
  const now = Date.now();
  const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
  installDatabaseResponseCapture(db, { heartbeatRuns }, capture);
  try { await replay(); }
  finally { capture.flush(); }
  const summary = events.find(event => event.event === "paperclip.db_response_capture.summary.v1")!;
  expect(summary.completedQueries).toBeGreaterThan(0);
  expect(summary.responseValueBytes).toBeLessThan(100_000);
  const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  expect(after).toEqual(before);
  expect(JSON.stringify(events)).not.toContain("saved-native-input-sentinel");
}
