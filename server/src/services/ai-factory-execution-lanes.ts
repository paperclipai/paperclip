import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRelations, issues } from "@paperclipai/db";
import type { IssueExecutionPolicy } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { assertFactoryExecutionPolicySnapshotConsistent } from "./ai-factory-policy.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import {
  issueService,
  type authorizeFactoryManagedCreate,
  type authorizeFactoryManagedPolicyPin,
} from "./issues.js";
import { issueTreeControlService } from "./issue-tree-control.js";

const FACTORY_LANE_IDEMPOTENCY_ORIGIN_KIND = "ai_factory_execution_lane";
const MAX_FACTORY_LANE_IDEMPOTENCY_KEY_LENGTH = 200;

type IssuesService = ReturnType<typeof issueService>;
type IssueChildCreateInput = Parameters<IssuesService["createChild"]>[1];

export type FactoryControlAuthorizationSource = {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  visibility: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionPolicy: unknown;
};

function stableFingerprintValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableFingerprintValue(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableFingerprintValue(record[key])}`)
    .join(",")}}`;
}

/**
 * Binds route authorization to the exact issue-row fields that determine
 * project access, private visibility, and factory-control ownership.
 */
export function factoryControlAuthorizationFingerprint(
  parent: FactoryControlAuthorizationSource,
) {
  return createHash("sha256")
    .update(stableFingerprintValue({
      id: parent.id,
      companyId: parent.companyId,
      projectId: parent.projectId,
      parentId: parent.parentId,
      visibility: parent.visibility,
      createdByAgentId: parent.createdByAgentId,
      createdByUserId: parent.createdByUserId,
      assigneeAgentId: parent.assigneeAgentId,
      assigneeUserId: parent.assigneeUserId,
    }))
    .digest("hex");
}

export type FactoryExecutionLaneIdempotency = {
  key: string;
  requestFingerprint: string;
};

export type CreateFactoryExecutionLaneInput = {
  companyId: string;
  parentAuthorizationFingerprint: string;
  authorizeLockedParent: (parent: FactoryControlAuthorizationSource) => Promise<void>;
  controlExecutionPolicy: IssueExecutionPolicy;
  factoryManagedPolicyPin: ReturnType<typeof authorizeFactoryManagedPolicyPin>;
  child: IssueChildCreateInput;
  idempotency?: FactoryExecutionLaneIdempotency | null;
  actorAgentId?: string | null;
  actorUserId?: string | null;
};

function normalizeFactoryLaneIdempotency(
  parentIssueId: string,
  value: FactoryExecutionLaneIdempotency | null | undefined,
) {
  if (!value) return null;
  const key = value.key.trim();
  if (key.length === 0 || key.length > MAX_FACTORY_LANE_IDEMPOTENCY_KEY_LENGTH) {
    throw unprocessable(
      `Idempotency-Key must contain between 1 and ${MAX_FACTORY_LANE_IDEMPOTENCY_KEY_LENGTH} characters.`,
      { code: "factory_lane_idempotency_key_invalid" },
    );
  }
  const requestFingerprint = value.requestFingerprint.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(requestFingerprint)) {
    throw unprocessable("The factory-lane request fingerprint is invalid.", {
      code: "factory_lane_idempotency_fingerprint_invalid",
    });
  }
  return {
    requestFingerprint,
    originId: `${parentIssueId}:${createHash("sha256").update(key).digest("hex")}`,
  };
}

function validateFactoryLanePolicies(input: {
  parentIssueId: string;
  controlExecutionPolicy: IssueExecutionPolicy;
  childExecutionPolicy: unknown;
}) {
  const control = normalizeIssueExecutionPolicy(input.controlExecutionPolicy);
  const lane = normalizeIssueExecutionPolicy(input.childExecutionPolicy);
  if (control?.factory?.laneKind !== "control" || lane?.factory?.laneKind !== "execution") {
    throw unprocessable(
      "Factory execution lanes must be created with typed control and execution snapshots.",
      { code: "factory_managed_route_required" },
    );
  }
  assertFactoryExecutionPolicySnapshotConsistent({
    executionPolicy: control,
    expectedControlIssueId: null,
  });
  assertFactoryExecutionPolicySnapshotConsistent({
    executionPolicy: lane,
    expectedControlIssueId: input.parentIssueId,
  });
  if (
    control.factory.policyHash !== lane.factory.policyHash
    || control.factory.policyKey !== lane.factory.policyKey
    || control.factory.coordinator.type !== lane.factory.coordinator.type
    || control.factory.coordinator.agentId !== lane.factory.coordinator.agentId
    || control.factory.coordinator.userId !== lane.factory.coordinator.userId
  ) {
    throw conflict("The execution lane does not match its control policy snapshot.", {
      code: "factory_control_snapshot_conflict",
      controlIssueId: input.parentIssueId,
      controlPolicyHash: control.factory.policyHash,
      lanePolicyHash: lane.factory.policyHash,
    });
  }
  return { control, lane };
}

function buildLockedControlPolicy(input: {
  lockedParentPolicy: IssueExecutionPolicy | null;
  proposedControlPolicy: IssueExecutionPolicy;
}) {
  const current = input.lockedParentPolicy;
  return {
    mode: current?.mode ?? input.proposedControlPolicy.mode,
    commentRequired: true,
    stages: current?.stages ?? input.proposedControlPolicy.stages,
    ...(current?.monitor ? { monitor: current.monitor } : {}),
    factory: input.proposedControlPolicy.factory,
  } satisfies IssueExecutionPolicy;
}

export function aiFactoryExecutionLaneService(db: Db) {
  return {
    create: async (parentIssueId: string, input: CreateFactoryExecutionLaneInput) => {
      const proposed = validateFactoryLanePolicies({
        parentIssueId,
        controlExecutionPolicy: input.controlExecutionPolicy,
        childExecutionPolicy: input.child.executionPolicy,
      });
      const idempotency = normalizeFactoryLaneIdempotency(parentIssueId, input.idempotency);

      return db.transaction(async (tx) => {
        const parent = await tx
          .select()
          .from(issues)
          .where(and(eq(issues.id, parentIssueId), eq(issues.companyId, input.companyId)))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!parent) throw notFound("Parent issue not found");
        const lockedAuthorizationFingerprint = factoryControlAuthorizationFingerprint(parent);
        if (lockedAuthorizationFingerprint !== input.parentAuthorizationFingerprint) {
          throw conflict(
            "The control issue access boundary changed after lane creation was authorized.",
            {
              code: "factory_control_authorization_stale",
              controlIssueId: parent.id,
            },
          );
        }
        await input.authorizeLockedParent(parent);
        if (parent.status === "done" || parent.status === "cancelled") {
          throw conflict("Execution lanes cannot be created under a terminal AI Factory control issue.", {
            code: "factory_control_terminal",
            controlIssueId: parent.id,
            status: parent.status,
          });
        }
        if (parent.parentId) {
          throw unprocessable(
            "Execution lanes can only be created under a top-level control issue.",
            {
              code: "factory_lane_parent_required",
              issueId: parent.id,
              parentId: parent.parentId,
            },
          );
        }

        const txIssues = issueService(tx as unknown as Db);
        if (idempotency) {
          const replayRow = await tx
            .select()
            .from(issues)
            .where(and(
              eq(issues.companyId, input.companyId),
              eq(issues.parentId, parent.id),
              eq(issues.originKind, FACTORY_LANE_IDEMPOTENCY_ORIGIN_KIND),
              eq(issues.originId, idempotency.originId),
            ))
            .then((rows) => rows[0] ?? null);
          if (replayRow) {
            if (replayRow.originFingerprint !== idempotency.requestFingerprint) {
              throw conflict("Idempotency-Key was already used for a different factory lane request.", {
                code: "factory_lane_idempotency_conflict",
                controlIssueId: parent.id,
              });
            }
            const replayPolicy = normalizeIssueExecutionPolicy(replayRow.executionPolicy);
            if (
              replayPolicy?.factory?.laneKind !== "execution"
              || replayPolicy.factory.controlIssueId !== parent.id
              || replayPolicy.factory.policyHash !== proposed.lane.factory!.policyHash
            ) {
              throw conflict("The idempotent lane no longer matches its immutable factory snapshot.", {
                code: "factory_control_snapshot_conflict",
                controlIssueId: parent.id,
                issueId: replayRow.id,
              });
            }
            const blocker = await tx
              .select({ id: issueRelations.id })
              .from(issueRelations)
              .where(and(
                eq(issueRelations.companyId, input.companyId),
                eq(issueRelations.issueId, replayRow.id),
                eq(issueRelations.relatedIssueId, parent.id),
                eq(issueRelations.type, "blocks"),
              ))
              .then((rows) => rows[0] ?? null);
            const issue = await txIssues.getById(replayRow.id);
            if (!issue) throw notFound("Idempotent factory lane not found");
            return {
              issue,
              parentBlockerAdded: Boolean(blocker),
              parentPinned: false,
              idempotentReplay: true,
            };
          }
        }

        const hold = await issueTreeControlService(tx as unknown as Db).getActivePauseHoldGate(
          input.companyId,
          parent.id,
        );
        if (hold) {
          throw conflict("AI Factory execution-lane creation is paused by an active issue-tree hold.", {
            code: "factory_execution_paused",
            issueId: parent.id,
            holdId: hold.holdId,
            rootIssueId: hold.rootIssueId,
          });
        }

        const lockedParentPolicy = normalizeIssueExecutionPolicy(parent.executionPolicy);
        const lockedFactory = lockedParentPolicy?.factory ?? null;
        let parentPinned = false;
        if (lockedFactory) {
          if (
            lockedFactory.laneKind !== "control"
            || lockedFactory.policyHash !== proposed.control.factory!.policyHash
            || lockedFactory.policyKey !== proposed.control.factory!.policyKey
            || lockedFactory.coordinator.type !== proposed.lane.factory!.coordinator.type
            || lockedFactory.coordinator.agentId !== proposed.lane.factory!.coordinator.agentId
            || lockedFactory.coordinator.userId !== proposed.lane.factory!.coordinator.userId
          ) {
            throw conflict("The control issue is pinned to a different factory policy snapshot.", {
              code: "factory_control_snapshot_conflict",
              controlIssueId: parent.id,
              controlPolicyHash: lockedFactory.policyHash,
              requestedPolicyHash: proposed.control.factory!.policyHash,
            });
          }
          assertFactoryExecutionPolicySnapshotConsistent({
            executionPolicy: lockedParentPolicy!,
            expectedControlIssueId: null,
          });
        } else {
          const controlPolicy = buildLockedControlPolicy({
            lockedParentPolicy,
            proposedControlPolicy: proposed.control,
          });
          const updatedParent = await txIssues.update(parent.id, {
            executionPolicy: controlPolicy as unknown as Record<string, unknown>,
            factoryManagedPolicyPin: input.factoryManagedPolicyPin,
            actorAgentId: input.actorAgentId ?? null,
            actorUserId: input.actorUserId ?? null,
          }, tx);
          if (!updatedParent) {
            throw conflict("The control issue changed before its factory policy could be pinned.", {
              code: "factory_control_issue_changed",
              controlIssueId: parent.id,
            });
          }
          parentPinned = true;
        }

        const child = {
          ...input.child,
          // These fields are authorization boundaries. Never persist the
          // route's pre-lock copy (or an internal caller's override).
          projectId: parent.projectId,
          visibility: parent.visibility,
          ...(idempotency
            ? {
                originKind: FACTORY_LANE_IDEMPOTENCY_ORIGIN_KIND,
                originId: idempotency.originId,
                originFingerprint: idempotency.requestFingerprint,
              }
            : {}),
        };
        const created = await txIssues.createChild(parent.id, child);
        return {
          ...created,
          parentPinned,
          idempotentReplay: false,
        };
      });
    },
  };
}
