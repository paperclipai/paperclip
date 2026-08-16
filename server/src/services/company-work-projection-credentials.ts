import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { activityLog, companyWorkProjectionCredentials, type Db } from "@paperclipai/db";
import {
  COMPANY_WORK_PROJECTION_CREDENTIAL_TOKEN_VERSION,
  companyWorkProjectionCredentialSchema,
  createdCompanyWorkProjectionCredentialSchema,
  type CompanyWorkProjectionCredential,
  type CreatedCompanyWorkProjectionCredential,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";

const CREDENTIAL_TOKEN_FAMILY_PREFIX = "pcwp_";
const CREDENTIAL_TOKEN_V1_PATTERN = /^pcwp_v1_[a-f0-9]{48}$/;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function lockCurrentCredentialManager(
  tx: DbTransaction,
  companyId: string,
  actorId: string,
): Promise<void> {
  const memberships = Array.from(await tx.execute(sql<{ id: string }>`
    SELECT id
    FROM public.company_memberships
    WHERE company_id = ${companyId}::uuid
      AND principal_type = 'user'
      AND principal_id = ${actorId}
      AND status = 'active'
      AND membership_role IN ('owner', 'admin')
    FOR UPDATE
  `));
  if (!memberships[0]) {
    throw forbidden("Work projection credential management requires current company administration");
  }

  const grants = Array.from(await tx.execute(sql<{ id: string }>`
    SELECT id
    FROM public.principal_permission_grants
    WHERE company_id = ${companyId}::uuid
      AND principal_type = 'user'
      AND principal_id = ${actorId}
      AND permission_key = 'work_projection_credentials:manage'
    FOR UPDATE
  `));
  if (!grants[0]) {
    throw forbidden("Work projection credential management requires current company administration");
  }
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function serializeCredential(
  row: typeof companyWorkProjectionCredentials.$inferSelect,
): CompanyWorkProjectionCredential | null {
  const parsed = companyWorkProjectionCredentialSchema.safeParse({
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    tokenVersion: row.tokenVersion,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Reserve the whole pcwp_ token family. Malformed or future-version tokens
 * must never fall through to board or agent-key authentication.
 */
export function isCompanyWorkProjectionCredentialToken(token: string): boolean {
  return token.startsWith(CREDENTIAL_TOKEN_FAMILY_PREFIX);
}

export async function authenticateCompanyWorkProjectionCredential(
  db: Db,
  token: string,
): Promise<{ credentialId: string; companyId: string } | null> {
  if (!CREDENTIAL_TOKEN_V1_PATTERN.test(token)) return null;
  const row = await db
    .select()
    .from(companyWorkProjectionCredentials)
    .where(and(
      eq(companyWorkProjectionCredentials.keyHash, hashToken(token)),
      isNull(companyWorkProjectionCredentials.revokedAt),
    ))
    .then((rows) => rows[0] ?? null);
  if (!row) return null;
  const credential = serializeCredential(row);
  if (!credential) return null;
  return { credentialId: credential.id, companyId: credential.companyId };
}

export function companyWorkProjectionCredentialService(db: Db) {
  return {
    create: async (
      companyId: string,
      name: string,
      actorId: string,
    ): Promise<CreatedCompanyWorkProjectionCredential> => {
      const token = `pcwp_v1_${randomBytes(24).toString("hex")}`;
      const credentialId = randomUUID();
      const normalizedName = name.trim();
      const row = await db.transaction(async (tx) => {
        await lockCurrentCredentialManager(tx, companyId, actorId);
        const audit = await tx.insert(activityLog).values({
          companyId,
          actorType: "user",
          actorId,
          action: "company_work_projection.credential_created",
          entityType: "company_work_projection_credential",
          entityId: credentialId,
          details: {
            name: normalizedName,
            tokenVersion: COMPANY_WORK_PROJECTION_CREDENTIAL_TOKEN_VERSION,
          },
        }).returning({ id: activityLog.id }).then((rows) => rows[0]);
        return tx
          .insert(companyWorkProjectionCredentials)
          .values({
            id: credentialId,
            companyId,
            name: normalizedName,
            keyHash: hashToken(token),
            tokenVersion: COMPANY_WORK_PROJECTION_CREDENTIAL_TOKEN_VERSION,
            creationActivityId: audit.id,
          })
          .returning()
          .then((rows) => rows[0]);
      });
      const serialized = serializeCredential(row);
      if (!serialized) {
        throw new Error("Created work projection credential did not satisfy its runtime schema");
      }
      return createdCompanyWorkProjectionCredentialSchema.parse({
        ...serialized,
        token,
      });
    },

    list: async (companyId: string, actorId: string): Promise<CompanyWorkProjectionCredential[]> => {
      const rows = await db.transaction(async (tx) => {
        await lockCurrentCredentialManager(tx, companyId, actorId);
        return tx
          .select()
          .from(companyWorkProjectionCredentials)
          .where(eq(companyWorkProjectionCredentials.companyId, companyId))
          .orderBy(desc(companyWorkProjectionCredentials.createdAt));
      });
      return rows.map(serializeCredential).filter((value): value is CompanyWorkProjectionCredential => value !== null);
    },

    revoke: async (
      companyId: string,
      credentialId: string,
      actorId: string,
    ): Promise<CompanyWorkProjectionCredential | null> => {
      const row = await db.transaction(async (tx) => {
        await lockCurrentCredentialManager(tx, companyId, actorId);
        await tx.execute(sql`
          SELECT id
          FROM public.company_work_projection_credentials
          WHERE company_id = ${companyId}::uuid
            AND id = ${credentialId}::uuid
          FOR UPDATE
        `);
        const existing = await tx.select().from(companyWorkProjectionCredentials)
          .where(and(
            eq(companyWorkProjectionCredentials.id, credentialId),
            eq(companyWorkProjectionCredentials.companyId, companyId),
          ))
          .then((rows) => rows[0] ?? null);
        if (!existing || existing.revokedAt) return existing;

        const audit = await tx.insert(activityLog).values({
          companyId,
          actorType: "user",
          actorId,
          action: "company_work_projection.credential_revoked",
          entityType: "company_work_projection_credential",
          entityId: credentialId,
        }).returning({ id: activityLog.id }).then((rows) => rows[0]);
        return tx.update(companyWorkProjectionCredentials)
          .set({ revokedAt: new Date(), revocationActivityId: audit.id })
          .where(and(
            eq(companyWorkProjectionCredentials.id, credentialId),
            eq(companyWorkProjectionCredentials.companyId, companyId),
            isNull(companyWorkProjectionCredentials.revokedAt),
          ))
          .returning()
          .then((rows) => rows[0] ?? existing);
      });
      return row ? serializeCredential(row) : null;
    },
  };
}
