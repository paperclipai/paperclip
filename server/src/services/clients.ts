import type { Db } from "@paperclipai/db";
import { clients, clientProjects, projects } from "@paperclipai/db";
import { eq, and, asc, sql, countDistinct } from "drizzle-orm";
import { conflict, notFound } from "../errors.js";

type ClientMetadata = Record<string, unknown> | null | undefined;
type ClientProjectMetadata = Record<string, unknown> | null | undefined;

function normalizeMetadata(value: Record<string, unknown> | null | undefined) {
  if (!value) return null;
  return Object.keys(value).length > 0 ? value : null;
}

function enrichClient<T extends { metadata: ClientMetadata }>(client: T) {
  return {
    ...client,
    metadata: normalizeMetadata(client.metadata ?? null),
  };
}

function enrichClientProject<
  T extends {
    metadata: ClientProjectMetadata;
    tags: string[] | null;
  },
>(clientProject: T) {
  return {
    ...clientProject,
    tags: clientProject.tags ?? [],
    metadata: normalizeMetadata(clientProject.metadata ?? null),
  };
}

function listProjectsSelection() {
  return {
    id: clientProjects.id,
    companyId: clientProjects.companyId,
    clientId: clientProjects.clientId,
    projectId: clientProjects.projectId,
    projectNameOverride: clientProjects.projectNameOverride,
    status: projects.status,
    description: clientProjects.description,
    startDate: clientProjects.startDate,
    endDate: clientProjects.endDate,
    tags: clientProjects.tags,
    metadata: clientProjects.metadata,
    createdAt: clientProjects.createdAt,
    updatedAt: clientProjects.updatedAt,
    projectName: projects.name,
  };
}

export function clientService(db: Db) {
  return {
    async list(companyId: string, opts?: { limit?: number; offset?: number }) {
      const where = eq(clients.companyId, companyId);
      const [countRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(clients)
        .where(where);
      const total = countRow?.count ?? 0;

      const baseQuery = db
        .select({
          id: clients.id,
          companyId: clients.companyId,
          name: clients.name,
          email: clients.email,
          phone: clients.phone,
          contactName: clients.contactName,
          notes: clients.notes,
          status: clients.status,
          metadata: clients.metadata,
          linkedProjectCount: countDistinct(clientProjects.projectId),
          activeProjectCount: sql<number>`count(distinct case when ${clientProjects.status} = 'active' then ${clientProjects.projectId} end)::int`,
          createdAt: clients.createdAt,
          updatedAt: clients.updatedAt,
        })
        .from(clients)
        .leftJoin(
          clientProjects,
          and(
            eq(clientProjects.clientId, clients.id),
            eq(clientProjects.companyId, clients.companyId),
          ),
        )
        .where(where)
        .groupBy(clients.id)
        .orderBy(asc(clients.name));

      let q = baseQuery;
      if (opts?.limit) q = q.limit(opts.limit) as typeof q;
      if (opts?.offset) q = q.offset(opts.offset) as typeof q;

      return {
        data: (await q).map((client) => enrichClient(client)),
        total,
      };
    },

    async getById(id: string, companyId?: string) {
      const where = companyId
        ? and(eq(clients.id, id), eq(clients.companyId, companyId))
        : eq(clients.id, id);
      return db
        .select({
          id: clients.id,
          companyId: clients.companyId,
          name: clients.name,
          email: clients.email,
          phone: clients.phone,
          contactName: clients.contactName,
          notes: clients.notes,
          status: clients.status,
          metadata: clients.metadata,
          linkedProjectCount: countDistinct(clientProjects.projectId),
          activeProjectCount: sql<number>`count(distinct case when ${clientProjects.status} = 'active' then ${clientProjects.projectId} end)::int`,
          createdAt: clients.createdAt,
          updatedAt: clients.updatedAt,
        })
        .from(clients)
        .leftJoin(
          clientProjects,
          and(
            eq(clientProjects.clientId, clients.id),
            eq(clientProjects.companyId, clients.companyId),
          ),
        )
        .where(where)
        .groupBy(clients.id)
        .then((rows) => {
          const client = rows[0] ?? null;
          return client ? enrichClient(client) : null;
        });
    },

    async create(companyId: string, data: {
      name: string;
      email?: string | null;
      phone?: string | null;
      contactName?: string | null;
      notes?: string | null;
      status?: string;
      metadata?: Record<string, unknown> | null;
    }) {
      return db
        .insert(clients)
        .values({
          ...data,
          metadata: normalizeMetadata(data.metadata ?? null),
          companyId,
        })
        .returning()
        .then((rows) => enrichClient(rows[0]));
    },

    async update(id: string, companyId: string, data: Record<string, unknown>) {
      return db
        .update(clients)
        .set({
          ...data,
          metadata:
            "metadata" in data
              ? normalizeMetadata((data.metadata as Record<string, unknown> | null | undefined) ?? null)
              : undefined,
          updatedAt: new Date(),
        })
        .where(and(eq(clients.id, id), eq(clients.companyId, companyId)))
        .returning()
        .then((rows) => {
          const client = rows[0] ?? null;
          return client ? enrichClient(client) : null;
        });
    },

    async remove(id: string, companyId: string) {
      await db.delete(clientProjects).where(and(eq(clientProjects.clientId, id), eq(clientProjects.companyId, companyId)));
      return db
        .delete(clients)
        .where(and(eq(clients.id, id), eq(clients.companyId, companyId)))
        .returning()
        .then((rows) => {
          const client = rows[0] ?? null;
          return client ? enrichClient(client) : null;
        });
    },

    async listProjects(clientId: string, companyId?: string) {
      const where = companyId
        ? and(eq(clientProjects.clientId, clientId), eq(clientProjects.companyId, companyId))
        : eq(clientProjects.clientId, clientId);
      return db
        .select(listProjectsSelection())
        .from(clientProjects)
        .leftJoin(projects, eq(clientProjects.projectId, projects.id))
        .where(where)
        .orderBy(asc(clientProjects.createdAt))
        .then((rows) => rows.map((row) => enrichClientProject(row)));
    },

    async getProjectById(id: string, companyId?: string) {
      const where = companyId
        ? and(eq(clientProjects.id, id), eq(clientProjects.companyId, companyId))
        : eq(clientProjects.id, id);
      return db
        .select(listProjectsSelection())
        .from(clientProjects)
        .leftJoin(projects, eq(clientProjects.projectId, projects.id))
        .where(where)
        .then((rows) => {
          const clientProject = rows[0] ?? null;
          return clientProject ? enrichClientProject(clientProject) : null;
        });
    },

    async createProject(companyId: string, data: {
      clientId: string;
      projectId: string;
      projectNameOverride?: string | null;
      status?: string;
      description?: string | null;
      startDate?: string | null;
      endDate?: string | null;
      tags?: string[];
      metadata?: Record<string, unknown> | null;
    }) {
      const [client, project, existingLink] = await Promise.all([
        db
          .select({ id: clients.id })
          .from(clients)
          .where(and(eq(clients.id, data.clientId), eq(clients.companyId, companyId)))
          .then((rows) => rows[0] ?? null),
        db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, data.projectId), eq(projects.companyId, companyId)))
          .then((rows) => rows[0] ?? null),
        db
          .select({ id: clientProjects.id })
          .from(clientProjects)
          .where(
            and(
              eq(clientProjects.companyId, companyId),
              eq(clientProjects.clientId, data.clientId),
              eq(clientProjects.projectId, data.projectId),
            ),
          )
          .then((rows) => rows[0] ?? null),
      ]);

      if (!client) throw notFound("Client not found");
      if (!project) throw notFound("Project not found");
      if (existingLink) throw conflict("Client is already linked to this project");

      const created = await db
        .insert(clientProjects)
        .values({
          ...data,
          companyId,
          tags: data.tags ?? [],
          metadata: normalizeMetadata(data.metadata ?? null),
        })
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!created) return null;
      return await db
        .select(listProjectsSelection())
        .from(clientProjects)
        .leftJoin(projects, eq(clientProjects.projectId, projects.id))
        .where(and(eq(clientProjects.id, created.id), eq(clientProjects.companyId, companyId)))
        .then((rows) => {
          const clientProject = rows[0] ?? null;
          return clientProject ? enrichClientProject(clientProject) : null;
        });
    },

    async updateProject(id: string, companyId: string, data: Record<string, unknown>) {
      if ("clientId" in data || "projectId" in data) {
        throw conflict("Client project links cannot change clientId or projectId after creation");
      }

      const updated = await db
        .update(clientProjects)
        .set({
          ...data,
          metadata:
            "metadata" in data
              ? normalizeMetadata((data.metadata as Record<string, unknown> | null | undefined) ?? null)
              : undefined,
          updatedAt: new Date(),
        })
        .where(and(eq(clientProjects.id, id), eq(clientProjects.companyId, companyId)))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) return null;
      return await db
        .select(listProjectsSelection())
        .from(clientProjects)
        .leftJoin(projects, eq(clientProjects.projectId, projects.id))
        .where(and(eq(clientProjects.id, updated.id), eq(clientProjects.companyId, companyId)))
        .then((rows) => {
          const clientProject = rows[0] ?? null;
          return clientProject ? enrichClientProject(clientProject) : null;
        });
    },

    async removeProject(id: string, companyId: string) {
      return db
        .delete(clientProjects)
        .where(and(eq(clientProjects.id, id), eq(clientProjects.companyId, companyId)))
        .returning()
        .then((rows) => {
          const clientProject = rows[0] ?? null;
          return clientProject ? enrichClientProject(clientProject) : null;
        });
    },
  };
}
