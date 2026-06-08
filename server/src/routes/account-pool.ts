import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { accountPoolState, companySecrets } from "@paperclipai/db";
import {
  POOL_ACCOUNT_TYPES,
  POOL_PROVIDERS,
  poolProviderFromType,
  type AccountPoolListResponse,
  type AccountWithHealth,
  type AddPoolAccountRequest,
  type OauthCompleteRequest,
  type OauthStartResponse,
  type PoolAccount,
  type PoolProvider,
  type PoolState,
  type RotationReason,
} from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity, secretService } from "../services/index.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import {
  DEFAULT_ACCOUNT_ID,
  getDefaultAccountHealth,
  readPoolAccountHealth,
  setAccountRotationEnabled,
  setDefaultRotationEnabled,
  setStopSwitch,
} from "../services/account-pool.js";
import { accountPoolBalancer, previewCombinedBest } from "../services/account-pool-balancer.js";
import {
  buildAuthorizeUrl,
  buildCredentialsBlob,
  exchangeCode,
  generatePkce,
  parsePastedCode,
} from "../services/claude-oauth.js";

/**
 * Account Pool & Rotation — Slice 4 API.
 *
 * Pool membership lives on company_secrets rows marked with
 * providerMetadata.poolType === POOL_ACCOUNT_TYPE ("claude_account"); the secret
 * value is the raw .credentials.json blob. The load-balancer state (which account
 * the whole team currently rides) lives in the account_pool_state table.
 *
 * All endpoints are company-scoped via a required ?companyId= query param so they
 * reuse the same auth/company-scoping guard as the secrets routes.
 */
export function accountPoolRoutes(db: Db) {
  const router = Router();
  const svc = secretService(db);
  const defaultProvider = getConfiguredSecretProvider();

  /** require + authorize the companyId query param, like the secrets routes do for the path param */
  function requireCompanyId(req: Parameters<Parameters<typeof router.get>[1]>[0]): string {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : "";
    if (!companyId) {
      throw Object.assign(new Error("companyId query parameter is required"), { status: 400 });
    }
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  /** read + validate the ?provider= query param; defaults to "claude" for back-compat */
  function readProvider(req: Parameters<Parameters<typeof router.get>[1]>[0]): PoolProvider {
    const raw = typeof req.query.provider === "string" ? req.query.provider : "";
    return raw === "codex" ? "codex" : "claude";
  }

  function poolTypeOf(metadata: unknown): string | null {
    if (!metadata || typeof metadata !== "object") return null;
    const value = (metadata as Record<string, unknown>).poolType;
    return typeof value === "string" ? value : null;
  }

  function metaString(metadata: unknown, key: string): string | undefined {
    if (!metadata || typeof metadata !== "object") return undefined;
    const value = (metadata as Record<string, unknown>)[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  async function listPoolSecrets(companyId: string, provider: PoolProvider) {
    const secrets = await svc.list(companyId);
    return secrets.filter((secret) => poolTypeOf(secret.providerMetadata) === POOL_ACCOUNT_TYPES[provider]);
  }

  function toPoolAccount(secret: {
    id: string;
    name: string;
    key: string;
    status: string;
  }): PoolAccount {
    return { id: secret.id, name: secret.name, key: secret.key, status: secret.status };
  }

  async function readState(companyId: string, provider: PoolProvider): Promise<PoolState | null> {
    const row = await db
      .select()
      .from(accountPoolState)
      .where(and(eq(accountPoolState.companyId, companyId), eq(accountPoolState.provider, provider)))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    return {
      companyId: row.companyId,
      provider: (row.provider as PoolProvider) ?? "claude",
      activeAccountId: row.activeAccountId,
      prevAccountId: row.prevAccountId,
      reason: row.reason as RotationReason,
      assignedAt: row.assignedAt.toISOString(),
      rotationStopped: row.rotationStopped,
      stopReason: row.stopReason,
      defaultRotationEnabled: row.defaultRotationEnabled,
    };
  }

  /**
   * Build the account list from the LAST-KNOWN health snapshots (persisted by the
   * Balancer Brain). This intentionally does NOT call the Anthropic usage API —
   * doing that on every 30s UI poll is what got us rate-limited (429). Live
   * re-probing happens on the 5-min Balancer tick and on the explicit Reload
   * endpoint below.
   */
  async function buildAccountList(companyId: string, provider: PoolProvider): Promise<AccountPoolListResponse> {
    const [secrets, state, defaultSnapshot] = await Promise.all([
      listPoolSecrets(companyId, provider),
      readState(companyId, provider),
      getDefaultAccountHealth(db, companyId, provider),
    ]);

    // The implicit "Default — this machine" account always comes first and is
    // never removable. Its health is the Balancer-persisted snapshot (same
    // pipeline as pooled accounts — no live API call on this GET).
    const defaultCard: AccountWithHealth = {
      id: DEFAULT_ACCOUNT_ID,
      provider,
      name: provider === "codex" ? "Default — this machine (Codex)" : "Default — this machine (Claude)",
      key: provider === "codex" ? "Machine login (~/.codex/auth.json)" : "Machine login (~/.claude)",
      status: "active",
      // the default/machine account participates in auto_rotation unless the
      // operator excluded it via the card's "Include in auto-rotation" checkbox
      // (persisted per-provider on account_pool_state.defaultRotationEnabled).
      rotationEnabled: state?.defaultRotationEnabled ?? true,
      windows: defaultSnapshot?.windows ?? [],
      usedPercent: defaultSnapshot?.usedPercent ?? null,
      resetsAt: defaultSnapshot?.resetsAt ?? null,
      capped: defaultSnapshot?.capped ?? false,
      error: defaultSnapshot?.error ?? undefined,
      email: defaultSnapshot?.email ?? undefined,
      subscriptionType: defaultSnapshot?.subscriptionType ?? undefined,
    };

    const pooled: AccountWithHealth[] = secrets.map((secret) => {
      const snapshot = readPoolAccountHealth(secret.providerMetadata);
      return {
        ...toPoolAccount(secret),
        provider,
        // default true — only an explicit rotationEnabled:false excludes it
        rotationEnabled: (secret.providerMetadata as Record<string, unknown> | null)?.rotationEnabled !== false,
        windows: snapshot?.windows ?? [],
        usedPercent: snapshot?.usedPercent ?? null,
        resetsAt: snapshot?.resetsAt ?? null,
        capped: snapshot?.capped ?? false,
        // surface the most-recent probe error (e.g. 429) without hiding the
        // last-good metrics — the snapshot preserves both.
        error: snapshot?.error ?? undefined,
        email: metaString(secret.providerMetadata, "email"),
        subscriptionType: metaString(secret.providerMetadata, "subscriptionType"),
      };
    });

    return { accounts: [defaultCard, ...pooled], state };
  }

  // GET /api/account-pool — list pooled accounts with last-known health + current
  // state. ?provider=claude|codex (default claude) selects the pool.
  router.get("/account-pool", async (req, res) => {
    const companyId = requireCompanyId(req);
    res.json(await buildAccountList(companyId, readProvider(req)));
  });

  // POST /api/account-pool/refresh — on-demand: re-probe every account's live
  // health NOW (the UI "Reload" button), persist fresh snapshots, return the list.
  router.post("/account-pool/refresh", async (req, res) => {
    const companyId = requireCompanyId(req);
    const provider = readProvider(req);
    await accountPoolBalancer(db).probeCompany(companyId, provider);
    res.json(await buildAccountList(companyId, provider));
  });

  // GET /api/account-pool/state — current active account + last rotation
  router.get("/account-pool/state", async (req, res) => {
    const companyId = requireCompanyId(req);
    const state = await readState(companyId, readProvider(req));
    res.json(state);
  });

  // GET /api/account-pool/auto-rotation-state — side-effect-free preview of which
  // pool/account the shared `auto_rotation` adapter would currently ride across
  // BOTH providers' pools + their local defaults. Powers the "Rotation Active"
  // tab indicator. Reads cached health snapshots only (no live probe / decrypt).
  router.get("/account-pool/auto-rotation-state", async (req, res) => {
    const companyId = requireCompanyId(req);
    const preview = await previewCombinedBest(db, companyId);
    res.json(preview);
  });

  // POST /api/account-pool/oauth/start — begin "Login with Claude".
  // Returns an authorize URL + the PKCE verifier (the client holds it and sends
  // it back on complete — no server-side challenge storage / migration needed).
  router.post("/account-pool/oauth/start", async (req, res) => {
    requireCompanyId(req);
    const pkce = generatePkce();
    const response: OauthStartResponse = {
      authorizeUrl: buildAuthorizeUrl(pkce.codeChallenge, pkce.state),
      state: pkce.state,
      codeVerifier: pkce.codeVerifier,
    };
    res.json(response);
  });

  // POST /api/account-pool/oauth/complete — exchange the pasted code for tokens,
  // capture the account email, and store the account as a pool secret.
  router.post("/account-pool/oauth/complete", async (req, res) => {
    const companyId = requireCompanyId(req);
    const body = req.body as Partial<OauthCompleteRequest>;
    const rawCode = typeof body.code === "string" ? body.code.trim() : "";
    const expectedState = typeof body.state === "string" ? body.state.trim() : "";
    const codeVerifier = typeof body.codeVerifier === "string" ? body.codeVerifier.trim() : "";
    if (!rawCode || !codeVerifier) {
      res.status(400).json({ error: "code and codeVerifier are required" });
      return;
    }
    // The pasted value may be "CODE#STATE"; split and validate state if present.
    const { code, state: pastedState } = parsePastedCode(rawCode);
    if (pastedState && expectedState && pastedState !== expectedState) {
      res.status(400).json({ error: "state mismatch — restart the login and try again" });
      return;
    }

    let token;
    try {
      // Anthropic requires `state` in the exchange body. Use the pasted state
      // when present (it matched above), else the expected state from /start.
      token = await exchangeCode(code, codeVerifier, pastedState ?? expectedState);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "token exchange failed" });
      return;
    }

    const name = token.email ?? `Claude account ${new Date().toISOString().slice(0, 10)}`;
    if (await svc.getByName(companyId, name).catch(() => null)) {
      res.status(409).json({ error: `Account "${name}" is already in the pool` });
      return;
    }

    const created = await svc.create(
      companyId,
      {
        name,
        provider: defaultProvider,
        managedMode: "paperclip_managed",
        value: buildCredentialsBlob(token),
        description: "Claude account added via Login with Claude",
        providerMetadata: {
          poolType: POOL_ACCOUNT_TYPES.claude,
          ...(token.email ? { email: token.email } : {}),
          ...(token.organizationName ? { organizationName: token.organizationName } : {}),
        },
      },
      { userId: req.actor.userId ?? "board", agentId: null },
    );

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "account_pool.account_added",
      entityType: "secret",
      entityId: created.id,
      details: { name: created.name, via: "oauth", email: token.email, provider: "claude" },
    });

    // Probe immediately so the new card shows health without waiting for a tick.
    await accountPoolBalancer(db).probeCompany(companyId, "claude").catch(() => undefined);
    res.status(201).json(toPoolAccount(created));
  });

  // POST /api/account-pool — add an account to the pool (stored as a marked secret).
  // For provider "claude" the blob is a `.credentials.json`; for "codex" it is a
  // `~/.codex/auth.json` (paste flow — Codex has no in-app OAuth).
  router.post("/account-pool", async (req, res) => {
    const companyId = requireCompanyId(req);
    const body = req.body as Partial<AddPoolAccountRequest>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const credentialsJson = typeof body.credentialsJson === "string" ? body.credentialsJson.trim() : "";
    const provider: PoolProvider = body.provider === "codex" ? "codex" : "claude";
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (!credentialsJson) {
      res.status(400).json({ error: "credentialsJson is required" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(credentialsJson);
    } catch {
      res.status(400).json({
        error:
          provider === "codex"
            ? "credentialsJson must be valid JSON (~/.codex/auth.json content)"
            : "credentialsJson must be valid JSON (.credentials.json content)",
      });
      return;
    }

    // For Codex, validate the pasted auth.json shape before storing.
    if (provider === "codex") {
      const obj = parsed as Record<string, unknown>;
      const tokens = (obj.tokens ?? null) as Record<string, unknown> | null;
      const hasTokens = !!tokens && typeof tokens.access_token === "string";
      const hasApiKey = typeof obj.OPENAI_API_KEY === "string" && obj.OPENAI_API_KEY.length > 0;
      if (!hasTokens && !hasApiKey) {
        res.status(400).json({ error: "auth.json must contain tokens.access_token or OPENAI_API_KEY" });
        return;
      }
    }

    const created = await svc.create(
      companyId,
      {
        name,
        provider: defaultProvider,
        managedMode: "paperclip_managed",
        value: credentialsJson,
        description: `${provider === "codex" ? "Codex" : "Claude"} account pool credential`,
        providerMetadata: {
          poolType: POOL_ACCOUNT_TYPES[provider],
        },
      },
      { userId: req.actor.userId ?? "board", agentId: null },
    );

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "account_pool.account_added",
      entityType: "secret",
      entityId: created.id,
      details: { name: created.name, provider },
    });

    // Probe immediately so the new card shows health without waiting for a tick.
    await accountPoolBalancer(db).probeCompany(companyId, provider).catch(() => undefined);
    res.status(201).json(toPoolAccount(created));
  });

  // POST /api/account-pool/stop — engage the STOP switch for ?provider= (default claude)
  // NOTE: the /stop routes MUST be registered before "/account-pool/:id" or
  // Express captures "stop" as :id and the uuid lookup throws.
  router.post("/account-pool/stop", async (req, res) => {
    const companyId = requireCompanyId(req);
    const provider = readProvider(req);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : null;
    await setStopSwitch(db, { companyId, provider, stopped: true, reason });

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "account_pool.stop_engaged",
      entityType: "company",
      entityId: companyId,
      details: { reason, provider },
    });

    res.json(await readState(companyId, provider));
  });

  // DELETE /api/account-pool/stop — release the STOP switch for ?provider= (default claude)
  router.delete("/account-pool/stop", async (req, res) => {
    const companyId = requireCompanyId(req);
    const provider = readProvider(req);
    await setStopSwitch(db, { companyId, provider, stopped: false });

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "account_pool.stop_released",
      entityType: "company",
      entityId: companyId,
      details: { provider },
    });

    // Releasing the STOP switch means "auto-rotate again" — immediately probe +
    // rebalance so Active jumps off a capped account onto the best available one
    // (a one-off user-triggered run, not the disabled proactive poll). Best-effort;
    // updates the active-account pointer so the UI reflects it and agents re-seed
    // on their next run.
    await accountPoolBalancer(db).runForCompany(companyId, provider).catch(() => undefined);

    res.json(await readState(companyId, provider));
  });

  // PATCH /api/account-pool/:id/rotation — include/exclude an account from rotation.
  // Body: { enabled: boolean }. Registered before "/account-pool/:id" patterns.
  router.patch("/account-pool/:id/rotation", async (req, res) => {
    const companyId = requireCompanyId(req);
    const id = req.params.id as string;
    const enabled = req.body?.enabled !== false; // default true

    // The synthetic default/machine account is NOT a company_secrets row — its
    // rotation flag lives on account_pool_state.defaultRotationEnabled (per
    // provider) and gates only auto_rotation's combined pick, not the per-provider
    // balancer fallback. Handle it before the secret lookup (which would 404).
    if (id === DEFAULT_ACCOUNT_ID) {
      const provider = readProvider(req);
      await setDefaultRotationEnabled(db, { companyId, provider, enabled });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: enabled ? "account_pool.default_rotation_enabled" : "account_pool.default_rotation_disabled",
        entityType: "account_pool_state",
        entityId: companyId,
        details: { provider },
      });
      res.json(await buildAccountList(companyId, provider));
      return;
    }

    const existing = await svc.getById(id);
    const provider = existing ? poolProviderFromType(poolTypeOf(existing.providerMetadata)) : null;
    if (!existing || existing.companyId !== companyId || existing.status === "deleted" || !provider) {
      res.status(404).json({ error: "Pool account not found" });
      return;
    }

    await setAccountRotationEnabled(db, id, enabled);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: enabled ? "account_pool.rotation_enabled" : "account_pool.rotation_disabled",
      entityType: "secret",
      entityId: id,
      details: { provider },
    });

    // If we just disabled the currently-active account, rebalance immediately so
    // Active moves off it onto the best remaining in-rotation account.
    await accountPoolBalancer(db).runForCompany(companyId, provider).catch(() => undefined);

    res.json(await buildAccountList(companyId, provider));
  });

  // DELETE /api/account-pool/:id — remove an account from the pool
  router.delete("/account-pool/:id", async (req, res) => {
    const companyId = requireCompanyId(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing || existing.companyId !== companyId || existing.status === "deleted") {
      res.status(404).json({ error: "Pool account not found" });
      return;
    }
    const removedProvider = poolProviderFromType(poolTypeOf(existing.providerMetadata));
    if (!removedProvider) {
      res.status(404).json({ error: "Pool account not found" });
      return;
    }

    const removed = await svc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Pool account not found" });
      return;
    }

    // If the removed account was the active one (for any provider row), clear the
    // pointer so the next Balancer tick rebalances onto a healthy account.
    await db
      .update(accountPoolState)
      .set({ activeAccountId: null, reason: "rotation", assignedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(accountPoolState.companyId, companyId), eq(accountPoolState.activeAccountId, id)));

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "account_pool.account_removed",
      entityType: "secret",
      entityId: id,
      details: { name: removed.name },
    });

    res.json({ ok: true });
  });

  return router;
}
