import { createHash, randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  agentHireOperations,
  type AgentHireOperationError,
  type AgentHireOperationResponse,
} from "@paperclipai/db";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { redactEventPayload, redactSensitiveText } from "../redaction.js";

const DEFAULT_LEASE_MS = 15 * 60 * 1000;

export class AgentHireIdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency-Key was already used with a different agent hire payload");
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashAgentHireRequest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function hashIdempotencyKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type AgentHireOperation = typeof agentHireOperations.$inferSelect;

export type PublicAgentHireOperation = Pick<
  AgentHireOperation,
  | "id"
  | "status"
  | "stage"
  | "agentId"
  | "response"
  | "error"
  | "stageTimings"
  | "startedAt"
  | "completedAt"
  | "createdAt"
  | "updatedAt"
>;

export function publicAgentHireOperation(operation: AgentHireOperation): PublicAgentHireOperation {
  return {
    id: operation.id,
    status: operation.status,
    stage: operation.stage,
    agentId: operation.agentId,
    response: operation.response,
    error: operation.error,
    stageTimings: operation.stageTimings,
    startedAt: operation.startedAt,
    completedAt: operation.completedAt,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}

export function agentHireOperationService(db: Db) {
  async function getById(id: string) {
    return db
      .select()
      .from(agentHireOperations)
      .where(eq(agentHireOperations.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getScoped(input: {
    companyId: string;
    principalType: "agent" | "user";
    principalId: string;
    idempotencyKeyHash: string;
  }) {
    return db
      .select()
      .from(agentHireOperations)
      .where(and(
        eq(agentHireOperations.companyId, input.companyId),
        eq(agentHireOperations.principalType, input.principalType),
        eq(agentHireOperations.principalId, input.principalId),
        eq(agentHireOperations.idempotencyKeyHash, input.idempotencyKeyHash),
      ))
      .then((rows) => rows[0] ?? null);
  }

  return {
    getById,

    getForPrincipal: (input: {
      id: string;
      companyId: string;
      principalType: "agent" | "user";
      principalId: string;
    }) =>
      db
        .select()
        .from(agentHireOperations)
        .where(and(
          eq(agentHireOperations.id, input.id),
          eq(agentHireOperations.companyId, input.companyId),
          eq(agentHireOperations.principalType, input.principalType),
          eq(agentHireOperations.principalId, input.principalId),
        ))
        .then((rows) => rows[0] ?? null),

    reserve: async (input: {
      companyId: string;
      principalType: "agent" | "user";
      principalId: string;
      idempotencyKey: string;
      requestHash: string;
    }) => {
      const idempotencyKeyHash = hashIdempotencyKey(input.idempotencyKey);
      const inserted = await db
        .insert(agentHireOperations)
        .values({
          companyId: input.companyId,
          principalType: input.principalType,
          principalId: input.principalId,
          idempotencyKeyHash,
          requestHash: input.requestHash,
          agentId: randomUUID(),
        })
        .onConflictDoNothing({
          target: [
            agentHireOperations.companyId,
            agentHireOperations.principalType,
            agentHireOperations.principalId,
            agentHireOperations.idempotencyKeyHash,
          ],
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      const operation = inserted ?? await getScoped({
        companyId: input.companyId,
        principalType: input.principalType,
        principalId: input.principalId,
        idempotencyKeyHash,
      });
      if (!operation) throw new Error("Failed to reserve agent hire operation");
      if (operation.requestHash !== input.requestHash) {
        throw new AgentHireIdempotencyConflictError();
      }
      return { operation, created: Boolean(inserted) };
    },

    claim: async (id: string, leaseMs = DEFAULT_LEASE_MS) => {
      const now = new Date();
      const leaseToken = randomUUID();
      const operation = await db
        .update(agentHireOperations)
        .set({
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          startedAt: sql`coalesce(${agentHireOperations.startedAt}, now())`,
          attemptCount: sql`${agentHireOperations.attemptCount} + 1`,
          updatedAt: now,
        })
        .where(and(
          eq(agentHireOperations.id, id),
          eq(agentHireOperations.status, "pending"),
          or(
            isNull(agentHireOperations.leaseToken),
            isNull(agentHireOperations.leaseExpiresAt),
            lt(agentHireOperations.leaseExpiresAt, now),
          ),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      return operation ? { operation, leaseToken } : null;
    },

    recordStage: async (id: string, leaseToken: string, stage: string, durationMs: number) => {
      const now = new Date();
      return db
        .update(agentHireOperations)
        .set({
          stage,
          stageTimings: sql`${agentHireOperations.stageTimings} || ${JSON.stringify({
            [stage]: Math.max(0, Math.round(durationMs)),
          })}::jsonb`,
          updatedAt: now,
        })
        .where(and(
          eq(agentHireOperations.id, id),
          eq(agentHireOperations.leaseToken, leaseToken),
          eq(agentHireOperations.status, "pending"),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    succeed: async (id: string, leaseToken: string, response: AgentHireOperationResponse) => {
      const now = new Date();
      const sanitizedResponse = redactEventPayload(response) as AgentHireOperationResponse;
      return db
        .update(agentHireOperations)
        .set({
          status: "succeeded",
          stage: "completed",
          response: sanitizedResponse,
          error: null,
          leaseToken: null,
          leaseExpiresAt: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(agentHireOperations.id, id),
          eq(agentHireOperations.leaseToken, leaseToken),
          eq(agentHireOperations.status, "pending"),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    fail: async (id: string, leaseToken: string, error: AgentHireOperationError) => {
      const now = new Date();
      const sanitizedError = {
        ...error,
        message: redactSensitiveText(error.message),
      };
      return db
        .update(agentHireOperations)
        .set({
          status: "failed",
          stage: "failed",
          response: null,
          error: sanitizedError,
          leaseToken: null,
          leaseExpiresAt: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(agentHireOperations.id, id),
          eq(agentHireOperations.leaseToken, leaseToken),
          eq(agentHireOperations.status, "pending"),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    waitForTerminal: async (id: string, budgetMs: number) => {
      const deadline = Date.now() + Math.max(0, budgetMs);
      do {
        const operation = await getById(id);
        if (!operation || operation.status !== "pending") return operation;
        if (Date.now() >= deadline) return operation;
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
      } while (true);
    },
  };
}
