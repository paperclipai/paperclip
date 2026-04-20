import { Router } from "express";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { estateAssets, estateFinancialAccounts, estateBalanceHistory } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

// ---------------------------------------------------------------------------
// Net worth helpers
// ---------------------------------------------------------------------------

function centsToDecimal(cents: string | null): number {
  return cents ? Number(cents) / 100 : 0;
}

async function computeNetWorth(db: Db, companyId: string, userId: string) {
  const [assetRow] = await db
    .select({ total: sql<string>`coalesce(sum(current_value_cents), 0)` })
    .from(estateAssets)
    .where(and(eq(estateAssets.companyId, companyId), eq(estateAssets.userId, userId)));

  const [accountRow] = await db
    .select({ total: sql<string>`coalesce(sum(balance_cents), 0)` })
    .from(estateFinancialAccounts)
    .where(and(eq(estateFinancialAccounts.companyId, companyId), eq(estateFinancialAccounts.userId, userId)));

  const assetsCents = Number(assetRow?.total ?? 0);
  const accountsCents = Number(accountRow?.total ?? 0);
  return {
    netWorthCents: assetsCents + accountsCents,
    netWorthDollars: (assetsCents + accountsCents) / 100,
    assetsTotalCents: assetsCents,
    accountsTotalCents: accountsCents,
  };
}

// ---------------------------------------------------------------------------
// CSV import parser (simple, no external dep)
// ---------------------------------------------------------------------------

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === "," && !inQuote) {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, (values[i] ?? "").trim()]));
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function estateRoutes(db: Db) {
  const router = Router();

  // ---- Asset Registry -------------------------------------------------------

  /** List assets for a user */
  router.get("/estate/assets", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const userId =
      typeof req.query.userId === "string" && req.query.userId.trim()
        ? req.query.userId.trim()
        : req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const rows = await db
      .select()
      .from(estateAssets)
      .where(and(eq(estateAssets.companyId, companyId), eq(estateAssets.userId, userId)))
      .orderBy(desc(estateAssets.createdAt));

    res.json({ assets: rows });
  });

  /** Get a single asset */
  router.get("/estate/assets/:assetId", async (req, res) => {
    assertBoard(req);
    const row = await db
      .select()
      .from(estateAssets)
      .where(eq(estateAssets.id, req.params.assetId))
      .then((r) => r[0] ?? null);
    if (!row) throw notFound("Asset not found");
    assertCompanyAccess(req, row.companyId);
    res.json(row);
  });

  /** Create an asset */
  router.post("/estate/assets", async (req, res) => {
    assertBoard(req);
    const body = req.body as Record<string, unknown>;
    const companyId = typeof body.companyId === "string" ? body.companyId : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const userId =
      typeof body.userId === "string" && body.userId.trim()
        ? body.userId
        : req.actor.userId ?? null;
    if (!userId) throw badRequest("userId is required");
    if (!body.name || typeof body.name !== "string") throw badRequest("name is required");
    if (!body.assetType || typeof body.assetType !== "string") throw badRequest("assetType is required");

    const [row] = await db
      .insert(estateAssets)
      .values({
        companyId,
        userId,
        name: body.name,
        assetType: body.assetType as typeof estateAssets.$inferInsert["assetType"],
        category: typeof body.category === "string" ? body.category : null,
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : null,
        entityId: typeof body.entityId === "string" ? body.entityId : null,
        currentValueCents: body.currentValueCents != null ? String(body.currentValueCents) : null,
        valuationDate: body.valuationDate ? new Date(body.valuationDate as string) : null,
        typeMetadata: typeof body.typeMetadata === "object" && body.typeMetadata !== null
          ? (body.typeMetadata as Record<string, unknown>)
          : null,
        notes: typeof body.notes === "string" ? body.notes : null,
      })
      .returning();
    res.status(201).json(row);
  });

  /** Update an asset */
  router.patch("/estate/assets/:assetId", async (req, res) => {
    assertBoard(req);
    const existing = await db
      .select()
      .from(estateAssets)
      .where(eq(estateAssets.id, req.params.assetId))
      .then((r) => r[0] ?? null);
    if (!existing) throw notFound("Asset not found");
    assertCompanyAccess(req, existing.companyId);

    const body = req.body as Record<string, unknown>;
    const [updated] = await db
      .update(estateAssets)
      .set({
        name: typeof body.name === "string" ? body.name : existing.name,
        category: body.category !== undefined ? (body.category as string | null) : existing.category,
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : existing.tags,
        entityId: body.entityId !== undefined ? (body.entityId as string | null) : existing.entityId,
        currentValueCents: body.currentValueCents != null
          ? String(body.currentValueCents)
          : existing.currentValueCents,
        valuationDate: body.valuationDate
          ? new Date(body.valuationDate as string)
          : existing.valuationDate,
        typeMetadata: body.typeMetadata !== undefined
          ? (body.typeMetadata as Record<string, unknown> | null)
          : existing.typeMetadata,
        notes: body.notes !== undefined ? (body.notes as string | null) : existing.notes,
        updatedAt: new Date(),
      })
      .where(eq(estateAssets.id, req.params.assetId))
      .returning();
    res.json(updated);
  });

  /** Delete an asset */
  router.delete("/estate/assets/:assetId", async (req, res) => {
    assertBoard(req);
    const existing = await db
      .select()
      .from(estateAssets)
      .where(eq(estateAssets.id, req.params.assetId))
      .then((r) => r[0] ?? null);
    if (!existing) throw notFound("Asset not found");
    assertCompanyAccess(req, existing.companyId);
    await db.delete(estateAssets).where(eq(estateAssets.id, req.params.assetId));
    res.status(204).send();
  });

  /** CSV bulk import */
  router.post("/estate/assets/import-csv", async (req, res) => {
    assertBoard(req);
    const body = req.body as Record<string, unknown>;
    const companyId = typeof body.companyId === "string" ? body.companyId : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const userId =
      typeof body.userId === "string" && body.userId.trim()
        ? body.userId
        : req.actor.userId ?? null;
    if (!userId) throw badRequest("userId is required");

    const csvText = typeof body.csv === "string" ? body.csv : null;
    if (!csvText) throw badRequest("csv field is required");

    const rows = parseCsv(csvText);
    if (rows.length === 0) {
      res.json({ imported: 0, errors: [] });
      return;
    }

    const errors: string[] = [];
    const toInsert: typeof estateAssets.$inferInsert[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row["name"]) { errors.push(`Row ${i + 2}: missing name`); continue; }
      if (!row["asset_type"]) { errors.push(`Row ${i + 2}: missing asset_type`); continue; }
      toInsert.push({
        companyId,
        userId,
        name: row["name"],
        assetType: row["asset_type"] as typeof estateAssets.$inferInsert["assetType"],
        category: row["category"] || null,
        tags: row["tags"] ? row["tags"].split("|").map((t) => t.trim()) : null,
        entityId: row["entity_id"] || null,
        currentValueCents: row["current_value_cents"] ? String(row["current_value_cents"]) : null,
        valuationDate: row["valuation_date"] ? new Date(row["valuation_date"]) : null,
        notes: row["notes"] || null,
      });
    }

    let imported = 0;
    if (toInsert.length > 0) {
      const inserted = await db.insert(estateAssets).values(toInsert).returning();
      imported = inserted.length;
    }

    res.status(201).json({ imported, errors });
  });

  // ---- Financial Accounts ---------------------------------------------------

  /** List accounts */
  router.get("/estate/financial-accounts", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const userId =
      typeof req.query.userId === "string" && req.query.userId.trim()
        ? req.query.userId.trim()
        : req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const rows = await db
      .select({
        id: estateFinancialAccounts.id,
        companyId: estateFinancialAccounts.companyId,
        userId: estateFinancialAccounts.userId,
        name: estateFinancialAccounts.name,
        institutionName: estateFinancialAccounts.institutionName,
        accountType: estateFinancialAccounts.accountType,
        entityId: estateFinancialAccounts.entityId,
        balanceCents: estateFinancialAccounts.balanceCents,
        balanceUpdatedAt: estateFinancialAccounts.balanceUpdatedAt,
        isManual: estateFinancialAccounts.isManual,
        metadata: estateFinancialAccounts.metadata,
        createdAt: estateFinancialAccounts.createdAt,
        updatedAt: estateFinancialAccounts.updatedAt,
        // plaidAccessToken intentionally excluded from list response
      })
      .from(estateFinancialAccounts)
      .where(
        and(
          eq(estateFinancialAccounts.companyId, companyId),
          eq(estateFinancialAccounts.userId, userId),
        ),
      )
      .orderBy(desc(estateFinancialAccounts.createdAt));

    res.json({ accounts: rows });
  });

  /** Create a manual financial account */
  router.post("/estate/financial-accounts", async (req, res) => {
    assertBoard(req);
    const body = req.body as Record<string, unknown>;
    const companyId = typeof body.companyId === "string" ? body.companyId : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const userId =
      typeof body.userId === "string" && body.userId.trim()
        ? body.userId
        : req.actor.userId ?? null;
    if (!userId) throw badRequest("userId is required");
    if (!body.name || typeof body.name !== "string") throw badRequest("name is required");
    if (!body.accountType || typeof body.accountType !== "string") throw badRequest("accountType is required");

    const balanceCents = body.balanceCents != null ? String(body.balanceCents) : null;

    const [account] = await db
      .insert(estateFinancialAccounts)
      .values({
        companyId,
        userId,
        name: body.name,
        institutionName: typeof body.institutionName === "string" ? body.institutionName : null,
        accountType: body.accountType as typeof estateFinancialAccounts.$inferInsert["accountType"],
        entityId: typeof body.entityId === "string" ? body.entityId : null,
        balanceCents,
        balanceUpdatedAt: balanceCents ? new Date() : null,
        isManual: true,
      })
      .returning();

    if (balanceCents) {
      await db.insert(estateBalanceHistory).values({
        accountId: account.id,
        balanceCents,
      });
    }

    res.status(201).json(account);
  });

  /** Update a financial account (manual balance update or metadata) */
  router.patch("/estate/financial-accounts/:accountId", async (req, res) => {
    assertBoard(req);
    const existing = await db
      .select()
      .from(estateFinancialAccounts)
      .where(eq(estateFinancialAccounts.id, req.params.accountId))
      .then((r) => r[0] ?? null);
    if (!existing) throw notFound("Account not found");
    assertCompanyAccess(req, existing.companyId);

    const body = req.body as Record<string, unknown>;
    const newBalance = body.balanceCents != null ? String(body.balanceCents) : null;
    const balanceChanged = newBalance !== null && newBalance !== existing.balanceCents;

    const [updated] = await db
      .update(estateFinancialAccounts)
      .set({
        name: typeof body.name === "string" ? body.name : existing.name,
        institutionName: body.institutionName !== undefined
          ? (body.institutionName as string | null)
          : existing.institutionName,
        entityId: body.entityId !== undefined ? (body.entityId as string | null) : existing.entityId,
        balanceCents: newBalance ?? existing.balanceCents,
        balanceUpdatedAt: balanceChanged ? new Date() : existing.balanceUpdatedAt,
        updatedAt: new Date(),
      })
      .where(eq(estateFinancialAccounts.id, req.params.accountId))
      .returning();

    if (balanceChanged && newBalance) {
      await db.insert(estateBalanceHistory).values({
        accountId: req.params.accountId,
        balanceCents: newBalance,
      });
    }

    res.json(updated);
  });

  /** Balance history for an account */
  router.get("/estate/financial-accounts/:accountId/balance-history", async (req, res) => {
    assertBoard(req);
    const account = await db
      .select({ companyId: estateFinancialAccounts.companyId })
      .from(estateFinancialAccounts)
      .where(eq(estateFinancialAccounts.id, req.params.accountId))
      .then((r) => r[0] ?? null);
    if (!account) throw notFound("Account not found");
    assertCompanyAccess(req, account.companyId);

    const days = Math.min(Number(req.query.days ?? 90), 365);
    const since = new Date();
    since.setDate(since.getDate() - days);

    const rows = await db
      .select()
      .from(estateBalanceHistory)
      .where(
        and(
          eq(estateBalanceHistory.accountId, req.params.accountId),
          gte(estateBalanceHistory.recordedAt, since),
        ),
      )
      .orderBy(desc(estateBalanceHistory.recordedAt));

    res.json({ history: rows });
  });

  // ---- Plaid webhook --------------------------------------------------------

  /**
   * POST /estate/plaid/webhook
   *
   * Handles Plaid item balance update events. In production, this endpoint
   * should be protected with Plaid webhook signature verification.
   * For Phase 1 we accept the event payload and update the stored balance.
   */
  router.post("/estate/plaid/webhook", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const webhookType = body["webhook_type"];
    const webhookCode = body["webhook_code"];
    const itemId = typeof body["item_id"] === "string" ? body["item_id"] : null;

    if (webhookType !== "TRANSACTIONS" && webhookType !== "ITEM") {
      res.json({ received: true });
      return;
    }

    if (
      (webhookCode === "DEFAULT_UPDATE" || webhookCode === "INITIAL_UPDATE") &&
      itemId
    ) {
      const newBalances = body["new_webhook_payload"] as Record<string, unknown> | undefined;
      const balanceCents = newBalances?.["balance_cents"];

      if (typeof balanceCents === "number") {
        const accounts = await db
          .select()
          .from(estateFinancialAccounts)
          .where(eq(estateFinancialAccounts.plaidItemId, itemId));

        for (const account of accounts) {
          await db
            .update(estateFinancialAccounts)
            .set({
              balanceCents: String(balanceCents),
              balanceUpdatedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(estateFinancialAccounts.id, account.id));
          await db.insert(estateBalanceHistory).values({
            accountId: account.id,
            balanceCents: String(balanceCents),
          });
        }
      }
    }

    res.json({ received: true });
  });

  // ---- Net worth ------------------------------------------------------------

  /**
   * GET /estate/net-worth
   *
   * Returns current net worth (assets + financial account balances) and
   * 90-day account balance trend for the authenticated user.
   */
  router.get("/estate/net-worth", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const userId =
      typeof req.query.userId === "string" && req.query.userId.trim()
        ? req.query.userId.trim()
        : req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const netWorth = await computeNetWorth(db, companyId, userId);

    const accounts = await db
      .select({
        id: estateFinancialAccounts.id,
        name: estateFinancialAccounts.name,
        accountType: estateFinancialAccounts.accountType,
        balanceCents: estateFinancialAccounts.balanceCents,
        balanceUpdatedAt: estateFinancialAccounts.balanceUpdatedAt,
      })
      .from(estateFinancialAccounts)
      .where(
        and(
          eq(estateFinancialAccounts.companyId, companyId),
          eq(estateFinancialAccounts.userId, userId),
        ),
      );

    const assetBreakdown = await db
      .select({
        assetType: estateAssets.assetType,
        totalCents: sql<string>`coalesce(sum(current_value_cents), 0)`,
      })
      .from(estateAssets)
      .where(and(eq(estateAssets.companyId, companyId), eq(estateAssets.userId, userId)))
      .groupBy(estateAssets.assetType);

    res.json({
      netWorthDollars: netWorth.netWorthDollars,
      netWorthCents: netWorth.netWorthCents,
      assetsTotalDollars: centsToDecimal(String(netWorth.assetsTotalCents)),
      accountsTotalDollars: centsToDecimal(String(netWorth.accountsTotalCents)),
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        accountType: a.accountType,
        balanceDollars: centsToDecimal(a.balanceCents),
        balanceUpdatedAt: a.balanceUpdatedAt,
      })),
      assetBreakdown: assetBreakdown.map((r) => ({
        assetType: r.assetType,
        totalDollars: centsToDecimal(r.totalCents),
      })),
    });
  });

  return router;
}
