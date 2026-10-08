import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  applyPendingMigrations,
  createDb,
  getEmbeddedPostgresTestSupport,
  registerAutonomousAction,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { autonomousActionLedger } from "@paperclipai/db/schema/autonomous_action_ledger";
import { companies } from "@paperclipai/db/schema/companies";
import { and, eq } from "drizzle-orm";
import {
  createAutonomousEffectRecord,
  type AutonomousActionRequest,
} from "@paperclipai/shared";
import { mapPaperclipExecutionToHermesRequest } from "@paperclipai/hermes-paperclip-adapter/gateway/server";
import {
  admitHeartbeatAutonomousAction,
  assertHeartbeatAutonomousDispatchOwnership,
  type HeartbeatAutonomousAdmissionInput,
} from "./heartbeat-autonomous-admission.js";

const db = {} as Db;
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function decision(request: AutonomousActionRequest) {
  return {
    decisionId: `autonomous-dedup/${request.actionId}/ACCEPT`,
    actionId: request.actionId,
    idempotencyKey: request.idempotencyKey,
    effectKey: "autonomous-effect/test/00000000",
    effectFingerprint: "00000000",
    outcome: "ACCEPT" as const,
    reasonCode: "new_effect" as const,
    existingActionId: null,
  };
}

function input(
  context: Record<string, unknown> = {},
  ledger: NonNullable<HeartbeatAutonomousAdmissionInput["ledger"]>,
): HeartbeatAutonomousAdmissionInput {
  return {
    db,
    adapterType: "hermes_gateway",
    companyId: "tenant-1",
    workerId: "worker-1",
    executionId: "run-1",
    runId: "run-1",
    context: {
      taskId: "task-1",
      projectId: "project-1",
      boardId: "board-1",
      autonomous: {},
      ...context,
    },
    ledger,
  };
}

describe("heartbeat autonomous admission boundary", () => {
  describeEmbeddedPostgres("real heartbeat admission ledger recovery", () => {
    it("reclaims a stale production ledger claim through heartbeat admission", async () => {
      const embedded = await startEmbeddedPostgresTestDatabase("heartbeat-autonomous-recovery-");
      try {
        await applyPendingMigrations(embedded.connectionString);
        const realDb = createDb(embedded.connectionString);
        const companyId = "00000000-0000-0000-0000-000000000019";
        await realDb.insert(companies).values({ id: companyId, name: "Heartbeat recovery test" });
        const action: AutonomousActionRequest = {
          actionId: "autonomous-action/run-recovery/task-recovery/1/WAKEUP",
          idempotencyKey: "autonomous-idempotency/run-recovery/task-recovery/1/WAKEUP",
          executionId: "run-recovery",
          taskId: "task-recovery",
          parentExecutionId: null,
          workerId: "worker-recovery",
          attempt: 1,
          kind: "WAKEUP",
          effectType: "hermes_gateway.run",
          effectPayload: {
            provider: "hermes_gateway",
            runId: "run-recovery",
            executionId: "run-recovery",
            taskId: "task-recovery",
            attempt: 1,
            scope: `${companyId}/paperclip/paperclip/task-recovery/worker-recovery`,
            risk: "LOW",
            approval: "NOT_REQUIRED",
            gateDecision: "PASS",
            riskOutcome: "ALLOW",
            companyId,
          },
        };
        await registerAutonomousAction(realDb, companyId, action);
        await realDb.update(autonomousActionLedger).set({
          status: "claimed",
          updatedAt: new Date(Date.now() - 6 * 60_000),
        }).where(and(
          eq(autonomousActionLedger.companyId, companyId),
          eq(autonomousActionLedger.actionId, action.actionId),
        ));

        await expect(admitHeartbeatAutonomousAction({
          db: realDb,
          adapterType: "hermes_gateway",
          companyId,
          workerId: "worker-recovery",
          executionId: action.executionId,
          runId: action.executionId,
          context: { taskId: action.taskId, autonomous: {} },
        })).resolves.toMatchObject({ outcome: "CONSUMED", actionId: action.actionId });
      } finally {
        await embedded.cleanup();
      }
    }, 240_000);

    it("revalidates production ownership after ledger claim and skips the remote run on reassignment", async () => {
      const embedded = await startEmbeddedPostgresTestDatabase("heartbeat-autonomous-reassignment-");
      try {
        await applyPendingMigrations(embedded.connectionString);
        const realDb = createDb(embedded.connectionString);
        const companyId = "00000000-0000-0000-0000-000000000020";
        await realDb.insert(companies).values({ id: companyId, name: "Heartbeat reassignment test" });
        const action: AutonomousActionRequest = {
          actionId: "autonomous-action/run-reassignment/task-reassignment/1/WAKEUP",
          idempotencyKey: "autonomous-idempotency/run-reassignment/task-reassignment/1/WAKEUP",
          executionId: "run-reassignment",
          taskId: "task-reassignment",
          parentExecutionId: null,
          workerId: "worker-reassignment",
          attempt: 1,
          kind: "WAKEUP",
          effectType: "hermes_gateway.run",
          effectPayload: {
            provider: "hermes_gateway",
            runId: "run-reassignment",
            executionId: "run-reassignment",
            taskId: "task-reassignment",
            attempt: 1,
            scope: `${companyId}/paperclip/paperclip/task-reassignment/worker-reassignment`,
            risk: "LOW",
            approval: "NOT_REQUIRED",
            gateDecision: "PASS",
            riskOutcome: "ALLOW",
            companyId,
          },
        };
        const remotePost = vi.fn();
        const admission = await admitHeartbeatAutonomousAction({
          db: realDb,
          adapterType: "hermes_gateway",
          companyId,
          workerId: "worker-reassignment",
          executionId: action.executionId,
          runId: action.executionId,
          context: { taskId: action.taskId, autonomous: action },
        });
        expect(admission).toMatchObject({ outcome: "CONSUMED", actionId: action.actionId });
        expect((await realDb.select().from(autonomousActionLedger)).at(0)).toMatchObject({ status: "claimed" });

        // This is the production ordering: admission has claimed the ledger,
        // then ownership changes before the adapter's remote POST boundary.
        try {
          assertHeartbeatAutonomousDispatchOwnership({
            aborted: false,
            currentRun: { status: "running", companyId, agentId: "new-owner" },
            companyId,
            agentId: "worker-reassignment",
          });
          remotePost();
        } catch (error) {
          expect(error).toHaveProperty("message", "autonomous_heartbeat_dispatch_ownership_changed");
        }
        expect(remotePost).not.toHaveBeenCalled();

        // A stale claim remains recoverable by the existing retry-safe ledger rule.
        await realDb.update(autonomousActionLedger).set({
          updatedAt: new Date(Date.now() - 6 * 60_000),
        }).where(eq(autonomousActionLedger.actionId, action.actionId));
        await expect(admitHeartbeatAutonomousAction({
          db: realDb,
          adapterType: "hermes_gateway",
          companyId,
          workerId: "worker-reassignment",
          executionId: action.executionId,
          runId: action.executionId,
          context: { taskId: action.taskId, autonomous: action },
        })).resolves.toMatchObject({ outcome: "CONSUMED", actionId: action.actionId });
      } finally {
        await embedded.cleanup();
      }
    }, 240_000);
  });

  it("records the company/worker/task admission and consumes it once", async () => {
    const registered: AutonomousActionRequest[] = [];
    const ledger = {
      register: async (_db: Db, _companyId: string, request: AutonomousActionRequest) => {
        registered.push(request);
        return decision(request);
      },
      consume: async (_db: Db, _companyId: string, request: AutonomousActionRequest) => ({
        outcome: "CONSUMED" as const,
        actionId: request.actionId,
        effectKey: "autonomous-effect/test/00000000",
        effectFingerprint: "00000000",
      }),
    };

    const result = await admitHeartbeatAutonomousAction(input({}, ledger));

    expect(result.outcome).toBe("CONSUMED");
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      executionId: "run-1",
      taskId: "task-1",
      workerId: "worker-1",
      effectType: "hermes_gateway.run",
      effectPayload: {
        companyId: "tenant-1",
        scope: "tenant-1/project-1/board-1/task-1/worker-1",
        risk: "LOW",
        approval: "NOT_REQUIRED",
        gateDecision: "PASS",
        riskOutcome: "ALLOW",
      },
    });

    const mapped = mapPaperclipExecutionToHermesRequest({
      runId: "run-1",
      agent: {
        id: "worker-1",
        companyId: "tenant-1",
        name: "Hermes",
        adapterType: "hermes_gateway",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: "task-1",
      },
      config: { apiBaseUrl: "http://127.0.0.1:8642", apiKey: "[REDACTED]" },
      context: {
        taskId: "task-1",
        projectId: "project-1",
        boardId: "board-1",
        autonomous: {},
      },
      onLog: async () => undefined,
    });
    expect(createAutonomousEffectRecord(registered[0]).effectFingerprint).toBe(
      mapped.body.autonomous.effectFingerprint,
    );
    expect(createAutonomousEffectRecord(registered[0]).effectKey).toBe(
      mapped.body.autonomous.effectKey,
    );
  });

  it("uses one deterministic autonomous alias source for stable action identity", async () => {
    const requests: AutonomousActionRequest[] = [];
    const ledger = {
      register: async (_db: Db, _companyId: string, request: AutonomousActionRequest) => {
        requests.push(request);
        return decision(request);
      },
      consume: async (_db: Db, _companyId: string, request: AutonomousActionRequest) => ({
        outcome: "CONSUMED" as const,
        actionId: request.actionId,
        effectKey: "autonomous-effect/test/00000000",
        effectFingerprint: "00000000",
      }),
    };
    const context = {
      taskId: "task-1",
      autonomousExecution: { actionId: "stable-action", idempotencyKey: "stable-idempotency" },
      autonomous: { actionId: "different-action", idempotencyKey: "different-idempotency" },
    };
    await admitHeartbeatAutonomousAction(input(context, ledger));
    await admitHeartbeatAutonomousAction(input(context, ledger));
    expect(requests.map((request) => request.actionId)).toEqual(["stable-action", "stable-action"]);
    expect(requests.map((request) => request.idempotencyKey)).toEqual(["stable-idempotency", "stable-idempotency"]);
  });

  it("blocks a duplicate action at the server boundary before adapter execution", async () => {
    const request = {
      actionId: "autonomous-action/run-1/task-1/1/WAKEUP",
      idempotencyKey: "autonomous-idempotency/run-1/task-1/1/WAKEUP",
    };
    const ledger = {
      register: async (_db: Db, _companyId: string, action: AutonomousActionRequest) =>
        ({ ...decision(action), outcome: "RETURN_EXISTING" as const, reasonCode: "duplicate_effect" as const, existingActionId: action.actionId }),
      consume: async () => ({
        outcome: "ALREADY_CONSUMED" as const,
        actionId: request.actionId,
        effectKey: "autonomous-effect/test/00000000",
        effectFingerprint: "00000000",
      }),
    };

    await expect(admitHeartbeatAutonomousAction(input({}, ledger))).rejects.toThrow(
      "autonomous_heartbeat_admission_duplicate",
    );
  });

  it("records a failed gate and denies before the adapter boundary", async () => {
    let consumeCalls = 0;
    let releaseCalls = 0;
    let registered: AutonomousActionRequest | null = null;
    const ledger = {
      register: async (_db: Db, _companyId: string, request: AutonomousActionRequest) => {
        registered = request;
        return decision(request);
      },
      consume: async () => {
        consumeCalls += 1;
        throw new Error("consume must not run on deny");
      },
      release: async () => { releaseCalls += 1; return true; },
    };

    await expect(
      admitHeartbeatAutonomousAction(
        input({ autonomous: { gates: [{ gateId: "scope", decision: "FAIL" }] } }, ledger),
      ),
    ).rejects.toThrow("autonomous_heartbeat_admission_denied:gate_failed_or_missing");
    expect(registered).toMatchObject({
      taskId: "task-1",
      workerId: "worker-1",
      effectPayload: { gateDecision: "FAIL", riskOutcome: "ALLOW" },
    });
    expect(consumeCalls).toBe(0);
    expect(releaseCalls).toBe(1);
  });

  it("fails closed for non-low risk without a granted risk decision", async () => {
    let registered: AutonomousActionRequest | null = null;
    const ledger = {
      register: async (_db: Db, _companyId: string, request: AutonomousActionRequest) => {
        registered = request;
        return decision(request);
      },
      consume: async () => {
        throw new Error("consume must not run on deny");
      },
    };

    await expect(
      admitHeartbeatAutonomousAction(
        input({ autonomous: { risk: "HIGH", gates: [{ gateId: "scope", decision: "PASS" }] } }, ledger),
      ),
    ).rejects.toThrow("autonomous_heartbeat_admission_denied:non_low_risk_requires_granted_approval");
    expect(registered).toMatchObject({
      effectPayload: { risk: "HIGH", approval: "NOT_REQUIRED", gateDecision: "PASS", riskOutcome: "DENY" },
    });
  });

  it("allows policy-compliant MEDIUM admission with NOT_REQUIRED approval", async () => {
    const ledger = {
      register: async (_db: Db, _companyId: string, request: AutonomousActionRequest) => decision(request),
      consume: async (_db: Db, _companyId: string, request: AutonomousActionRequest) => ({
        outcome: "CONSUMED" as const,
        actionId: request.actionId,
        effectKey: "autonomous-effect/test/00000000",
        effectFingerprint: "00000000",
      }),
    };
    const actionId = "autonomous-action/run-1/task-1/1/WAKEUP";
    const checkpoint = { manifestId: "checkpoint-1", actionId, executionId: "run-1", taskId: "task-1", createdAt: "2026-09-27T00:00:00.000Z", scope: "task-1", artifactRefs: ["artifact://run-1/checkpoint"] };
    const backup = { manifestId: "backup-1", actionId, executionId: "run-1", taskId: "task-1", createdAt: "2026-09-27T00:00:00.000Z", sourceRef: "artifact://run-1/source", artifactRefs: ["artifact://run-1/backup"] };
    await expect(admitHeartbeatAutonomousAction(input({ autonomous: {
      risk: "MEDIUM",
      gates: [{ gateId: "scope", decision: "PASS" }],
      riskDecision: { decisionId: `autonomous-risk/${actionId}/MEDIUM/ALLOW/checkpoint_and_backup_present`, actionId, executionId: "run-1", taskId: "task-1", risk: "MEDIUM", outcome: "ALLOW", reasonCode: "checkpoint_and_backup_present", disposable: false, requiresCheckpoint: true, requiresBackup: true, requiresApproval: false, requiresRollback: false, checkpointManifestId: "checkpoint-1", backupManifestId: "backup-1", checkpointManifest: checkpoint, backupManifest: backup, rollback: null },
    } }, ledger))).resolves.toMatchObject({ outcome: "CONSUMED" });
  });

  it("fails closed for an explicitly denied approval", async () => {
    const ledger = {
      register: async (_db: Db, _companyId: string, request: AutonomousActionRequest) => decision(request),
      consume: async () => {
        throw new Error("consume must not run on deny");
      },
    };

    await expect(
      admitHeartbeatAutonomousAction(
        input({ autonomous: { approval: "DENIED" } }, ledger),
      ),
    ).rejects.toThrow("autonomous_heartbeat_admission_denied:approval_not_granted");
  });

  it("fails closed when the risk decision class does not match the request risk", async () => {
    const ledger = {
      register: async (_db: Db, _companyId: string, request: AutonomousActionRequest) => decision(request),
      consume: async () => {
        throw new Error("consume must not run on a risk mismatch");
      },
    };

    await expect(
      admitHeartbeatAutonomousAction(
        input({
          autonomous: {
            risk: "HIGH",
            approval: "GRANTED",
            gates: [{ gateId: "scope", decision: "PASS" }],
            riskDecision: {
              decisionId: "autonomous-risk/autonomous-action/run-1/task-1/1/WAKEUP/MEDIUM/ALLOW/checkpoint_and_backup_present",
              actionId: "autonomous-action/run-1/task-1/1/WAKEUP",
              executionId: "run-1",
              taskId: "task-1",
              risk: "MEDIUM",
              outcome: "ALLOW",
              reasonCode: "checkpoint_and_backup_present",
              disposable: false,
              requiresCheckpoint: true,
              requiresBackup: true,
              requiresApproval: false,
              requiresRollback: false,
              checkpointManifestId: "checkpoint-1",
              backupManifestId: "backup-1",
              checkpointManifest: null,
              backupManifest: null,
              rollback: null,
            },
          },
        }, ledger),
      ),
    ).rejects.toThrow("autonomous_heartbeat_admission_risk_decision_risk_mismatch");
  });

  it("binds approval, gates, and required evidence to the risk decision", async () => {
    const ledger = {
      register: async (_db: Db, _companyId: string, request: AutonomousActionRequest) => decision(request),
      consume: async () => {
        throw new Error("consume must not run when risk evidence is incomplete");
      },
    };

    await expect(
      admitHeartbeatAutonomousAction(
        input({
          autonomous: {
            risk: "HIGH",
            approval: "GRANTED",
            gates: [{ gateId: "scope", decision: "PASS" }],
            riskDecision: {
              decisionId: "autonomous-risk/autonomous-action/run-1/task-1/1/WAKEUP/HIGH/ALLOW/approval_and_rollback_present",
              actionId: "autonomous-action/run-1/task-1/1/WAKEUP",
              executionId: "run-1",
              taskId: "task-1",
              risk: "HIGH",
              outcome: "ALLOW",
              reasonCode: "approval_and_rollback_present",
              disposable: false,
              requiresCheckpoint: false,
              requiresBackup: false,
              requiresApproval: true,
              requiresRollback: true,
              checkpointManifestId: null,
              backupManifestId: null,
              checkpointManifest: null,
              backupManifest: null,
              rollback: null,
            },
          },
        }, ledger),
      ),
    ).rejects.toThrow("autonomous_heartbeat_admission_risk_decision_rollback_evidence_missing");
  });

  it.each([
    ["checkpoint", { checkpointManifestId: null, backupManifestId: "backup-1", checkpointManifest: null, backupManifest: null }, "checkpoint_evidence_missing"],
    ["backup", {
      checkpointManifestId: "checkpoint-1",
      backupManifestId: null,
      checkpointManifest: {
        manifestId: "checkpoint-1",
        actionId: "autonomous-action/run-1/task-1/1/WAKEUP",
        executionId: "run-1",
        taskId: "task-1",
        createdAt: "2026-09-27T00:00:00.000Z",
        scope: "issue-1",
        artifactRefs: ["artifact://run-1/checkpoint"],
      },
      backupManifest: null,
    }, "backup_evidence_missing"],
  ] as const)("fails closed when required %s evidence is absent", async (_name, evidence, issue) => {
    const ledger = {
      register: async (_db: Db, _companyId: string, request: AutonomousActionRequest) => decision(request),
      consume: async () => {
        throw new Error("consume must not run when required evidence is absent");
      },
    };

    await expect(
      admitHeartbeatAutonomousAction(
        input({
          autonomous: {
            risk: "MEDIUM",
            gates: [{ gateId: "scope", decision: "PASS" }],
            riskDecision: {
              decisionId: "autonomous-risk/autonomous-action/run-1/task-1/1/WAKEUP/MEDIUM/ALLOW/checkpoint_and_backup_present",
              actionId: "autonomous-action/run-1/task-1/1/WAKEUP",
              executionId: "run-1",
              taskId: "task-1",
              risk: "MEDIUM",
              outcome: "ALLOW",
              reasonCode: "checkpoint_and_backup_present",
              disposable: false,
              requiresCheckpoint: true,
              requiresBackup: true,
              requiresApproval: false,
              requiresRollback: false,
              ...evidence,
              rollback: null,
            },
          },
        }, ledger),
      ),
    ).rejects.toThrow(`autonomous_heartbeat_admission_risk_decision_${issue}`);
  });

  it("preserves parent execution lineage in the ledger request and effect payload", async () => {
    let registered: AutonomousActionRequest | null = null;
    const ledger = {
      register: async (_db: Db, _companyId: string, request: AutonomousActionRequest) => {
        registered = request;
        return decision(request);
      },
      consume: async (_db: Db, _companyId: string, request: AutonomousActionRequest) => ({
        outcome: "CONSUMED" as const,
        actionId: request.actionId,
        effectKey: "autonomous-effect/test/00000000",
        effectFingerprint: "00000000",
      }),
    };
    const now = "2026-09-27T22:00:00.000Z";

    await expect(
      admitHeartbeatAutonomousAction(
        input({
          autonomous: {
            parentExecutionId: "parent-run-1",
            stateEnvelope: {
              schemaVersion: 1,
              executionId: "run-1",
              taskId: "task-1",
              parentExecutionId: "parent-run-1",
              risk: "LOW",
              state: "PENDING",
              dependencies: [],
              workers: [],
              gates: [],
              attempt: 1,
              createdAt: now,
              updatedAt: now,
            },
          },
        }, ledger),
      ),
    ).resolves.toMatchObject({ outcome: "CONSUMED" });
    expect(registered).toMatchObject({
      parentExecutionId: "parent-run-1",
    });
  });

  it("rejects divergent top-level and nested parent execution lineage", async () => {
    const ledger = {
      register: async (_db: Db, _companyId: string, request: AutonomousActionRequest) => decision(request),
      consume: async () => {
        throw new Error("consume must not run on lineage mismatch");
      },
    };

    await expect(
      admitHeartbeatAutonomousAction(
        input({
          parentExecutionId: "top-level-parent",
          autonomous: { parentExecutionId: "nested-parent" },
        }, ledger),
      ),
    ).rejects.toThrow("autonomous_heartbeat_admission_parent_execution_mismatch");
  });
});
