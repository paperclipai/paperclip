import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { accountPoolState, companySecrets } from "@paperclipai/db";
import {
  POOL_ACCOUNT_TYPE,
  type AccountPoolListResponse,
  type AccountWithHealth,
  type AddPoolAccountRequest,
  type PoolAccount,
  type PoolState,
  type RotationReason,
} from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity, secretService } from "../services/index.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import { readPoolAccountHealth } from "../services/account-pool.js";
import { accountPoolBalancer } from "../services/account-pool-balancer.js";

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

  function poolTypeOf(metadata: unknown): string | null {
    if (!metadata || typeof metadata !== "object") return null;
    const value = (metadata as Record<string, unknown>).poolType;
    return typeof value === "string" ? value : null;
  }

  async function listPoolSecrets(companyId: string) {
    const secrets = await svc.list(companyId);
    return secrets.filter((secret) => poolTypeOf(secret.providerMetadata) === POOL_ACCOUNT_TYPE);
  }

  function toPoolAccount(secret: {
    id: string;
    name: string;
    key: string;
    status: string;
  }): PoolAccount {
    return { id: secret.id, name: secret.name, key: secret.key, status: secret.status };
  }

  async function readState(companyId: string): Promise<PoolState | null> {
    const row = await db
      .select()
      .from(accountPoolState)
      .where(eq(accountPoolState.companyId, companyId))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    return {
      companyId: row.companyId,
      activeAccountId: row.activeAccountId,
      prevAccountId: row.prevAccountId,
      reason: row.reason as RotationReason,
      assignedAt: row.assignedAt.toISOString(),
      rotationStopped: row.rotationStopped,
      stopReason: row.stopReason,
    };
  }

  /**
   * Build the account list from the LAST-KNOWN health snapshots (persisted by the
   * Balancer Brain). This intentionally does NOT call the Anthropic usage API —
   * doing that on every 30s UI poll is what got us rate-limited (429). Live
   * re-probing happens on the 5-min Balancer tick and on the explicit Reload
   * endpoint below.
   */
  async function buildAccountList(companyId: string): Promise<AccountPoolListResponse> {
    const [secrets, state] = await Promise.all([listPoolSecrets(companyId), readState(companyId)]);
    const accounts: AccountWithHealth[] = secrets.map((secret) => {
      const snapshot = readPoolAccountHealth(secret.providerMetadata);
      return {
        ...toPoolAccount(secret),
        windows: snapshot?.windows ?? [],
        usedPercent: snapshot?.usedPercent ?? null,
        resetsAt: snapshot?.resetsAt ?? null,
        capped: snapshot?.capped ?? false,
        // surface the most-recent probe error (e.g. 429) without hiding the
        // last-good metrics — the snapshot preserves both.
        error: snapshot?.error ?? undefined,
      };
    });
    return { accounts, state };
  }

  // GET /api/account-pool — list pooled accounts with last-known health + current state
  router.get("/account-pool", async (req, res) => {
    const companyId = requireCompanyId(req);
    res.json(await buildAccountList(companyId));
  });

  // POST /api/account-pool/refresh — on-demand: re-probe every account's live
  // health NOW (the UI "Reload" button), persist fresh snapshots, return the list.
  router.post("/account-pool/refresh", async (req, res) => {
    const companyId = requireCompanyId(req);
    await accountPoolBalancer(db).probeCompany(companyId);
    res.json(await buildAccountList(companyId));
  });

  // GET /api/account-pool/state — current active account + last rotation
  router.get("/account-pool/state", async (req, res) => {
    const companyId = requireCompanyId(req);
    const state = await readState(companyId);
    res.json(state);
  });

  // POST /api/account-pool — add an account to the pool (stored as a marked secret)
  router.post("/account-pool", async (req, res) => {
    const companyId = requireCompanyId(req);
    const body = req.body as Partial<AddPoolAccountRequest>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const credentialsJson = typeof body.credentialsJson === "string" ? body.credentialsJson.trim() : "";
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (!credentialsJson) {
      res.status(400).json({ error: "credentialsJson is required" });
      return;
    }
    try {
      JSON.parse(credentialsJson);
    } catch {
      res.status(400).json({ error: "credentialsJson must be valid JSON (.credentials.json content)" });
      return;
    }

    const created = await svc.create(
      companyId,
      {
        name,
        provider: defaultProvider,
        managedMode: "paperclip_managed",
        value: credentialsJson,
        description: "Claude account pool credential",
        providerMetadata: { poolType: POOL_ACCOUNT_TYPE },
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
      details: { name: created.name },
    });

    res.status(201).json(toPoolAccount(created));
  });

  /** ensure a state row exists for the company, then return it */
  async function ensureStateRow(companyId: string) {
    const existing = await db
      .select()
      .from(accountPoolState)
      .where(eq(accountPoolState.companyId, companyId))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;
    return db
      .insert(accountPoolState)
      .values({ companyId, reason: "initial" })
      .returning()
      .then((rows) => rows[0]);
  }

  // POST /api/account-pool/stop — engage the global STOP switch
  // NOTE: the /stop routes MUST be registered before "/account-pool/:id" or
  // Express captures "stop" as :id and the uuid lookup throws.
  router.post("/account-pool/stop", async (req, res) => {
    const companyId = requireCompanyId(req);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : null;
    await ensureStateRow(companyId);
    await db
      .update(accountPoolState)
      .set({ rotationStopped: true, stopReason: reason, updatedAt: new Date() })
      .where(eq(accountPoolState.companyId, companyId));

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "account_pool.stop_engaged",
      entityType: "company",
      entityId: companyId,
      details: { reason },
    });

    res.json(await readState(companyId));
  });

  // DELETE /api/account-pool/stop — release the global STOP switch
  router.delete("/account-pool/stop", async (req, res) => {
    const companyId = requireCompanyId(req);
    await ensureStateRow(companyId);
    await db
      .update(accountPoolState)
      .set({ rotationStopped: false, stopReason: null, updatedAt: new Date() })
      .where(eq(accountPoolState.companyId, companyId));

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "account_pool.stop_released",
      entityType: "company",
      entityId: companyId,
      details: {},
    });

    res.json(await readState(companyId));
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
    if (poolTypeOf(existing.providerMetadata) !== POOL_ACCOUNT_TYPE) {
      res.status(404).json({ error: "Pool account not found" });
      return;
    }

    const removed = await svc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Pool account not found" });
      return;
    }

    // If the removed account was the active one, clear the pointer so the next
    // Balancer tick rebalances onto a healthy account.
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
