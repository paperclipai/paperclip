import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { adapterAuthSessions, ADAPTER_AUTH_SESSION_ACTIVE_STATES, environments, type Db } from "@paperclipai/db";
import type { AiConnectionLoginIntent, LocalAiLoginAttempt, LocalAiLoginStatus } from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { notFound, unprocessable } from "../errors.js";
import { aiConnectionService } from "./ai-connections.js";
import { readVerifiedLocalAiCredential } from "./local-ai-credentials.js";
import { logActivity } from "./activity-log.js";
import { startLocalBrowserLogin, type LocalBrowserLoginState } from "./local-ai-browser-login.js";

const LOCAL_LOGIN_METHOD = "local_subscription";
const ATTEMPT_DURATION_MS = 30 * 60 * 1000;
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
    ...(provider === "xai" ? { command: `(export GROK_HOME=${shellQuote(directory)} && mkdir -p "$GROK_HOME" && grok login --device-auth)` }
      : provider === "antigravity" ? { command: `(export HOME=${shellQuote(directory)} && mkdir -p "$HOME/.gemini/antigravity-cli" && agy)` } : {}),
  };
}
async function prepareHome(id: string, provider: string) {
  const directory = loginHome(id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (provider === "openai") {
    // Idempotent: preserve credentials when a user returns to an active attempt.
    await writeFile(path.join(directory, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  } else if (provider === "antigravity") {
    await mkdir(path.join(directory, ".gemini", "antigravity-cli"), { recursive: true, mode: 0o700 });
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

/** Local sign-ins share the durable attempt/credential lifecycle, but never seed
 * their home from the operator's rotating CLI credential. */
export function localAiLoginService(db: Db) {
  function stopBrowserLogin(id: string) {
    browserLogins.get(id)?.abort();
    browserLogins.delete(id);
  }
  function ensureBrowserLogin(id: string, provider: string) {
    if (provider === "xai" || provider === "antigravity" || browserLogins.has(id)) return;
    browserLogins.set(id, startLocalBrowserLogin(provider as "anthropic" | "openai", loginHome(id)));
  }
  async function reapExpired() {
    // Bounded batches use the existing expires-at index. Replaying is safe.
    const rows = await db.select({ id: adapterAuthSessions.id }).from(adapterAuthSessions)
      .where(and(eq(adapterAuthSessions.connectionMethod, LOCAL_LOGIN_METHOD),
        lte(adapterAuthSessions.expiresAt, new Date())))
      .orderBy(adapterAuthSessions.expiresAt).limit(100);
    for (const row of rows) {
      await db.transaction(async (tx) => {
        const [session] = await tx.select().from(adapterAuthSessions)
          .where(eq(adapterAuthSessions.id, row.id)).for("update");
        if (!session || !session.expiresAt || session.expiresAt.getTime() > Date.now()) return;
        stopBrowserLogin(row.id);
        await rm(loginHome(row.id), { recursive: true, force: true });
        await tx.update(adapterAuthSessions).set({
          status: session.connectionId ? "authenticated" : "timed_out",
          expiresAt: null, finishedAt: session.finishedAt ?? new Date(), updatedAt: new Date(),
        }).where(eq(adapterAuthSessions.id, row.id));
      });
    }
  }

  async function start(companyId: string, userId: string, intent: AiConnectionLoginIntent, restart = false): Promise<LocalAiLoginAttempt> {
    if (intent.provider !== "openai" && intent.provider !== "xai" && intent.provider !== "anthropic" && intent.provider !== "antigravity")
      throw unprocessable("This provider does not use a separate local login home.");
    await reapExpired();
    const attempt = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ai-local-login:${companyId}:${userId}:${intent.provider}`}, 0))`);
      const adapterType = intent.provider === "openai" ? "codex_local" : intent.provider === "anthropic" ? "claude_local" : intent.provider === "antigravity" ? "agy_local" : "grok_local";
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
        stopBrowserLogin(existing.id);
        await rm(loginHome(existing.id), { recursive: true, force: true });
        await tx.update(adapterAuthSessions).set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
          .where(eq(adapterAuthSessions.id, existing.id));
        await logActivity(tx as unknown as Db, {
          companyId, actorType: "user", actorId: userId, action: "ai_connection.local_login_cancelled",
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
        await tx.insert(adapterAuthSessions).values({
          id, publicSessionId: id, companyId, environmentId: environment.id,
          adapterType,
          startedByUserId: userId, aiConnection: intent,
          connectionMethod: LOCAL_LOGIN_METHOD, status: "waiting_for_user", expiresAt,
        });
        await logActivity(tx as unknown as Db, {
          companyId, actorType: "user", actorId: userId, action: "ai_connection.local_login_started",
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
    ensureBrowserLogin(attempt.sessionId, intent.provider);
    return attempt;
  }

  // Read-only credential detection: never saves a connection or refreshes another
  // login. Scope and intent are checked before touching an attempt's directory.
  async function check(companyId: string, userId: string, intent: AiConnectionLoginIntent, id?: string): Promise<LocalAiLoginStatus> {
    let directory: string | undefined;
    {
      if (!id) throw unprocessable(intent.provider === "xai" || intent.provider === "antigravity"
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
      await readVerifiedLocalAiCredential(intent.provider, directory);
      return { status: "ready" };
    } catch {
      const login = id ? browserLogins.get(id) : undefined;
      return { status: "sign_in_required", authorizationUrl: login?.authorizationUrl, code: login?.code,
        ...(!login && intent.provider !== "xai" && intent.provider !== "antigravity"
          ? { error: "The server restarted during sign-in. Start sign-in again." }
          : login?.outcome === "failure"
            ? { error: "Sign-in ended before the account was connected. Start sign-in again." }
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

  async function complete(companyId: string, userId: string, id: string, intent: AiConnectionLoginIntent) {
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
      const credential = await readVerifiedLocalAiCredential(intent.provider, loginHome(id));
      await tx.update(adapterAuthSessions).set({ status: "promoting", updatedAt: new Date() })
        .where(eq(adapterAuthSessions.id, id));
      // Nested transaction is a savepoint on this same connection. Holding the
      // attempt lock makes completion/cancellation/restart retries idempotent.
      const saved = await aiConnectionService(tx as unknown as Db)
        .save(companyId, userId, intent, credential, id, session.createdAt);
      await tx.update(adapterAuthSessions).set({
        status: "authenticated", connectionMethod: LOCAL_LOGIN_METHOD,
        finishedAt: new Date(), updatedAt: new Date(),
      }).where(eq(adapterAuthSessions.id, id));
      return saved;
    });
    // Failed cleanup can be retried by the same completed attempt or reaper.
    stopBrowserLogin(id);
    await rm(loginHome(id), { recursive: true, force: true });
    return result;
  }

  async function cancel(companyId: string, userId: string, id: string) {
    await db.transaction(async (tx) => {
      const [session] = await tx.select().from(adapterAuthSessions).where(and(
        eq(adapterAuthSessions.id, id), eq(adapterAuthSessions.companyId, companyId),
        eq(adapterAuthSessions.startedByUserId, userId),
        eq(adapterAuthSessions.connectionMethod, LOCAL_LOGIN_METHOD),
      )).for("update");
      if (!session) throw notFound("Local sign-in attempt not found.");
      stopBrowserLogin(id);
      await rm(loginHome(id), { recursive: true, force: true });
      if (!session.connectionId && session.status !== "cancelled") {
        await tx.update(adapterAuthSessions).set({
          status: "cancelled", finishedAt: new Date(), updatedAt: new Date(),
        }).where(eq(adapterAuthSessions.id, id));
        await logActivity(tx as unknown as Db, {
          companyId, actorType: "user", actorId: userId, action: "ai_connection.local_login_cancelled",
          entityType: "adapter_auth_session", entityId: id,
          details: { provider: session.aiConnection?.provider },
        });
      }
    });
  }
  return { start, check, submitCode, complete, cancel, reapExpired };
}
