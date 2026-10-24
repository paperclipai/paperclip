// Test-only legacy controller in its own OS process. It launches one reviewer
// run through the real heartbeat service, reports the run's persisted process
// identity on one stdout line, then idles until the test kills it. Killing it
// drops the controller's in-memory process tracking and its lease renewal.
//
// Usage: node --import tsx legacy-controller-process.ts
// Environment: DECIDED_REVIEW_DATABASE_URL, DECIDED_REVIEW_AGENT_ID, DECIDED_REVIEW_ISSUE_ID
import { and, eq } from "drizzle-orm";
import { createDb, heartbeatRuns } from "@paperclipai/db";
import { heartbeatService } from "../../services/heartbeat.ts";

const url = process.env.DECIDED_REVIEW_DATABASE_URL;
const agentId = process.env.DECIDED_REVIEW_AGENT_ID;
const issueId = process.env.DECIDED_REVIEW_ISSUE_ID;
if (!url || !agentId || !issueId) throw new Error("legacy controller fixture is missing its environment");

// A crashed test runner must not leak this controller.
process.on("disconnect", () => process.exit(1));

const db = createDb(url);
const heartbeat = heartbeatService(db, { runtimeEnv: {} });
const run = await heartbeat.wakeup(agentId, {
  source: "assignment",
  triggerDetail: "system",
  reason: "execution_review_requested",
  payload: { issueId },
  contextSnapshot: { issueId, taskId: issueId, wakeReason: "execution_review_requested" },
});
if (!run) throw new Error("legacy controller fixture could not queue the reviewer run");

const deadline = Date.now() + 25_000;
for (;;) {
  const [current] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.id)));
  if (current?.status === "running" && current.processPid && current.processGroupId) {
    process.stdout.write(`${JSON.stringify({ runId: current.id, pid: current.processPid, processGroupId: current.processGroupId })}\n`);
    break;
  }
  if (Date.now() > deadline) throw new Error(`reviewer run did not start: ${current?.status ?? "missing"}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
}
// Idle. The lease renewal timer keeps the event loop alive until SIGKILL.
setInterval(() => {}, 60_000);
