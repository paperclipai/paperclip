import { and, eq, isNull, asc, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { globalPrompts, agentPromptOverrides } from "@paperclipai/db";
import { notFound } from "../errors.js";

interface Actor {
  agentId?: string | null;
  userId?: string | null;
}

interface UpsertPromptData {
  title?: string | null;
  body: string;
  enabled?: boolean;
  sortOrder?: number;
}

export interface ResolvedPrompt {
  key: string;
  title: string | null;
  body: string;
  source: "company" | "project";
  sourceId: string;
  overriddenByProject: boolean;
}

export interface DisabledPrompt {
  key: string;
  source: "company" | "project";
  reason: "agent_override";
}

const STANDARD_PROMPTS = [
  {
    key: "culture",
    title: "Culture",
    body: "Define your company's agent interaction norms, values, and behavioral expectations here.",
    sortOrder: 0,
  },
  {
    key: "conventions",
    title: "Conventions",
    body: "Define your coding standards, naming conventions, and engineering practices here.",
    sortOrder: 1,
  },
  {
    key: "terminology",
    title: "Terminology",
    body: "Define domain-specific vocabulary and terminology that agents should use consistently here.",
    sortOrder: 2,
  },
] as const;

export function globalPromptService(db: Db) {
  // ─── Company Prompts ───

  async function listCompanyPrompts(companyId: string, opts?: { enabled?: boolean }) {
    const conditions = [eq(globalPrompts.companyId, companyId), isNull(globalPrompts.projectId)];
    if (opts?.enabled !== undefined) {
      conditions.push(eq(globalPrompts.enabled, opts.enabled));
    }
    return db
      .select()
      .from(globalPrompts)
      .where(and(...conditions))
      .orderBy(asc(globalPrompts.sortOrder), asc(globalPrompts.key));
  }

  async function getCompanyPrompt(companyId: string, key: string) {
    const rows = await db
      .select()
      .from(globalPrompts)
      .where(
        and(
          eq(globalPrompts.companyId, companyId),
          isNull(globalPrompts.projectId),
          eq(globalPrompts.key, key),
        ),
      );
    return rows[0] ?? null;
  }

  async function upsertCompanyPrompt(
    companyId: string,
    key: string,
    data: UpsertPromptData,
    actor: Actor,
  ) {
    return db.transaction(async (tx) => {
      // Lock the row if it exists to prevent concurrent insert race
      const existing = await tx
        .select()
        .from(globalPrompts)
        .where(
          and(
            eq(globalPrompts.companyId, companyId),
            isNull(globalPrompts.projectId),
            eq(globalPrompts.key, key),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);

      if (existing) {
        const rows = await tx
          .update(globalPrompts)
          .set({
            title: data.title ?? existing.title,
            body: data.body,
            enabled: data.enabled ?? existing.enabled,
            sortOrder: data.sortOrder ?? existing.sortOrder,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(globalPrompts.id, existing.id))
          .returning();
        return { prompt: rows[0]!, created: false };
      }
      const rows = await tx
        .insert(globalPrompts)
        .values({
          companyId,
          projectId: null,
          key,
          title: data.title ?? null,
          body: data.body,
          enabled: data.enabled ?? true,
          sortOrder: data.sortOrder ?? 0,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
        })
        .returning();
      return { prompt: rows[0]!, created: true };
    });
  }

  async function deleteCompanyPrompt(companyId: string, key: string) {
    const existing = await getCompanyPrompt(companyId, key);
    if (!existing) return null;
    await db.delete(globalPrompts).where(eq(globalPrompts.id, existing.id));
    return existing;
  }

  // ─── Project Prompts ───

  async function listProjectPrompts(projectId: string, opts?: { enabled?: boolean }) {
    const conditions = [eq(globalPrompts.projectId, projectId)];
    if (opts?.enabled !== undefined) {
      conditions.push(eq(globalPrompts.enabled, opts.enabled));
    }
    return db
      .select()
      .from(globalPrompts)
      .where(and(...conditions))
      .orderBy(asc(globalPrompts.sortOrder), asc(globalPrompts.key));
  }

  async function getProjectPrompt(projectId: string, key: string) {
    const rows = await db
      .select()
      .from(globalPrompts)
      .where(and(eq(globalPrompts.projectId, projectId), eq(globalPrompts.key, key)));
    return rows[0] ?? null;
  }

  async function upsertProjectPrompt(
    companyId: string,
    projectId: string,
    key: string,
    data: UpsertPromptData,
    actor: Actor,
  ) {
    return db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(globalPrompts)
        .where(and(eq(globalPrompts.projectId, projectId), eq(globalPrompts.key, key)))
        .for("update")
        .then((rows) => rows[0] ?? null);

      if (existing) {
        const rows = await tx
          .update(globalPrompts)
          .set({
            title: data.title ?? existing.title,
            body: data.body,
            enabled: data.enabled ?? existing.enabled,
            sortOrder: data.sortOrder ?? existing.sortOrder,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(globalPrompts.id, existing.id))
          .returning();
        return { prompt: rows[0]!, created: false };
      }
      const rows = await tx
        .insert(globalPrompts)
        .values({
          companyId,
          projectId,
          key,
          title: data.title ?? null,
          body: data.body,
          enabled: data.enabled ?? true,
          sortOrder: data.sortOrder ?? 0,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
        })
        .returning();
      return { prompt: rows[0]!, created: true };
    });
  }

  async function deleteProjectPrompt(projectId: string, key: string) {
    const existing = await getProjectPrompt(projectId, key);
    if (!existing) return null;
    await db.delete(globalPrompts).where(eq(globalPrompts.id, existing.id));
    return existing;
  }

  // ─── Agent Overrides ───

  async function listAgentOverrides(agentId: string) {
    return db
      .select({
        id: agentPromptOverrides.id,
        agentId: agentPromptOverrides.agentId,
        globalPromptId: agentPromptOverrides.globalPromptId,
        globalPromptKey: globalPrompts.key,
        disabled: agentPromptOverrides.disabled,
        createdAt: agentPromptOverrides.createdAt,
        updatedAt: agentPromptOverrides.updatedAt,
      })
      .from(agentPromptOverrides)
      .innerJoin(globalPrompts, eq(agentPromptOverrides.globalPromptId, globalPrompts.id))
      .where(eq(agentPromptOverrides.agentId, agentId));
  }

  async function setAgentOverride(
    agentId: string,
    globalPromptId: string,
    disabled: boolean,
    actor: Actor,
  ) {
    // Verify the global prompt exists
    const prompt = await db
      .select()
      .from(globalPrompts)
      .where(eq(globalPrompts.id, globalPromptId))
      .then((rows) => rows[0] ?? null);
    if (!prompt) throw notFound("Global prompt not found");

    const existing = await db
      .select()
      .from(agentPromptOverrides)
      .where(
        and(
          eq(agentPromptOverrides.agentId, agentId),
          eq(agentPromptOverrides.globalPromptId, globalPromptId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing) {
      const rows = await db
        .update(agentPromptOverrides)
        .set({
          disabled,
          updatedAt: new Date(),
        })
        .where(eq(agentPromptOverrides.id, existing.id))
        .returning();
      return { override: rows[0]!, created: false };
    }

    const rows = await db
      .insert(agentPromptOverrides)
      .values({
        agentId,
        globalPromptId,
        disabled,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
      })
      .returning();
    return { override: rows[0]!, created: true };
  }

  async function deleteAgentOverride(agentId: string, globalPromptId: string) {
    const existing = await db
      .select()
      .from(agentPromptOverrides)
      .where(
        and(
          eq(agentPromptOverrides.agentId, agentId),
          eq(agentPromptOverrides.globalPromptId, globalPromptId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!existing) return null;
    await db.delete(agentPromptOverrides).where(eq(agentPromptOverrides.id, existing.id));
    return existing;
  }

  // ─── Resolution Algorithm (spec §3.1) ───

  async function resolveForAgent(
    agentId: string,
    companyId: string,
    projectId?: string | null,
  ): Promise<{ resolvedPrompts: ResolvedPrompt[]; disabledPrompts: DisabledPrompt[] }> {
    // 1. Fetch enabled company-level prompts
    const companyPrompts = await db
      .select()
      .from(globalPrompts)
      .where(
        and(
          eq(globalPrompts.companyId, companyId),
          isNull(globalPrompts.projectId),
          eq(globalPrompts.enabled, true),
        ),
      )
      .orderBy(asc(globalPrompts.sortOrder), asc(globalPrompts.key));

    // 2. Fetch enabled project-level prompts if projectId given
    let projectPrompts: typeof companyPrompts = [];
    if (projectId) {
      projectPrompts = await db
        .select()
        .from(globalPrompts)
        .where(
          and(
            eq(globalPrompts.projectId, projectId),
            eq(globalPrompts.enabled, true),
          ),
        )
        .orderBy(asc(globalPrompts.sortOrder), asc(globalPrompts.key));
    }

    // 3. Fetch agent overrides
    const overrides = await db
      .select()
      .from(agentPromptOverrides)
      .where(eq(agentPromptOverrides.agentId, agentId));
    const disabledIds = new Set(
      overrides.filter((o) => o.disabled).map((o) => o.globalPromptId),
    );

    // 4. Merge: project prompts REPLACE company prompts on matching key
    const merged = new Map<string, { prompt: (typeof companyPrompts)[0]; source: "company" | "project"; overriddenByProject: boolean }>();
    for (const p of companyPrompts) {
      merged.set(p.key, { prompt: p, source: "company", overriddenByProject: false });
    }
    for (const p of projectPrompts) {
      const wasCompany = merged.has(p.key);
      merged.set(p.key, { prompt: p, source: "project", overriddenByProject: wasCompany });
    }

    // 5. Filter disabled and build results
    const resolvedPrompts: ResolvedPrompt[] = [];
    const disabledPrompts: DisabledPrompt[] = [];

    // Sort by sort_order, then key
    const sorted = Array.from(merged.values()).sort((a, b) => {
      const orderDiff = a.prompt.sortOrder - b.prompt.sortOrder;
      if (orderDiff !== 0) return orderDiff;
      return a.prompt.key.localeCompare(b.prompt.key);
    });

    for (const entry of sorted) {
      if (disabledIds.has(entry.prompt.id)) {
        disabledPrompts.push({
          key: entry.prompt.key,
          source: entry.source,
          reason: "agent_override",
        });
      } else {
        resolvedPrompts.push({
          key: entry.prompt.key,
          title: entry.prompt.title,
          body: entry.prompt.body,
          source: entry.source,
          sourceId: entry.prompt.id,
          overriddenByProject: entry.overriddenByProject,
        });
      }
    }

    return { resolvedPrompts, disabledPrompts };
  }

  // ─── Seeding ───

  async function seedStandardPrompts(companyId: string, actor?: Actor) {
    for (const prompt of STANDARD_PROMPTS) {
      const existing = await getCompanyPrompt(companyId, prompt.key);
      if (!existing) {
        await db.insert(globalPrompts).values({
          companyId,
          projectId: null,
          key: prompt.key,
          title: prompt.title,
          body: prompt.body,
          enabled: true,
          sortOrder: prompt.sortOrder,
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? "system",
        });
      }
    }
  }

  return {
    listCompanyPrompts,
    getCompanyPrompt,
    upsertCompanyPrompt,
    deleteCompanyPrompt,
    listProjectPrompts,
    getProjectPrompt,
    upsertProjectPrompt,
    deleteProjectPrompt,
    listAgentOverrides,
    setAgentOverride,
    deleteAgentOverride,
    resolveForAgent,
    seedStandardPrompts,
  };
}
