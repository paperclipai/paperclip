import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { chatEndpointLeases, chatEndpoints, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { ChatChannelServiceOptions } from "./chat-channels.js";

type EndpointRow = typeof chatEndpoints.$inferSelect;
type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
export const CREDENTIAL_MUTATION_LEASE_TTL_MS = 90_000;
const CREDENTIAL_MUTATION_LEASE_WAIT_MS = 10_000;
const CREDENTIAL_MUTATION_LEASE_POLL_MS = 25;

export interface CredentialMutationLeaseGuard {
  assertOwned(database?: DbOrTransaction): Promise<void>;
}

export interface CredentialMutationLeaseCompletion<T> {
  beforeFinalOwnershipCheck?: () => Promise<void>;
  recoverCommittedResultAfterLeaseLoss?: (
    result: T,
    error: Error,
  ) => Promise<boolean>;
}

/** Shared by chat setup and generic connection removal so late OAuth cannot restore a removed bot. */
export function chatCredentialMutationLease(db: Db, options: Pick<ChatChannelServiceOptions,
  "renewCredentialMutationLease" | "credentialMutationLeaseRenewalIntervalMs"> = {}) {
  async function acquireCredentialMutationLease(endpoint: EndpointRow) {
    const token = randomUUID();
    const leaseKey = "credentials";
    const deadline = Date.now() + CREDENTIAL_MUTATION_LEASE_WAIT_MS;
    while (true) {
      const now = new Date();
      const expiresAt = new Date(
        now.getTime() + CREDENTIAL_MUTATION_LEASE_TTL_MS,
      );
      const inserted = await db
        .insert(chatEndpointLeases)
        .values({
          companyId: endpoint.companyId,
          endpointId: endpoint.id,
          leaseKey,
          token,
          expiresAt,
        })
        .onConflictDoNothing()
        .returning({ id: chatEndpointLeases.id });
      if (inserted.length > 0) return { leaseKey, token };
      const reclaimed = await db
        .update(chatEndpointLeases)
        .set({ token, expiresAt, updatedAt: now })
        .where(
          and(
            eq(chatEndpointLeases.companyId, endpoint.companyId),
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, leaseKey),
            lte(chatEndpointLeases.expiresAt, now),
          ),
        )
        .returning({ id: chatEndpointLeases.id });
      if (reclaimed.length > 0) return { leaseKey, token };
      if (Date.now() >= deadline) {
        throw conflict(
          "Another credential update is still in progress; try again",
          {
            code: "chat_endpoint_credentials_busy",
          },
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, CREDENTIAL_MUTATION_LEASE_POLL_MS),
      );
    }
  }

  async function withCredentialMutationLease<T>(
    endpoint: EndpointRow,
    mutation: (lease: CredentialMutationLeaseGuard) => Promise<T>,
    completion?: CredentialMutationLeaseCompletion<T>,
  ): Promise<T> {
    const lease = await acquireCredentialMutationLease(endpoint);
    let leaseLoss: Error | null = null;
    const lostLeaseError = (cause?: unknown) =>
      Object.assign(
        new Error(
          "Chat credential mutation lease ownership was lost before the operation completed",
          cause === undefined ? undefined : { cause },
        ),
        { code: "CHAT_CREDENTIAL_LEASE_LOST" },
      );
    const assertOwned: CredentialMutationLeaseGuard["assertOwned"] = async (
      database = db,
    ) => {
      if (leaseLoss) throw leaseLoss;
      const now = new Date();
      const expiresAt = new Date(
        now.getTime() + CREDENTIAL_MUTATION_LEASE_TTL_MS,
      );
      try {
        const owned = options.renewCredentialMutationLease
          ? await options.renewCredentialMutationLease({
              companyId: endpoint.companyId,
              endpointId: endpoint.id,
              expiresAt,
              leaseKey: lease.leaseKey,
              token: lease.token,
            })
          : (
              await database
                .update(chatEndpointLeases)
                .set({ expiresAt, updatedAt: now })
                .where(
                  and(
                    eq(chatEndpointLeases.companyId, endpoint.companyId),
                    eq(chatEndpointLeases.endpointId, endpoint.id),
                    eq(chatEndpointLeases.leaseKey, lease.leaseKey),
                    eq(chatEndpointLeases.token, lease.token),
                  ),
                )
                .returning({ id: chatEndpointLeases.id })
            ).length > 0;
        if (!owned) {
          leaseLoss = lostLeaseError();
          throw leaseLoss;
        }
      } catch (error) {
        if (leaseLoss) throw leaseLoss;
        leaseLoss = lostLeaseError(error);
        throw leaseLoss;
      }
    };
    const guard: CredentialMutationLeaseGuard = { assertOwned };
    let renewal: Promise<void> | null = null;
    const renewTimer = setInterval(
      () => {
        if (renewal) return;
        renewal = assertOwned()
          .catch((error) => {
            logger.warn(
              { endpointId: endpoint.id, error: "Credential lease operation failed" },
              "lost chat credential mutation lease ownership",
            );
          })
          .finally(() => {
            renewal = null;
          });
      },
      options.credentialMutationLeaseRenewalIntervalMs ??
        CREDENTIAL_MUTATION_LEASE_TTL_MS / 3,
    );
    renewTimer.unref?.();
    try {
      const result = await mutation(guard);
      await completion?.beforeFinalOwnershipCheck?.();
      try {
        await assertOwned();
      } catch (error) {
        const recovered = completion?.recoverCommittedResultAfterLeaseLoss
          ? await completion
              .recoverCommittedResultAfterLeaseLoss(result, error as Error)
              .catch((recoveryError) => {
                logger.warn(
                  {
                    endpointId: endpoint.id,
                    error: "Credential lease recovery failed",
                  },
                  "could not verify a committed chat credential mutation after lease loss",
                );
                return false;
              })
          : false;
        if (!recovered) throw error;
      }
      return result;
    } finally {
      clearInterval(renewTimer);
      await renewal;
      await db
        .delete(chatEndpointLeases)
        .where(
          and(
            eq(chatEndpointLeases.companyId, endpoint.companyId),
            eq(chatEndpointLeases.endpointId, endpoint.id),
            eq(chatEndpointLeases.leaseKey, lease.leaseKey),
            eq(chatEndpointLeases.token, lease.token),
          ),
        )
        .catch((error) => {
          logger.warn(
            { endpointId: endpoint.id, error: "Credential lease operation failed" },
            "could not release chat credential mutation lease",
          );
        });
    }
  }

  return withCredentialMutationLease;
}
