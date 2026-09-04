import { Router } from "express";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gte, isNotNull, isNull, lte, sql, or } from "drizzle-orm";
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
  estateTaxLots,
  estateNetWorthSnapshots,
  estateValuationReminders,
  estateDocumentAlerts,
  estateReviews,
  estatePropertyTaxBills,
  DEFAULT_REVIEW_CHECKLIST,
  estates,
  estateBeneficiaries,
  estateTrusts,
  estateTrustAssets,
  estateCollaborators,
  estateDocuments,
  estateDocumentAccessLog,
  estateTrustDistributions,
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
// Plaid client interface + default HTTP implementation
// ---------------------------------------------------------------------------

export interface PlaidAccountBalance {
  accountId: string;
  name: string;
  balanceCents: number;
  accountType: string;
  institutionName: string;
}

export interface PlaidClient {
  createLinkToken(userId: string): Promise<{ linkToken: string; expiration: string }>;
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  getAccountBalances(accessToken: string, institutionName?: string): Promise<PlaidAccountBalance[]>;
}

function mapPlaidSubtype(subtype: string | undefined): string {
  const map: Record<string, string> = {
    checking: "checking",
    savings: "savings",
    "401k": "retirement",
    ira: "retirement",
    roth: "retirement",
    investment: "investment",
    credit: "credit",
    loan: "loan",
    mortgage: "mortgage",
  };
  return map[subtype?.toLowerCase() ?? ""] ?? "other";
}

export function createDefaultPlaidClient(): PlaidClient | null {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const env = process.env.PLAID_ENV ?? "sandbox";
  if (!clientId || !secret) return null;
  const baseUrl = `https://${env}.plaid.com`;

  async function plaidPost(path: string, body: Record<string, unknown>) {
    const resp = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, secret, ...body }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Plaid API error ${resp.status}: ${text}`);
    }
    return resp.json() as Promise<Record<string, unknown>>;
  }

  return {
    async createLinkToken(userId) {
      const data = await plaidPost("/link/token/create", {
        user: { client_user_id: userId },
        client_name: "IUnify",
        products: ["transactions"],
        country_codes: ["US"],
        language: "en",
      });
      return {
        linkToken: data["link_token"] as string,
        expiration: data["expiration"] as string,
      };
    },
    async exchangePublicToken(publicToken) {
      const data = await plaidPost("/item/public_token/exchange", {
        public_token: publicToken,
      });
      return {
        accessToken: data["access_token"] as string,
        itemId: data["item_id"] as string,
      };
    },
    async getAccountBalances(accessToken, institutionName) {
      const data = await plaidPost("/accounts/balance/get", { access_token: accessToken });
      const accounts = (data["accounts"] as Array<Record<string, unknown>>) ?? [];
      return accounts.map((acct) => {
        const balances = acct["balances"] as Record<string, unknown>;
        const rawBalance = (balances?.["current"] as number | null) ?? 0;
        return {
          accountId: acct["account_id"] as string,
          name: (acct["name"] as string) ?? "Account",
          balanceCents: Math.round(rawBalance * 100),
          accountType: mapPlaidSubtype(acct["subtype"] as string | undefined),
          institutionName: institutionName ?? "Unknown",
        };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// S3 Vault client interface + default implementation
// ---------------------------------------------------------------------------

export interface S3VaultClient {
  createUploadUrl(opts: {
    bucket: string;
    key: string;
    contentType?: string;
    ttlSeconds?: number;
  }): Promise<string>;
  createDownloadUrl(opts: {
    bucket: string;
    key: string;
    ttlSeconds?: number;
  }): Promise<string>;
  deleteObject(opts: { bucket: string; key: string }): Promise<void>;
  putObject(opts: { bucket: string; key: string; buffer: Buffer; contentType?: string }): Promise<void>;
}

export function createDefaultS3VaultClient(): S3VaultClient | null {
  const bucket = process.env.ESTATE_DOCS_S3_BUCKET;
  const region = process.env.ESTATE_DOCS_S3_REGION ?? process.env.AWS_REGION;
  if (!bucket || !region) return null;

  return {
    async createUploadUrl({ bucket: b, key, contentType, ttlSeconds }) {
      const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      const client = new S3Client({ region });
      // Cast to any to work around @smithy/types version mismatch between client-s3 and s3-request-presigner
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (getSignedUrl as any)(
        client,
        new PutObjectCommand({ Bucket: b, Key: key, ContentType: contentType }),
        { expiresIn: ttlSeconds ?? 900 },
      );
    },
    async createDownloadUrl({ bucket: b, key, ttlSeconds }) {
      const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      const client = new S3Client({ region });
      // Cast to any to work around @smithy/types version mismatch between client-s3 and s3-request-presigner
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (getSignedUrl as any)(
        client,
        new GetObjectCommand({ Bucket: b, Key: key }),
        { expiresIn: ttlSeconds ?? 900 },
      );
    },
    async deleteObject({ bucket: b, key }) {
      const { S3Client, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
      const client = new S3Client({ region });
      await client.send(new DeleteObjectCommand({ Bucket: b, Key: key }));
    },
    async putObject({ bucket: b, key, buffer, contentType }) {
      const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
      const client = new S3Client({ region });
      await client.send(new PutObjectCommand({ Bucket: b, Key: key, Body: buffer, ContentType: contentType }));
    },
  };
}

const DEFAULT_VAULT_BUCKET = process.env.ESTATE_DOCS_S3_BUCKET ?? "iun-estate-docs";

// ---------------------------------------------------------------------------
// ATTOM client interface + default HTTP implementation
// ---------------------------------------------------------------------------

export interface AttomPropertyDetail {
  attomId: string;
  assessedValueCents: number | null;
  marketValueCents: number | null;
  squareFeet: number | null;
  lotSizeSqFt: number | null;
  yearBuilt: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  ownerName: string | null;
  legalDescription: string | null;
}

export interface AttomClient {
  getPropertyByAddress(address1: string, address2: string): Promise<AttomPropertyDetail | null>;
}

export function createDefaultAttomClient(): AttomClient | null {
  const apiKey = process.env.ATTOM_API_KEY;
  if (!apiKey) return null;
  const baseUrl = "https://api.gateway.attomdata.com";

  return {
    async getPropertyByAddress(address1, address2) {
      const params = new URLSearchParams({ address1, address2 });
      const resp = await fetch(
        `${baseUrl}/propertyapi/v1.0.0/property/address?${params.toString()}`,
        { headers: { Accept: "application/json", apikey: apiKey } },
      );
      if (resp.status === 404) return null;
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`ATTOM API error ${resp.status}: ${text}`);
      }
      const data = (await resp.json()) as Record<string, unknown>;
      const properties = (data["property"] as Array<Record<string, unknown>>) ?? [];
      if (properties.length === 0) return null;
      const prop = properties[0];
      const identifier = (prop["identifier"] as Record<string, unknown>) ?? {};
      const avm = (prop["avm"] as Record<string, unknown>) ?? {};
      const avmAmount = (avm["amount"] as Record<string, unknown>) ?? {};
      const building = (prop["building"] as Record<string, unknown>) ?? {};
      const size = (building["size"] as Record<string, unknown>) ?? {};
      const lot = (prop["lot"] as Record<string, unknown>) ?? {};
      const summary = (prop["summary"] as Record<string, unknown>) ?? {};
      const owner = (prop["owner"] as Record<string, unknown>) ?? {};
      const owner1 = (owner["owner1"] as Record<string, unknown>) ?? {};
      return {
        attomId: String(identifier["attomId"] ?? identifier["obPropId"] ?? ""),
        assessedValueCents: avmAmount["value"] != null ? Math.round(Number(avmAmount["value"]) * 100) : null,
        marketValueCents: avmAmount["high"] != null ? Math.round(Number(avmAmount["high"]) * 100) : null,
        squareFeet: size["livingsize"] != null ? Number(size["livingsize"]) : null,
        lotSizeSqFt: lot["lotsize2"] != null ? Number(lot["lotsize2"]) : null,
        yearBuilt: summary["yearbuilt"] != null ? Number(summary["yearbuilt"]) : null,
        bedrooms: building["rooms"] != null ? Number((building["rooms"] as Record<string, unknown>)["beds"]) : null,
        bathrooms: building["rooms"] != null ? Number((building["rooms"] as Record<string, unknown>)["bathstotal"]) : null,
        ownerName:
          owner1["lastNameAndSuffix"] != null
            ? `${owner1["firstNameAndMi"] ?? ""} ${owner1["lastNameAndSuffix"]}`.trim()
            : null,
        legalDescription: (prop["legal"] as Record<string, unknown>)?.["description"] as string | null ?? null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Snug client interface + default HTTP implementation
// ---------------------------------------------------------------------------

export interface SnugDocumentPayload {
  buffer: Buffer;
  contentType: string;
  sizeBytes: number;
}

export interface SnugClient {
  downloadDocument(url: string): Promise<SnugDocumentPayload>;
}

export function createDefaultSnugClient(): SnugClient | null {
  const apiKey = process.env.SNUG_API_KEY;
  if (!apiKey) return null;

  return {
    async downloadDocument(url) {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Snug download error ${resp.status}: ${text}`);
      }
      const contentType = resp.headers.get("content-type") ?? "application/octet-stream";
      const arrayBuffer = await resp.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return { buffer, contentType, sizeBytes: buffer.byteLength };
    },
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function estateRoutes(
  db: Db,
  plaidClient?: PlaidClient | null,
  s3VaultClient?: S3VaultClient | null,
  attomClient?: AttomClient | null,
  snugClient?: SnugClient | null,
) {
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

  // ---- Snug webhook ---------------------------------------------------------

  /**
   * POST /estate/integrations/snug/webhook
   *
   * Receives a document-completion event from the Snug legal document platform.
   * Downloads the completed document server-side, stores it in the S3 vault,
   * and creates an estate_documents record.
   *
   * Expected body:
   *   { event, estateId, companyId, documentType, title, documentUrl }
   *
   * Signature verification: when SNUG_WEBHOOK_SECRET is set, the request must
   * include X-Snug-Signature: sha256=<hex> computed over the raw body.
   */
  router.post("/estate/integrations/snug/webhook", async (req, res) => {
    const secret = process.env.SNUG_WEBHOOK_SECRET;
    if (secret) {
      const sigHeader = req.headers["x-snug-signature"];
      const rawSig = typeof sigHeader === "string" ? sigHeader.replace(/^sha256=/, "") : "";
      const expected = createHmac("sha256", secret)
        .update(JSON.stringify(req.body))
        .digest("hex");
      let match = false;
      try {
        match = timingSafeEqual(Buffer.from(rawSig, "hex"), Buffer.from(expected, "hex"));
      } catch {
        match = false;
      }
      if (!match) {
        res.status(401).json({ error: "Invalid webhook signature" });
        return;
      }
    }

    const body = req.body as Record<string, unknown>;
    const event = typeof body["event"] === "string" ? body["event"] : null;
    if (event !== "document.completed") {
      res.json({ received: true });
      return;
    }

    const estateId = typeof body["estateId"] === "string" ? body["estateId"].trim() : null;
    const companyId = typeof body["companyId"] === "string" ? body["companyId"].trim() : null;
    const documentType = typeof body["documentType"] === "string" ? body["documentType"].trim() : "other";
    const title = typeof body["title"] === "string" ? body["title"].trim() : null;
    const documentUrl = typeof body["documentUrl"] === "string" ? body["documentUrl"].trim() : null;

    if (!estateId || !companyId || !title || !documentUrl) {
      res.status(400).json({ error: "estateId, companyId, title, and documentUrl are required" });
      return;
    }

    const vault = s3VaultClient ?? createDefaultS3VaultClient();
    if (!vault) {
      res.status(503).json({ error: "Document vault not configured" });
      return;
    }

    const snug = snugClient ?? createDefaultSnugClient();
    if (!snug) {
      res.status(503).json({ error: "Snug integration not configured" });
      return;
    }

    const [estate] = await db
      .select({ id: estates.id })
      .from(estates)
      .where(and(eq(estates.id, estateId), eq(estates.companyId, companyId)));
    if (!estate) {
      res.status(404).json({ error: "Estate not found" });
      return;
    }

    const { buffer, contentType, sizeBytes } = await snug.downloadDocument(documentUrl);

    const s3Key = `estates/${estateId}/documents/${randomBytes(16).toString("hex")}`;
    const bucket = DEFAULT_VAULT_BUCKET;

    await vault.putObject({ bucket, key: s3Key, buffer, contentType });

    const allowedDocTypes = ["will", "trust", "deed", "poa", "healthcare_directive", "insurance", "other"] as const;
    const safeDocType = (allowedDocTypes as readonly string[]).includes(documentType)
      ? (documentType as typeof allowedDocTypes[number])
      : "other";

    const [doc] = await db
      .insert(estateDocuments)
      .values({
        estateId,
        companyId,
        uploaderUserId: "snug-webhook",
        documentType: safeDocType,
        title,
        s3Key,
        s3Bucket: bucket,
        sizeBytes,
      })
      .returning();

    res.status(201).json({ received: true, document: doc });
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

  // =========================================================================
  // Phase 2 Priority 2 — Advanced Financial Features
  // =========================================================================

  // ---- Portfolio Consolidation View ----------------------------------------
  // GET /estate/portfolio?companyId=&userId=
  // Returns all assets + accounts with current values, grouped by class,
  // plus allocation percentages.

  router.get("/estate/portfolio", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const userId =
      typeof req.query.userId === "string" && req.query.userId.trim()
        ? req.query.userId.trim()
        : req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [assets, accounts] = await Promise.all([
      db.select().from(estateAssets)
        .where(and(eq(estateAssets.companyId, companyId), eq(estateAssets.userId, userId)))
        .orderBy(desc(estateAssets.currentValueCents)),
      db.select().from(estateFinancialAccounts)
        .where(and(eq(estateFinancialAccounts.companyId, companyId), eq(estateFinancialAccounts.userId, userId)))
        .orderBy(desc(estateFinancialAccounts.balanceCents)),
    ]);

    const assetTotalCents = assets.reduce((sum, a) => sum + Number(a.currentValueCents ?? 0), 0);
    const accountTotalCents = accounts.reduce((sum, a) => sum + Number(a.balanceCents ?? 0), 0);
    const netWorthCents = assetTotalCents + accountTotalCents;

    // Group assets by type
    const byClass: Record<string, { totalCents: number; count: number; allocationPct: number }> = {};
    for (const asset of assets) {
      const key = asset.assetType;
      if (!byClass[key]) byClass[key] = { totalCents: 0, count: 0, allocationPct: 0 };
      byClass[key].totalCents += Number(asset.currentValueCents ?? 0);
      byClass[key].count++;
    }
    // Financial accounts as own class
    if (accounts.length > 0) {
      byClass["financial_account"] = { totalCents: accountTotalCents, count: accounts.length, allocationPct: 0 };
    }
    if (netWorthCents > 0) {
      for (const cls of Object.values(byClass)) {
        cls.allocationPct = Math.round((cls.totalCents / netWorthCents) * 10000) / 100;
      }
    }

    res.json({
      netWorthCents,
      netWorthDollars: netWorthCents / 100,
      assetsTotalCents: assetTotalCents,
      accountsTotalCents: accountTotalCents,
      allocationByClass: byClass,
      assets: assets.map((a) => ({
        id: a.id,
        name: a.name,
        assetType: a.assetType,
        currentValueCents: Number(a.currentValueCents ?? 0),
        currentValueDollars: Number(a.currentValueCents ?? 0) / 100,
        valuationDate: a.valuationDate,
      })),
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        accountType: a.accountType,
        balanceCents: Number(a.balanceCents ?? 0),
        balanceDollars: Number(a.balanceCents ?? 0) / 100,
        balanceUpdatedAt: a.balanceUpdatedAt,
      })),
    });
  });

  // ---- Net Worth History (snapshots) --------------------------------------
  // POST /estate/net-worth/snapshot  → capture current net worth as a snapshot
  // GET  /estate/net-worth/history   → paginated history for charting

  router.post("/estate/net-worth/snapshot", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.body.companyId === "string" ? req.body.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const userId =
      typeof req.body.userId === "string" && req.body.userId.trim()
        ? req.body.userId.trim()
        : req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    // Compute current net worth
    const [assetRow] = await db
      .select({ total: sql<string>`coalesce(sum(current_value_cents), 0)` })
      .from(estateAssets)
      .where(and(eq(estateAssets.companyId, companyId), eq(estateAssets.userId, userId)));

    const [accountRow] = await db
      .select({ total: sql<string>`coalesce(sum(balance_cents), 0)` })
      .from(estateFinancialAccounts)
      .where(and(eq(estateFinancialAccounts.companyId, companyId), eq(estateFinancialAccounts.userId, userId)));

    const [breakdownRows] = await Promise.all([
      db
        .select({ assetType: estateAssets.assetType, total: sql<string>`coalesce(sum(current_value_cents), 0)` })
        .from(estateAssets)
        .where(and(eq(estateAssets.companyId, companyId), eq(estateAssets.userId, userId)))
        .groupBy(estateAssets.assetType),
    ]);

    const assetsTotalCents = Number(assetRow?.total ?? 0);
    const accountsTotalCents = Number(accountRow?.total ?? 0);
    const netWorthCents = assetsTotalCents + accountsTotalCents;

    const breakdown: Record<string, number> = {};
    for (const row of (breakdownRows as unknown as Array<{ assetType: string; total: string }>)) {
      breakdown[row.assetType] = Number(row.total);
    }

    const [snapshot] = await db
      .insert(estateNetWorthSnapshots)
      .values({
        companyId,
        userId,
        snapshotDate: req.body.snapshotDate ? new Date(req.body.snapshotDate) : new Date(),
        netWorthCents: String(netWorthCents),
        assetsTotalCents: String(assetsTotalCents),
        accountsTotalCents: String(accountsTotalCents),
        breakdown,
      })
      .returning();

    res.status(201).json(snapshot);
  });

  router.get("/estate/net-worth/history", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const userId =
      typeof req.query.userId === "string" && req.query.userId.trim()
        ? req.query.userId.trim()
        : req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const fromDate = typeof req.query.from === "string" ? new Date(req.query.from) : null;
    const toDate = typeof req.query.to === "string" ? new Date(req.query.to) : null;

    const conditions = [
      eq(estateNetWorthSnapshots.companyId, companyId),
      eq(estateNetWorthSnapshots.userId, userId),
      ...(fromDate ? [gte(estateNetWorthSnapshots.snapshotDate, fromDate)] : []),
      ...(toDate ? [lte(estateNetWorthSnapshots.snapshotDate, toDate)] : []),
    ];

    const snapshots = await db
      .select()
      .from(estateNetWorthSnapshots)
      .where(and(...conditions))
      .orderBy(asc(estateNetWorthSnapshots.snapshotDate));

    res.json({
      snapshots: snapshots.map((s) => ({
        id: s.id,
        snapshotDate: s.snapshotDate,
        netWorthDollars: Number(s.netWorthCents) / 100,
        netWorthCents: Number(s.netWorthCents),
        assetsTotalCents: Number(s.assetsTotalCents),
        accountsTotalCents: Number(s.accountsTotalCents),
        breakdown: s.breakdown,
      })),
    });
  });

  // ---- Tax Lot Tracking ----------------------------------------------------
  // GET    /estate/assets/:assetId/tax-lots
  // POST   /estate/assets/:assetId/tax-lots
  // PATCH  /estate/tax-lots/:lotId
  // DELETE /estate/tax-lots/:lotId

  router.get("/estate/assets/:assetId/tax-lots", async (req, res) => {
    assertBoard(req);
    const { assetId } = req.params;
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const asset = await resolveAsset(assetId, companyId);
    if (!asset) throw notFound("Asset not found");

    const status = typeof req.query.status === "string" ? req.query.status.trim() : null;
    const conditions = [eq(estateTaxLots.assetId, assetId)];
    if (status) conditions.push(eq(estateTaxLots.status, status as "open" | "closed" | "transferred"));

    const lots = await db
      .select()
      .from(estateTaxLots)
      .where(and(...conditions))
      .orderBy(asc(estateTaxLots.acquiredAt));

    // Summary
    const openLots = lots.filter((l) => l.status === "open");
    const totalCostBasisCents = openLots.reduce((s, l) => s + Number(l.totalCostBasisCents), 0);
    const totalCurrentValueCents = openLots.reduce((s, l) => s + Number(l.currentValueCents ?? 0), 0);
    const unrealizedGainCents = totalCurrentValueCents - totalCostBasisCents;

    res.json({
      lots,
      summary: {
        totalLots: lots.length,
        openLots: openLots.length,
        totalCostBasisCents,
        totalCurrentValueCents,
        unrealizedGainCents,
        unrealizedGainDollars: unrealizedGainCents / 100,
      },
    });
  });

  router.post("/estate/assets/:assetId/tax-lots", async (req, res) => {
    assertBoard(req);
    const { assetId } = req.params;
    const companyId = typeof req.body.companyId === "string" ? req.body.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const asset = await resolveAsset(assetId, companyId);
    if (!asset) throw notFound("Asset not found");

    const { ticker, cusip, securityName, shares, costBasisPerShareCents, acquiredAt, notes } = req.body;
    if (shares == null) throw badRequest("shares is required");
    if (costBasisPerShareCents == null) throw badRequest("costBasisPerShareCents is required");
    if (!acquiredAt) throw badRequest("acquiredAt is required");

    const sharesNum = Number(shares);
    const basisPerShare = Number(costBasisPerShareCents);
    const totalCostBasisCents = Math.round(sharesNum * basisPerShare);
    const acquiredDate = new Date(acquiredAt);
    const holdingMs = Date.now() - acquiredDate.getTime();
    const isLongTerm = holdingMs > 365 * 24 * 60 * 60 * 1000;

    const [lot] = await db
      .insert(estateTaxLots)
      .values({
        assetId,
        companyId,
        userId: asset.userId,
        ticker: ticker ?? null,
        cusip: cusip ?? null,
        securityName: securityName ?? null,
        shares: String(sharesNum),
        costBasisPerShareCents: String(basisPerShare),
        totalCostBasisCents: String(totalCostBasisCents),
        acquiredAt: acquiredDate,
        isLongTerm,
        notes: notes ?? null,
      })
      .returning();

    res.status(201).json(lot);
  });

  router.patch("/estate/tax-lots/:lotId", async (req, res) => {
    assertBoard(req);
    const { lotId } = req.params;
    const companyId = typeof req.body.companyId === "string" ? req.body.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const [existing] = await db
      .select()
      .from(estateTaxLots)
      .where(and(eq(estateTaxLots.id, lotId), eq(estateTaxLots.companyId, companyId)));
    if (!existing) throw notFound("Tax lot not found");

    const { currentPricePerShareCents, status, soldAt, salePerShareCents, isWashSale, washSaleDisallowedCents, notes } =
      req.body;

    const currentPrice = currentPricePerShareCents != null ? Number(currentPricePerShareCents) : null;
    const currentValue =
      currentPrice != null ? Math.round(Number(existing.shares) * currentPrice) : null;

    const [updated] = await db
      .update(estateTaxLots)
      .set({
        ...(currentPrice != null && {
          currentPricePerShareCents: String(currentPrice),
          currentValueCents: String(currentValue),
        }),
        ...(status !== undefined && { status }),
        ...(soldAt !== undefined && { soldAt: soldAt ? new Date(soldAt) : null }),
        ...(salePerShareCents != null && { salePerShareCents: String(salePerShareCents) }),
        ...(isWashSale !== undefined && { isWashSale: Boolean(isWashSale) }),
        ...(washSaleDisallowedCents != null && { washSaleDisallowedCents: String(washSaleDisallowedCents) }),
        ...(notes !== undefined && { notes }),
        updatedAt: new Date(),
      })
      .where(eq(estateTaxLots.id, lotId))
      .returning();

    res.json(updated);
  });

  router.delete("/estate/tax-lots/:lotId", async (req, res) => {
    assertBoard(req);
    const { lotId } = req.params;
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const [existing] = await db
      .select({ id: estateTaxLots.id })
      .from(estateTaxLots)
      .where(and(eq(estateTaxLots.id, lotId), eq(estateTaxLots.companyId, companyId)));
    if (!existing) throw notFound("Tax lot not found");

    await db.delete(estateTaxLots).where(eq(estateTaxLots.id, lotId));
    res.status(204).send();
  });

  // ---- RMD Calculation Engine ----------------------------------------------
  // GET /estate/rmd-summary?companyId=&userId=&year=
  // Returns all retirement accounts with RMD status + shortfall/excess analysis.

  router.get("/estate/rmd-summary", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const userId =
      typeof req.query.userId === "string" && req.query.userId.trim()
        ? req.query.userId.trim()
        : req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const year = typeof req.query.year === "string" ? parseInt(req.query.year, 10) : new Date().getFullYear();

    const retirementDetails = await db
      .select({
        id: estateRetirementAccounts.id,
        assetId: estateRetirementAccounts.assetId,
        accountType: estateRetirementAccounts.accountType,
        isRoth: estateRetirementAccounts.isRoth,
        rmdRequired: estateRetirementAccounts.rmdRequired,
        rmdAmountCents: estateRetirementAccounts.rmdAmountCents,
        rmdDueYear: estateRetirementAccounts.rmdDueYear,
        rmdWithdrawnThisYearCents: estateRetirementAccounts.rmdWithdrawnThisYearCents,
        custodian: estateRetirementAccounts.custodian,
        assetName: estateAssets.name,
        assetValueCents: estateAssets.currentValueCents,
      })
      .from(estateRetirementAccounts)
      .innerJoin(estateAssets, eq(estateRetirementAccounts.assetId, estateAssets.id))
      .where(
        and(
          eq(estateRetirementAccounts.companyId, companyId),
          eq(estateRetirementAccounts.userId, userId),
        ),
      );

    const accounts = retirementDetails.map((r) => {
      const rmdCents = Number(r.rmdAmountCents ?? 0);
      const withdrawnCents = Number(r.rmdWithdrawnThisYearCents ?? 0);
      const remainingCents = r.rmdRequired && r.rmdDueYear === year ? Math.max(0, rmdCents - withdrawnCents) : 0;
      const isDue = r.rmdRequired && (r.rmdDueYear ?? year) <= year;
      return {
        id: r.id,
        assetId: r.assetId,
        assetName: r.assetName,
        accountType: r.accountType,
        isRoth: r.isRoth,
        custodian: r.custodian,
        currentValueCents: Number(r.assetValueCents ?? 0),
        rmdRequired: r.rmdRequired,
        rmdDueYear: r.rmdDueYear,
        rmdAmountCents: rmdCents,
        rmdWithdrawnThisYearCents: withdrawnCents,
        rmdRemainingCents: remainingCents,
        isDueThisYear: isDue,
        isFullySatisfied: isDue ? withdrawnCents >= rmdCents : null,
      };
    });

    const totalRmdDueCents = accounts
      .filter((a) => a.isDueThisYear)
      .reduce((s, a) => s + a.rmdAmountCents, 0);
    const totalWithdrawnCents = accounts
      .filter((a) => a.isDueThisYear)
      .reduce((s, a) => s + a.rmdWithdrawnThisYearCents, 0);

    res.json({
      year,
      accounts,
      summary: {
        totalAccountsWithRmd: accounts.filter((a) => a.rmdRequired).length,
        accountsDueThisYear: accounts.filter((a) => a.isDueThisYear).length,
        totalRmdDueCents,
        totalWithdrawnCents,
        totalRemainingCents: Math.max(0, totalRmdDueCents - totalWithdrawnCents),
        allSatisfied: totalRmdDueCents > 0 && totalWithdrawnCents >= totalRmdDueCents,
      },
    });
  });

  // ---- Estate Value Projection ---------------------------------------------
  // GET /estate/projection?companyId=&userId=&years=&growthRatePct=
  // Projects net worth forward using a simple compound growth model per asset class.

  router.get("/estate/projection", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const userId =
      typeof req.query.userId === "string" && req.query.userId.trim()
        ? req.query.userId.trim()
        : req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const horizonYears = Math.min(
      50,
      typeof req.query.years === "string" ? parseInt(req.query.years, 10) || 10 : 10,
    );

    // Default growth rates by asset class (annual %)
    const DEFAULT_RATES: Record<string, number> = {
      real_estate: 4.0,
      investment: 7.0,
      retirement: 6.5,
      vehicle: -5.0,
      personal_property: 0.0,
      digital_asset: 15.0,
      other: 3.0,
      financial_account: 4.5,
    };

    // Allow caller to override with ?rates[real_estate]=5
    const rateOverrides: Record<string, number> = {};
    if (req.query.rates && typeof req.query.rates === "object") {
      for (const [k, v] of Object.entries(req.query.rates as Record<string, string>)) {
        rateOverrides[k] = parseFloat(v);
      }
    }

    const [assets, accounts] = await Promise.all([
      db.select().from(estateAssets)
        .where(and(eq(estateAssets.companyId, companyId), eq(estateAssets.userId, userId))),
      db.select().from(estateFinancialAccounts)
        .where(and(eq(estateFinancialAccounts.companyId, companyId), eq(estateFinancialAccounts.userId, userId))),
    ]);

    // Group assets by class with their current values
    const classes: Record<string, number> = {};
    for (const asset of assets) {
      const key = asset.assetType;
      classes[key] = (classes[key] ?? 0) + Number(asset.currentValueCents ?? 0);
    }
    const accountTotal = accounts.reduce((s, a) => s + Number(a.balanceCents ?? 0), 0);
    if (accountTotal > 0) classes["financial_account"] = accountTotal;

    const currentNetWorthCents = Object.values(classes).reduce((s, v) => s + v, 0);

    // Project year-by-year
    const projections = [];
    let stateByClass = { ...classes };

    for (let yr = 1; yr <= horizonYears; yr++) {
      const next: Record<string, number> = {};
      for (const [cls, val] of Object.entries(stateByClass)) {
        const rate = (rateOverrides[cls] ?? DEFAULT_RATES[cls] ?? 3.0) / 100;
        next[cls] = Math.round(val * (1 + rate));
      }
      stateByClass = next;
      const total = Object.values(next).reduce((s, v) => s + v, 0);
      projections.push({
        year: new Date().getFullYear() + yr,
        projectedNetWorthCents: total,
        projectedNetWorthDollars: total / 100,
        byClass: Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v / 100])),
      });
    }

    res.json({
      currentNetWorthCents,
      currentNetWorthDollars: currentNetWorthCents / 100,
      horizonYears,
      growthRatesUsed: {
        ...DEFAULT_RATES,
        ...rateOverrides,
      },
      projections,
    });
  });

  // ── Priority 3: Compliance & Automation ──────────────────────────────────

  // ---- Valuation Reminders -------------------------------------------------

  /** List valuation reminders for a user */
  router.get("/estate/valuation-reminders", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);
    const userId = typeof req.query.userId === "string" ? req.query.userId.trim() : req.actor!.userId;
    if (!userId) throw badRequest("Could not resolve userId");

    const rows = await db
      .select()
      .from(estateValuationReminders)
      .where(and(eq(estateValuationReminders.companyId, companyId), eq(estateValuationReminders.userId, userId)))
      .orderBy(asc(estateValuationReminders.nextDueAt));

    res.json({ reminders: rows });
  });

  /** Create a valuation reminder for an asset */
  router.post("/estate/valuation-reminders", async (req, res) => {
    assertBoard(req);
    const { companyId, userId: bodyUserId, assetId, frequency, frequencyDays, nextDueAt, notes } = req.body ?? {};
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);
    if (!assetId) throw badRequest("assetId is required");
    if (!nextDueAt) throw badRequest("nextDueAt is required");
    const userId = bodyUserId ?? req.actor!.userId;

    const freqDays = frequencyDays ?? (frequency === "quarterly" ? 91 : frequency === "monthly" ? 30 : frequency === "semi_annual" ? 182 : 365);

    const [reminder] = await db
      .insert(estateValuationReminders)
      .values({ companyId, userId, assetId, frequency: frequency ?? "annual", frequencyDays: freqDays, nextDueAt: new Date(nextDueAt), notes })
      .returning();

    res.status(201).json(reminder);
  });

  /** Update a valuation reminder */
  router.patch("/estate/valuation-reminders/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params;
    const { nextDueAt, lastRemindedAt, isActive, notes, frequency, frequencyDays } = req.body ?? {};

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (nextDueAt !== undefined) updates.nextDueAt = new Date(nextDueAt);
    if (lastRemindedAt !== undefined) updates.lastRemindedAt = new Date(lastRemindedAt);
    if (isActive !== undefined) updates.isActive = isActive;
    if (notes !== undefined) updates.notes = notes;
    if (frequency !== undefined) updates.frequency = frequency;
    if (frequencyDays !== undefined) updates.frequencyDays = frequencyDays;

    const [updated] = await db
      .update(estateValuationReminders)
      .set(updates)
      .where(eq(estateValuationReminders.id, id))
      .returning();

    if (!updated) throw notFound("Valuation reminder not found");
    res.json(updated);
  });

  /** Delete a valuation reminder */
  router.delete("/estate/valuation-reminders/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params;
    const [deleted] = await db
      .delete(estateValuationReminders)
      .where(eq(estateValuationReminders.id, id))
      .returning();
    if (!deleted) throw notFound("Valuation reminder not found");
    res.json({ deleted: true });
  });

  // ---- Document Expiry Alerts ----------------------------------------------

  /** List document alerts for a user */
  router.get("/estate/document-alerts", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);
    const userId = typeof req.query.userId === "string" ? req.query.userId.trim() : req.actor!.userId;
    if (!userId) throw badRequest("Could not resolve userId");
    const statusFilter = typeof req.query.status === "string" ? req.query.status.trim() : null;

    const conditions = [
      eq(estateDocumentAlerts.companyId, companyId),
      eq(estateDocumentAlerts.userId, userId),
    ];
    if (statusFilter) {
      conditions.push(eq(estateDocumentAlerts.status, statusFilter as "active" | "dismissed" | "expired"));
    }

    const rows = await db
      .select()
      .from(estateDocumentAlerts)
      .where(and(...conditions))
      .orderBy(asc(estateDocumentAlerts.expiresAt));

    // Annotate each alert with urgency: days until expiry
    const now = Date.now();
    const annotated = rows.map((r) => ({
      ...r,
      daysUntilExpiry: Math.ceil((new Date(r.expiresAt).getTime() - now) / 86_400_000),
    }));

    res.json({ alerts: annotated });
  });

  /** Create a document alert */
  router.post("/estate/document-alerts", async (req, res) => {
    assertBoard(req);
    const { companyId, userId: bodyUserId, assetId, documentName, alertType, expiresAt, alertDaysBefore, notes } = req.body ?? {};
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);
    if (!documentName) throw badRequest("documentName is required");
    if (!expiresAt) throw badRequest("expiresAt is required");
    const userId = bodyUserId ?? req.actor!.userId;

    const [alert] = await db
      .insert(estateDocumentAlerts)
      .values({
        companyId,
        userId,
        assetId: assetId ?? null,
        documentName,
        alertType: alertType ?? "other",
        expiresAt: new Date(expiresAt),
        alertDaysBefore: alertDaysBefore ?? [30, 60, 90],
        notes,
      })
      .returning();

    res.status(201).json(alert);
  });

  /** Update a document alert (status, notes, etc.) */
  router.patch("/estate/document-alerts/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params;
    const { status, notes, expiresAt, alertDaysBefore, lastAlertedAt } = req.body ?? {};

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (status !== undefined) updates.status = status;
    if (notes !== undefined) updates.notes = notes;
    if (expiresAt !== undefined) updates.expiresAt = new Date(expiresAt);
    if (alertDaysBefore !== undefined) updates.alertDaysBefore = alertDaysBefore;
    if (lastAlertedAt !== undefined) updates.lastAlertedAt = new Date(lastAlertedAt);

    const [updated] = await db
      .update(estateDocumentAlerts)
      .set(updates)
      .where(eq(estateDocumentAlerts.id, id))
      .returning();

    if (!updated) throw notFound("Document alert not found");
    res.json(updated);
  });

  /** Delete a document alert */
  router.delete("/estate/document-alerts/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params;
    const [deleted] = await db
      .delete(estateDocumentAlerts)
      .where(eq(estateDocumentAlerts.id, id))
      .returning();
    if (!deleted) throw notFound("Document alert not found");
    res.json({ deleted: true });
  });

  // ---- Annual Estate Review Workflow ---------------------------------------

  /** Get or create the estate review for a given year */
  router.get("/estate/reviews/:year", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);
    const userId = typeof req.query.userId === "string" ? req.query.userId.trim() : req.actor!.userId;
    if (!userId) throw badRequest("Could not resolve userId");
    const reviewYear = parseInt(req.params.year, 10);
    if (isNaN(reviewYear)) throw badRequest("Invalid year");

    const [existing] = await db
      .select()
      .from(estateReviews)
      .where(and(eq(estateReviews.companyId, companyId), eq(estateReviews.userId, userId), eq(estateReviews.reviewYear, reviewYear)));

    if (existing) {
      res.json(existing);
      return;
    }

    // Auto-create with default checklist
    const [created] = await db
      .insert(estateReviews)
      .values({ companyId, userId, reviewYear, checklist: DEFAULT_REVIEW_CHECKLIST })
      .returning();

    res.status(201).json(created);
  });

  /** Update a checklist item or overall review status/notes */
  router.patch("/estate/reviews/:year", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);
    const userId = typeof req.query.userId === "string" ? req.query.userId.trim() : req.actor!.userId;
    if (!userId) throw badRequest("Could not resolve userId");
    const reviewYear = parseInt(req.params.year, 10);
    if (isNaN(reviewYear)) throw badRequest("Invalid year");

    const [existing] = await db
      .select()
      .from(estateReviews)
      .where(and(eq(estateReviews.companyId, companyId), eq(estateReviews.userId, userId), eq(estateReviews.reviewYear, reviewYear)));

    if (!existing) throw notFound("Estate review not found for this year");

    const { status, notes, checklist, checklistItemId, checklistCompleted } = req.body ?? {};

    let updatedChecklist = existing.checklist;
    if (checklistItemId !== undefined && checklistCompleted !== undefined) {
      updatedChecklist = (existing.checklist ?? []).map((item) =>
        item.id === checklistItemId
          ? { ...item, completed: checklistCompleted, completedAt: checklistCompleted ? new Date().toISOString() : undefined }
          : item,
      );
    } else if (checklist !== undefined) {
      updatedChecklist = checklist;
    }

    const allDone = updatedChecklist.length > 0 && updatedChecklist.every((i) => i.completed);
    const derivedStatus = status ?? (allDone ? "complete" : updatedChecklist.some((i) => i.completed) ? "in_progress" : existing.status);

    const updates: Record<string, unknown> = {
      checklist: updatedChecklist,
      status: derivedStatus,
      updatedAt: new Date(),
    };
    if (notes !== undefined) updates.notes = notes;
    if (derivedStatus === "complete" && !existing.reviewedAt) updates.reviewedAt = new Date();

    const [updated] = await db
      .update(estateReviews)
      .set(updates)
      .where(eq(estateReviews.id, existing.id))
      .returning();

    res.json(updated);
  });

  /** List all estate reviews for a user */
  router.get("/estate/reviews", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);
    const userId = typeof req.query.userId === "string" ? req.query.userId.trim() : req.actor!.userId;
    if (!userId) throw badRequest("Could not resolve userId");

    const rows = await db
      .select()
      .from(estateReviews)
      .where(and(eq(estateReviews.companyId, companyId), eq(estateReviews.userId, userId)))
      .orderBy(desc(estateReviews.reviewYear));

    res.json({ reviews: rows });
  });

  // ---- Multi-State Property Tax Calendar ----------------------------------

  /** List property tax bills for a user */
  router.get("/estate/property-tax", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);
    const userId = typeof req.query.userId === "string" ? req.query.userId.trim() : req.actor!.userId;
    if (!userId) throw badRequest("Could not resolve userId");
    const stateFilter = typeof req.query.state === "string" ? req.query.state.trim().toUpperCase() : null;
    const yearFilter = typeof req.query.year === "string" ? parseInt(req.query.year, 10) : null;

    const conditions = [
      eq(estatePropertyTaxBills.companyId, companyId),
      eq(estatePropertyTaxBills.userId, userId),
    ];
    if (stateFilter) conditions.push(eq(estatePropertyTaxBills.state, stateFilter));
    if (yearFilter && !isNaN(yearFilter)) conditions.push(eq(estatePropertyTaxBills.taxYear, yearFilter));

    const rows = await db
      .select()
      .from(estatePropertyTaxBills)
      .where(and(...conditions))
      .orderBy(asc(estatePropertyTaxBills.dueDate));

    // Compute overdue status on-the-fly for upcoming bills past due
    const now = new Date();
    const annotated = rows.map((r) => ({
      ...r,
      isOverdue: r.status === "upcoming" && new Date(r.dueDate) < now,
      daysUntilDue: Math.ceil((new Date(r.dueDate).getTime() - now.getTime()) / 86_400_000),
    }));

    res.json({ bills: annotated });
  });

  /** Add a property tax bill */
  router.post("/estate/property-tax", async (req, res) => {
    assertBoard(req);
    const { companyId, userId: bodyUserId, assetId, state, county, taxYear, installment, dueDate, amountCents, notes } = req.body ?? {};
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);
    if (!assetId) throw badRequest("assetId is required");
    if (!state) throw badRequest("state is required");
    if (!taxYear) throw badRequest("taxYear is required");
    if (!dueDate) throw badRequest("dueDate is required");
    const userId = bodyUserId ?? req.actor!.userId;

    const [bill] = await db
      .insert(estatePropertyTaxBills)
      .values({
        companyId,
        userId,
        assetId,
        state: state.toUpperCase(),
        county: county ?? null,
        taxYear,
        installment: installment ?? 1,
        dueDate: new Date(dueDate),
        amountCents: amountCents ? String(amountCents) : null,
        notes,
      })
      .returning();

    res.status(201).json(bill);
  });

  /** Mark a property tax bill as paid or update it */
  router.patch("/estate/property-tax/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params;
    const { status, paidAt, paidAmountCents, amountCents, notes, dueDate } = req.body ?? {};

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (status !== undefined) updates.status = status;
    if (paidAt !== undefined) updates.paidAt = new Date(paidAt);
    if (paidAmountCents !== undefined) updates.paidAmountCents = String(paidAmountCents);
    if (amountCents !== undefined) updates.amountCents = String(amountCents);
    if (notes !== undefined) updates.notes = notes;
    if (dueDate !== undefined) updates.dueDate = new Date(dueDate);
    if (status === "paid" && !paidAt) updates.paidAt = new Date();

    const [updated] = await db
      .update(estatePropertyTaxBills)
      .set(updates)
      .where(eq(estatePropertyTaxBills.id, id))
      .returning();

    if (!updated) throw notFound("Property tax bill not found");
    res.json(updated);
  });

  /** Delete a property tax bill */
  router.delete("/estate/property-tax/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params;
    const [deleted] = await db
      .delete(estatePropertyTaxBills)
      .where(eq(estatePropertyTaxBills.id, id))
      .returning();
    if (!deleted) throw notFound("Property tax bill not found");
    res.json({ deleted: true });
  });

  // =========================================================================
  // ATTOM Property Enrichment
  // =========================================================================

  /**
   * POST /estate/assets/:assetId/attom/enrich
   *
   * Looks up property details from ATTOM Data Solutions and writes assessed
   * value, ATTOM property ID, and physical attributes back to the asset.
   *
   * Address resolution order:
   *   1. address1/address2 fields in request body
   *   2. address/city/state/zip fields in asset.typeMetadata
   */
  router.post("/estate/assets/:assetId/attom/enrich", async (req, res) => {
    assertBoard(req);

    const { companyId, address1: bodyAddress1, address2: bodyAddress2 } = req.body as {
      companyId?: string;
      address1?: string;
      address2?: string;
    };

    if (!companyId) {
      res.status(400).json({ error: "companyId is required" });
      return;
    }

    const client = attomClient ?? createDefaultAttomClient();
    if (!client) {
      res.status(503).json({ error: "ATTOM integration is not configured" });
      return;
    }

    const assetId = req.params.assetId;
    const [asset] = await db
      .select()
      .from(estateAssets)
      .where(and(eq(estateAssets.id, assetId), eq(estateAssets.companyId, companyId)));

    if (!asset) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }

    // Resolve address to pass to ATTOM
    let address1 = bodyAddress1?.trim() ?? "";
    let address2 = bodyAddress2?.trim() ?? "";

    if (!address1) {
      const meta = (asset.typeMetadata ?? {}) as Record<string, string | undefined>;
      address1 = (meta["address"] ?? meta["street"] ?? "").trim();
      if (meta["city"] || meta["state"]) {
        address2 = `${meta["city"] ?? ""}, ${meta["state"] ?? ""} ${meta["zip"] ?? ""}`.trim().replace(/^,\s*/, "");
      }
    }

    if (!address1) {
      res.status(400).json({ error: "address is required — provide address1 in the request body or set address in the asset typeMetadata" });
      return;
    }

    const detail = await client.getPropertyByAddress(address1, address2);
    if (!detail) {
      res.status(422).json({ error: "No property found at the provided address" });
      return;
    }

    const [updated] = await db
      .update(estateAssets)
      .set({
        attomPropertyId: detail.attomId || null,
        assessedValueCents: detail.assessedValueCents != null ? String(detail.assessedValueCents) : null,
        valuationSource: "attom",
        attomEnrichedAt: new Date(),
        attomSquareFeet: detail.squareFeet ?? null,
        attomLotSizeSqFt: detail.lotSizeSqFt ?? null,
        attomYearBuilt: detail.yearBuilt ?? null,
        updatedAt: new Date(),
      })
      .where(eq(estateAssets.id, assetId))
      .returning();

    res.json(updated);
  });

  // =========================================================================
  // Core Estate Entities — IUN-1568
  // =========================================================================

  // ---- Estates CRUD ---------------------------------------------------------

  /** List estates owned by the authenticated user */
  router.get("/estates", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const userId =
      typeof req.query.userId === "string" && req.query.userId.trim()
        ? req.query.userId.trim()
        : req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor.trim() : null;

    let query = db
      .select()
      .from(estates)
      .where(and(eq(estates.companyId, companyId), eq(estates.ownerUserId, userId)))
      .orderBy(asc(estates.createdAt))
      .limit(limit + 1) as any;

    const rows = await query;
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    res.json({ estates: items, nextCursor });
  });

  /** Create a new estate */
  router.post("/estates", async (req, res) => {
    assertBoard(req);
    const body = req.body as Record<string, unknown>;
    const companyId = typeof body.companyId === "string" ? body.companyId : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const userId =
      typeof body.ownerUserId === "string" && body.ownerUserId.trim()
        ? body.ownerUserId
        : req.actor.userId ?? null;
    if (!userId) throw badRequest("ownerUserId is required");
    if (!body.name || typeof body.name !== "string") throw badRequest("name is required");

    const [row] = await db
      .insert(estates)
      .values({
        companyId,
        ownerUserId: userId,
        name: body.name,
        estateType: (typeof body.estateType === "string" ? body.estateType : "individual") as typeof estates.$inferInsert["estateType"],
        maritalStatus: typeof body.maritalStatus === "string"
          ? (body.maritalStatus as typeof estates.$inferInsert["maritalStatus"])
          : null,
        stateOfResidence: typeof body.stateOfResidence === "string" ? body.stateOfResidence : null,
        notes: typeof body.notes === "string" ? body.notes : null,
      })
      .returning();

    res.status(201).json(row);
  });

  /** Get a single estate by id */
  router.get("/estates/:estateId", async (req, res) => {
    assertBoard(req);
    const row = await db
      .select()
      .from(estates)
      .where(eq(estates.id, req.params.estateId))
      .then((r) => r[0] ?? null);
    if (!row) throw notFound("Estate not found");
    assertCompanyAccess(req, row.companyId);
    res.json(row);
  });

  /** Update an estate */
  router.patch("/estates/:estateId", async (req, res) => {
    assertBoard(req);
    const existing = await db
      .select()
      .from(estates)
      .where(eq(estates.id, req.params.estateId))
      .then((r) => r[0] ?? null);
    if (!existing) throw notFound("Estate not found");
    assertCompanyAccess(req, existing.companyId);

    const body = req.body as Record<string, unknown>;
    const [updated] = await db
      .update(estates)
      .set({
        name: typeof body.name === "string" ? body.name : existing.name,
        estateType: typeof body.estateType === "string"
          ? (body.estateType as typeof estates.$inferInsert["estateType"])
          : existing.estateType,
        maritalStatus: body.maritalStatus !== undefined
          ? (body.maritalStatus as typeof estates.$inferInsert["maritalStatus"])
          : existing.maritalStatus,
        stateOfResidence: body.stateOfResidence !== undefined
          ? (body.stateOfResidence as string | null)
          : existing.stateOfResidence,
        notes: body.notes !== undefined ? (body.notes as string | null) : existing.notes,
        updatedAt: new Date(),
      })
      .where(eq(estates.id, req.params.estateId))
      .returning();
    res.json(updated);
  });

  /** Delete an estate */
  router.delete("/estates/:estateId", async (req, res) => {
    assertBoard(req);
    const existing = await db
      .select()
      .from(estates)
      .where(eq(estates.id, req.params.estateId))
      .then((r) => r[0] ?? null);
    if (!existing) throw notFound("Estate not found");
    assertCompanyAccess(req, existing.companyId);
    await db.delete(estates).where(eq(estates.id, req.params.estateId));
    res.status(204).send();
  });

  // ---- Assets by Estate -----------------------------------------------------

  /** List assets for an estate */
  router.get("/estates/:estateId/assets", async (req, res) => {
    assertBoard(req);
    const estate = await db
      .select()
      .from(estates)
      .where(eq(estates.id, req.params.estateId))
      .then((r) => r[0] ?? null);
    if (!estate) throw notFound("Estate not found");
    assertCompanyAccess(req, estate.companyId);

    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const rows = await db
      .select()
      .from(estateAssets)
      .where(eq(estateAssets.estateId, req.params.estateId))
      .orderBy(desc(estateAssets.createdAt))
      .limit(limit);

    res.json({ assets: rows });
  });

  /** Create an asset linked to an estate */
  router.post("/estates/:estateId/assets", async (req, res) => {
    assertBoard(req);
    const estate = await db
      .select()
      .from(estates)
      .where(eq(estates.id, req.params.estateId))
      .then((r) => r[0] ?? null);
    if (!estate) throw notFound("Estate not found");
    assertCompanyAccess(req, estate.companyId);

    const body = req.body as Record<string, unknown>;
    if (!body.name || typeof body.name !== "string") throw badRequest("name is required");
    if (!body.assetType || typeof body.assetType !== "string") throw badRequest("assetType is required");

    const [row] = await db
      .insert(estateAssets)
      .values({
        companyId: estate.companyId,
        userId: estate.ownerUserId,
        estateId: estate.id,
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

  // ---- Beneficiaries --------------------------------------------------------

  /** List beneficiaries for an estate */
  router.get("/estates/:estateId/beneficiaries", async (req, res) => {
    assertBoard(req);
    const estate = await db
      .select()
      .from(estates)
      .where(eq(estates.id, req.params.estateId))
      .then((r) => r[0] ?? null);
    if (!estate) throw notFound("Estate not found");
    assertCompanyAccess(req, estate.companyId);

    const rows = await db
      .select()
      .from(estateBeneficiaries)
      .where(eq(estateBeneficiaries.estateId, req.params.estateId))
      .orderBy(asc(estateBeneficiaries.createdAt));

    res.json({ beneficiaries: rows });
  });

  /** Create a beneficiary */
  router.post("/estates/:estateId/beneficiaries", async (req, res) => {
    assertBoard(req);
    const estate = await db
      .select()
      .from(estates)
      .where(eq(estates.id, req.params.estateId))
      .then((r) => r[0] ?? null);
    if (!estate) throw notFound("Estate not found");
    assertCompanyAccess(req, estate.companyId);

    const body = req.body as Record<string, unknown>;
    if (!body.name || typeof body.name !== "string") throw badRequest("name is required");

    const [row] = await db
      .insert(estateBeneficiaries)
      .values({
        estateId: estate.id,
        companyId: estate.companyId,
        name: body.name,
        relationship: typeof body.relationship === "string" ? body.relationship : null,
        email: typeof body.email === "string" ? body.email : null,
        phone: typeof body.phone === "string" ? body.phone : null,
        allocationPercentage: body.allocationPercentage != null ? String(body.allocationPercentage) : null,
        designationType: (typeof body.designationType === "string"
          ? body.designationType
          : "primary") as typeof estateBeneficiaries.$inferInsert["designationType"],
        notes: typeof body.notes === "string" ? body.notes : null,
      })
      .returning();

    res.status(201).json(row);
  });

  /** Get a single beneficiary */
  router.get("/estate/beneficiaries/:beneficiaryId", async (req, res) => {
    assertBoard(req);
    const row = await db
      .select()
      .from(estateBeneficiaries)
      .where(eq(estateBeneficiaries.id, req.params.beneficiaryId))
      .then((r) => r[0] ?? null);
    if (!row) throw notFound("Beneficiary not found");
    assertCompanyAccess(req, row.companyId);
    res.json(row);
  });

  /** Update a beneficiary */
  router.patch("/estate/beneficiaries/:beneficiaryId", async (req, res) => {
    assertBoard(req);
    const existing = await db
      .select()
      .from(estateBeneficiaries)
      .where(eq(estateBeneficiaries.id, req.params.beneficiaryId))
      .then((r) => r[0] ?? null);
    if (!existing) throw notFound("Beneficiary not found");
    assertCompanyAccess(req, existing.companyId);

    const body = req.body as Record<string, unknown>;
    const [updated] = await db
      .update(estateBeneficiaries)
      .set({
        name: typeof body.name === "string" ? body.name : existing.name,
        relationship: body.relationship !== undefined ? (body.relationship as string | null) : existing.relationship,
        email: body.email !== undefined ? (body.email as string | null) : existing.email,
        phone: body.phone !== undefined ? (body.phone as string | null) : existing.phone,
        allocationPercentage: body.allocationPercentage != null
          ? String(body.allocationPercentage)
          : existing.allocationPercentage,
        designationType: typeof body.designationType === "string"
          ? (body.designationType as typeof estateBeneficiaries.$inferInsert["designationType"])
          : existing.designationType,
        notes: body.notes !== undefined ? (body.notes as string | null) : existing.notes,
        updatedAt: new Date(),
      })
      .where(eq(estateBeneficiaries.id, req.params.beneficiaryId))
      .returning();
    res.json(updated);
  });

  /** Delete a beneficiary */
  router.delete("/estate/beneficiaries/:beneficiaryId", async (req, res) => {
    assertBoard(req);
    const existing = await db
      .select()
      .from(estateBeneficiaries)
      .where(eq(estateBeneficiaries.id, req.params.beneficiaryId))
      .then((r) => r[0] ?? null);
    if (!existing) throw notFound("Beneficiary not found");
    assertCompanyAccess(req, existing.companyId);
    await db.delete(estateBeneficiaries).where(eq(estateBeneficiaries.id, req.params.beneficiaryId));
    res.status(204).send();
  });

  // ---- Trusts ---------------------------------------------------------------

  /** List trusts for an estate */
  router.get("/estates/:estateId/trusts", async (req, res) => {
    assertBoard(req);
    const estate = await db
      .select()
      .from(estates)
      .where(eq(estates.id, req.params.estateId))
      .then((r) => r[0] ?? null);
    if (!estate) throw notFound("Estate not found");
    assertCompanyAccess(req, estate.companyId);

    const rows = await db
      .select()
      .from(estateTrusts)
      .where(eq(estateTrusts.estateId, req.params.estateId))
      .orderBy(asc(estateTrusts.createdAt));

    res.json({ trusts: rows });
  });

  /** Create a trust */
  router.post("/estates/:estateId/trusts", async (req, res) => {
    assertBoard(req);
    const estate = await db
      .select()
      .from(estates)
      .where(eq(estates.id, req.params.estateId))
      .then((r) => r[0] ?? null);
    if (!estate) throw notFound("Estate not found");
    assertCompanyAccess(req, estate.companyId);

    const body = req.body as Record<string, unknown>;
    if (!body.trustName || typeof body.trustName !== "string") throw badRequest("trustName is required");
    if (!body.trustType || typeof body.trustType !== "string") throw badRequest("trustType is required");

    const [row] = await db
      .insert(estateTrusts)
      .values({
        estateId: estate.id,
        companyId: estate.companyId,
        trustName: body.trustName,
        trustType: body.trustType as typeof estateTrusts.$inferInsert["trustType"],
        trusteeUserId: typeof body.trusteeUserId === "string" ? body.trusteeUserId : null,
        successorTrusteeName: typeof body.successorTrusteeName === "string" ? body.successorTrusteeName : null,
        fundingStatus: (typeof body.fundingStatus === "string" ? body.fundingStatus : "unfunded") as typeof estateTrusts.$inferInsert["fundingStatus"],
        notes: typeof body.notes === "string" ? body.notes : null,
      })
      .returning();

    res.status(201).json(row);
  });

  /** Get a single trust */
  router.get("/estate/trusts/:trustId", async (req, res) => {
    assertBoard(req);
    const row = await db
      .select()
      .from(estateTrusts)
      .where(eq(estateTrusts.id, req.params.trustId))
      .then((r) => r[0] ?? null);
    if (!row) throw notFound("Trust not found");
    assertCompanyAccess(req, row.companyId);
    res.json(row);
  });

  /** Update a trust */
  router.patch("/estate/trusts/:trustId", async (req, res) => {
    assertBoard(req);
    const existing = await db
      .select()
      .from(estateTrusts)
      .where(eq(estateTrusts.id, req.params.trustId))
      .then((r) => r[0] ?? null);
    if (!existing) throw notFound("Trust not found");
    assertCompanyAccess(req, existing.companyId);

    const body = req.body as Record<string, unknown>;
    const [updated] = await db
      .update(estateTrusts)
      .set({
        trustName: typeof body.trustName === "string" ? body.trustName : existing.trustName,
        trustType: typeof body.trustType === "string"
          ? (body.trustType as typeof estateTrusts.$inferInsert["trustType"])
          : existing.trustType,
        trusteeUserId: body.trusteeUserId !== undefined ? (body.trusteeUserId as string | null) : existing.trusteeUserId,
        successorTrusteeName: body.successorTrusteeName !== undefined
          ? (body.successorTrusteeName as string | null)
          : existing.successorTrusteeName,
        fundingStatus: typeof body.fundingStatus === "string"
          ? (body.fundingStatus as typeof estateTrusts.$inferInsert["fundingStatus"])
          : existing.fundingStatus,
        notes: body.notes !== undefined ? (body.notes as string | null) : existing.notes,
        updatedAt: new Date(),
      })
      .where(eq(estateTrusts.id, req.params.trustId))
      .returning();
    res.json(updated);
  });

  /** Delete a trust */
  router.delete("/estate/trusts/:trustId", async (req, res) => {
    assertBoard(req);
    const existing = await db
      .select()
      .from(estateTrusts)
      .where(eq(estateTrusts.id, req.params.trustId))
      .then((r) => r[0] ?? null);
    if (!existing) throw notFound("Trust not found");
    assertCompanyAccess(req, existing.companyId);
    await db.delete(estateTrusts).where(eq(estateTrusts.id, req.params.trustId));
    res.status(204).send();
  });

  // ---- Trust-asset linkage --------------------------------------------------

  /** Link an asset to a trust */
  router.post("/estate/trusts/:trustId/assets", async (req, res) => {
    assertBoard(req);
    const trust = await db
      .select()
      .from(estateTrusts)
      .where(eq(estateTrusts.id, req.params.trustId))
      .then((r) => r[0] ?? null);
    if (!trust) throw notFound("Trust not found");
    assertCompanyAccess(req, trust.companyId);

    const body = req.body as Record<string, unknown>;
    if (!body.assetId || typeof body.assetId !== "string") throw badRequest("assetId is required");

    const asset = await db
      .select()
      .from(estateAssets)
      .where(eq(estateAssets.id, body.assetId))
      .then((r) => r[0] ?? null);
    if (!asset) throw notFound("Asset not found");
    assertCompanyAccess(req, asset.companyId);

    const [row] = await db
      .insert(estateTrustAssets)
      .values({
        trustId: trust.id,
        assetId: body.assetId,
        transferDate: body.transferDate ? new Date(body.transferDate as string) : null,
        transferDeedDocId: typeof body.transferDeedDocId === "string" ? body.transferDeedDocId : null,
      })
      .onConflictDoNothing()
      .returning();

    res.status(201).json(row ?? { trustId: trust.id, assetId: body.assetId });
  });

  /** Unlink an asset from a trust */
  router.delete("/estate/trusts/:trustId/assets/:assetId", async (req, res) => {
    assertBoard(req);
    const trust = await db
      .select()
      .from(estateTrusts)
      .where(eq(estateTrusts.id, req.params.trustId))
      .then((r) => r[0] ?? null);
    if (!trust) throw notFound("Trust not found");
    assertCompanyAccess(req, trust.companyId);

    await db
      .delete(estateTrustAssets)
      .where(
        and(
          eq(estateTrustAssets.trustId, req.params.trustId),
          eq(estateTrustAssets.assetId, req.params.assetId),
        ),
      );

    res.status(204).send();
  });

  /** List assets linked to a trust */
  router.get("/estate/trusts/:trustId/assets", async (req, res) => {
    assertBoard(req);
    const trust = await db
      .select()
      .from(estateTrusts)
      .where(eq(estateTrusts.id, req.params.trustId))
      .then((r) => r[0] ?? null);
    if (!trust) throw notFound("Trust not found");
    assertCompanyAccess(req, trust.companyId);

    const rows = await db
      .select({
        trustId: estateTrustAssets.trustId,
        assetId: estateTrustAssets.assetId,
        transferDate: estateTrustAssets.transferDate,
        transferDeedDocId: estateTrustAssets.transferDeedDocId,
        createdAt: estateTrustAssets.createdAt,
        assetName: estateAssets.name,
        assetType: estateAssets.assetType,
        currentValueCents: estateAssets.currentValueCents,
      })
      .from(estateTrustAssets)
      .innerJoin(estateAssets, eq(estateTrustAssets.assetId, estateAssets.id))
      .where(eq(estateTrustAssets.trustId, req.params.trustId));

    res.json({ assets: rows });
  });

  // ---- Trust distributions --------------------------------------------------

  /**
   * GET /estate/trusts/:trustId/distributions
   *
   * List all distributions recorded against a trust, newest first.
   */
  router.get("/estate/trusts/:trustId/distributions", async (req, res) => {
    assertBoard(req);
    const trust = await db
      .select()
      .from(estateTrusts)
      .where(eq(estateTrusts.id, req.params.trustId))
      .then((r) => r[0] ?? null);
    if (!trust) throw notFound("Trust not found");
    assertCompanyAccess(req, trust.companyId);

    const rows = await db
      .select()
      .from(estateTrustDistributions)
      .where(eq(estateTrustDistributions.trustId, req.params.trustId))
      .orderBy(desc(estateTrustDistributions.distributionDate));

    const totalCents = rows.reduce((sum, r) => sum + r.amountCents, 0);
    res.json({ distributions: rows, totalAmountCents: totalCents, totalAmountDollars: totalCents / 100 });
  });

  /**
   * POST /estate/trusts/:trustId/distributions
   *
   * Record a new distribution from a trust.
   * Body: { beneficiaryId?, beneficiaryName?, amountCents, distributionDate, distributionType?, description? }
   */
  router.post("/estate/trusts/:trustId/distributions", async (req, res) => {
    assertBoard(req);
    const trust = await db
      .select()
      .from(estateTrusts)
      .where(eq(estateTrusts.id, req.params.trustId))
      .then((r) => r[0] ?? null);
    if (!trust) throw notFound("Trust not found");
    assertCompanyAccess(req, trust.companyId);

    const { beneficiaryId, beneficiaryName, amountCents, distributionDate, distributionType, description } = req.body as {
      beneficiaryId?: string;
      beneficiaryName?: string;
      amountCents?: number;
      distributionDate?: string;
      distributionType?: string;
      description?: string;
    };

    if (!amountCents || typeof amountCents !== "number" || amountCents <= 0) {
      throw badRequest("amountCents must be a positive integer");
    }
    if (!distributionDate || typeof distributionDate !== "string") {
      throw badRequest("distributionDate is required (YYYY-MM-DD)");
    }
    if (!beneficiaryId && !beneficiaryName) {
      throw badRequest("Either beneficiaryId or beneficiaryName is required");
    }

    const validTypes = ["income", "principal", "discretionary", "mandatory"] as const;
    const distType = (distributionType ?? "discretionary") as typeof validTypes[number];
    if (!validTypes.includes(distType)) {
      throw badRequest(`distributionType must be one of: ${validTypes.join(", ")}`);
    }

    const [row] = await db
      .insert(estateTrustDistributions)
      .values({
        trustId: req.params.trustId,
        companyId: trust.companyId,
        beneficiaryId: beneficiaryId ?? null,
        beneficiaryName: beneficiaryName ?? null,
        amountCents: Math.round(amountCents),
        distributionDate,
        distributionType: distType,
        description: description ?? null,
      })
      .returning();

    res.status(201).json({ distribution: row });
  });

  /**
   * PATCH /estate/trust-distributions/:distributionId
   *
   * Update a distribution record (e.g. correct amount or description).
   */
  router.patch("/estate/trust-distributions/:distributionId", async (req, res) => {
    assertBoard(req);
    const dist = await db
      .select()
      .from(estateTrustDistributions)
      .where(eq(estateTrustDistributions.id, req.params.distributionId))
      .then((r) => r[0] ?? null);
    if (!dist) throw notFound("Distribution not found");
    assertCompanyAccess(req, dist.companyId);

    const { amountCents, distributionDate, distributionType, description, beneficiaryId, beneficiaryName } = req.body as {
      amountCents?: number;
      distributionDate?: string;
      distributionType?: string;
      description?: string;
      beneficiaryId?: string | null;
      beneficiaryName?: string | null;
    };

    if (amountCents !== undefined && (typeof amountCents !== "number" || amountCents <= 0)) {
      throw badRequest("amountCents must be a positive integer");
    }

    const validTypes = ["income", "principal", "discretionary", "mandatory"] as const;
    if (distributionType !== undefined && !validTypes.includes(distributionType as typeof validTypes[number])) {
      throw badRequest(`distributionType must be one of: ${validTypes.join(", ")}`);
    }

    const updates: Partial<typeof estateTrustDistributions.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (amountCents !== undefined) updates.amountCents = Math.round(amountCents);
    if (distributionDate !== undefined) updates.distributionDate = distributionDate;
    if (distributionType !== undefined) updates.distributionType = distributionType as typeof validTypes[number];
    if (description !== undefined) updates.description = description;
    if (beneficiaryId !== undefined) updates.beneficiaryId = beneficiaryId;
    if (beneficiaryName !== undefined) updates.beneficiaryName = beneficiaryName;

    const [updated] = await db
      .update(estateTrustDistributions)
      .set(updates)
      .where(eq(estateTrustDistributions.id, req.params.distributionId))
      .returning();

    res.json({ distribution: updated });
  });

  /**
   * DELETE /estate/trust-distributions/:distributionId
   *
   * Delete a distribution record.
   */
  router.delete("/estate/trust-distributions/:distributionId", async (req, res) => {
    assertBoard(req);
    const dist = await db
      .select()
      .from(estateTrustDistributions)
      .where(eq(estateTrustDistributions.id, req.params.distributionId))
      .then((r) => r[0] ?? null);
    if (!dist) throw notFound("Distribution not found");
    assertCompanyAccess(req, dist.companyId);

    await db
      .delete(estateTrustDistributions)
      .where(eq(estateTrustDistributions.id, req.params.distributionId));

    res.status(204).send();
  });

  // ---- Collaborators --------------------------------------------------------

  /** List collaborators for an estate */
  router.get("/estates/:estateId/collaborators", async (req, res) => {
    assertBoard(req);
    const estate = await db
      .select()
      .from(estates)
      .where(eq(estates.id, req.params.estateId))
      .then((r) => r[0] ?? null);
    if (!estate) throw notFound("Estate not found");
    assertCompanyAccess(req, estate.companyId);

    const rows = await db
      .select()
      .from(estateCollaborators)
      .where(eq(estateCollaborators.estateId, req.params.estateId))
      .orderBy(asc(estateCollaborators.createdAt));

    res.json({ collaborators: rows });
  });

  /** Invite a collaborator to an estate */
  router.post("/estates/:estateId/collaborators", async (req, res) => {
    assertBoard(req);
    const estate = await db
      .select()
      .from(estates)
      .where(eq(estates.id, req.params.estateId))
      .then((r) => r[0] ?? null);
    if (!estate) throw notFound("Estate not found");
    assertCompanyAccess(req, estate.companyId);

    const body = req.body as Record<string, unknown>;
    if (!body.email || typeof body.email !== "string") throw badRequest("email is required");

    const invitedByUserId = req.actor.userId ?? null;
    if (!invitedByUserId) throw badRequest("Could not resolve inviting user");

    const inviteToken = randomBytes(32).toString("hex");
    const defaultExpiry = new Date();
    defaultExpiry.setDate(defaultExpiry.getDate() + 30);

    const [row] = await db
      .insert(estateCollaborators)
      .values({
        estateId: estate.id,
        companyId: estate.companyId,
        invitedByUserId,
        email: body.email,
        accessLevel: (typeof body.accessLevel === "string" ? body.accessLevel : "read") as typeof estateCollaborators.$inferInsert["accessLevel"],
        inviteToken,
        expiresAt: body.expiresAt ? new Date(body.expiresAt as string) : defaultExpiry,
      })
      .returning();

    res.status(201).json(row);
  });

  /** Accept a collaborator invite by token */
  router.post("/estate/collaborators/:collaboratorId/accept", async (req, res) => {
    assertBoard(req);
    const existing = await db
      .select()
      .from(estateCollaborators)
      .where(eq(estateCollaborators.id, req.params.collaboratorId))
      .then((r) => r[0] ?? null);
    if (!existing) throw notFound("Collaborator invite not found");

    if (existing.acceptedAt) {
      res.json({ message: "Already accepted", collaborator: existing });
      return;
    }

    if (existing.expiresAt && existing.expiresAt < new Date()) {
      throw badRequest("Invite has expired");
    }

    const advisorUserId = req.actor.userId ?? null;
    const [updated] = await db
      .update(estateCollaborators)
      .set({
        acceptedAt: new Date(),
        advisorUserId,
        updatedAt: new Date(),
      })
      .where(eq(estateCollaborators.id, req.params.collaboratorId))
      .returning();

    res.json(updated);
  });

  /** Revoke a collaborator */
  router.delete("/estate/collaborators/:collaboratorId", async (req, res) => {
    assertBoard(req);
    const existing = await db
      .select()
      .from(estateCollaborators)
      .where(eq(estateCollaborators.id, req.params.collaboratorId))
      .then((r) => r[0] ?? null);
    if (!existing) throw notFound("Collaborator not found");
    assertCompanyAccess(req, existing.companyId);

    await db.delete(estateCollaborators).where(eq(estateCollaborators.id, req.params.collaboratorId));
    res.status(204).send();
  });

  // =========================================================================
  // Federal Estate Tax Calculator (2026 OBBBA exemptions)
  // =========================================================================

  // 2026 OBBBA exemptions: $15M individual, $30M married / domestic partnership
  const FEDERAL_EXEMPTION_INDIVIDUAL_CENTS = 1_500_000_000; // $15,000,000
  const FEDERAL_EXEMPTION_MARRIED_CENTS = 3_000_000_000;    // $30,000,000
  const FEDERAL_ESTATE_TAX_RATE = 0.4;

  function getExemptionCents(maritalStatus: string | null): number {
    return maritalStatus === "married" || maritalStatus === "domestic_partnership"
      ? FEDERAL_EXEMPTION_MARRIED_CENTS
      : FEDERAL_EXEMPTION_INDIVIDUAL_CENTS;
  }

  /** Compute federal estate tax summary for a given estate */
  router.get("/estates/:estateId/tax-summary", async (req, res) => {
    assertBoard(req);

    const estate = await db
      .select()
      .from(estates)
      .where(eq(estates.id, req.params.estateId))
      .then((r) => r[0] ?? null);
    if (!estate) throw notFound("Estate not found");
    assertCompanyAccess(req, estate.companyId);

    // Sum assets directly linked to this estate
    const [assetRow] = await db
      .select({ total: sql<string>`coalesce(sum(current_value_cents), 0)` })
      .from(estateAssets)
      .where(and(eq(estateAssets.estateId, estate.id), eq(estateAssets.companyId, estate.companyId)));

    // Sum financial accounts for the estate owner (Plaid + manual)
    const [accountRow] = await db
      .select({ total: sql<string>`coalesce(sum(balance_cents), 0)` })
      .from(estateFinancialAccounts)
      .where(
        and(
          eq(estateFinancialAccounts.companyId, estate.companyId),
          eq(estateFinancialAccounts.userId, estate.ownerUserId),
        ),
      );

    const assetsCents = Number(assetRow?.total ?? 0);
    const accountsCents = Number(accountRow?.total ?? 0);
    const grossEstateCents = assetsCents + accountsCents;

    const exemptionCents = getExemptionCents(estate.maritalStatus ?? null);
    const taxableEstateCents = Math.max(0, grossEstateCents - exemptionCents);
    const estimatedFederalTaxCents = Math.round(taxableEstateCents * FEDERAL_ESTATE_TAX_RATE);

    res.json({
      estateId: estate.id,
      estateName: estate.name,
      maritalStatus: estate.maritalStatus,
      grossEstateCents,
      grossEstateDollars: grossEstateCents / 100,
      federalExemptionCents: exemptionCents,
      federalExemptionDollars: exemptionCents / 100,
      taxableEstateCents,
      taxableEstateDollars: taxableEstateCents / 100,
      estimatedFederalTaxCents,
      estimatedFederalTaxDollars: estimatedFederalTaxCents / 100,
      taxRate: FEDERAL_ESTATE_TAX_RATE,
      exemptionYear: 2026,
      exemptionLaw: "OBBBA 2026",
      asOfDate: new Date().toISOString(),
    });
  });

  // ---- Estate Plan Status --------------------------------------------------

  /**
   * GET /estates/:estateId/plan-status
   *
   * Returns a completeness score and checklist showing which key estate
   * planning components are in place for the given estate.
   *
   * Checks (each worth 1 point toward score):
   *   hasWill, hasTrust, hasPOA, hasHealthcareDirective, hasInsurance,
   *   hasRetirementAccount, hasBeneficiaries, hasAnnualReview, hasDocumentVault
   */
  router.get("/estates/:estateId/plan-status", async (req, res) => {
    assertBoard(req);

    const estate = await db
      .select()
      .from(estates)
      .where(eq(estates.id, req.params.estateId))
      .then((r) => r[0] ?? null);
    if (!estate) throw notFound("Estate not found");
    assertCompanyAccess(req, estate.companyId);

    const currentYear = new Date().getFullYear();

    const [
      documents,
      trusts,
      beneficiaries,
      insurancePolicies,
      retirementAccounts,
      annualReviews,
    ] = await Promise.all([
      db.select({ documentType: estateDocuments.documentType })
        .from(estateDocuments)
        .where(and(eq(estateDocuments.estateId, estate.id), isNull(estateDocuments.deletedAt))),
      db.select({ id: estateTrusts.id })
        .from(estateTrusts)
        .where(eq(estateTrusts.estateId, estate.id)),
      db.select({ id: estateBeneficiaries.id })
        .from(estateBeneficiaries)
        .where(eq(estateBeneficiaries.estateId, estate.id)),
      db.select({ id: estateInsurancePolicies.id })
        .from(estateInsurancePolicies)
        .where(eq(estateInsurancePolicies.companyId, estate.companyId)),
      db.select({ id: estateRetirementAccounts.id })
        .from(estateRetirementAccounts)
        .where(eq(estateRetirementAccounts.companyId, estate.companyId)),
      db.select({ status: estateReviews.status })
        .from(estateReviews)
        .where(and(
          eq(estateReviews.companyId, estate.companyId),
          eq(estateReviews.year, currentYear),
        )),
    ]);

    const docTypes = new Set(documents.map((d) => d.documentType));

    const checks = {
      hasWill: docTypes.has("will"),
      hasTrust: trusts.length > 0,
      hasPOA: docTypes.has("poa"),
      hasHealthcareDirective: docTypes.has("healthcare_directive"),
      hasInsurance: insurancePolicies.length > 0,
      hasRetirementAccount: retirementAccounts.length > 0,
      hasBeneficiaries: beneficiaries.length > 0,
      hasAnnualReview: annualReviews.some((r) => r.status === "complete"),
      hasDocumentVault: documents.length > 0,
    };

    const checkKeys = Object.keys(checks) as (keyof typeof checks)[];
    const completedCount = checkKeys.filter((k) => checks[k]).length;
    const score = Math.round((completedCount / checkKeys.length) * 100);

    const completedItems = checkKeys.filter((k) => checks[k]);
    const missingItems = checkKeys.filter((k) => !checks[k]);

    res.json({
      estateId: estate.id,
      estateName: estate.name,
      score,
      completedCount,
      totalChecks: checkKeys.length,
      checks,
      completedItems,
      missingItems,
    });
  });

  // ---- Plaid Link integration -----------------------------------------------

  /**
   * POST /estate/integrations/plaid/link-token
   *
   * Creates a Plaid Link token for the authenticated user.
   * The client uses this token to open the Plaid Link SDK.
   * Returns 503 when Plaid is not configured via env vars.
   */
  router.post("/estate/integrations/plaid/link-token", async (req, res) => {
    assertBoard(req);
    const client = plaidClient ?? createDefaultPlaidClient();
    if (!client) {
      res.status(503).json({ error: "Plaid integration not configured" });
      return;
    }
    const { userId } = req.actor as { userId: string };
    const result = await client.createLinkToken(userId);
    res.json({ linkToken: result.linkToken, expiration: result.expiration });
  });

  /**
   * POST /estate/integrations/plaid/exchange
   *
   * Exchanges a Plaid public_token (from Link SDK) for a permanent access
   * token, fetches account balances, and creates or updates financial account
   * records for each returned account.
   *
   * Body: { publicToken: string, institutionName?: string, companyId: string }
   */
  router.post("/estate/integrations/plaid/exchange", async (req, res) => {
    assertBoard(req);
    const client = plaidClient ?? createDefaultPlaidClient();
    if (!client) {
      res.status(503).json({ error: "Plaid integration not configured" });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const publicToken = typeof body["publicToken"] === "string" ? body["publicToken"].trim() : null;
    const institutionName = typeof body["institutionName"] === "string" ? body["institutionName"].trim() : undefined;
    const companyId = typeof body["companyId"] === "string" ? body["companyId"].trim() : null;

    if (!publicToken) throw badRequest("publicToken is required");
    if (!companyId) throw badRequest("companyId is required");

    const { userId } = req.actor as { userId: string };

    const { accessToken, itemId } = await client.exchangePublicToken(publicToken);
    const plaidAccounts = await client.getAccountBalances(accessToken, institutionName);

    const created: unknown[] = [];
    for (const acct of plaidAccounts) {
      const [existing] = await db
        .select()
        .from(estateFinancialAccounts)
        .where(eq(estateFinancialAccounts.plaidAccountId, acct.accountId));

      if (existing) {
        const [updated] = await db
          .update(estateFinancialAccounts)
          .set({
            balanceCents: String(acct.balanceCents),
            balanceUpdatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(estateFinancialAccounts.id, existing.id))
          .returning();
        await db.insert(estateBalanceHistory).values({
          accountId: existing.id,
          balanceCents: String(acct.balanceCents),
        });
        created.push({ ...updated, plaidAccessToken: undefined });
      } else {
        const accountType = acct.accountType as typeof estateFinancialAccounts.$inferInsert["accountType"];
        const [inserted] = await db
          .insert(estateFinancialAccounts)
          .values({
            companyId,
            userId,
            name: acct.name,
            institutionName: acct.institutionName,
            accountType,
            plaidAccessToken: accessToken,
            plaidItemId: itemId,
            plaidAccountId: acct.accountId,
            balanceCents: String(acct.balanceCents),
            balanceUpdatedAt: new Date(),
            isManual: false,
          })
          .returning();
        if (acct.balanceCents > 0) {
          await db.insert(estateBalanceHistory).values({
            accountId: inserted.id,
            balanceCents: String(acct.balanceCents),
          });
        }
        created.push({ ...inserted, plaidAccessToken: undefined });
      }
    }

    res.status(201).json({ accounts: created });
  });

  /**
   * POST /estate/integrations/plaid/refresh
   *
   * Re-fetches current balances from Plaid for all linked accounts belonging
   * to the calling user. Groups by plaidAccessToken to minimise API calls.
   * Body: { companyId }
   */
  router.post("/estate/integrations/plaid/refresh", async (req, res) => {
    assertBoard(req);
    const client = plaidClient ?? createDefaultPlaidClient();
    if (!client) {
      res.status(503).json({ error: "Plaid integration not configured" });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const companyId = typeof body["companyId"] === "string" ? body["companyId"].trim() : null;
    if (!companyId) throw badRequest("companyId is required");

    const { userId } = req.actor as { userId: string };

    const linkedAccounts = await db
      .select()
      .from(estateFinancialAccounts)
      .where(
        and(
          eq(estateFinancialAccounts.companyId, companyId),
          eq(estateFinancialAccounts.userId, userId),
          isNotNull(estateFinancialAccounts.plaidAccessToken),
        ),
      );

    if (linkedAccounts.length === 0) {
      res.json({ accounts: [], refreshed: 0 });
      return;
    }

    // Group by access token so we call Plaid once per item, not once per account.
    const byToken = new Map<string, typeof linkedAccounts>();
    for (const acct of linkedAccounts) {
      if (!acct.plaidAccessToken) continue;
      const group = byToken.get(acct.plaidAccessToken) ?? [];
      group.push(acct);
      byToken.set(acct.plaidAccessToken, group);
    }

    const updated: unknown[] = [];

    for (const [accessToken, accounts] of byToken) {
      const institutionName = accounts[0]?.institutionName ?? undefined;
      let freshBalances: PlaidAccountBalance[];
      try {
        freshBalances = await client.getAccountBalances(accessToken, institutionName ?? undefined);
      } catch {
        continue;
      }

      const freshByAccountId = new Map(freshBalances.map((b) => [b.accountId, b]));

      for (const acct of accounts) {
        if (!acct.plaidAccountId) continue;
        const fresh = freshByAccountId.get(acct.plaidAccountId);
        if (!fresh) continue;

        const [upd] = await db
          .update(estateFinancialAccounts)
          .set({
            balanceCents: String(fresh.balanceCents),
            balanceUpdatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(estateFinancialAccounts.id, acct.id))
          .returning();

        await db.insert(estateBalanceHistory).values({
          accountId: acct.id,
          balanceCents: String(fresh.balanceCents),
        });

        updated.push({ ...upd, plaidAccessToken: undefined });
      }
    }

    res.json({ accounts: updated, refreshed: updated.length });
  });

  // ---- Document Vault -------------------------------------------------------

  /**
   * POST /estate/estates/:estateId/documents
   *
   * Creates a document metadata record and returns a presigned S3 PUT URL.
   * The client uploads the file directly to S3 using the presigned URL.
   * Returns 503 when S3 vault is not configured.
   *
   * Body: { title, documentType?, contentType?, sizeBytes?, contentHash?, accessPolicy?, companyId }
   */
  router.post("/estate/estates/:estateId/documents", async (req, res) => {
    assertBoard(req);
    const vault = s3VaultClient ?? createDefaultS3VaultClient();
    if (!vault) {
      res.status(503).json({ error: "Document vault not configured" });
      return;
    }

    const { estateId } = req.params as { estateId: string };
    const body = req.body as Record<string, unknown>;
    const companyId = typeof body["companyId"] === "string" ? body["companyId"].trim() : null;
    const title = typeof body["title"] === "string" ? body["title"].trim() : null;
    const documentType = typeof body["documentType"] === "string" ? body["documentType"].trim() : "other";
    const contentType = typeof body["contentType"] === "string" ? body["contentType"].trim() : undefined;
    const sizeBytes = typeof body["sizeBytes"] === "number" ? body["sizeBytes"] : null;
    const contentHash = typeof body["contentHash"] === "string" ? body["contentHash"].trim() : null;
    const accessPolicy = typeof body["accessPolicy"] === "string" ? body["accessPolicy"].trim() : "owner_only";

    if (!companyId) throw badRequest("companyId is required");
    if (!title) throw badRequest("title is required");

    const { userId } = req.actor as { userId: string };

    const [estate] = await db
      .select({ id: estates.id })
      .from(estates)
      .where(and(eq(estates.id, estateId), eq(estates.companyId, companyId)));
    if (!estate) throw notFound("Estate not found");

    const s3Key = `estates/${estateId}/documents/${randomBytes(16).toString("hex")}`;
    const bucket = DEFAULT_VAULT_BUCKET;

    const [doc] = await db
      .insert(estateDocuments)
      .values({
        estateId,
        companyId,
        uploaderUserId: userId,
        documentType: documentType as typeof estateDocuments.$inferInsert["documentType"],
        title,
        s3Key,
        s3Bucket: bucket,
        contentHash,
        sizeBytes,
        accessPolicy: accessPolicy as typeof estateDocuments.$inferInsert["accessPolicy"],
      })
      .returning();

    const uploadUrl = await vault.createUploadUrl({ bucket, key: s3Key, contentType, ttlSeconds: 900 });

    res.status(201).json({ document: doc, uploadUrl, uploadUrlExpiresInSeconds: 900 });
  });

  /**
   * GET /estate/estates/:estateId/documents
   *
   * Lists non-deleted documents for an estate.
   */
  router.get("/estate/estates/:estateId/documents", async (req, res) => {
    assertBoard(req);
    const { estateId } = req.params as { estateId: string };
    const companyId = (req.query["companyId"] as string | undefined)?.trim();
    if (!companyId) throw badRequest("companyId query param is required");

    const [estate] = await db
      .select({ id: estates.id })
      .from(estates)
      .where(and(eq(estates.id, estateId), eq(estates.companyId, companyId)));
    if (!estate) throw notFound("Estate not found");

    const docs = await db
      .select()
      .from(estateDocuments)
      .where(and(eq(estateDocuments.estateId, estateId), isNull(estateDocuments.deletedAt)))
      .orderBy(desc(estateDocuments.createdAt));

    res.json({ documents: docs });
  });

  /**
   * GET /estate/documents/:id/download-url
   *
   * Returns a presigned S3 GET URL (15-min TTL) and writes to access log.
   * Returns 503 when S3 vault is not configured.
   */
  router.get("/estate/documents/:id/download-url", async (req, res) => {
    assertBoard(req);
    const vault = s3VaultClient ?? createDefaultS3VaultClient();
    if (!vault) {
      res.status(503).json({ error: "Document vault not configured" });
      return;
    }

    const { id } = req.params as { id: string };
    const { userId } = req.actor as { userId: string };

    const [doc] = await db
      .select()
      .from(estateDocuments)
      .where(and(eq(estateDocuments.id, id), isNull(estateDocuments.deletedAt)));
    if (!doc) throw notFound("Document not found");

    const downloadUrl = await vault.createDownloadUrl({
      bucket: doc.s3Bucket,
      key: doc.s3Key,
      ttlSeconds: 900,
    });

    await db.insert(estateDocumentAccessLog).values({
      documentId: id,
      accessorUserId: userId,
      accessType: "download",
      ipAddress: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    });

    res.json({ downloadUrl, expiresInSeconds: 900 });
  });

  /**
   * DELETE /estate/documents/:id
   *
   * Soft-deletes a document by setting deleted_at. Does not remove from S3.
   * Hard deletion from S3 should be handled by a background cleanup job.
   */
  router.delete("/estate/documents/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params as { id: string };

    const [doc] = await db
      .select({ id: estateDocuments.id, deletedAt: estateDocuments.deletedAt })
      .from(estateDocuments)
      .where(eq(estateDocuments.id, id));
    if (!doc || doc.deletedAt) throw notFound("Document not found");

    await db
      .update(estateDocuments)
      .set({ deletedAt: new Date() })
      .where(eq(estateDocuments.id, id));

    res.status(204).send();
  });

  return router;
}
