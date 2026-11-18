import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import type { ConnectionManagementContext } from "./connection-management.js";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, isNotNull, lte, notInArray, sql } from "drizzle-orm";
import { adapterAuthSessions, ADAPTER_AUTH_SESSION_ACTIVE_STATES, databaseWorkScopeKey, environments, type Db } from "@paperclipai/db";
import type { AiConnectionLoginIntent, LocalAiLoginAttempt, LocalAiLoginStatus } from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { notFound, unprocessable } from "../errors.js";
import { aiConnectionService } from "./ai-connections.js";
import { readVerifiedLocalAiCredentialDetails } from "./local-ai-credentials.js";
import { logActivity } from "./activity-log.js";
import { startLocalBrowserLogin, type LocalBrowserLoginState } from "./local-ai-browser-login.js";
import { registerIdleLocalWorkProbe } from "./idle-local-work.js";

const LOCAL_LOGIN_METHOD = "local_subscription";
const ATTEMPT_DURATION_MS = 30 * 60 * 1000;
const BROWSER_STOP_WAIT_MS = 5_000;
const RETIREMENT_PENDING = "local_login_retirement_pending";
const CLEANUP_BATCH_SIZE = 16;
const CLEANUP_CONCURRENCY = 4;
function loginHome(id: string) {
  const root = resolvePaperclipInstanceRoot();
  // macOS exposes /var through a system symlink to /private/var. Credential
  // reads use O_NOFOLLOW_ANY, so generate login homes from the canonical root.
  // A fresh instance root may not exist yet; prepareHome creates it first.
  let canonicalRoot = root;
  try { canonicalRoot = realpathSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return path.join(canonicalRoot, "ai-local-logins", id);
}
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function presentAttempt(id: string, expiresAt: Date, provider: string): LocalAiLoginAttempt {
  const directory = loginHome(id);
  return {
    sessionId: id, expiresAt: expiresAt.toISOString(),
    ...(provider === "xai" ? { command: `(export GROK_HOME=${shellQuote(directory)} && mkdir -p "$GROK_HOME" && grok login --device-auth)` } : {}),
  };
}
async function prepareHome(id: string, provider: string) {
  const directory = loginHome(id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (provider === "openai") {
    // Idempotent: preserve credentials when a user returns to an active attempt.
    await writeFile(path.join(directory, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  }
}
function sameTarget(a: AiConnectionLoginIntent, b: AiConnectionLoginIntent) {
  return a.provider === b.provider && a.method === b.method && a.ownership === b.ownership &&
    a.connectionId === b.connectionId && a.allAgents === b.allAgents &&
    JSON.stringify([...a.agentIds].sort()) === JSON.stringify([...b.agentIds].sort());
}

// Route handlers construct this service per request. Keep live browser processes
// shared so status polling and code submission can reach the original process.
const browserLogins = new Map<string, LocalBrowserLoginState>();
const browserRetirements = new Map<string, Promise<void>>();
const deferredRetirements = new Map<string, { scope: object; retirement: Promise<void>; ready: boolean }>();
const cleanupReadyListeners = new WeakMap<object, Set<() => void>>();
registerIdleLocalWorkProbe(() => browserRetirements.size || deferredRetirements.size ? "present" : "none");

/** Local sign-ins share the durable attempt/credential lifecycle, but never seed
 * their home from the operator's rotating CLI credential. */
export function localAiLoginService(db: Db) {
  const scope = databaseWorkScopeKey(db);
  function retirementReady(id: string) {
    const retained = deferredRetirements.get(id);
    if (!retained || retained.scope !== scope || retained.ready) return;
    retained.ready = true;
    for (const wake of cleanupReadyListeners.get(scope) ?? []) {
      try { wake(); } catch { process.emitWarning("Local sign-in cleanup wake failed"); }
    }
  }
  function retainRetirement(id: string, retirement: Promise<void>) {
    if (deferredRetirements.get(id)?.retirement === retirement) return;
    const retained = { scope, retirement, ready: false };
    deferredRetirements.set(id, retained);
    void retirement.then(() => {
      if (deferredRetirements.get(id) === retained) retirementReady(id);
    }, () => {
      // A rejected abort needs an explicit Cancel or Start sign-in again to
      // retry its original owner. Keep its home/claim and sleep blocker; an
      // idle timer must not repeatedly signal a process with uncertain state.
    });
  }
  function subscribeCleanupReady(wake: () => void) {
    let listeners = cleanupReadyListeners.get(scope);
    if (!listeners) cleanupReadyListeners.set(scope, listeners = new Set());
    listeners.add(wake);
    return () => { listeners.delete(wake); };
  }
  function waitingRetirementIds() {
    return [...deferredRetirements].filter(([, owner]) => owner.scope === scope && !owner.ready).map(([id]) => id);
  }
  async function nextCleanupAt() {
    const waiting = waitingRetirementIds();
    const rows = await db.select({ at: adapterAuthSessions.expiresAt }).from(adapterAuthSessions).where(and(
      eq(adapterAuthSessions.connectionMethod, LOCAL_LOGIN_METHOD), isNotNull(adapterAuthSessions.expiresAt),
      waiting.length ? notInArray(adapterAuthSessions.id, waiting) : undefined,
    )).orderBy(adapterAuthSessions.expiresAt).limit(1);
    return rows[0]?.at?.getTime() ?? null;
  }
  function stopBrowserLogin(id: string): Promise<void> {
    const pending = browserRetirements.get(id);
    if (pending) return pending;
    const owner = browserLogins.get(id);
    const retirement = Promise.resolve().then(() => owner?.abort()).then(() => {
      if (browserLogins.get(id) === owner) browserLogins.delete(id);
      retirementReady(id);
    });
    browserRetirements.set(id, retirement);
    const release = () => { if (browserRetirements.get(id) === retirement) browserRetirements.delete(id); };
    void retirement.then(release, release);
    return retirement;
  }
  async function retireOwnedAttempt(companyId: string, userId: string, id: string, managementContext?: ConnectionManagementContext) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const retirement = stopBrowserLogin(id);
    try {
      await Promise.race([retirement, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(RETIREMENT_PENDING)), BROWSER_STOP_WAIT_MS);
      })]);
    } catch {
      retainRetirement(id, retirement);
      // Keep the active claim and private home. The existing expiry worker may
      // join the original retirement without holding a database transaction.
      await db.transaction(async tx => {
        const [session] = await tx.select().from(adapterAuthSessions).where(and(
          eq(adapterAuthSessions.id, id), eq(adapterAuthSessions.companyId, companyId),
          eq(adapterAuthSessions.startedByUserId, userId), eq(adapterAuthSessions.connectionMethod, LOCAL_LOGIN_METHOD),
        )).for("update");
        if (!session) return;
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.localLoginCleanup);
        const now = new Date();
        await tx.update(adapterAuthSessions).set({ expiresAt: session.expiresAt && session.expiresAt < now ? session.expiresAt : now,
          failureReason: RETIREMENT_PENDING, updatedAt: now })
          .where(eq(adapterAuthSessions.id, id));
        await logActivity(tx as unknown as Db, {
          companyId, ...(managementContext?.audit ?? { actorType: "user" as const, actorId: userId }),
          action: "ai_connection.local_login_cleanup_requested", entityType: "adapter_auth_session", entityId: id,
          details: { provider: session.aiConnection?.provider },
        });
      });
      throw unprocessable("The previous sign-in is still stopping. Retry shortly.", { code: "ai_connection_busy" });
    } finally { clearTimeout(timeout); }
  }
  function ensureBrowserLogin(id: string, provider: string) {
    if (provider === "xai" || browserLogins.has(id)) return;
    browserLogins.set(id, startLocalBrowserLogin(provider as "anthropic" | "openai" | "google", loginHome(id)));
  }
  async function reapExpired() {
    // Waiting native owners have a completion wake, not a retry deadline. The
    // durable expiry remains unchanged and reconstructs cleanup after restart.
    const waiting = waitingRetirementIds();
    const rows = await db.select({ id: adapterAuthSessions.id }).from(adapterAuthSessions)
      .where(and(eq(adapterAuthSessions.connectionMethod, LOCAL_LOGIN_METHOD),
        lte(adapterAuthSessions.expiresAt, new Date()), waiting.length ? notInArray(adapterAuthSessions.id, waiting) : undefined))
      .orderBy(adapterAuthSessions.expiresAt).limit(CLEANUP_BATCH_SIZE);
    // Include completed owners even if a prior cleanup committed but its reply
    // was lost. Only a durable read may release that uncertain obligation.
    const ready = [...deferredRetirements].filter(([, owner]) => owner.scope === scope && owner.ready).map(([id]) => id);
    const ids = [...new Set([...ready.slice(0, CLEANUP_BATCH_SIZE), ...rows.map(row => row.id)])];
    if (!ids.length) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), BROWSER_STOP_WAIT_MS); });
    async function cleanup(id: string) {
      const retirement = stopBrowserLogin(id);
      const retired = await Promise.race([retirement.then(() => true, () => false), budget]);
      if (!retired) { retainRetirement(id, retirement); return; }
      await db.transaction(async (tx) => {
        const [session] = await tx.select().from(adapterAuthSessions)
          .where(eq(adapterAuthSessions.id, id)).for("update");
        if (!session || session.connectionMethod !== LOCAL_LOGIN_METHOD || !session.expiresAt) {
          deferredRetirements.delete(id);
          return;
        }
        if (session.expiresAt.getTime() > Date.now()) return;
        await rm(loginHome(id), { recursive: true, force: true });
        await tx.update(adapterAuthSessions).set({
          status: session.connectionId ? "authenticated" : session.failureReason === RETIREMENT_PENDING ? "cancelled" : "timed_out",
          failureReason: null,
          expiresAt: null, finishedAt: session.finishedAt ?? new Date(), updatedAt: new Date(),
        }).where(eq(adapterAuthSessions.id, id));
      });
      deferredRetirements.delete(id);
    }
    try {
      const failures: unknown[] = [];
      for (let offset = 0; offset < ids.length; offset += CLEANUP_CONCURRENCY) {
        const results = await Promise.allSettled(ids.slice(offset, offset + CLEANUP_CONCURRENCY).map(cleanup));
        for (const result of results) if (result.status === "rejected") failures.push(result.reason);
      }
      if (failures.length) throw new AggregateError(failures, "Local sign-in expiry cleanup failed");
    } finally { clearTimeout(timeout); }
  }

  async function start(companyId: string, userId: string, intent: AiConnectionLoginIntent, restart = false, managementContext?: ConnectionManagementContext): Promise<LocalAiLoginAttempt> {
    if (!["openai", "xai", "anthropic", "google"].includes(intent.provider))
      throw unprocessable("This provider does not use a separate local login home.");
    // Expiry is owned by the durable localLoginCleanup deadline. Starting a
    // sign-in must not wait for another user's or provider's native retirement.
    await managementContext?.reauthorize();
    const adapterType = intent.provider === "google" ? "paperclip_runner" : intent.provider === "openai" ? "codex_local" : intent.provider === "anthropic" ? "claude_local" : "grok_local";
    let retiredAttemptId: string | undefined;
    if (restart) {
      const [existing] = await db.select().from(adapterAuthSessions).where(and(
        eq(adapterAuthSessions.companyId, companyId), eq(adapterAuthSessions.startedByUserId, userId),
        eq(adapterAuthSessions.adapterType, adapterType), inArray(adapterAuthSessions.status, [...ADAPTER_AUTH_SESSION_ACTIVE_STATES]),
      ));
      if (existing) {
        if (existing.connectionMethod !== LOCAL_LOGIN_METHOD) throw unprocessable("Another sign-in is still open. Finish or cancel it before starting again.");
        retiredAttemptId = existing.id;
        await retireOwnedAttempt(companyId, userId, existing.id, managementContext);
      }
    }
    const attempt = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ai-local-login:${companyId}:${userId}:${intent.provider}`}, 0))`);
      const [existing] = await tx.select().from(adapterAuthSessions).where(and(
        eq(adapterAuthSessions.companyId, companyId), eq(adapterAuthSessions.startedByUserId, userId),
        eq(adapterAuthSessions.adapterType, adapterType),
        inArray(adapterAuthSessions.status, [...ADAPTER_AUTH_SESSION_ACTIVE_STATES]),
      )).for("update");
      if (existing) {
        if (!restart && existing.connectionMethod === LOCAL_LOGIN_METHOD && existing.status === "waiting_for_user" &&
            existing.aiConnection && sameTarget(existing.aiConnection, intent) &&
            existing.expiresAt && existing.expiresAt.getTime() > Date.now()) {
          await prepareHome(existing.id, intent.provider);
          return presentAttempt(existing.id, existing.expiresAt, intent.provider);
        }
        if (!restart || existing.connectionMethod !== LOCAL_LOGIN_METHOD)
          throw unprocessable("Another sign-in is still open. Finish it, or choose Start sign-in again to replace a local attempt.");
        if (existing.id !== retiredAttemptId) throw unprocessable("The sign-in attempt changed. Retry Start sign-in again.");
        await rm(loginHome(existing.id), { recursive: true, force: true });
        await tx.update(adapterAuthSessions).set({ status: "cancelled", expiresAt: null, failureReason: null, finishedAt: new Date(), updatedAt: new Date() })
          .where(eq(adapterAuthSessions.id, existing.id));
        await logActivity(tx as unknown as Db, {
          companyId, ...(managementContext?.audit ?? { actorType: "user" as const, actorId: userId }), action: "ai_connection.local_login_cancelled",
          entityType: "adapter_auth_session", entityId: existing.id, details: { provider: intent.provider },
        });
      }
      const [environment] = await tx.select().from(environments)
        .where(and(eq(environments.driver, "local"), eq(environments.status, "active"))).limit(1);
      if (!environment) throw unprocessable("No active local environment is available.");
      const id = randomUUID();
      const directory = loginHome(id);
      const expiresAt = new Date(Date.now() + ATTEMPT_DURATION_MS);
      await prepareHome(id, intent.provider);
      try {
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.localLoginCleanup);
        await tx.insert(adapterAuthSessions).values({
          id, publicSessionId: id, companyId, environmentId: environment.id,
          adapterType,
          startedByUserId: userId, aiConnection: intent,
          connectionMethod: LOCAL_LOGIN_METHOD, status: "waiting_for_user", expiresAt,
        });
        await logActivity(tx as unknown as Db, {
          companyId, ...(managementContext?.audit ?? { actorType: "user" as const, actorId: userId }), action: "ai_connection.local_login_started",
          entityType: "adapter_auth_session", entityId: id, details: { provider: intent.provider },
        });
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        if ((error as { cause?: { code?: string }; code?: string }).cause?.code === "23505" ||
            (error as { code?: string }).code === "23505")
          throw unprocessable("Another sign-in is still open. Finish or cancel it before starting again.");
        throw error;
      }
      return presentAttempt(id, expiresAt, intent.provider);
    });
    if (retiredAttemptId) deferredRetirements.delete(retiredAttemptId);
    ensureBrowserLogin(attempt.sessionId, intent.provider);
    return attempt;
  }

  // Read-only credential detection: never saves a connection or refreshes another
  // login. Scope and intent are checked before touching an attempt's directory.
  async function check(companyId: string, userId: string, intent: AiConnectionLoginIntent, id?: string): Promise<LocalAiLoginStatus> {
    let directory: string | undefined;
    {
      if (!id) throw unprocessable(intent.provider === "xai"
        ? "Start local sign-in before checking this account."
        : "Start browser sign-in before checking this account.");
      const [session] = await db.select().from(adapterAuthSessions).where(and(
        eq(adapterAuthSessions.id, id), eq(adapterAuthSessions.companyId, companyId),
        eq(adapterAuthSessions.startedByUserId, userId),
        eq(adapterAuthSessions.connectionMethod, LOCAL_LOGIN_METHOD),
      ));
      if (!session?.aiConnection || !sameTarget(session.aiConnection, intent))
        throw notFound("Local sign-in attempt not found for this connection.");
      if (session.status !== "waiting_for_user" || !session.expiresAt || session.expiresAt.getTime() <= Date.now())
        return { status: "expired" };
      directory = loginHome(id);
    }
    try {
      if (intent.provider === "google" && browserLogins.get(id!)?.outcome !== "success") throw new Error("Google sign-in is incomplete");
      const verified = await readVerifiedLocalAiCredentialDetails(intent.provider, directory);
      return { status: "ready", ...(verified.accountLabel ? { accountLabel: verified.accountLabel } : {}) };
    } catch {
      const login = id ? browserLogins.get(id) : undefined;
      return { status: "sign_in_required", authorizationUrl: login?.authorizationUrl, code: login?.code,
        ...(!login && intent.provider !== "xai"
          ? { error: "The server restarted during sign-in. Start sign-in again." }
          : login?.outcome === "failure"
            ? { error: login.error ?? "Sign-in ended before the account was connected. Start sign-in again." }
            : {}) };
    }
  }

  async function submitCode(companyId: string, userId: string, id: string, code: string) {
    await db.transaction(async (tx) => {
      const [session] = await tx.select().from(adapterAuthSessions).where(and(
        eq(adapterAuthSessions.id, id), eq(adapterAuthSessions.companyId, companyId),
        eq(adapterAuthSessions.startedByUserId, userId), eq(adapterAuthSessions.connectionMethod, LOCAL_LOGIN_METHOD),
        eq(adapterAuthSessions.adapterType, "claude_local"),
      )).for("update");
      if (!session) throw notFound("Local sign-in attempt not found.");
      if (session.status !== "waiting_for_user" || !session.expiresAt || session.expiresAt.getTime() <= Date.now())
        throw unprocessable("This sign-in attempt has expired or was cancelled. Start sign-in again.");
      const login = browserLogins.get(id);
      if (!login?.authorizationUrl || !login.submitCode || login.outcome)
        throw unprocessable("This sign-in attempt cannot accept a code. Start sign-in again.");
      const submit = login.submitCode;
      login.submitCode = undefined;
      submit(code);
      await logActivity(tx as unknown as Db, {
        companyId, actorType: "user", actorId: userId, action: "ai_connection.local_login_code_submitted",
        entityType: "adapter_auth_session", entityId: id, details: { provider: "anthropic" },
      });
    });
  }

  async function complete(companyId: string, userId: string, id: string, intent: AiConnectionLoginIntent, managementContext?: ConnectionManagementContext) {
    await managementContext?.reauthorize();
    const result = await db.transaction(async (tx) => {
      const [session] = await tx.select().from(adapterAuthSessions).where(and(
        eq(adapterAuthSessions.id, id), eq(adapterAuthSessions.companyId, companyId),
        eq(adapterAuthSessions.startedByUserId, userId),
        // Successful completion replaces connectionMethod with subscription.
        sql`${adapterAuthSessions.providerLeaseId} is null`,
      )).for("update");
      if (!session || !session.aiConnection || !sameTarget(session.aiConnection, intent))
        throw notFound("Local sign-in attempt not found for this connection.");
      if (session.connectionId && session.connectionGrantId)
        return { connectionId: session.connectionId, grantId: session.connectionGrantId };
      if (session.connectionMethod !== LOCAL_LOGIN_METHOD || session.status !== "waiting_for_user" ||
          !session.expiresAt || session.expiresAt.getTime() <= Date.now())
        throw unprocessable("This sign-in attempt has expired or was cancelled. Start sign-in again.");
      if (intent.provider === "google" && browserLogins.get(id)?.outcome !== "success")
        throw unprocessable("Finish Google browser sign-in before connecting. If the server restarted, start sign-in again.");
      const verified = await readVerifiedLocalAiCredentialDetails(intent.provider, loginHome(id));
      await tx.update(adapterAuthSessions).set({ status: "promoting", updatedAt: new Date() })
        .where(eq(adapterAuthSessions.id, id));
      // Nested transaction is a savepoint on this same connection. Holding the
      // attempt lock makes completion/cancellation/restart retries idempotent.
      const saved = await aiConnectionService(tx as unknown as Db)
        .save(companyId, userId, intent, verified.credential, { id }, session.createdAt, managementContext, verified.accountLabel);
      await tx.update(adapterAuthSessions).set({
        status: "authenticated", connectionMethod: LOCAL_LOGIN_METHOD,
        finishedAt: new Date(), updatedAt: new Date(),
      }).where(eq(adapterAuthSessions.id, id));
      return saved;
    });
    // Failed cleanup can be retried by the same completed attempt or reaper.
    await stopBrowserLogin(id);
    await rm(loginHome(id), { recursive: true, force: true });
    deferredRetirements.delete(id);
    return result;
  }

  async function cancel(companyId: string, userId: string, id: string, managementContext?: ConnectionManagementContext) {
    await managementContext?.reauthorize();
    const [owned] = await db.select().from(adapterAuthSessions).where(and(
      eq(adapterAuthSessions.id, id), eq(adapterAuthSessions.companyId, companyId),
      eq(adapterAuthSessions.startedByUserId, userId), eq(adapterAuthSessions.connectionMethod, LOCAL_LOGIN_METHOD),
    ));
    if (!owned) throw notFound("Local sign-in attempt not found.");
    await retireOwnedAttempt(companyId, userId, id, managementContext);
    await db.transaction(async (tx) => {
      const [session] = await tx.select().from(adapterAuthSessions).where(and(
        eq(adapterAuthSessions.id, id), eq(adapterAuthSessions.companyId, companyId),
        eq(adapterAuthSessions.startedByUserId, userId),
        eq(adapterAuthSessions.connectionMethod, LOCAL_LOGIN_METHOD),
      )).for("update");
      if (!session) throw notFound("Local sign-in attempt not found.");
      await rm(loginHome(id), { recursive: true, force: true });
      if (!session.connectionId && session.status !== "cancelled") {
        await tx.update(adapterAuthSessions).set({
          status: "cancelled", expiresAt: null, failureReason: null, finishedAt: new Date(), updatedAt: new Date(),
        }).where(eq(adapterAuthSessions.id, id));
        await logActivity(tx as unknown as Db, {
          companyId, ...(managementContext?.audit ?? { actorType: "user" as const, actorId: userId }), action: "ai_connection.local_login_cancelled",
          entityType: "adapter_auth_session", entityId: id,
          details: { provider: session.aiConnection?.provider },
        });
      }
    });
    deferredRetirements.delete(id);
  }
  return { start, check, submitCode, complete, cancel, reapExpired, nextCleanupAt, subscribeCleanupReady };
}
