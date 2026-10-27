import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  chatActions,
  chatDiscordCommandOwners,
  type Db,
} from "@paperclipai/db";
import {
  createDiscordCommandRegistration,
  parseDiscordCommandRegistration,
  reconcileDiscordCommandRegistration,
  type DiscordCommandRegistration,
  type DiscordCommandRegistrationFence,
  type DiscordCommandRegistrationResult,
  type DiscordCommandRegistrationScope,
} from "./chat-discord-command-registration.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Database = Db | Tx;
type Registered = Extract<DiscordCommandRegistration, { phase: "registered" }>;
const kind = "discord_command_registration";
const resultSchema = "paperclip.discord.command-registration-result.v1";
const actionKey = (applicationId: string) =>
  `discord-command-registration:${applicationId}`;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
class OwnershipConflict extends Error {}
function deny(): never {
  throw new OwnershipConflict(
    "Discord command registration ownership is unavailable",
  );
}

export interface StoredDiscordCommandRegistrationOptions {
  scope: DiscordCommandRegistrationScope;
  runtimeFence: DiscordCommandRegistrationFence;
  botToken: string;
  fetch: typeof globalThis.fetch;
  /** Lock and verify endpoint -> current enabled connection, immutable app and
   * guild, runtime generation/credential fingerprint, and caller credential lease.
   * No HTTP may occur here. Store locks app-owner -> action after this callback. */
  authorize(tx: Tx): Promise<void>;
  /** Only bypass a successful registration's cache, never failure backoff. */
  force?: boolean;
  /** Atomic capability projection. Throwing rolls back the descriptor change. */
  onState?(tx: Tx, state: DiscordCommandRegistration): Promise<void>;
}
export type StoredDiscordCommandRegistrationResult =
  DiscordCommandRegistrationResult | { kind: "deferred" };

function retrySchedule(outcome: string, seconds?: number) {
  const minimum = outcome === "registered" ? 300 : 30;
  const delay =
    typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
      ? Math.max(minimum, seconds)
      : minimum;
  const until = Date.now() + Math.ceil(delay * 1000);
  // An unrepresentable Retry-After must not become an earlier retry. The date
  // remains safe for schedulers, with an explicit indefinite hold at this seam.
  return {
    retryAt: new Date(Math.min(8_640_000_000_000_000, until)).toISOString(),
    ...(until > 8_640_000_000_000_000 ? { retryIndefinite: true } : {}),
  };
}
function safeResult(outcome: string, seconds?: number) {
  return { schema: resultSchema, outcome, ...retrySchedule(outcome, seconds) };
}

async function stored(
  database: Database,
  scope: DiscordCommandRegistrationScope,
  lock = false,
  allowKnownPriorDefinition = false,
) {
  const owners = database
    .select()
    .from(chatDiscordCommandOwners)
    .where(eq(chatDiscordCommandOwners.applicationId, scope.applicationId));
  const [owner] = await (lock ? owners.for("update") : owners);
  if (
    !owner ||
    owner.companyId !== scope.companyId ||
    owner.endpointId !== scope.endpointId
  )
    return null;
  const actions = database
    .select()
    .from(chatActions)
    .where(
      and(
        eq(chatActions.id, owner.actionId),
        eq(chatActions.kind, kind),
        eq(chatActions.providerActionId, actionKey(scope.applicationId)),
      ),
    )
    .limit(1);
  const rows = await (lock ? actions.for("update") : actions);
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (
    row.id !== owner.actionId ||
    row.companyId !== scope.companyId ||
    row.endpointId !== scope.endpointId ||
    row.conversationId !== null ||
    row.deliveryId !== null ||
    row.principalId !== null
  )
    return null;
  const state = parseDiscordCommandRegistration(
    row.payload.registration,
    scope,
    allowKnownPriorDefinition,
  );
  if (
    !state ||
    row.status !== (state.phase === "registered" ? "processed" : "received")
  )
    return null;
  return { row, state };
}

/** Read-only current registration proof; a public command marker or an orphaned
 * action/tombstone is never sufficient. Runtime current-authority checks remain
 * the caller's responsibility. No remote state is inferred from this receipt. */
export async function readRegisteredDiscordCommandRegistration(
  database: Database,
  scope: DiscordCommandRegistrationScope,
  /** Use only inside the caller's endpoint -> connection transaction. */
  lock = false,
): Promise<Registered | null> {
  const value = await stored(database, scope, lock);
  return value?.state.phase === "registered" &&
    value.row.result?.schema === resultSchema &&
    value.row.result.outcome === "registered"
    ? value.state
    : null;
}

export async function reconcileStoredDiscordCommandRegistration(
  db: Db,
  options: StoredDiscordCommandRegistrationOptions,
): Promise<StoredDiscordCommandRegistrationResult> {
  // Copy caller-owned mutable inputs before any await. Validation is delegated
  // to the same closed descriptor/helper contract used for persisted receipts.
  const scope = Object.freeze({ ...options.scope });
  const fence = Object.freeze({ ...options.runtimeFence });
  const { authorize, onState, botToken, fetch, force } = options;
  let state: DiscordCommandRegistration | undefined;
  try {
    const proposed = createDiscordCommandRegistration(scope);
    if (
      !Number.isSafeInteger(fence.generation) ||
      fence.generation < 0 ||
      fence.generation > 2_147_483_647 ||
      typeof fence.credentialFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(fence.credentialFingerprint) ||
      typeof botToken !== "string" ||
      !botToken ||
      botToken.length > 4096 ||
      /[\r\n]/.test(botToken) ||
      typeof fetch !== "function"
    )
      throw new Error("Invalid registration context");
    const initial = await db.transaction(async (tx) => {
      await authorize(tx);
      const [priorOwner] = await tx
        .select()
        .from(chatDiscordCommandOwners)
        .where(eq(chatDiscordCommandOwners.applicationId, scope.applicationId))
        .for("update");
      if (!priorOwner) {
        const [history] = await tx
          .select({ id: chatActions.id })
          .from(chatActions)
          .where(
            and(
              eq(chatActions.kind, kind),
              eq(chatActions.providerActionId, actionKey(scope.applicationId)),
            ),
          )
          .limit(1);
        if (history) deny(); // No adoption of history lacking the global claim.
        const actionId = randomUUID();
        const inserted = await tx
          .insert(chatDiscordCommandOwners)
          .values({
            applicationId: scope.applicationId,
            companyId: scope.companyId,
            endpointId: scope.endpointId,
            actionId,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted.length) {
          await tx.insert(chatActions).values({
            id: actionId,
            companyId: scope.companyId,
            endpointId: scope.endpointId,
            kind,
            providerActionId: actionKey(scope.applicationId),
            payload: { registration: proposed },
            status: "received",
            result: safeResult("unavailable"),
          });
          await onState?.(tx, proposed);
          return { state: proposed, deferred: false };
        }
      }
      const current = await stored(tx, scope, true, true);
      if (!current) deny(); // In particular, never recreate an orphaned action.
      const result = current.row.result;
      const due =
        result?.schema === resultSchema && typeof result.retryAt === "string"
          ? Date.parse(result.retryAt)
          : NaN;
      if (!Number.isFinite(due)) deny();
      return {
        state: current.state,
        deferred:
          result?.retryIndefinite === true ||
          (due > Date.now() &&
            !(
              force === true &&
              current.state.phase === "registered" &&
              result?.outcome === "registered"
            )),
      };
    });
    state = initial.state;
    if (initial.deferred) return { kind: "deferred" };
    const check = async (tx: Tx) => {
      await authorize(tx);
      const current = await stored(tx, scope, true, true);
      if (!current || !same(current.state, state)) deny();
      return current;
    };
    const outcome = await reconcileDiscordCommandRegistration({
      state,
      scope,
      runtimeFence: fence,
      botToken,
      fetch,
      verifiedIdentity: {
        botExternalId: scope.applicationId,
        providerAccountId: scope.guildId,
      },
      authorize: async () => {
        await db.transaction(async (tx) => {
          await check(tx);
        });
      },
      commit: async (expected, next) => {
        await db.transaction(async (tx) => {
          const current = await check(tx);
          if (!same(current.state, expected)) deny();
          const result = safeResult(
            next.phase === "registered" ? "registered" : "unknown",
          );
          await tx
            .update(chatActions)
            .set({
              payload: { registration: next },
              status: next.phase === "registered" ? "processed" : "received",
              result,
              updatedAt: new Date(),
            })
            .where(eq(chatActions.id, current.row.id));
          await onState?.(tx, next);
        });
        state = next;
      },
    });
    await db.transaction(async (tx) => {
      const current = await check(tx);
      await tx
        .update(chatActions)
        .set({
          result: safeResult(
            outcome.kind,
            "retryAfterSeconds" in outcome
              ? outcome.retryAfterSeconds
              : undefined,
          ),
          updatedAt: new Date(),
        })
        .where(eq(chatActions.id, current.row.id));
    });
    return outcome;
  } catch (error) {
    if (error instanceof OwnershipConflict)
      return { kind: "conflict", reason: "unowned_namespace" };
    // No provider error prose/headers/body/credential enters storage or return.
    // A failed receipt commit leaves the already durable attempt quarantined.
    return state?.phase === "attempted"
      ? { kind: "unknown", state }
      : { kind: "unavailable", reason: "request_failed" };
  }
}
