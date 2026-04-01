import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentTemplates, agents } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";

export function agentTemplateService(db: Db) {
  return {
    async list(organizationId: string) {
      return db
        .select()
        .from(agentTemplates)
        .where(eq(agentTemplates.organizationId, organizationId))
        .orderBy(agentTemplates.name);
    },

    async getById(id: string) {
      const [row] = await db
        .select()
        .from(agentTemplates)
        .where(eq(agentTemplates.id, id))
        .limit(1);
      return row ?? null;
    },

    async create(
      organizationId: string,
      data: {
        name: string;
        role?: string;
        title?: string | null;
        icon?: string | null;
        adapterType?: string;
        adapterConfig?: Record<string, unknown>;
        systemPrompt?: string | null;
        skills?: unknown[];
        approvalPolicy?: Record<string, unknown>;
      },
    ) {
      const [created] = await db
        .insert(agentTemplates)
        .values({
          organizationId,
          name: data.name,
          role: data.role ?? "general",
          title: data.title ?? null,
          icon: data.icon ?? null,
          adapterType: data.adapterType ?? "claude_local",
          adapterConfig: data.adapterConfig ?? {},
          systemPrompt: data.systemPrompt ?? null,
          skills: data.skills ?? [],
          approvalPolicy: data.approvalPolicy ?? {},
        })
        .returning();
      return created;
    },

    async update(
      id: string,
      data: Partial<{
        name: string;
        role: string;
        title: string | null;
        icon: string | null;
        adapterType: string;
        adapterConfig: Record<string, unknown>;
        systemPrompt: string | null;
        skills: unknown[];
        approvalPolicy: Record<string, unknown>;
      }>,
    ) {
      const existing = await this.getById(id);
      if (!existing) return null;

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (data.name !== undefined) updates.name = data.name;
      if (data.role !== undefined) updates.role = data.role;
      if (data.title !== undefined) updates.title = data.title;
      if (data.icon !== undefined) updates.icon = data.icon;
      if (data.adapterType !== undefined) updates.adapterType = data.adapterType;
      if (data.adapterConfig !== undefined) updates.adapterConfig = data.adapterConfig;
      if (data.systemPrompt !== undefined) updates.systemPrompt = data.systemPrompt;
      if (data.skills !== undefined) updates.skills = data.skills;
      if (data.approvalPolicy !== undefined) updates.approvalPolicy = data.approvalPolicy;

      const [updated] = await db
        .update(agentTemplates)
        .set(updates)
        .where(eq(agentTemplates.id, id))
        .returning();
      return updated ?? null;
    },

    async remove(id: string) {
      const existing = await this.getById(id);
      if (!existing) return null;

      // Fail if any agent instances reference this template
      const [instance] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.templateId, id))
        .limit(1);

      if (instance) {
        throw conflict(
          "Cannot delete template: one or more agent instances still reference it. Remove or unlink those agents first.",
        );
      }

      const [deleted] = await db
        .delete(agentTemplates)
        .where(eq(agentTemplates.id, id))
        .returning();
      return deleted ?? null;
    },

    async instantiate(
      templateId: string,
      companyId: string,
      overrides?: { name?: string; credentialId?: string | null },
    ) {
      const template = await this.getById(templateId);
      if (!template) throw notFound("Agent template not found");

      const [created] = await db
        .insert(agents)
        .values({
          companyId,
          templateId,
          name: overrides?.name ?? template.name,
          role: template.role,
          title: template.title,
          icon: template.icon,
          adapterType: template.adapterType,
          adapterConfig: template.adapterConfig,
          credentialId: overrides?.credentialId ?? null,
          status: "idle",
        })
        .returning();
      return created;
    },

    async listInstances(templateId: string) {
      return db
        .select()
        .from(agents)
        .where(eq(agents.templateId, templateId));
    },
  };
}
