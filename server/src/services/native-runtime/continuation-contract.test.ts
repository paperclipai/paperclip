import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { ensureNativeCompletionContract } from "./completion-contracts.js";
import { rebindContinuationContract } from "./continuation-contract.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "current-request completion contract",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;
    beforeAll(async () => {
      database = await startEmbeddedPostgresTestDatabase(
        "continuation-contract-",
      );
      db = createDb(database.connectionString);
    }, 30_000);
    afterAll(async () => {
      await database?.cleanup();
    });
    async function setup() {
      const companyId = randomUUID(),
        agentId = randomUUID(),
        issueId = randomUUID(),
        runId = randomUUID();
      await db
        .insert(companies)
        .values({
          id: companyId,
          name: "Context",
          issuePrefix: `C${companyId.slice(0, 6)}`,
        });
      await db
        .insert(agents)
        .values({
          id: agentId,
          companyId,
          name: "Executor",
          role: "engineer",
          adapterType: "paperclip_runner",
        });
      const [task] = await db
        .insert(issues)
        .values({
          id: issueId,
          companyId,
          title: "Read Notion",
          status: "in_progress",
          assigneeAgentId: agentId,
        })
        .returning();
      const previous = await ensureNativeCompletionContract({
        db,
        companyId,
        issue: task!,
        actorId: agentId,
        immediateRequest: "Read Notion",
      });
      const current = await ensureNativeCompletionContract({
        db,
        companyId,
        issue: task!,
        actorId: agentId,
        immediateRequest: "Now read Gmail",
      });
      const contract = (value: typeof previous) => ({
        id: value.row.id,
        sha256: value.row.canonicalSha256,
        schemaVersion: value.row.schemaVersion,
        contract: value.contract,
      });
      const oldInput = parseNativeExecutionInput({
        schema: "paperclip.native-execution-input.v1",
        binding: {
          companyId,
          issueId,
          agentId,
          runId,
          executionWorkspaceId: runId,
        },
        task: {
          identifier: "CTX-1",
          title: "Read Notion",
          description: null,
          prompt: "Read Notion",
          workMode: "standard",
        },
        workspace: {
          cwd: "/tmp",
          repoUrl: null,
          repoRef: null,
          branchName: null,
        },
        session: {
          normalizedSessionId: null,
          driverKind: "codex_app_server",
          protocolVersion: 1,
          lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
        },
        provider: { kind: "codex", model: null },
        completionContract: contract(previous),
        interactionResponses: [],
        credentialBindings: [],
      });
      const nextInput = parseNativeExecutionInput({
        ...oldInput,
        completionContract: contract(current),
      });
      await db
        .insert(heartbeatRuns)
        .values({
          id: runId,
          companyId,
          agentId,
          nativeIssueId: issueId,
          status: "running",
          runtimeMode: "native",
          completionContractId: previous.row.id,
          completionContractSha256: previous.row.canonicalSha256,
          runnerProfileJson: { nativeExecutionInput: oldInput },
        });
      await db
        .insert(nativeRunFinalizations)
        .values({
          companyId,
          issueId,
          runId,
          phase: "retryable_failure",
          attempt: 1,
        });
      return { companyId, issueId, runId, oldInput, nextInput };
    }
    it("rebinds a fenced unfinished run to Gmail while retaining the Notion revision", async () => {
      const s = await setup();
      await rebindContinuationContract(db, s.oldInput, s.nextInput);
      await rebindContinuationContract(db, s.oldInput, s.nextInput);
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, s.runId));
      expect(run?.completionContractId).toBe(s.nextInput.completionContract.id);
      expect(run?.runnerProfileJson?.nativeExecutionInput).toMatchObject({
        completionContract: {
          contract: { criteria: [{ requirement: "Now read Gmail" }] },
        },
      });
    });
    it("incorporates later direction under the matching fenced recovery claim", async () => {
      const s = await setup();
      await db.update(nativeRunFinalizations).set({ leaseOwner: "recovery-owner", controllerGeneration: 2, phase: "observed", recoveryState: "resuming_session" }).where(eq(nativeRunFinalizations.runId, s.runId));
      const claim = { kind: "resume_dead_runner" as const, runId: s.runId, leaseOwner: "recovery-owner", controllerGeneration: 2, providerAttempt: 2, restartKind: "hard" as const, recoveryRequestId: null };
      await expect(rebindContinuationContract(db, s.oldInput, s.nextInput, { ...claim, leaseOwner: "other-owner" })).rejects.toThrow("requires_fenced_uncompleted_run");
      await rebindContinuationContract(db, s.oldInput, s.nextInput, claim);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.runId));
      expect(run?.completionContractId).toBe(s.nextInput.completionContract.id);
    });
    it("cannot change the contract beneath a live execution owner", async () => {
      const s = await setup();
      await db
        .update(nativeRunFinalizations)
        .set({ leaseOwner: "live-owner" })
        .where(eq(nativeRunFinalizations.runId, s.runId));
      await expect(
        rebindContinuationContract(db, s.oldInput, s.nextInput),
      ).rejects.toThrow("requires_fenced_uncompleted_run");
    });
    it("preserves a durable completed result and rejects ownership changes", async () => {
      const s = await setup();
      await db
        .insert(nativeRunResults)
        .values({
          companyId: s.companyId,
          issueId: s.issueId,
          runId: s.runId,
          completionContractId: s.oldInput.completionContract.id,
          serverFingerprint: "completed",
          schemaStatus: "accepted",
          resultJson: {},
          canonicalSha256: "completed",
        });
      await expect(
        rebindContinuationContract(db, s.oldInput, s.nextInput),
      ).rejects.toThrow("requires_fenced_uncompleted_run");
      await db
        .update(issues)
        .set({ assigneeAgentId: null })
        .where(
          and(eq(issues.companyId, s.companyId), eq(issues.id, s.issueId)),
        );
      await expect(
        rebindContinuationContract(db, s.oldInput, s.nextInput),
      ).rejects.toThrow("ownership_changed");
    });
  },
);
