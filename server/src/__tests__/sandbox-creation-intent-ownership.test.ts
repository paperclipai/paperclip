import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, sandboxCreationOperations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { currentControllerProcessStamp, currentProcessSpaceHash } from "../services/controller-process-identity.js";
import { nextEnvironmentCleanupAt } from "../services/environment-cleanup-state.js";
import { createOwnershipReportState, runOwnershipReconciliationPass } from "../services/recovery/ownership-invariant-report.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const KIND = "sandbox_creation_intent";

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
  return pid;
}

suite("sandbox_creation_intent on the shared ownership path", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-sandbox-creation-intent-ownership-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "SCI",
      requireBoardApprovalForNewAgents: false });
  }, 30_000);

  afterEach(async () => {
    await db.delete(sandboxCreationOperations);
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  /** The state a crash between the intent write and the provider reply leaves:
   * a pending intent waiting for its 30-minute settle deadline. */
  async function intent(creationController: Record<string, unknown>) {
    const id = randomUUID();
    const settleAt = new Date(Date.now() + 30 * 60_000);
    await db.insert(sandboxCreationOperations).values({ id, companyId, originalEnvironmentId: randomUUID(),
      runId: randomUUID(), requestKey: "run", provider: "fixture", driverKey: "fixture", state: "pending", config: {},
      nextAttemptAt: settleAt, metadata: { creationController, creationSettleAt: settleAt.toISOString() } });
    return id;
  }

  async function row(id: string) {
    const [found] = await db.select().from(sandboxCreationOperations).where(eq(sandboxCreationOperations.id, id));
    return found!;
  }

  async function pass(record = true) {
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record });
    return report.kinds.find(entry => entry.kind === KIND)!;
  }

  it("makes a dead creator's intent due on the next pass, keeping the provider absence deadline", async () => {
    const id = await intent({ bootId: "earlier-boot", pid: await exitedPid(), hostHash: currentProcessSpaceHash(),
      processStartedAt: null });
    expect(await pass()).toMatchObject({ settled: 1, reasons: { pid_dead: 1 } });
    const settled = await row(id);
    expect(settled.state).toBe("pending");
    expect(settled.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(settled.metadata).toMatchObject({ creationControllerLost: true, creationControllerLostProof: "pid_dead" });
    // Creation recovery is due now; the saved settle deadline still guards absence.
    expect(await nextEnvironmentCleanupAt(db)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(String(settled.metadata.creationSettleAt))).toBeGreaterThan(Date.now() + 25 * 60_000);
    // A lost creator's intent belongs to creation recovery now.
    expect(await pass()).toMatchObject({ inProgress: 0 });
  });

  it("keeps the deadline of a live creator, a creator on another host, and an intent with no creator", async () => {
    const ids = [
      await intent(currentControllerProcessStamp()),
      await intent({ bootId: "other", pid: await exitedPid(), hostHash: "f".repeat(32), processStartedAt: null }),
      await intent({}),
    ];
    const before = await Promise.all(ids.map(row));
    expect(await pass()).toMatchObject({ settled: 0,
      reasons: { current_process: 1, different_process_space: 1, no_owner_stamp: 1 } });
    expect(await Promise.all(ids.map(row))).toEqual(before);
  });

  it("never changes an intent on a read-only pass", async () => {
    const id = await intent({ bootId: "earlier-boot", pid: await exitedPid(), hostHash: currentProcessSpaceHash(),
      processStartedAt: null });
    const before = await row(id);
    expect(await pass(false)).toMatchObject({ settled: 0, verdicts: { gone: 1 } });
    expect(await row(id)).toEqual(before);
  });
});
