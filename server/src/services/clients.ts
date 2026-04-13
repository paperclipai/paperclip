import type { Db } from "@paperclipai/db";
import { clients, clientProjects, projects } from "@paperclipai/db";
import { eq, and, asc, sql } from "drizzle-orm";

export function clientService(db: Db) {
  return {
    async list(companyId: string, opts?: { limit?: number; offset?: number }) {
      const where = eq(clients.companyId, companyId);
      const [countRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(clients)
        .where(where);
      const total = countRow?.count ?? 0;

      let q = db.select().from(clients).where(where).orderBy(asc(clients.name));
      if (opts?.limit) q = q.limit(opts.limit) as typeof q;
      if (opts?.offset) q = q.offset(opts.offset) as typeof q;

      return { data: await q, total };
    },

    async getById(id: string) {
      return db
        .select()
        .from(clients)
        .where(eq(clients.id, id))
        .then((rows) => rows[0] ?? null);
    },

    async create(companyId: string, data: {
      name: string;
      email?: string | null;
      cnpj?: string | null;
      phone?: string | null;
      contactName?: string | null;
      notes?: string | null;
      status?: string;
    }) {
      return db
        .insert(clients)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]);
    },

    async update(id: string, data: Record<string, unknown>) {
      return db
        .update(clients)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(clients.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    async remove(id: string) {
      await db.delete(clientProjects).where(eq(clientProjects.clientId, id));
      return db
        .delete(clients)
        .where(eq(clients.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    async listProjects(clientId: string) {
      return db
        .select({
          id: clientProjects.id,
          companyId: clientProjects.companyId,
          clientId: clientProjects.clientId,
          projectId: clientProjects.projectId,
          projectNameOverride: clientProjects.projectNameOverride,
          projectType: clientProjects.projectType,
          status: clientProjects.status,
          description: clientProjects.description,
          billingType: clientProjects.billingType,
          amountCents: clientProjects.amountCents,
          lastPaymentAt: clientProjects.lastPaymentAt,
          startDate: clientProjects.startDate,
          endDate: clientProjects.endDate,
          tags: clientProjects.tags,
          createdAt: clientProjects.createdAt,
          updatedAt: clientProjects.updatedAt,
          projectName: projects.name,
        })
        .from(clientProjects)
        .leftJoin(projects, eq(clientProjects.projectId, projects.id))
        .where(eq(clientProjects.clientId, clientId))
        .orderBy(asc(clientProjects.createdAt));
    },

    async getProjectById(id: string) {
      return db
        .select({
          id: clientProjects.id,
          companyId: clientProjects.companyId,
          clientId: clientProjects.clientId,
          projectId: clientProjects.projectId,
          projectNameOverride: clientProjects.projectNameOverride,
          projectType: clientProjects.projectType,
          status: clientProjects.status,
          description: clientProjects.description,
          billingType: clientProjects.billingType,
          amountCents: clientProjects.amountCents,
          lastPaymentAt: clientProjects.lastPaymentAt,
          startDate: clientProjects.startDate,
          endDate: clientProjects.endDate,
          tags: clientProjects.tags,
          createdAt: clientProjects.createdAt,
          updatedAt: clientProjects.updatedAt,
          projectName: projects.name,
        })
        .from(clientProjects)
        .leftJoin(projects, eq(clientProjects.projectId, projects.id))
        .where(eq(clientProjects.id, id))
        .then((rows) => rows[0] ?? null);
    },

    async createProject(companyId: string, data: {
      clientId: string;
      projectId: string;
      projectNameOverride?: string | null;
      projectType?: string | null;
      status?: string;
      description?: string | null;
      billingType?: string | null;
      amountCents?: number | null;
      lastPaymentAt?: string | null;
      startDate?: string | null;
      endDate?: string | null;
      tags?: string[];
    }) {
      const { lastPaymentAt, ...rest } = data;
      return db
        .insert(clientProjects)
        .values({
          ...rest,
          companyId,
          lastPaymentAt: lastPaymentAt ? new Date(lastPaymentAt) : null,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    async updateProject(id: string, data: Record<string, unknown>) {
      return db
        .update(clientProjects)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(clientProjects.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    async removeProject(id: string) {
      return db
        .delete(clientProjects)
        .where(eq(clientProjects.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },
  };
}
