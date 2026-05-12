import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { oauthConnections } from "@paperclipai/db";
import type { createDb } from "@paperclipai/db";

/**
 * CRUD for BYO credential-broker push targets attached to OAuth connections.
 *
 * In M1 this service has no callers — the refresh worker's push pathway
 * and the operator UI both land in M3. Shipping the service shape now
 * keeps M3's PR additive and gives integrators a clear contract.
 */

/** Maximum number of broker push targets per OAuth connection. */
export const MAX_BROKER_TARGETS_PER_CONNECTION = 8;

/** Stored shape of a push target — matches the JSONB column type in `oauth_connections`. */
export interface BrokerTarget {
  id: string;
  url: string;
  /** References company_secrets.id so the shared push token rotates through the secret pipeline. */
  authTokenSecretId: string;
  /** ISO 8601 timestamp. */
  addedAt: string;
}

export interface AddBrokerTargetInput {
  url: string;
  authTokenSecretId: string;
}

const ADD_INPUT_SCHEMA = z.object({
  url: z
    .string()
    .url()
    .refine(
      (u) => u.startsWith("https://") || u.startsWith("http://"),
      { message: "broker target URL must use http or https" },
    ),
  authTokenSecretId: z.string().uuid(),
});

/**
 * Validate an incoming push target. Pure; throws on bad input.
 * Exposed for unit testing and for callers that want to validate
 * without hitting the database.
 */
export function validateBrokerTargetInput(
  input: AddBrokerTargetInput,
): AddBrokerTargetInput {
  const parsed = ADD_INPUT_SCHEMA.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `invalid broker target: ${parsed.error.issues
        .map((i) => i.message)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

export class BrokerTargetCapExceededError extends Error {
  constructor(public readonly cap: number) {
    super(
      `too many broker targets for connection (cap=${cap}); remove one before adding another`,
    );
    this.name = "BrokerTargetCapExceededError";
  }
}

/**
 * Append a target to the current list with the per-connection cap enforced.
 * Pure helper exposed for unit testing.
 */
export function appendTargetWithCap(
  current: BrokerTarget[],
  target: BrokerTarget,
): BrokerTarget[] {
  if (current.length >= MAX_BROKER_TARGETS_PER_CONNECTION) {
    throw new BrokerTargetCapExceededError(MAX_BROKER_TARGETS_PER_CONNECTION);
  }
  return [...current, target];
}

/** Pure helper — remove the target with the given id, no-op if absent. */
export function removeTargetById(
  current: BrokerTarget[],
  targetId: string,
): BrokerTarget[] {
  return current.filter((t) => t.id !== targetId);
}

export type Db = ReturnType<typeof createDb>;

export interface BrokerTargetsService {
  list(connectionId: string): Promise<BrokerTarget[]>;
  add(connectionId: string, input: AddBrokerTargetInput): Promise<BrokerTarget>;
  remove(connectionId: string, targetId: string): Promise<void>;
}

export interface CreateBrokerTargetsServiceDeps {
  db: Db;
  /** Test seam — overridable id generator. */
  newId?: () => string;
  /** Test seam — overridable clock. */
  now?: () => Date;
}

export function createBrokerTargetsService(
  deps: CreateBrokerTargetsServiceDeps,
): BrokerTargetsService {
  const newId = deps.newId ?? (() => randomUUID());
  const now = deps.now ?? (() => new Date());

  return {
    async list(connectionId: string): Promise<BrokerTarget[]> {
      const [row] = await deps.db
        .select({ brokerTargets: oauthConnections.brokerTargets })
        .from(oauthConnections)
        .where(eq(oauthConnections.id, connectionId));
      return row?.brokerTargets ?? [];
    },

    async add(
      connectionId: string,
      input: AddBrokerTargetInput,
    ): Promise<BrokerTarget> {
      const validated = validateBrokerTargetInput(input);
      const target: BrokerTarget = {
        id: newId(),
        url: validated.url,
        authTokenSecretId: validated.authTokenSecretId,
        addedAt: now().toISOString(),
      };

      return deps.db.transaction(async (tx) => {
        const [row] = await tx
          .select({ brokerTargets: oauthConnections.brokerTargets })
          .from(oauthConnections)
          .where(eq(oauthConnections.id, connectionId))
          .for("update");
        if (!row) {
          throw new Error(`oauth connection not found: ${connectionId}`);
        }
        const next = appendTargetWithCap(row.brokerTargets ?? [], target);
        await tx
          .update(oauthConnections)
          .set({ brokerTargets: next })
          .where(eq(oauthConnections.id, connectionId));
        return target;
      });
    },

    async remove(connectionId: string, targetId: string): Promise<void> {
      await deps.db.transaction(async (tx) => {
        const [row] = await tx
          .select({ brokerTargets: oauthConnections.brokerTargets })
          .from(oauthConnections)
          .where(eq(oauthConnections.id, connectionId))
          .for("update");
        if (!row) {
          throw new Error(`oauth connection not found: ${connectionId}`);
        }
        const next = removeTargetById(row.brokerTargets ?? [], targetId);
        await tx
          .update(oauthConnections)
          .set({ brokerTargets: next })
          .where(eq(oauthConnections.id, connectionId));
      });
    },
  };
}
