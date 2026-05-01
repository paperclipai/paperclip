import { Router } from "express";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  estateAssets,
  estateFinancialAccounts,
  estateBalanceHistory,
  estateInsurancePolicies,
  estateRetirementAccounts,
  estateBusinessInterests,
  estateDigitalAssets,
  estateCollectibles,
} from "@paperclipai/db";
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

  // =========================================================================
  // Phase 2 — Enhanced Asset Detail Routes
  // =========================================================================
  // All detail routes follow the same pattern:
  //   GET  /estate/assets/:assetId/<type>  → fetch detail (404 if not set up yet)
  //   PUT  /estate/assets/:assetId/<type>  → upsert (create or replace)
  //   DELETE /estate/assets/:assetId/<type> → remove detail record

  async function resolveAsset(assetId: string, companyId: string) {
    const [asset] = await db
      .select({ id: estateAssets.id, companyId: estateAssets.companyId, userId: estateAssets.userId })
      .from(estateAssets)
      .where(and(eq(estateAssets.id, assetId), eq(estateAssets.companyId, companyId)));
    return asset ?? null;
  }

  // ---- Insurance Policies ---------------------------------------------------

  router.get("/estate/assets/:assetId/insurance", async (req, res) => {
    assertBoard(req);
    const { assetId } = req.params;
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const asset = await resolveAsset(assetId, companyId);
    if (!asset) throw notFound("Asset not found");

    const [detail] = await db
      .select()
      .from(estateInsurancePolicies)
      .where(eq(estateInsurancePolicies.assetId, assetId));
    if (!detail) throw notFound("Insurance policy detail not found");
    res.json(detail);
  });

  router.put("/estate/assets/:assetId/insurance", async (req, res) => {
    assertBoard(req);
    const { assetId } = req.params;
    const companyId = typeof req.body.companyId === "string" ? req.body.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const asset = await resolveAsset(assetId, companyId);
    if (!asset) throw notFound("Asset not found");

    const {
      policyNumber, insurer, policyType, deathBenefitCents, cashValueCents,
      premiumAmountCents, premiumFrequency, premiumNextDueAt, ilitTrustName,
      ilitTrustEntityId, outstandingLoanCents, beneficiaries, documentIds,
      isActive, notes,
    } = req.body;

    const [existing] = await db
      .select({ id: estateInsurancePolicies.id })
      .from(estateInsurancePolicies)
      .where(eq(estateInsurancePolicies.assetId, assetId));

    const payload = {
      assetId,
      companyId,
      userId: asset.userId,
      policyNumber: policyNumber ?? null,
      insurer: insurer ?? null,
      policyType: policyType ?? "term",
      deathBenefitCents: deathBenefitCents != null ? String(deathBenefitCents) : null,
      cashValueCents: cashValueCents != null ? String(cashValueCents) : null,
      premiumAmountCents: premiumAmountCents != null ? String(premiumAmountCents) : null,
      premiumFrequency: premiumFrequency ?? null,
      premiumNextDueAt: premiumNextDueAt ? new Date(premiumNextDueAt) : null,
      ilitTrustName: ilitTrustName ?? null,
      ilitTrustEntityId: ilitTrustEntityId ?? null,
      outstandingLoanCents: outstandingLoanCents != null ? String(outstandingLoanCents) : null,
      beneficiaries: beneficiaries ?? null,
      documentIds: documentIds ?? null,
      isActive: isActive !== undefined ? Boolean(isActive) : true,
      notes: notes ?? null,
      updatedAt: new Date(),
    };

    if (existing) {
      const [updated] = await db
        .update(estateInsurancePolicies)
        .set(payload)
        .where(eq(estateInsurancePolicies.id, existing.id))
        .returning();
      return res.json(updated);
    }

    const [created] = await db
      .insert(estateInsurancePolicies)
      .values(payload)
      .returning();
    res.status(201).json(created);
  });

  router.delete("/estate/assets/:assetId/insurance", async (req, res) => {
    assertBoard(req);
    const { assetId } = req.params;
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const asset = await resolveAsset(assetId, companyId);
    if (!asset) throw notFound("Asset not found");

    await db
      .delete(estateInsurancePolicies)
      .where(eq(estateInsurancePolicies.assetId, assetId));
    res.status(204).send();
  });

  // ---- Retirement Accounts --------------------------------------------------

  router.get("/estate/assets/:assetId/retirement", async (req, res) => {
    assertBoard(req);
    const { assetId } = req.params;
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const asset = await resolveAsset(assetId, companyId);
    if (!asset) throw notFound("Asset not found");

    const [detail] = await db
      .select()
      .from(estateRetirementAccounts)
      .where(eq(estateRetirementAccounts.assetId, assetId));
    if (!detail) throw notFound("Retirement account detail not found");
    res.json(detail);
  });

  router.put("/estate/assets/:assetId/retirement", async (req, res) => {
    assertBoard(req);
    const { assetId } = req.params;
    const companyId = typeof req.body.companyId === "string" ? req.body.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const asset = await resolveAsset(assetId, companyId);
    if (!asset) throw notFound("Asset not found");

    const {
      accountType, isRoth, custodian, accountNumber,
      annualContributionLimitCents, ytdContributionCents,
      rmdRequired, rmdAmountCents, rmdDueYear, rmdWithdrawnThisYearCents,
      primaryBeneficiaries, contingentBeneficiaries, documentIds, notes,
    } = req.body;

    const [existing] = await db
      .select({ id: estateRetirementAccounts.id })
      .from(estateRetirementAccounts)
      .where(eq(estateRetirementAccounts.assetId, assetId));

    const payload = {
      assetId,
      companyId,
      userId: asset.userId,
      accountType: accountType ?? "traditional_ira",
      isRoth: isRoth !== undefined ? Boolean(isRoth) : false,
      custodian: custodian ?? null,
      accountNumber: accountNumber ?? null,
      annualContributionLimitCents: annualContributionLimitCents != null ? String(annualContributionLimitCents) : null,
      ytdContributionCents: ytdContributionCents != null ? String(ytdContributionCents) : null,
      rmdRequired: rmdRequired !== undefined ? Boolean(rmdRequired) : false,
      rmdAmountCents: rmdAmountCents != null ? String(rmdAmountCents) : null,
      rmdDueYear: rmdDueYear ?? null,
      rmdWithdrawnThisYearCents: rmdWithdrawnThisYearCents != null ? String(rmdWithdrawnThisYearCents) : null,
      primaryBeneficiaries: primaryBeneficiaries ?? null,
      contingentBeneficiaries: contingentBeneficiaries ?? null,
      documentIds: documentIds ?? null,
      notes: notes ?? null,
      updatedAt: new Date(),
    };

    if (existing) {
      const [updated] = await db
        .update(estateRetirementAccounts)
        .set(payload)
        .where(eq(estateRetirementAccounts.id, existing.id))
        .returning();
      return res.json(updated);
    }

    const [created] = await db
      .insert(estateRetirementAccounts)
      .values(payload)
      .returning();
    res.status(201).json(created);
  });

  router.delete("/estate/assets/:assetId/retirement", async (req, res) => {
    assertBoard(req);
    const { assetId } = req.params;
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const asset = await resolveAsset(assetId, companyId);
    if (!asset) throw notFound("Asset not found");

    await db
      .delete(estateRetirementAccounts)
      .where(eq(estateRetirementAccounts.assetId, assetId));
    res.status(204).send();
  });

  // ---- Business Interests ---------------------------------------------------

  router.get("/estate/assets/:assetId/business", async (req, res) => {
    assertBoard(req);
    const { assetId } = req.params;
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const asset = await resolveAsset(assetId, companyId);
    if (!asset) throw notFound("Asset not found");

    const [detail] = await db
      .select()
      .from(estateBusinessInterests)
      .where(eq(estateBusinessInterests.assetId, assetId));
    if (!detail) throw notFound("Business interest detail not found");
    res.json(detail);
  });

  router.put("/estate/assets/:assetId/business", async (req, res) => {
    assertBoard(req);
    const { assetId } = req.params;
    const companyId = typeof req.body.companyId === "string" ? req.body.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const asset = await resolveAsset(assetId, companyId);
    if (!asset) throw notFound("Asset not found");

    const {
      businessName, entityType, ownershipPct, ein, state,
      lastAppraisalValueCents, lastAppraisalDate, nextAppraisalDueDate,
      appraisalDocIds, hasBuySellAgreement, buySellAgreementDocId,
      buySellTriggers, hasKeyPersonInsurance, keyPersonInsurancePolicyIds,
      coOwners, notes,
    } = req.body;

    if (!businessName) throw badRequest("businessName is required");

    const [existing] = await db
      .select({ id: estateBusinessInterests.id })
      .from(estateBusinessInterests)
      .where(eq(estateBusinessInterests.assetId, assetId));

    const payload = {
      assetId,
      companyId,
      userId: asset.userId,
      businessName,
      entityType: entityType ?? "llc",
      ownershipPct: ownershipPct != null ? String(ownershipPct) : null,
      ein: ein ?? null,
      state: state ?? null,
      lastAppraisalValueCents: lastAppraisalValueCents != null ? String(lastAppraisalValueCents) : null,
      lastAppraisalDate: lastAppraisalDate ? new Date(lastAppraisalDate) : null,
      nextAppraisalDueDate: nextAppraisalDueDate ? new Date(nextAppraisalDueDate) : null,
      appraisalDocIds: appraisalDocIds ?? null,
      hasBuySellAgreement: Boolean(hasBuySellAgreement),
      buySellAgreementDocId: buySellAgreementDocId ?? null,
      buySellTriggers: buySellTriggers ?? null,
      hasKeyPersonInsurance: Boolean(hasKeyPersonInsurance),
      keyPersonInsurancePolicyIds: keyPersonInsurancePolicyIds ?? null,
      coOwners: coOwners ?? null,
      notes: notes ?? null,
      updatedAt: new Date(),
    };

    if (existing) {
      const [updated] = await db
        .update(estateBusinessInterests)
        .set(payload)
        .where(eq(estateBusinessInterests.id, existing.id))
        .returning();
      return res.json(updated);
    }

    const [created] = await db
      .insert(estateBusinessInterests)
      .values(payload)
      .returning();
    res.status(201).json(created);
  });

  router.delete("/estate/assets/:assetId/business", async (req, res) => {
    assertBoard(req);
    const { assetId } = req.params;
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const asset = await resolveAsset(assetId, companyId);
    if (!asset) throw notFound("Asset not found");

    await db
      .delete(estateBusinessInterests)
      .where(eq(estateBusinessInterests.assetId, assetId));
    res.status(204).send();
  });

  // ---- Digital Assets -------------------------------------------------------

  router.get("/estate/assets/:assetId/digital", async (req, res) => {
    assertBoard(req);
    const { assetId } = req.params;
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const asset = await resolveAsset(assetId, companyId);
    if (!asset) throw notFound("Asset not found");

    const [detail] = await db
      .select()
      .from(estateDigitalAssets)
      .where(eq(estateDigitalAssets.assetId, assetId));
    if (!detail) throw notFound("Digital asset detail not found");
    res.json(detail);
  });

  router.put("/estate/assets/:assetId/digital", async (req, res) => {
    assertBoard(req);
    const { assetId } = req.params;
    const companyId = typeof req.body.companyId === "string" ? req.body.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const asset = await resolveAsset(assetId, companyId);
    if (!asset) throw notFound("Asset not found");

    const {
      digitalAssetType, ticker, blockchain, quantityHeld,
      walletAddresses, exchangeAccounts, coldStorageDocIds,
      contractAddress, tokenId, recoveryDocIds, notes,
    } = req.body;

    const [existing] = await db
      .select({ id: estateDigitalAssets.id })
      .from(estateDigitalAssets)
      .where(eq(estateDigitalAssets.assetId, assetId));

    const payload = {
      assetId,
      companyId,
      userId: asset.userId,
      digitalAssetType: digitalAssetType ?? "cryptocurrency",
      ticker: ticker ?? null,
      blockchain: blockchain ?? null,
      quantityHeld: quantityHeld != null ? String(quantityHeld) : null,
      walletAddresses: walletAddresses ?? null,
      exchangeAccounts: exchangeAccounts ?? null,
      coldStorageDocIds: coldStorageDocIds ?? null,
      contractAddress: contractAddress ?? null,
      tokenId: tokenId ?? null,
      recoveryDocIds: recoveryDocIds ?? null,
      notes: notes ?? null,
      updatedAt: new Date(),
    };

    if (existing) {
      const [updated] = await db
        .update(estateDigitalAssets)
        .set(payload)
        .where(eq(estateDigitalAssets.id, existing.id))
        .returning();
      return res.json(updated);
    }

    const [created] = await db
      .insert(estateDigitalAssets)
      .values(payload)
      .returning();
    res.status(201).json(created);
  });

  router.delete("/estate/assets/:assetId/digital", async (req, res) => {
    assertBoard(req);
    const { assetId } = req.params;
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const asset = await resolveAsset(assetId, companyId);
    if (!asset) throw notFound("Asset not found");

    await db
      .delete(estateDigitalAssets)
      .where(eq(estateDigitalAssets.assetId, assetId));
    res.status(204).send();
  });

  // ---- Collectibles ---------------------------------------------------------

  router.get("/estate/assets/:assetId/collectible", async (req, res) => {
    assertBoard(req);
    const { assetId } = req.params;
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const asset = await resolveAsset(assetId, companyId);
    if (!asset) throw notFound("Asset not found");

    const [detail] = await db
      .select()
      .from(estateCollectibles)
      .where(eq(estateCollectibles.assetId, assetId));
    if (!detail) throw notFound("Collectible detail not found");
    res.json(detail);
  });

  router.put("/estate/assets/:assetId/collectible", async (req, res) => {
    assertBoard(req);
    const { assetId } = req.params;
    const companyId = typeof req.body.companyId === "string" ? req.body.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const asset = await resolveAsset(assetId, companyId);
    if (!asset) throw notFound("Asset not found");

    const {
      collectibleType, artist, maker, yearCreated, medium, dimensions, condition,
      provenanceDocIds, authCertDocIds, insuranceRiderDocIds, insuredValueCents,
      lastAppraisalValueCents, lastAppraisalDate, appraisalDocIds,
      storageFacility, storageLocation, additionalInfo, notes,
    } = req.body;

    const [existing] = await db
      .select({ id: estateCollectibles.id })
      .from(estateCollectibles)
      .where(eq(estateCollectibles.assetId, assetId));

    const payload = {
      assetId,
      companyId,
      userId: asset.userId,
      collectibleType: collectibleType ?? "art",
      artist: artist ?? null,
      maker: maker ?? null,
      yearCreated: yearCreated ?? null,
      medium: medium ?? null,
      dimensions: dimensions ?? null,
      condition: condition ?? null,
      provenanceDocIds: provenanceDocIds ?? null,
      authCertDocIds: authCertDocIds ?? null,
      insuranceRiderDocIds: insuranceRiderDocIds ?? null,
      insuredValueCents: insuredValueCents != null ? String(insuredValueCents) : null,
      lastAppraisalValueCents: lastAppraisalValueCents != null ? String(lastAppraisalValueCents) : null,
      lastAppraisalDate: lastAppraisalDate ? new Date(lastAppraisalDate) : null,
      appraisalDocIds: appraisalDocIds ?? null,
      storageFacility: storageFacility ?? null,
      storageLocation: storageLocation ?? null,
      additionalInfo: additionalInfo ?? null,
      notes: notes ?? null,
      updatedAt: new Date(),
    };

    if (existing) {
      const [updated] = await db
        .update(estateCollectibles)
        .set(payload)
        .where(eq(estateCollectibles.id, existing.id))
        .returning();
      return res.json(updated);
    }

    const [created] = await db
      .insert(estateCollectibles)
      .values(payload)
      .returning();
    res.status(201).json(created);
  });

  router.delete("/estate/assets/:assetId/collectible", async (req, res) => {
    assertBoard(req);
    const { assetId } = req.params;
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const asset = await resolveAsset(assetId, companyId);
    if (!asset) throw notFound("Asset not found");

    await db
      .delete(estateCollectibles)
      .where(eq(estateCollectibles.assetId, assetId));
    res.status(204).send();
  });

  return router;
}
