import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { agents, companies, crossCompanyAgentGrants } from "@paperclipai/db";
import type {
  CrossCompanyAgentGrantCapability,
  CrossCompanyAgentGrantListResponse,
  CrossCompanyAgentGrantRecord,
  CrossCompanyAgentGrantStatus,
  CreateCrossCompanyAgentGrant,
  ListCrossCompanyAgentGrantsQuery,
} from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";

export const CROSS_COMPANY_AGENT_SOURCE_COMPANY_IDS_ENV_VAR =
  "PAPERCLIP_CROSS_COMPANY_AGENT_SOURCE_COMPANY_IDS";

export const TWX_CROSS_COMPANY_SOURCE_COMPANY_ID = "2db649fb-c269-41bc-a8da-0747c21ba2eb";

export function listAllowedCrossCompanyAgentSourceCompanyIds() {
  return (process.env[CROSS_COMPANY_AGENT_SOURCE_COMPANY_IDS_ENV_VAR] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function isAllowedCrossCompanyAgentSourceCompany(companyId: string) {
  return listAllowedCrossCompanyAgentSourceCompanyIds().includes(companyId);
}

type CrossCompanyAgentGrantRow = typeof crossCompanyAgentGrants.$inferSelect;

function mapGrantRecord(
  row: CrossCompanyAgentGrantRow & {
    sourceCompanyName: string | null;
    principalAgentName: string | null;
    targetCompanyName: string | null;
  },
): CrossCompanyAgentGrantRecord {
  return {
    id: row.id,
    sourceCompanyId: row.sourceCompanyId,
    sourceCompanyName: row.sourceCompanyName,
    principalType: "agent",
    principalId: row.principalId,
    principalAgentName: row.principalAgentName,
    targetCompanyId: row.targetCompanyId,
    targetCompanyName: row.targetCompanyName,
    capability: row.capability as CrossCompanyAgentGrantCapability,
    status: row.status as CrossCompanyAgentGrantStatus,
    createdByUserId: row.createdByUserId,
    revokedByUserId: row.revokedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revokedAt: row.revokedAt,
  };
}

export function crossCompanyAgentGrantService(db: Db) {
  const sourceCompanies = alias(companies, "cross_company_grant_source_company");
  const targetCompanies = alias(companies, "cross_company_grant_target_company");
  const principalAgents = alias(agents, "cross_company_grant_principal_agent");

  async function assertGrantTargets(input: CreateCrossCompanyAgentGrant) {
    if (!isAllowedCrossCompanyAgentSourceCompany(input.sourceCompanyId)) {
      throw badRequest("Only configured source companies can hold cross-company agent grants");
    }

    const [sourceCompany, targetCompany, principalAgent] = await Promise.all([
      db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, input.sourceCompanyId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, input.targetCompanyId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: agents.id, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, input.principalId))
        .then((rows) => rows[0] ?? null),
    ]);

    if (!sourceCompany) throw notFound("Source company not found");
    if (!targetCompany) throw notFound("Target company not found");
    if (!principalAgent || principalAgent.companyId !== input.sourceCompanyId) {
      throw badRequest("Principal agent must belong to the source company");
    }
  }

  async function getById(grantId: string) {
    return db
      .select({
        id: crossCompanyAgentGrants.id,
        sourceCompanyId: crossCompanyAgentGrants.sourceCompanyId,
        principalType: crossCompanyAgentGrants.principalType,
        principalId: crossCompanyAgentGrants.principalId,
        targetCompanyId: crossCompanyAgentGrants.targetCompanyId,
        capability: crossCompanyAgentGrants.capability,
        status: crossCompanyAgentGrants.status,
        createdByUserId: crossCompanyAgentGrants.createdByUserId,
        revokedByUserId: crossCompanyAgentGrants.revokedByUserId,
        createdAt: crossCompanyAgentGrants.createdAt,
        updatedAt: crossCompanyAgentGrants.updatedAt,
        revokedAt: crossCompanyAgentGrants.revokedAt,
        sourceCompanyName: sourceCompanies.name,
        principalAgentName: principalAgents.name,
        targetCompanyName: targetCompanies.name,
      })
      .from(crossCompanyAgentGrants)
      .leftJoin(sourceCompanies, eq(sourceCompanies.id, crossCompanyAgentGrants.sourceCompanyId))
      .leftJoin(targetCompanies, eq(targetCompanies.id, crossCompanyAgentGrants.targetCompanyId))
      .leftJoin(principalAgents, eq(principalAgents.id, crossCompanyAgentGrants.principalId))
      .where(eq(crossCompanyAgentGrants.id, grantId))
      .then((rows) => {
        const row = rows[0];
        return row ? mapGrantRecord(row) : null;
      });
  }

  async function list(query: ListCrossCompanyAgentGrantsQuery): Promise<CrossCompanyAgentGrantListResponse> {
    const conditions = [];
    if (query.sourceCompanyId) conditions.push(eq(crossCompanyAgentGrants.sourceCompanyId, query.sourceCompanyId));
    if (query.targetCompanyId) conditions.push(eq(crossCompanyAgentGrants.targetCompanyId, query.targetCompanyId));
    if (query.principalId) conditions.push(eq(crossCompanyAgentGrants.principalId, query.principalId));
    if (query.capability) conditions.push(eq(crossCompanyAgentGrants.capability, query.capability));
    if (query.status) conditions.push(eq(crossCompanyAgentGrants.status, query.status));

    const rows = await db
      .select({
        id: crossCompanyAgentGrants.id,
        sourceCompanyId: crossCompanyAgentGrants.sourceCompanyId,
        principalType: crossCompanyAgentGrants.principalType,
        principalId: crossCompanyAgentGrants.principalId,
        targetCompanyId: crossCompanyAgentGrants.targetCompanyId,
        capability: crossCompanyAgentGrants.capability,
        status: crossCompanyAgentGrants.status,
        createdByUserId: crossCompanyAgentGrants.createdByUserId,
        revokedByUserId: crossCompanyAgentGrants.revokedByUserId,
        createdAt: crossCompanyAgentGrants.createdAt,
        updatedAt: crossCompanyAgentGrants.updatedAt,
        revokedAt: crossCompanyAgentGrants.revokedAt,
        sourceCompanyName: sourceCompanies.name,
        principalAgentName: principalAgents.name,
        targetCompanyName: targetCompanies.name,
      })
      .from(crossCompanyAgentGrants)
      .leftJoin(sourceCompanies, eq(sourceCompanies.id, crossCompanyAgentGrants.sourceCompanyId))
      .leftJoin(targetCompanies, eq(targetCompanies.id, crossCompanyAgentGrants.targetCompanyId))
      .leftJoin(principalAgents, eq(principalAgents.id, crossCompanyAgentGrants.principalId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(crossCompanyAgentGrants.createdAt))
      .limit(query.limit + 1)
      .offset(query.offset);

    const hasMore = rows.length > query.limit;
    return {
      grants: rows.slice(0, query.limit).map(mapGrantRecord),
      nextOffset: hasMore ? query.offset + query.limit : null,
    };
  }

  async function upsert(input: CreateCrossCompanyAgentGrant & { createdByUserId: string | null }) {
    await assertGrantTargets(input);

    const now = new Date();
    const existing = await db
      .select({ id: crossCompanyAgentGrants.id })
      .from(crossCompanyAgentGrants)
      .where(
        and(
          eq(crossCompanyAgentGrants.sourceCompanyId, input.sourceCompanyId),
          eq(crossCompanyAgentGrants.principalType, "agent"),
          eq(crossCompanyAgentGrants.principalId, input.principalId),
          eq(crossCompanyAgentGrants.targetCompanyId, input.targetCompanyId),
          eq(crossCompanyAgentGrants.capability, input.capability),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing) {
      await db
        .update(crossCompanyAgentGrants)
        .set({
          status: "active",
          createdByUserId: input.createdByUserId,
          revokedByUserId: null,
          revokedAt: null,
          updatedAt: now,
        })
        .where(eq(crossCompanyAgentGrants.id, existing.id));
      return (await getById(existing.id))!;
    }

    const created = await db
      .insert(crossCompanyAgentGrants)
      .values({
        sourceCompanyId: input.sourceCompanyId,
        principalType: "agent",
        principalId: input.principalId,
        targetCompanyId: input.targetCompanyId,
        capability: input.capability,
        status: "active",
        createdByUserId: input.createdByUserId,
        revokedByUserId: null,
        createdAt: now,
        updatedAt: now,
        revokedAt: null,
      })
      .returning({ id: crossCompanyAgentGrants.id })
      .then((rows) => rows[0]!);

    return (await getById(created.id))!;
  }

  async function revoke(grantId: string, revokedByUserId: string | null) {
    const existing = await getById(grantId);
    if (!existing) return null;

    if (existing.status === "revoked") return existing;

    const now = new Date();
    await db
      .update(crossCompanyAgentGrants)
      .set({
        status: "revoked",
        revokedByUserId,
        revokedAt: now,
        updatedAt: now,
      })
      .where(eq(crossCompanyAgentGrants.id, grantId));

    return (await getById(grantId))!;
  }

  return {
    getById,
    list,
    revoke,
    upsert,
  };
}
