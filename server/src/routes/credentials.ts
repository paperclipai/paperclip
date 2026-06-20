import type { Request } from "express";
import { Router } from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  createProviderCredentialSchema,
  type CredentialType,
  type QuotaWindow,
  updateProviderCredentialSchema,
} from "@paperclipai/shared";
import { fetchClaudeCliQuotaForOAuth, fetchClaudeQuota } from "@paperclipai/adapter-claude-local/server";
import { fetchCodexQuota, runCodexLogin } from "@paperclipai/adapter-codex-local/server";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { forbidden } from "../errors.js";
import { accessService, credentialService, logActivity } from "../services/index.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const QUOTA_PROVIDER_REFRESH_MS = 15 * 60 * 1000;
export const QUOTA_ERROR_COOLDOWN_MS = 15 * 60 * 1000;
export const QUOTA_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

type CredentialQuotaCacheEntry = {
  type: CredentialType;
  credentialUpdatedAtMs: number;
  source: string;
  quotaWindows: QuotaWindow[];
  sampledAt: string;
};

type CredentialQuotaErrorCacheEntry = {
  type: CredentialType;
  credentialUpdatedAtMs: number;
  error: string;
  failedAt: string;
};

const credentialQuotaCache = new Map<string, CredentialQuotaCacheEntry>();
const credentialQuotaErrorCache = new Map<string, CredentialQuotaErrorCacheEntry>();

function normalizeQuotaError(provider: "claude" | "codex", error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("429")) {
    return provider === "claude"
      ? "Anthropic usage endpoint is rate limited (HTTP 429). OAuth can still be active; showing the last successful quota sample when available."
      : "ChatGPT usage endpoint is rate limited (HTTP 429). OAuth can still be active; showing the last successful quota sample when available.";
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return provider === "claude"
      ? "Anthropic usage endpoint timed out. Showing the last successful quota sample when available."
      : "Codex quota polling timed out. Showing the last successful quota sample when available.";
  }
  if (lower.includes("401") || lower.includes("403")) {
    return provider === "claude"
      ? `Anthropic rejected this OAuth token: ${message}`
      : `ChatGPT rejected this OAuth token: ${message}`;
  }
  return message;
}

function isCredentialQuotaCacheValid(
  cached: CredentialQuotaCacheEntry | CredentialQuotaErrorCacheEntry | undefined,
  credential: {
    type: CredentialType;
    updatedAt: Date;
  },
): cached is CredentialQuotaCacheEntry | CredentialQuotaErrorCacheEntry {
  if (!cached) return false;
  if (cached.type !== credential.type) return false;
  if (cached.credentialUpdatedAtMs !== credential.updatedAt.getTime()) return false;
  return true;
}

export function getReusableQuotaCache(credential: {
  id: string;
  type: CredentialType;
  updatedAt: Date;
}, now = Date.now()): CredentialQuotaCacheEntry | null {
  const cached = credentialQuotaCache.get(credential.id);
  if (!isCredentialQuotaCacheValid(cached, credential)) return null;
  if (now - new Date(cached.sampledAt).getTime() > QUOTA_PROVIDER_REFRESH_MS) return null;
  return cached;
}

export function getFreshQuotaCache(credential: {
  id: string;
  type: CredentialType;
  updatedAt: Date;
}, now = Date.now()): CredentialQuotaCacheEntry | null {
  const cached = credentialQuotaCache.get(credential.id);
  if (!isCredentialQuotaCacheValid(cached, credential)) return null;
  if (now - new Date(cached.sampledAt).getTime() > QUOTA_CACHE_MAX_AGE_MS) return null;
  return cached;
}

export function getRecentQuotaErrorCache(credential: {
  id: string;
  type: CredentialType;
  updatedAt: Date;
}, now = Date.now()): CredentialQuotaErrorCacheEntry | null {
  const cached = credentialQuotaErrorCache.get(credential.id);
  if (!isCredentialQuotaCacheValid(cached, credential)) return null;
  if (now - new Date(cached.failedAt).getTime() > QUOTA_ERROR_COOLDOWN_MS) return null;
  return cached;
}

function setQuotaSuccessCache(
  credentialId: string,
  entry: CredentialQuotaCacheEntry,
) {
  credentialQuotaCache.set(credentialId, entry);
  credentialQuotaErrorCache.delete(credentialId);
}

function setQuotaErrorCache(
  credentialId: string,
  entry: CredentialQuotaErrorCacheEntry,
) {
  credentialQuotaErrorCache.set(credentialId, entry);
}

export function credentialRoutes(db: Db) {
  const router = Router();
  const svc = credentialService(db);
  const access = accessService(db);

  async function requireCredentialManage(req: Request, companyId: string): Promise<void> {
    assertBoard(req);
    if (req.actor.type !== "board") throw forbidden("Board access required");
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const userId = req.actor.userId;
    if (!userId) throw forbidden("Board access required");
    const allowed = await access.canUser(companyId, userId, "credentials:manage");
    if (!allowed) throw forbidden("Missing permission: credentials:manage");
  }

  // List credentials for a company (credential values are NOT returned)
  router.get("/companies/:companyId/credentials", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await svc.list(companyId);
    res.json(rows);
  });

  // Per-credential token/cost usage. `period=month` uses calendar month-to-date
  // from the first day of the current UTC month; `days=N` remains for legacy
  // trailing-window callers.
  // Feeds the Credentials UI's usage column; aggregates cost_events.credentialId.
  router.get("/companies/:companyId/credentials/usage", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const period = String(req.query.period ?? "").trim().toLowerCase();
    if (period === "month" || period === "mtd" || period === "calendar_month_utc") {
      const result = await svc.usageByCredentialMonthToDate(companyId);
      res.json({
        period: "calendar_month_utc",
        since: result.since.toISOString(),
        usage: result.usage,
      });
      return;
    }
    const daysRaw = Number.parseInt(String(req.query.days ?? "30"), 10);
    const days = Number.isFinite(daysRaw) ? Math.min(365, Math.max(1, daysRaw)) : 30;
    const usage = await svc.usageByCredential(companyId, days * 24 * 60 * 60 * 1000);
    res.json({ period: "rolling_days", days, usage });
  });

  router.get("/companies/:companyId/credentials/quota-windows", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await svc.list(companyId);
    const sampledAt = new Date().toISOString();
    const results = await Promise.all(rows.map(async (credential) => {
      const base = {
        credentialId: credential.id,
        name: credential.name,
        type: credential.type,
        cooldownUntil: credential.cooldownUntil ? credential.cooldownUntil.toISOString() : null,
        cooldownReason: credential.cooldownReason ?? null,
        disabledAt: credential.disabledAt ? credential.disabledAt.toISOString() : null,
        sampledAt,
      };
      if (credential.type !== "claude_oauth" && credential.type !== "codex_oauth") {
        return {
          ...base,
          supported: false,
          ok: false,
          quotaWindows: [],
          source: null,
          error: "live quota is only available for Claude OAuth and Codex OAuth credentials",
        };
      }
      const credentialType: Extract<CredentialType, "claude_oauth" | "codex_oauth"> =
        credential.type === "claude_oauth" ? "claude_oauth" : "codex_oauth";
      const source = credentialType === "claude_oauth" ? "anthropic-oauth-usage" : "chatgpt-wham-usage";
      const reusableCached = getReusableQuotaCache({
        id: credential.id,
        type: credentialType,
        updatedAt: credential.updatedAt,
      });
      if (reusableCached) {
        return {
          ...base,
          sampledAt: reusableCached.sampledAt,
          supported: true,
          ok: true,
          quotaWindows: reusableCached.quotaWindows,
          source: reusableCached.source,
          stale: false,
          cachedAt: reusableCached.sampledAt,
        };
      }
      const recentError = getRecentQuotaErrorCache({
        id: credential.id,
        type: credentialType,
        updatedAt: credential.updatedAt,
      });
      if (recentError) {
        const cached = getFreshQuotaCache({
          id: credential.id,
          type: credentialType,
          updatedAt: credential.updatedAt,
        });
        return {
          ...base,
          sampledAt: recentError.failedAt,
          supported: true,
          ok: false,
          quotaWindows: cached?.quotaWindows ?? [],
          source: cached?.source ?? source,
          error: recentError.error,
          stale: Boolean(cached),
          cachedAt: cached?.sampledAt ?? null,
        };
      }
      try {
        const payload = await svc.getDecryptedPayload(credential.id);
        const payloadRecord = payload ?? {};
        const accessToken = typeof payloadRecord.accessToken === "string" ? payloadRecord.accessToken : "";
        if (!accessToken) throw new Error("credential has no accessToken");
        if (credentialType === "claude_oauth") {
          let source = "anthropic-oauth-usage";
          let quotaWindows: QuotaWindow[];
          try {
            quotaWindows = await fetchClaudeQuota(accessToken);
          } catch (oauthError) {
            try {
              quotaWindows = await fetchClaudeCliQuotaForOAuth(payloadRecord, { timeoutMs: 35_000 });
              source = "claude-cli-usage";
            } catch {
              throw oauthError;
            }
          }
          setQuotaSuccessCache(credential.id, {
            type: credentialType,
            credentialUpdatedAtMs: credential.updatedAt.getTime(),
            source,
            quotaWindows,
            sampledAt,
          });
          return {
            ...base,
            supported: true,
            ok: true,
            quotaWindows,
            source,
            stale: false,
            cachedAt: null,
          };
        }
        const accountId = typeof payload?.accountId === "string" && payload.accountId.trim()
          ? payload.accountId.trim()
          : null;
        return {
          ...base,
          supported: true,
          ok: true,
          quotaWindows: await fetchCodexQuota(accessToken, accountId).then((quotaWindows) => {
            setQuotaSuccessCache(credential.id, {
              type: credentialType,
              credentialUpdatedAtMs: credential.updatedAt.getTime(),
              source,
              quotaWindows,
              sampledAt,
            });
            return quotaWindows;
          }),
          source,
          stale: false,
          cachedAt: null,
        };
      } catch (error) {
        const provider = credentialType === "claude_oauth" ? "claude" : "codex";
        const normalizedError = normalizeQuotaError(provider, error);
        setQuotaErrorCache(credential.id, {
          type: credentialType,
          credentialUpdatedAtMs: credential.updatedAt.getTime(),
          error: normalizedError,
          failedAt: sampledAt,
        });
        const cached = getFreshQuotaCache({
          id: credential.id,
          type: credentialType,
          updatedAt: credential.updatedAt,
        });
        return {
          ...base,
          supported: true,
          ok: false,
          quotaWindows: cached?.quotaWindows ?? [],
          source: cached?.source ?? source,
          error: normalizedError,
          stale: Boolean(cached),
          cachedAt: cached?.sampledAt ?? null,
        };
      }
    }));
    res.json(results);
  });

  // Create a credential
  router.post(
    "/companies/:companyId/credentials",
    validate(createProviderCredentialSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await requireCredentialManage(req, companyId);

      if (req.query.skipTest !== "true") {
        const probe = await safeProbe(req.body.type, req.body.credential);
        if (!probe.ok && probe.reason === "invalid") {
          res.status(400).json({ error: `Credential test failed: ${probe.message}` });
          return;
        }
        if (!probe.ok && probe.reason === "infra") {
          logger.warn(
            { companyId, type: req.body.type, message: probe.message },
            "credential probe unreachable — saving without validation",
          );
        }
      }

      const created = await svc.create(companyId, {
        name: req.body.name,
        type: req.body.type,
        credential: req.body.credential,
        isDefault: req.body.isDefault,
      });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.type === "board" ? req.actor.userId ?? "board" : "board",
        action: "credential.created",
        entityType: "credential",
        entityId: created.id,
        details: { name: created.name, type: created.type },
      });

      res.status(201).json(created);
    },
  );

  // Update a credential
  router.patch(
    "/credentials/:id",
    validate(updateProviderCredentialSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Credential not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);
      await requireCredentialManage(req, existing.companyId);

      if (req.body.credential !== undefined && req.query.skipTest !== "true") {
        const probe = await safeProbe(existing.type, req.body.credential);
        if (!probe.ok && probe.reason === "invalid") {
          res.status(400).json({ error: `Credential test failed: ${probe.message}` });
          return;
        }
        if (!probe.ok && probe.reason === "infra") {
          logger.warn(
            { credentialId: id, type: existing.type, message: probe.message },
            "credential probe unreachable — updating without validation",
          );
        }
      }

      const updated = await svc.update(id, {
        name: req.body.name,
        credential: req.body.credential,
        isDefault: req.body.isDefault,
      });

      if (!updated) {
        res.status(404).json({ error: "Credential not found" });
        return;
      }

      await logActivity(db, {
        companyId: updated.companyId,
        actorType: "user",
        actorId: req.actor.type === "board" ? req.actor.userId ?? "board" : "board",
        action: "credential.updated",
        entityType: "credential",
        entityId: updated.id,
        details: { name: updated.name },
      });

      res.json(updated);
    },
  );

  // Delete a credential
  router.delete("/credentials/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Credential not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    await requireCredentialManage(req, existing.companyId);

    const force = req.query.force === "true";
    const result = await svc.remove(id, force);
    if (result && "error" in result) {
      res.status(409).json({
        error: "Credential is in use by one or more agents. Delete with ?force=true to remove anyway.",
      });
      return;
    }
    if (!result) {
      res.status(404).json({ error: "Credential not found" });
      return;
    }

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.type === "board" ? req.actor.userId ?? "board" : "board",
      action: "credential.deleted",
      entityType: "credential",
      entityId: existing.id,
      details: { name: existing.name },
    });

    res.json({ ok: true });
  });

  // ── Probe a credential from the form (before save) ───────────────────

  router.post("/credentials/probe", async (req, res) => {
    assertBoard(req);
    const body = req.body as { type?: unknown; credential?: unknown };
    const type = typeof body.type === "string" ? body.type : "";
    const credential =
      body.credential && typeof body.credential === "object" && !Array.isArray(body.credential)
        ? (body.credential as Record<string, unknown>)
        : null;
    if (!type || !credential) {
      res.status(400).json({ error: "type and credential (object) are required" });
      return;
    }
    const result = await safeProbe(type, credential);
    res.json({ ok: result.ok, message: result.message });
  });

  // ── Test credential (probe provider API) ─────────────────────────────

  router.post("/credentials/:id/test", async (req, res) => {
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "Invalid credential id" });
      return;
    }
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Credential not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    await requireCredentialManage(req, existing.companyId);
    const payload = await svc.getDecryptedPayload(id);
    if (!payload) {
      res.status(404).json({ error: "Credential not found" });
      return;
    }
    const result = await safeProbe(existing.type, payload);
    res.json({ ok: result.ok, message: result.message });
  });

  // Re-enable a disabled / cooling-down credential so it rejoins the rotation
  // pool (clears disabled flag, cooldown, and the failure counter).
  router.post("/credentials/:id/reenable", async (req, res) => {
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "Invalid credential id" });
      return;
    }
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Credential not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    await requireCredentialManage(req, existing.companyId);
    const updated = await svc.reenable(id);
    res.json(updated);
  });

  // ── Reveal credential value (audit-logged, rate-limited) ──────────────

  // In-memory sliding-window rate limit: max 10 reveals per minute per user
  const revealTimestamps = new Map<string, number[]>();

  router.get("/credentials/:id/reveal", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Credential not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    await requireCredentialManage(req, existing.companyId);

    const rateLimitKey =
      req.actor.type === "board" ? req.actor.userId ?? "board" : "board";
    const now = Date.now();
    const windowMs = 60_000;
    const maxReveals = 10;
    const timestamps = revealTimestamps.get(rateLimitKey) ?? [];
    const recent = timestamps.filter((t) => now - t < windowMs);
    if (recent.length >= maxReveals) {
      res.status(429).json({ error: "Too many credential reveals. Try again later." });
      return;
    }
    recent.push(now);
    revealTimestamps.set(rateLimitKey, recent);

    const decrypted = await svc.getDecryptedPayload(id);
    if (!decrypted) {
      res.status(404).json({ error: "Credential not found" });
      return;
    }

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: rateLimitKey,
      action: "credential.revealed",
      entityType: "credential",
      entityId: id,
      details: { name: existing.name, type: existing.type },
    });

    res.json({ credential: decrypted });
  });

  // ── Codex device-auth flow for credential creation/edit ──────────────
  // The agent-scoped flow at /agents/:id/codex-login writes auth.json into the
  // company's managed CODEX_HOME. For *creating* a credential we don't have an
  // agent yet (and don't want to mutate any other agent's auth.json), so this
  // flow runs `codex login --device-auth` against an isolated temp directory,
  // captures the resulting auth.json contents, and returns them once to the UI
  // for storage via the existing credential CREATE endpoint. The temp dir is
  // wiped on success/error/timeout — auth.json is NEVER persisted server-side
  // outside the in-memory session.
  type CodexCredLoginSession = {
    companyId: string;
    codexHome: string; // temp dir under os.tmpdir()
    status: "starting" | "awaiting_user" | "success" | "error";
    verificationUrl: string | null;
    userCode: string | null;
    error: string | null;
    errorCode: "timeout" | "denied" | "device_code_disabled" | "infra" | null;
    authJson: string | null; // populated once on success, then cleared on first read
    stderr: string;
    startedAt: number;
    finishedAt: number | null;
    cleanupTimer: NodeJS.Timeout | null;
  };
  const codexCredSessions = new Map<string, CodexCredLoginSession>();
  const CODEX_CRED_LOGIN_SESSION_TTL_MS = 30 * 60 * 1000; // 30min

  async function wipeCodexCredSession(sessionId: string): Promise<void> {
    const session = codexCredSessions.get(sessionId);
    if (!session) return;
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }
    codexCredSessions.delete(sessionId);
    try {
      await fs.rm(session.codexHome, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        { sessionId, codexHome: session.codexHome, err: err instanceof Error ? err.message : String(err) },
        "failed to remove codex credential temp home",
      );
    }
  }

  router.post("/companies/:companyId/credentials/codex/device-auth-start", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await requireCredentialManage(req, companyId);

    const sessionId = randomUUID();
    // Codex 0.130+ refuses CODEX_HOME under /tmp (it won't write helper binaries or
    // auth.json there), so the session dir must live under $HOME instead.
    const codexHome = path.join(os.homedir(), ".paperclip-codex-oauth", sessionId);
    await fs.mkdir(codexHome, { recursive: true });

    const session: CodexCredLoginSession = {
      companyId,
      codexHome,
      status: "starting",
      verificationUrl: null,
      userCode: null,
      error: null,
      errorCode: null,
      authJson: null,
      stderr: "",
      startedAt: Date.now(),
      finishedAt: null,
      cleanupTimer: null,
    };

    // Hard TTL guard: even if the UI never polls again, wipe the temp dir
    // and session entry after 30min so we don't leak fs space or memory.
    session.cleanupTimer = setTimeout(() => {
      void wipeCodexCredSession(sessionId);
    }, CODEX_CRED_LOGIN_SESSION_TTL_MS);

    // Diagnostic startup guard: if codex hasn't emitted a device-auth URL+code
    // within 8s, transition to error and surface the captured stdout/stderr
    // so the user (and we) can see what went wrong instead of staring at
    // "Generating a one-time code…" forever. Catches codex output-format
    // drift, network blocks to auth.openai.com, hangs on stdin, etc.
    setTimeout(() => {
      const current = codexCredSessions.get(sessionId);
      if (!current || current.status !== "starting") return;
      current.status = "error";
      current.errorCode = "infra";
      const captured = current.stderr.trim();
      current.error = captured
        ? "ChatGPT login did not emit a device code within 8s. The codex CLI may be unreachable, blocked from auth.openai.com, or have changed its output format. See diagnostic output below."
        : "ChatGPT login did not emit a device code within 8s. The codex CLI produced NO output at all — likely the binary is missing, hanging on stdin, or being killed before it starts. Check Dokploy logs.";
    }, 8_000);

    codexCredSessions.set(sessionId, session);

    void (async () => {
      try {
        const result = await runCodexLogin({
          runId: `codex-cred-login-${sessionId}`,
          // No agent: this is a credential-creation flow with no agent context.
          // codexHomeOverride forces the CLI to write into the temp dir without
          // touching the host's shared codex home or any company managed home.
          config: {},
          codexHomeOverride: codexHome,
          onLog: async (stream, chunk) => {
            // Capture BOTH streams. When the codex CLI changes its output
            // format (or emits the device-auth URL/code on stderr), we still
            // want it surfaced to the UI on the diagnostic timeout below.
            const tag = stream === "stdout" ? "" : "[stderr] ";
            const next = session.stderr + tag + chunk;
            session.stderr = next.length > 16384 ? next.slice(-16384) : next;
          },
          onDeviceAuth: ({ verificationUrl, userCode }) => {
            session.verificationUrl = verificationUrl;
            session.userCode = userCode;
            session.status = "awaiting_user";
          },
        });

        session.finishedAt = Date.now();
        if (!session.verificationUrl && result.loginUrl) session.verificationUrl = result.loginUrl;
        if (!session.userCode && result.userCode) session.userCode = result.userCode;

        const evidence = `${result.stdout}\n${result.stderr}`.toLowerCase();
        const deviceCodeDisabled = evidence.includes("device code login is not enabled");

        if (deviceCodeDisabled) {
          session.status = "error";
          session.errorCode = "device_code_disabled";
          session.error =
            "Device Code Login is not enabled for this ChatGPT account. Enable it in your ChatGPT account security settings, then try again.";
          await fs.rm(codexHome, { recursive: true, force: true }).catch(() => {});
          return;
        }

        if (result.timedOut) {
          session.status = "error";
          session.errorCode = "timeout";
          session.error = "Timed out waiting for browser approval.";
          await fs.rm(codexHome, { recursive: true, force: true }).catch(() => {});
          return;
        }

        if ((result.exitCode ?? 0) === 0) {
          // Capture the resulting auth.json so the UI can submit it via the
          // existing credential CREATE endpoint. The file lives in the temp
          // dir and is wiped as soon as the UI reads it (or after TTL).
          try {
            const authJsonPath = path.join(codexHome, "auth.json");
            const contents = await fs.readFile(authJsonPath, "utf8");
            session.authJson = contents;
            session.status = "success";
            session.error = null;
          } catch (err) {
            session.status = "error";
            session.errorCode = "infra";
            session.error =
              "codex login completed but auth.json could not be read: " +
              (err instanceof Error ? err.message : String(err));
            await fs.rm(codexHome, { recursive: true, force: true }).catch(() => {});
          }
          return;
        }

        session.status = "error";
        session.errorCode = "denied";
        session.error =
          result.stderr?.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ??
          `codex login --device-auth exited with code ${result.exitCode ?? -1}`;
        await fs.rm(codexHome, { recursive: true, force: true }).catch(() => {});
      } catch (err) {
        session.finishedAt = Date.now();
        session.status = "error";
        session.errorCode = "infra";
        session.error = err instanceof Error ? err.message : String(err);
        await fs.rm(codexHome, { recursive: true, force: true }).catch(() => {});
      }
    })();

    res.json({ sessionId });
  });

  router.get(
    "/companies/:companyId/credentials/codex/device-auth-poll/:sessionId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const sessionId = req.params.sessionId as string;
      assertCompanyAccess(req, companyId);
      await requireCredentialManage(req, companyId);

      res.set("Cache-Control", "no-store");

      const session = codexCredSessions.get(sessionId);
      if (!session || session.companyId !== companyId) {
        res.status(404).json({ error: "Codex login session not found or expired" });
        return;
      }

      // On success: return auth.json ONCE, then wipe the temp dir + session.
      // The UI is expected to immediately POST it to the credential CREATE
      // endpoint. We don't keep the secret around server-side.
      if (session.status === "success" && session.authJson) {
        const authJson = session.authJson;
        session.authJson = null;
        const stderr = session.stderr;
        await wipeCodexCredSession(sessionId);
        res.json({
          status: "success",
          verificationUrl: null,
          userCode: null,
          error: null,
          errorCode: null,
          authJson,
          stderr,
        });
        return;
      }

      res.json({
        status: session.status,
        verificationUrl: session.verificationUrl,
        userCode: session.userCode,
        error: session.error,
        errorCode: session.errorCode,
        authJson: null,
        stderr: session.stderr,
      });
    },
  );

  return router;
}

type ProbeResult =
  | { ok: true; message: string }
  | { ok: false; reason: "invalid" | "infra"; message: string };

const PROBE_TIMEOUT_MS = 10_000;

function probeFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
}

function classifyStatus(status: number): "invalid" | "infra" {
  // 401/403 from provider = bad credential. Everything else (5xx, 429, etc.) = infra/transient.
  return status === 401 || status === 403 ? "invalid" : "infra";
}

async function safeProbe(type: string, payload: Record<string, unknown>): Promise<ProbeResult> {
  try {
    return await probeCredential(type, payload);
  } catch (err) {
    logger.error(
      { type, err: err instanceof Error ? err.message : String(err) },
      "probeCredential threw unexpectedly",
    );
    return {
      ok: false,
      reason: "infra",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeCredential(type: string, payload: Record<string, unknown>): Promise<ProbeResult> {
  switch (type) {
    case "claude_oauth": {
      const accessToken = typeof payload.accessToken === "string" ? payload.accessToken : "";
      if (!accessToken) return { ok: false, reason: "invalid", message: "Missing accessToken" };
      const res = await probeFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      if (res.ok) {
        const tokenKind = typeof payload.tokenKind === "string" ? payload.tokenKind : null;
        const isLongLived = tokenKind === "long_lived" || (accessToken.startsWith("sk-ant-oat") && !payload.refreshToken);
        if (isLongLived) {
          return { ok: true, message: "Long-lived setup-token valid (no expiry / refresh required)" };
        }
        const refreshToken = typeof payload.refreshToken === "string" ? payload.refreshToken : "";
        const expiresAt = typeof payload.expiresAt === "number" ? payload.expiresAt : 0;
        const expiresSoon = expiresAt > 0 && expiresAt - Date.now() < 24 * 3600 * 1000;
        const warnings: string[] = [];
        if (!refreshToken) warnings.push("no refreshToken (will break when access token expires)");
        if (expiresSoon) warnings.push(`access token expires ${new Date(expiresAt).toISOString()}`);
        return {
          ok: true,
          message: warnings.length > 0 ? `OAuth token valid. Warning: ${warnings.join("; ")}` : "OAuth token valid",
        };
      }
      const body = await res.text().catch(() => "");
      return { ok: false, reason: classifyStatus(res.status), message: `Anthropic API returned ${res.status}: ${body.slice(0, 200)}` };
    }
    case "claude_api_key": {
      const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";
      if (!apiKey) return { ok: false, reason: "invalid", message: "Missing apiKey" };
      const res = await probeFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      if (res.ok) return { ok: true, message: "API key valid" };
      const body = await res.text().catch(() => "");
      return { ok: false, reason: classifyStatus(res.status), message: `Anthropic API returned ${res.status}: ${body.slice(0, 200)}` };
    }
    case "codex_oauth": {
      const accessToken = typeof payload.accessToken === "string" ? payload.accessToken : "";
      if (!accessToken) return { ok: false, reason: "invalid", message: "Missing accessToken" };
      const accountId = typeof payload.accountId === "string" ? payload.accountId : "";
      const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
      if (accountId) headers["ChatGPT-Account-Id"] = accountId;
      const res = await probeFetch("https://chatgpt.com/backend-api/wham/usage", { headers });
      if (res.ok) {
        const refreshToken = typeof payload.refreshToken === "string" ? payload.refreshToken : "";
        const warnings: string[] = [];
        if (!refreshToken) warnings.push("no refreshToken (will break when access token expires)");
        return {
          ok: true,
          message: warnings.length > 0 ? `OAuth token valid. Warning: ${warnings.join("; ")}` : "OAuth token valid",
        };
      }
      const body = await res.text().catch(() => "");
      return { ok: false, reason: classifyStatus(res.status), message: `ChatGPT API returned ${res.status}: ${body.slice(0, 200)}` };
    }
    case "openai_api_key": {
      const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";
      if (!apiKey) return { ok: false, reason: "invalid", message: "Missing apiKey" };
      const res = await probeFetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) return { ok: true, message: "API key valid" };
      return { ok: false, reason: classifyStatus(res.status), message: `OpenAI API returned ${res.status}` };
    }
    case "openrouter_api_key": {
      const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";
      if (!apiKey) return { ok: false, reason: "invalid", message: "Missing apiKey" };
      const res = await probeFetch("https://openrouter.ai/api/v1/auth/key", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) return { ok: true, message: "API key valid" };
      return { ok: false, reason: classifyStatus(res.status), message: `OpenRouter API returned ${res.status}` };
    }
    case "deepseek_api_key": {
      const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
      if (!apiKey) return { ok: false, reason: "invalid", message: "Missing apiKey" };
      const res = await probeFetch("https://api.deepseek.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) return { ok: true, message: "API key valid" };
      return { ok: false, reason: classifyStatus(res.status), message: `DeepSeek API returned ${res.status}` };
    }
    case "mimo_api_key": {
      const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
      if (!apiKey) return { ok: false, reason: "invalid", message: "Missing apiKey" };
      const res = await probeFetch("https://token-plan-sgp.xiaomimimo.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) return { ok: true, message: "API key valid" };
      return { ok: false, reason: classifyStatus(res.status), message: `MiMo API returned ${res.status}` };
    }
    case "gemini_api_key": {
      const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";
      if (!apiKey) return { ok: false, reason: "invalid", message: "Missing apiKey" };
      const res = await probeFetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      );
      if (res.ok) return { ok: true, message: "API key valid" };
      // Gemini returns 400 for bad keys; treat 400 like 401.
      const reason: "invalid" | "infra" = res.status === 400 ? "invalid" : classifyStatus(res.status);
      return { ok: false, reason, message: `Gemini API returned ${res.status}` };
    }
    default:
      return { ok: false, reason: "invalid", message: `Unknown credential type: ${type}` };
  }
}
