import { receiverLeaseKey as leaseKeyForProvider } from "./receiver-policy.js";
import type { EndpointRow, DbTransaction, RuntimeContext, InboundRuntimeContext } from "../runtime-types.js";
import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { chatEndpointLeases } from "@paperclipai/db";
import { conflict } from "../../../errors.js";
import { logger } from "../../../middleware/logger.js";
import type { Db } from "@paperclipai/db";
import type { ChatRuntime } from "../../chat-runtime.js";
import type { createChatMessageLifecycle } from "../inbound/lifecycle.js";
import type { DiscordGatewayOwnership } from "../runtime-types.js";
type OwnershipOptions = {
  runtime: Pick<ChatRuntime, "get" | "removeEndpoint">;
  runtimeVersions: Map<string, string>;
  runtimeCallbackEndpoint: Parameters<typeof createChatMessageLifecycle>[1]["runtimeCallbackEndpoint"];
  redactError: (error: unknown) => string;
  leasedChatProvider: (provider: string) => boolean;
  discordGatewayOwnerships: Map<string, DiscordGatewayOwnership>;
  discordGatewayStopTasks: Set<Promise<void>>;
  isShuttingDown: () => boolean;
  onStopped?: (endpointId: string) => void;
  readonly discordGatewayLeaseTtlMs?: number;
  readonly discordGatewayLeaseRenewalIntervalMs?: number;
  readonly discordGatewayLeaseWaitMs?: number;
  readonly renewDiscordGatewayLease?: (input: { companyId: string; credentialFingerprint: string; endpointId: string; expiresAt: Date; generation: number; leaseKey: string; token: string }) => Promise<boolean>;
};
const DISCORD_GATEWAY_LEASE_TTL_MS = 15_000;
const DISCORD_GATEWAY_LEASE_WAIT_MS = 20_000;
const DISCORD_GATEWAY_LEASE_POLL_MS = 100;
export function createChatReceiverOwnership(db: Db, options: OwnershipOptions) {
  const { runtime, runtimeVersions, runtimeCallbackEndpoint, redactError, leasedChatProvider, discordGatewayOwnerships, discordGatewayStopTasks } = options;
  function discordGatewayNotOwnedError() {
    return conflict(
      "Another Paperclip server owns this Discord Gateway connection; retry shortly",
      { code: "chat_discord_gateway_not_owned" },
    );
  }

  function isDiscordGatewayNotOwnedError(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === "object" &&
      "details" in error &&
      error.details &&
      typeof error.details === "object" &&
      "code" in error.details &&
      error.details.code === "chat_discord_gateway_not_owned",
    );
  }

  async function releaseDiscordGatewayLeaseRow(
    ownership: DiscordGatewayOwnership,
  ): Promise<void> {
    await db
      .delete(chatEndpointLeases)
      .where(
        and(
          eq(chatEndpointLeases.companyId, ownership.companyId),
          eq(chatEndpointLeases.endpointId, ownership.endpointId),
          eq(chatEndpointLeases.leaseKey, ownership.leaseKey),
          eq(chatEndpointLeases.token, ownership.token),
        ),
      )
      .catch((error) => {
        logger.warn(
          {
            endpointId: ownership.endpointId,
            error: redactError(error),
          },
          "could not release Discord Gateway ownership lease",
        );
      });
  }

  async function stopDiscordGatewayOwnership(
    ownership: DiscordGatewayOwnership,
    stopOptions: { removeRuntime?: boolean; notifyStopped?: boolean } = {},
  ): Promise<void> {
    if (ownership.stopPromise) return ownership.stopPromise;
    ownership.stopping = true;
    if (ownership.renewTimer) {
      clearInterval(ownership.renewTimer);
      ownership.renewTimer = null;
    }
    ownership.stopPromise = (async () => {
      if (
        stopOptions.removeRuntime !== false &&
        ownership.context.endpointRuntime &&
        runtime.get(ownership.endpointId) === ownership.context.endpointRuntime
      ) {
        runtimeVersions.delete(ownership.endpointId);
        await runtime.removeEndpoint(ownership.endpointId).catch((error) => {
          logger.warn(
            {
              endpointId: ownership.endpointId,
              error: redactError(error),
            },
            "could not stop Discord Gateway after ownership loss",
          );
        });
      }
      // The listener is stopped before the lease is released. A standby can
      // therefore acquire immediately without overlapping Gateway sessions.
      await releaseDiscordGatewayLeaseRow(ownership);
      if (discordGatewayOwnerships.get(ownership.endpointId) === ownership) {
        discordGatewayOwnerships.delete(ownership.endpointId);
      }
      if (!options.isShuttingDown() && stopOptions.notifyStopped !== false) options.onStopped?.(ownership.endpointId);
    })();
    discordGatewayStopTasks.add(ownership.stopPromise);
    void ownership.stopPromise.finally(() => {
      if (ownership.stopPromise) {
        discordGatewayStopTasks.delete(ownership.stopPromise);
      }
    });
    return ownership.stopPromise;
  }

  async function renewDiscordGatewayOwnership(
    ownership: DiscordGatewayOwnership,
  ): Promise<boolean> {
    if (
      options.isShuttingDown() ||
      ownership.stopping ||
      discordGatewayOwnerships.get(ownership.endpointId) !== ownership ||
      ownership.context.discordGatewayOwned !== true ||
      ownership.context.endpointRuntime === undefined ||
      runtime.get(ownership.endpointId) !== ownership.context.endpointRuntime
    ) {
      return false;
    }
    const proposedExpiresAt = new Date(
      Date.now() +
      (options.discordGatewayLeaseTtlMs ?? DISCORD_GATEWAY_LEASE_TTL_MS),
    );
    if (
      options.renewDiscordGatewayLease &&
      !(await options.renewDiscordGatewayLease({
        companyId: ownership.companyId,
        credentialFingerprint: ownership.context.credentialFingerprint,
        endpointId: ownership.endpointId,
        expiresAt: proposedExpiresAt,
        generation: ownership.context.generation,
        leaseKey: ownership.leaseKey,
        token: ownership.token,
      }))
    ) {
      return false;
    }
    return db.transaction(async (tx) => {
      const now = new Date();
      const current = await runtimeCallbackEndpoint(
        tx,
        ownership.endpointId,
        {
          credentialFingerprint: ownership.context.credentialFingerprint,
          generation: ownership.context.generation,
        },
        ["verifying", "active", "attention"],
      );
      if (!current || !leasedChatProvider(current.provider)) return false;
      const expiresAt = new Date(
        now.getTime() +
        (options.discordGatewayLeaseTtlMs ?? DISCORD_GATEWAY_LEASE_TTL_MS),
      );
      const renewed = await tx
        .update(chatEndpointLeases)
        .set({ expiresAt, updatedAt: now })
        .where(
          and(
            eq(chatEndpointLeases.companyId, ownership.companyId),
            eq(chatEndpointLeases.endpointId, ownership.endpointId),
            eq(chatEndpointLeases.leaseKey, ownership.leaseKey),
            eq(chatEndpointLeases.token, ownership.token),
          ),
        )
        .returning({ id: chatEndpointLeases.id });
      if (!renewed.length) return false;
      ownership.expiresAt = expiresAt;
      return true;
    });
  }

  async function renewDiscordGatewayOwnershipForMessageAdmission(
    tx: DbTransaction,
    endpointId: string,
    context: InboundRuntimeContext,
  ): Promise<
    | {
      kind: "owned";
      expiresAt: Date;
      ownership: DiscordGatewayOwnership;
    }
    | { kind: "lost"; ownership: DiscordGatewayOwnership | null }
  > {
    const ownership = discordGatewayOwnerships.get(endpointId);
    if (
      !ownership ||
      ownership.stopping ||
      ownership.context !== context ||
      context.discordGatewayOwned !== true ||
      context.endpointRuntime === undefined ||
      runtime.get(endpointId) !== context.endpointRuntime
    ) {
      return {
        kind: "lost",
        ownership: ownership?.context === context ? ownership : null,
      };
    }
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() +
      (options.discordGatewayLeaseTtlMs ?? DISCORD_GATEWAY_LEASE_TTL_MS),
    );
    const renewed = await tx
      .update(chatEndpointLeases)
      .set({ expiresAt, updatedAt: now })
      .where(
        and(
          eq(chatEndpointLeases.companyId, ownership.companyId),
          eq(chatEndpointLeases.endpointId, ownership.endpointId),
          eq(chatEndpointLeases.leaseKey, ownership.leaseKey),
          eq(chatEndpointLeases.token, ownership.token),
        ),
      )
      .returning({ id: chatEndpointLeases.id });
    return renewed.length
      ? { kind: "owned", expiresAt, ownership }
      : { kind: "lost", ownership };
  }

  function refreshDiscordGatewayOwnership(
    ownership: DiscordGatewayOwnership,
  ): Promise<void> {
    if (ownership.renewal) return ownership.renewal;
    ownership.renewal = renewDiscordGatewayOwnership(ownership)
      .then((owned) => {
        if (owned) return;
        logger.warn(
          { endpointId: ownership.endpointId },
          "lost Discord Gateway ownership; stopping the local listener",
        );
        // A Gateway lifecycle callback can be the caller that discovers the
        // lost token. Fence it synchronously, but do not make that callback
        // await the Gateway task whose adapter notification may be waiting on
        // the callback itself. The tracked stop task is joined at shutdown.
        void stopDiscordGatewayOwnership(ownership);
      })
      .catch((error) => {
        logger.warn(
          {
            endpointId: ownership.endpointId,
            error: redactError(error),
          },
          "Discord Gateway ownership renewal failed; stopping the local listener",
        );
        void stopDiscordGatewayOwnership(ownership);
      })
      .finally(() => {
        ownership.renewal = null;
      });
    return ownership.renewal;
  }

  async function ensureDiscordGatewayRuntimeIsCurrent(
    endpointId: string,
    context: RuntimeContext,
  ): Promise<boolean> {
    const ownership = discordGatewayOwnerships.get(endpointId);
    if (
      !ownership ||
      ownership.stopping ||
      ownership.context !== context ||
      context.discordGatewayOwned !== true ||
      context.endpointRuntime === undefined ||
      runtime.get(endpointId) !== context.endpointRuntime
    ) {
      return false;
    }
    if (ownership.expiresAt.getTime() <= Date.now()) {
      // A host can resume after the local TTL while its durable token is still
      // authoritative. Reclaim that exact token before accepting buffered
      // callbacks. A standby takeover changes the token, so the CAS fails and
      // the old listener remains fenced.
      await refreshDiscordGatewayOwnership(ownership);
    }
    return discordGatewayRuntimeIsCurrent(endpointId, context);
  }

  function startDiscordGatewayLeaseRenewal(
    ownership: DiscordGatewayOwnership,
  ): void {
    ownership.renewTimer = setInterval(
      () => {
        if (ownership.renewal || ownership.stopping) return;
        void refreshDiscordGatewayOwnership(ownership);
      },
      options.discordGatewayLeaseRenewalIntervalMs ??
      (options.discordGatewayLeaseTtlMs ?? DISCORD_GATEWAY_LEASE_TTL_MS) / 3,
    );
    ownership.renewTimer.unref?.();
  }

  async function acquireDiscordGatewayOwnership(
    endpoint: EndpointRow,
    context: RuntimeContext,
    waitForOwnership: boolean,
  ): Promise<DiscordGatewayOwnership | null> {
    const receiverLeaseKey = leaseKeyForProvider(endpoint.provider)!;
    const local = discordGatewayOwnerships.get(endpoint.id);
    if (
      local &&
      !local.stopping &&
      local.context.version === context.version &&
      local.expiresAt.getTime() > Date.now()
    ) {
      return local;
    }
    if (local) await stopDiscordGatewayOwnership(local);

    const token = randomUUID();
    const deadline =
      Date.now() +
      (waitForOwnership
        ? (options.discordGatewayLeaseWaitMs ?? DISCORD_GATEWAY_LEASE_WAIT_MS)
        : 0);
    for (; ;) {
      if (options.isShuttingDown()) return null;
      const now = new Date();
      const expiresAt = new Date(
        now.getTime() +
        (options.discordGatewayLeaseTtlMs ?? DISCORD_GATEWAY_LEASE_TTL_MS),
      );
      const inserted = await db
        .insert(chatEndpointLeases)
        .values({
          companyId: endpoint.companyId,
          endpointId: endpoint.id,
          leaseKey: receiverLeaseKey,
          token,
          expiresAt,
        })
        .onConflictDoNothing()
        .returning({ id: chatEndpointLeases.id });
      const reclaimed = inserted.length
        ? inserted
        : await db
          .update(chatEndpointLeases)
          .set({ token, expiresAt, updatedAt: now })
          .where(
            and(
              eq(chatEndpointLeases.companyId, endpoint.companyId),
              eq(chatEndpointLeases.endpointId, endpoint.id),
              eq(chatEndpointLeases.leaseKey, receiverLeaseKey),
              lte(chatEndpointLeases.expiresAt, now),
            ),
          )
          .returning({ id: chatEndpointLeases.id });
      if (reclaimed.length) {
        const ownership: DiscordGatewayOwnership = {
          companyId: endpoint.companyId,
          context,
          endpointId: endpoint.id,
          expiresAt,
          leaseKey: receiverLeaseKey,
          renewal: null,
          renewTimer: null,
          stopPromise: null,
          stopping: false,
          token,
        };
        discordGatewayOwnerships.set(endpoint.id, ownership);
        startDiscordGatewayLeaseRenewal(ownership);
        return ownership;
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) =>
        setTimeout(resolve, DISCORD_GATEWAY_LEASE_POLL_MS),
      );
    }
  }

  function discordGatewayRuntimeIsCurrent(
    endpointId: string,
    context: RuntimeContext,
  ): boolean {
    const ownership = discordGatewayOwnerships.get(endpointId);
    return (
      ownership !== undefined &&
      !ownership.stopping &&
      ownership.context === context &&
      ownership.expiresAt.getTime() > Date.now() &&
      context.discordGatewayOwned === true &&
      context.endpointRuntime !== undefined &&
      runtime.get(endpointId) === context.endpointRuntime
    );
  }
  return { discordGatewayNotOwnedError, isDiscordGatewayNotOwnedError, releaseDiscordGatewayLeaseRow, stopDiscordGatewayOwnership, renewDiscordGatewayOwnershipForMessageAdmission, ensureDiscordGatewayRuntimeIsCurrent, acquireDiscordGatewayOwnership, discordGatewayRuntimeIsCurrent };
}
