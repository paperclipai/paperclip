import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { resources } from "@paperclipai/db";
import type { CreateResource, Resource, UpdateResource } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { secretService } from "./secrets.js";

function toResource(row: typeof resources.$inferSelect): Resource {
  return {
    id: row.id,
    companyId: row.companyId,
    key: row.key,
    type: row.type as Resource["type"],
    repository: row.repository,
    sourcePath: row.sourcePath ?? null,
    defaultRef: row.defaultRef,
    mountPath: row.mountPath,
    credentialRef: row.credentialRef ?? null,
    labels: row.labels && typeof row.labels === "object" && !Array.isArray(row.labels)
      ? row.labels as Record<string, string>
      : {},
    status: row.status as Resource["status"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isUniqueViolation(error: unknown, constraint: string) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; constraint?: string; constraint_name?: string };
  return candidate.code === "23505" && (candidate.constraint ?? candidate.constraint_name) === constraint;
}

export function resourceService(db: Db) {
  const secrets = secretService(db);

  async function assertCredential(companyId: string, credentialRef: string | null | undefined) {
    if (!credentialRef) return;
    const secret = await secrets.getById(credentialRef);
    if (!secret) throw notFound("Resource credential not found");
    if (secret.companyId !== companyId) throw unprocessable("Resource credential must belong to same company");
  }

  return {
    list: async (companyId: string, includeArchived = false) => {
      const rows = await db
        .select()
        .from(resources)
        .where(includeArchived ? eq(resources.companyId, companyId) : and(eq(resources.companyId, companyId), eq(resources.status, "active")))
        .orderBy(desc(resources.updatedAt));
      return rows.map(toResource);
    },

    getById: async (id: string) => {
      const row = await db.select().from(resources).where(eq(resources.id, id)).then((rows) => rows[0] ?? null);
      return row ? toResource(row) : null;
    },

    getByKey: async (companyId: string, key: string) => {
      const row = await db.select().from(resources).where(and(eq(resources.companyId, companyId), eq(resources.key, key))).then((rows) => rows[0] ?? null);
      return row ? toResource(row) : null;
    },

    create: async (companyId: string, input: CreateResource) => {
      await assertCredential(companyId, input.credentialRef ?? null);
      try {
        const row = await db.insert(resources).values({
          companyId,
          key: input.key,
          type: input.type,
          repository: input.repository,
          sourcePath: input.sourcePath ?? null,
          defaultRef: input.defaultRef,
          mountPath: input.mountPath,
          credentialRef: input.credentialRef ?? null,
          labels: input.labels,
          status: "active",
        }).returning().then((rows) => rows[0] ?? null);
        if (!row) throw unprocessable("Failed to create resource");
        return toResource(row);
      } catch (error) {
        if (isUniqueViolation(error, "resources_company_key_uq")) throw conflict("Resource key already exists in this company");
        if (isUniqueViolation(error, "resources_company_mount_path_uq")) throw conflict("Resource mount path already exists in this company");
        throw error;
      }
    },

    update: async (id: string, patch: UpdateResource) => {
      const existing = await db.select().from(resources).where(eq(resources.id, id)).then((rows) => rows[0] ?? null);
      if (!existing) return null;
      await assertCredential(existing.companyId, patch.credentialRef !== undefined ? patch.credentialRef : existing.credentialRef);
      try {
        const row = await db.update(resources).set({
          ...(patch.key !== undefined ? { key: patch.key } : {}),
          ...(patch.type !== undefined ? { type: patch.type } : {}),
          ...(patch.repository !== undefined ? { repository: patch.repository } : {}),
          ...(patch.sourcePath !== undefined ? { sourcePath: patch.sourcePath } : {}),
          ...(patch.defaultRef !== undefined ? { defaultRef: patch.defaultRef } : {}),
          ...(patch.mountPath !== undefined ? { mountPath: patch.mountPath } : {}),
          ...(patch.credentialRef !== undefined ? { credentialRef: patch.credentialRef } : {}),
          ...(patch.labels !== undefined ? { labels: patch.labels } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          updatedAt: new Date(),
        }).where(eq(resources.id, id)).returning().then((rows) => rows[0] ?? null);
        return row ? toResource(row) : null;
      } catch (error) {
        if (isUniqueViolation(error, "resources_company_key_uq")) throw conflict("Resource key already exists in this company");
        if (isUniqueViolation(error, "resources_company_mount_path_uq")) throw conflict("Resource mount path already exists in this company");
        throw error;
      }
    },

    archive: async (id: string) => {
      const row = await db.update(resources).set({ status: "archived", updatedAt: new Date() }).where(eq(resources.id, id)).returning().then((rows) => rows[0] ?? null);
      return row ? toResource(row) : null;
    },
  };
}
