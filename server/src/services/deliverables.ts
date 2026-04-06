import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  deliverables,
  deliverableContents,
  deliverableReviewStages,
  deliverableComments,
  reviewPipelineTemplates,
  projectReviewDefaults,
  agents,
} from "@paperclipai/db";

// ---------------------------------------------------------------------------
// Deliverable Service
// ---------------------------------------------------------------------------

export function deliverableService(db: Db) {
  // ── helpers ──────────────────────────────────────────────────────────

  async function instantiateStagesFromTemplate(
    deliverableId: string,
    templateId: string,
  ) {
    const tpl = await db
      .select()
      .from(reviewPipelineTemplates)
      .where(eq(reviewPipelineTemplates.id, templateId))
      .then((r) => r[0] ?? null);
    if (!tpl || !Array.isArray(tpl.stages)) return;

    const stagesArr = tpl.stages as Array<{
      label: string;
      reviewerAgentId?: string;
      reviewerUserId?: string;
      role?: string;
    }>;

    for (let i = 0; i < stagesArr.length; i++) {
      const s = stagesArr[i];
      // Validate agent still exists
      let agentId: string | null = s.reviewerAgentId ?? null;
      if (agentId) {
        const agentExists = await db
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.id, agentId))
          .then((r) => r.length > 0);
        if (!agentExists) agentId = null;
      }
      await db.insert(deliverableReviewStages).values({
        deliverableId,
        stageIndex: i,
        label: s.label,
        reviewerAgentId: agentId,
        reviewerUserId: s.reviewerUserId ?? null,
      });
    }
  }

  async function resolveTemplateForDeliverable(
    companyId: string,
    projectId: string | null,
  ): Promise<string | null> {
    // 1. project default
    if (projectId) {
      const pd = await db
        .select()
        .from(projectReviewDefaults)
        .where(eq(projectReviewDefaults.projectId, projectId))
        .then((r) => r[0] ?? null);
      if (pd) return pd.reviewPipelineTemplateId;
    }
    // 2. company default
    const companyDefault = await db
      .select()
      .from(reviewPipelineTemplates)
      .where(
        and(
          eq(reviewPipelineTemplates.companyId, companyId),
          eq(reviewPipelineTemplates.isDefault, true),
        ),
      )
      .then((r) => r[0] ?? null);
    return companyDefault?.id ?? null;
  }

  // ── CRUD ─────────────────────────────────────────────────────────────

  return {
    list: async (
      companyId: string,
      filters?: {
        status?: string;
        projectId?: string;
        issueId?: string;
        submittedByAgentId?: string;
      },
    ) => {
      const conditions = [eq(deliverables.companyId, companyId)];
      if (filters?.status) {
        if (filters.status.includes(",")) {
          conditions.push(
            inArray(deliverables.status, filters.status.split(",")),
          );
        } else {
          conditions.push(eq(deliverables.status, filters.status));
        }
      }
      if (filters?.projectId)
        conditions.push(eq(deliverables.projectId, filters.projectId));
      if (filters?.issueId)
        conditions.push(eq(deliverables.issueId, filters.issueId));
      if (filters?.submittedByAgentId)
        conditions.push(
          eq(deliverables.submittedByAgentId, filters.submittedByAgentId),
        );

      return db
        .select()
        .from(deliverables)
        .where(and(...conditions))
        .orderBy(desc(deliverables.createdAt));
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(deliverables)
        .where(eq(deliverables.id, id))
        .then((r) => r[0] ?? null);
      if (!row) return null;

      const [contents, stages, comments] = await Promise.all([
        db
          .select()
          .from(deliverableContents)
          .where(eq(deliverableContents.deliverableId, id))
          .orderBy(deliverableContents.sortOrder),
        db
          .select()
          .from(deliverableReviewStages)
          .where(eq(deliverableReviewStages.deliverableId, id))
          .orderBy(deliverableReviewStages.stageIndex),
        db
          .select()
          .from(deliverableComments)
          .where(eq(deliverableComments.deliverableId, id))
          .orderBy(deliverableComments.createdAt),
      ]);

      return { ...row, contents, stages, comments };
    },

    create: async (
      companyId: string,
      data: {
        title: string;
        description?: string | null;
        type?: string;
        priority?: string;
        projectId?: string | null;
        issueId?: string | null;
        dueAt?: string | null;
        templateId?: string | null;
        submittedByAgentId?: string | null;
        submittedByUserId?: string | null;
        stages?: Array<{
          label: string;
          reviewerAgentId?: string;
          reviewerUserId?: string;
        }>;
      },
    ) => {
      const [row] = await db
        .insert(deliverables)
        .values({
          companyId,
          title: data.title,
          description: data.description ?? null,
          type: data.type ?? "mixed",
          priority: data.priority ?? "medium",
          projectId: data.projectId ?? null,
          issueId: data.issueId ?? null,
          dueAt: data.dueAt ? new Date(data.dueAt) : null,
          reviewPipelineTemplateId: data.templateId ?? null,
          submittedByAgentId: data.submittedByAgentId ?? null,
          submittedByUserId: data.submittedByUserId ?? null,
        })
        .returning();

      // If custom stages provided, use them
      if (data.stages && data.stages.length > 0) {
        for (let i = 0; i < data.stages.length; i++) {
          const s = data.stages[i];
          await db.insert(deliverableReviewStages).values({
            deliverableId: row.id,
            stageIndex: i,
            label: s.label,
            reviewerAgentId: s.reviewerAgentId ?? null,
            reviewerUserId: s.reviewerUserId ?? null,
          });
        }
      } else {
        // Resolve template: explicit > project default > company default
        const templateId =
          data.templateId ??
          (await resolveTemplateForDeliverable(companyId, data.projectId ?? null));
        if (templateId) {
          await instantiateStagesFromTemplate(row.id, templateId);
          if (!data.templateId && templateId) {
            await db
              .update(deliverables)
              .set({ reviewPipelineTemplateId: templateId })
              .where(eq(deliverables.id, row.id));
          }
        }
      }

      return row;
    },

    update: async (
      id: string,
      data: {
        title?: string;
        description?: string | null;
        priority?: string;
        dueAt?: string | null;
      },
    ) => {
      const sets: Record<string, unknown> = {
        updatedAt: new Date(),
      };
      if (data.title !== undefined) sets.title = data.title;
      if (data.description !== undefined) sets.description = data.description;
      if (data.priority !== undefined) sets.priority = data.priority;
      if (data.dueAt !== undefined)
        sets.dueAt = data.dueAt ? new Date(data.dueAt) : null;

      return db
        .update(deliverables)
        .set(sets)
        .where(eq(deliverables.id, id))
        .returning()
        .then((r) => r[0] ?? null);
    },

    remove: async (id: string) =>
      db
        .delete(deliverables)
        .where(eq(deliverables.id, id))
        .returning()
        .then((r) => r[0] ?? null),

    // ── Lifecycle ────────────────────────────────────────────────────

    submit: async (id: string) => {
      const d = await db
        .select()
        .from(deliverables)
        .where(eq(deliverables.id, id))
        .then((r) => r[0] ?? null);
      if (!d) throw new Error("Deliverable not found");
      if (d.status !== "draft")
        throw new Error(`Cannot submit deliverable with status '${d.status}'`);

      // Check if there are stages
      const stages = await db
        .select()
        .from(deliverableReviewStages)
        .where(eq(deliverableReviewStages.deliverableId, id))
        .orderBy(deliverableReviewStages.stageIndex);

      const now = new Date();
      if (stages.length === 0) {
        // Zero stages → auto-approve
        return db
          .update(deliverables)
          .set({
            status: "approved",
            submittedAt: now,
            approvedAt: now,
            currentStageIndex: 0,
            updatedAt: now,
          })
          .where(eq(deliverables.id, id))
          .returning()
          .then((r) => r[0]);
      }

      return db
        .update(deliverables)
        .set({
          status: "in_review",
          submittedAt: now,
          currentStageIndex: 0,
          updatedAt: now,
        })
        .where(eq(deliverables.id, id))
        .returning()
        .then((r) => r[0]);
    },

    approveStage: async (
      id: string,
      stageId: string,
      decisionNote: string | null,
    ) => {
      const d = await db
        .select()
        .from(deliverables)
        .where(eq(deliverables.id, id))
        .then((r) => r[0] ?? null);
      if (!d) throw new Error("Deliverable not found");
      if (d.status !== "in_review")
        throw new Error("Deliverable is not in review");

      const stage = await db
        .select()
        .from(deliverableReviewStages)
        .where(eq(deliverableReviewStages.id, stageId))
        .then((r) => r[0] ?? null);
      if (!stage) throw new Error("Stage not found");
      if (stage.stageIndex !== d.currentStageIndex)
        throw new Error("Stage is not the current review stage");

      const now = new Date();
      await db
        .update(deliverableReviewStages)
        .set({ status: "approved", decisionNote, decidedAt: now, updatedAt: now })
        .where(eq(deliverableReviewStages.id, stageId));

      // Check if this was the final stage
      const allStages = await db
        .select()
        .from(deliverableReviewStages)
        .where(eq(deliverableReviewStages.deliverableId, id))
        .orderBy(deliverableReviewStages.stageIndex);

      const nextIndex = d.currentStageIndex + 1;
      const isLast = nextIndex >= allStages.length;

      if (isLast) {
        return db
          .update(deliverables)
          .set({
            status: "approved",
            approvedAt: now,
            currentStageIndex: nextIndex,
            updatedAt: now,
          })
          .where(eq(deliverables.id, id))
          .returning()
          .then((r) => r[0]);
      }

      return db
        .update(deliverables)
        .set({ currentStageIndex: nextIndex, updatedAt: now })
        .where(eq(deliverables.id, id))
        .returning()
        .then((r) => r[0]);
    },

    requestChanges: async (
      id: string,
      stageId: string,
      decisionNote: string | null,
    ) => {
      const now = new Date();
      await db
        .update(deliverableReviewStages)
        .set({
          status: "changes_requested",
          decisionNote,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(deliverableReviewStages.id, stageId));

      return db
        .update(deliverables)
        .set({ status: "changes_requested", updatedAt: now })
        .where(eq(deliverables.id, id))
        .returning()
        .then((r) => r[0]);
    },

    rejectStage: async (
      id: string,
      stageId: string,
      decisionNote: string | null,
    ) => {
      const now = new Date();
      await db
        .update(deliverableReviewStages)
        .set({ status: "rejected", decisionNote, decidedAt: now, updatedAt: now })
        .where(eq(deliverableReviewStages.id, stageId));

      return db
        .update(deliverables)
        .set({ status: "rejected", rejectedAt: now, updatedAt: now })
        .where(eq(deliverables.id, id))
        .returning()
        .then((r) => r[0]);
    },

    skipStage: async (id: string, stageId: string) => {
      const d = await db
        .select()
        .from(deliverables)
        .where(eq(deliverables.id, id))
        .then((r) => r[0] ?? null);
      if (!d) throw new Error("Deliverable not found");

      const now = new Date();
      await db
        .update(deliverableReviewStages)
        .set({ status: "skipped", decidedAt: now, updatedAt: now })
        .where(eq(deliverableReviewStages.id, stageId));

      const allStages = await db
        .select()
        .from(deliverableReviewStages)
        .where(eq(deliverableReviewStages.deliverableId, id))
        .orderBy(deliverableReviewStages.stageIndex);

      const nextIndex = d.currentStageIndex + 1;
      const isLast = nextIndex >= allStages.length;

      if (isLast) {
        return db
          .update(deliverables)
          .set({
            status: "approved",
            approvedAt: now,
            currentStageIndex: nextIndex,
            updatedAt: now,
          })
          .where(eq(deliverables.id, id))
          .returning()
          .then((r) => r[0]);
      }

      return db
        .update(deliverables)
        .set({ currentStageIndex: nextIndex, updatedAt: now })
        .where(eq(deliverables.id, id))
        .returning()
        .then((r) => r[0]);
    },

    resubmit: async (id: string) => {
      const d = await db
        .select()
        .from(deliverables)
        .where(eq(deliverables.id, id))
        .then((r) => r[0] ?? null);
      if (!d) throw new Error("Deliverable not found");
      if (d.status !== "changes_requested")
        throw new Error("Deliverable is not in changes_requested status");

      const now = new Date();
      // Reset current stage to pending
      const currentStage = await db
        .select()
        .from(deliverableReviewStages)
        .where(
          and(
            eq(deliverableReviewStages.deliverableId, id),
            eq(deliverableReviewStages.stageIndex, d.currentStageIndex),
          ),
        )
        .then((r) => r[0] ?? null);

      if (currentStage) {
        await db
          .update(deliverableReviewStages)
          .set({
            status: "pending",
            decisionNote: null,
            decidedAt: null,
            updatedAt: now,
          })
          .where(eq(deliverableReviewStages.id, currentStage.id));
      }

      return db
        .update(deliverables)
        .set({ status: "in_review", updatedAt: now })
        .where(eq(deliverables.id, id))
        .returning()
        .then((r) => r[0]);
    },

    reopen: async (id: string) => {
      const d = await db
        .select()
        .from(deliverables)
        .where(eq(deliverables.id, id))
        .then((r) => r[0] ?? null);
      if (!d) throw new Error("Deliverable not found");
      if (d.status !== "rejected")
        throw new Error("Only rejected deliverables can be reopened");

      const now = new Date();
      // Reset current stage to pending
      const currentStage = await db
        .select()
        .from(deliverableReviewStages)
        .where(
          and(
            eq(deliverableReviewStages.deliverableId, id),
            eq(deliverableReviewStages.stageIndex, d.currentStageIndex),
          ),
        )
        .then((r) => r[0] ?? null);

      if (currentStage) {
        await db
          .update(deliverableReviewStages)
          .set({
            status: "pending",
            decisionNote: null,
            decidedAt: null,
            updatedAt: now,
          })
          .where(eq(deliverableReviewStages.id, currentStage.id));
      }

      return db
        .update(deliverables)
        .set({
          status: "in_review",
          rejectedAt: null,
          updatedAt: now,
        })
        .where(eq(deliverables.id, id))
        .returning()
        .then((r) => r[0]);
    },

    reassign: async (id: string, newAgentId: string) => {
      return db
        .update(deliverables)
        .set({ submittedByAgentId: newAgentId, updatedAt: new Date() })
        .where(eq(deliverables.id, id))
        .returning()
        .then((r) => r[0] ?? null);
    },

    // ── Content ──────────────────────────────────────────────────────

    addContent: async (
      deliverableId: string,
      data: {
        kind: string;
        title: string;
        body?: string | null;
        url?: string | null;
        filePath?: string | null;
        originalFilename?: string | null;
        mimeType?: string | null;
        sizeBytes?: number | null;
        metadata?: Record<string, unknown> | null;
        sortOrder?: number;
      },
    ) =>
      db
        .insert(deliverableContents)
        .values({
          deliverableId,
          kind: data.kind,
          title: data.title,
          body: data.body ?? null,
          url: data.url ?? null,
          filePath: data.filePath ?? null,
          originalFilename: data.originalFilename ?? null,
          mimeType: data.mimeType ?? null,
          sizeBytes: data.sizeBytes ?? null,
          metadata: data.metadata ?? null,
          sortOrder: data.sortOrder ?? 0,
        })
        .returning()
        .then((r) => r[0]),

    updateContent: async (
      contentId: string,
      data: Record<string, unknown>,
    ) => {
      const sets: Record<string, unknown> = { updatedAt: new Date() };
      for (const key of [
        "title",
        "body",
        "url",
        "filePath",
        "originalFilename",
        "mimeType",
        "sizeBytes",
        "metadata",
        "sortOrder",
        "kind",
      ]) {
        if (data[key] !== undefined) sets[key] = data[key];
      }
      return db
        .update(deliverableContents)
        .set(sets)
        .where(eq(deliverableContents.id, contentId))
        .returning()
        .then((r) => r[0] ?? null);
    },

    removeContent: async (contentId: string) =>
      db
        .delete(deliverableContents)
        .where(eq(deliverableContents.id, contentId))
        .returning()
        .then((r) => r[0] ?? null),

    // ── Comments ─────────────────────────────────────────────────────

    listComments: async (deliverableId: string) =>
      db
        .select()
        .from(deliverableComments)
        .where(eq(deliverableComments.deliverableId, deliverableId))
        .orderBy(deliverableComments.createdAt),

    addComment: async (
      deliverableId: string,
      body: string,
      actor: { agentId?: string; userId?: string },
    ) =>
      db
        .insert(deliverableComments)
        .values({
          deliverableId,
          body,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
        })
        .returning()
        .then((r) => r[0]),

    // ── Stages management ────────────────────────────────────────────

    addStage: async (
      deliverableId: string,
      data: {
        label: string;
        reviewerAgentId?: string | null;
        reviewerUserId?: string | null;
      },
    ) => {
      // Get max stageIndex
      const existing = await db
        .select({ maxIdx: sql<number>`COALESCE(MAX(${deliverableReviewStages.stageIndex}), -1)` })
        .from(deliverableReviewStages)
        .where(eq(deliverableReviewStages.deliverableId, deliverableId))
        .then((r) => r[0]);
      const nextIdx = (existing?.maxIdx ?? -1) + 1;

      return db
        .insert(deliverableReviewStages)
        .values({
          deliverableId,
          stageIndex: nextIdx,
          label: data.label,
          reviewerAgentId: data.reviewerAgentId ?? null,
          reviewerUserId: data.reviewerUserId ?? null,
        })
        .returning()
        .then((r) => r[0]);
    },

    updateStage: async (stageId: string, data: Record<string, unknown>) => {
      const sets: Record<string, unknown> = { updatedAt: new Date() };
      if (data.label !== undefined) sets.label = data.label;
      if (data.reviewerAgentId !== undefined)
        sets.reviewerAgentId = data.reviewerAgentId;
      if (data.reviewerUserId !== undefined)
        sets.reviewerUserId = data.reviewerUserId;
      return db
        .update(deliverableReviewStages)
        .set(sets)
        .where(eq(deliverableReviewStages.id, stageId))
        .returning()
        .then((r) => r[0] ?? null);
    },

    removeStage: async (stageId: string) => {
      const stage = await db
        .select()
        .from(deliverableReviewStages)
        .where(eq(deliverableReviewStages.id, stageId))
        .then((r) => r[0] ?? null);
      if (!stage) return null;

      await db
        .delete(deliverableReviewStages)
        .where(eq(deliverableReviewStages.id, stageId));

      // Reindex remaining stages
      const remaining = await db
        .select()
        .from(deliverableReviewStages)
        .where(
          eq(deliverableReviewStages.deliverableId, stage.deliverableId),
        )
        .orderBy(deliverableReviewStages.stageIndex);

      for (let i = 0; i < remaining.length; i++) {
        if (remaining[i].stageIndex !== i) {
          await db
            .update(deliverableReviewStages)
            .set({ stageIndex: i })
            .where(eq(deliverableReviewStages.id, remaining[i].id));
        }
      }

      return stage;
    },

    // ── Review Pipeline Templates ────────────────────────────────────

    listTemplates: async (companyId: string) =>
      db
        .select()
        .from(reviewPipelineTemplates)
        .where(eq(reviewPipelineTemplates.companyId, companyId))
        .orderBy(desc(reviewPipelineTemplates.createdAt)),

    getTemplate: async (id: string) =>
      db
        .select()
        .from(reviewPipelineTemplates)
        .where(eq(reviewPipelineTemplates.id, id))
        .then((r) => r[0] ?? null),

    createTemplate: async (
      companyId: string,
      data: {
        name: string;
        description?: string | null;
        stages: unknown[];
        isDefault?: boolean;
      },
    ) => {
      // If setting as default, unset others
      if (data.isDefault) {
        await db
          .update(reviewPipelineTemplates)
          .set({ isDefault: false })
          .where(
            and(
              eq(reviewPipelineTemplates.companyId, companyId),
              eq(reviewPipelineTemplates.isDefault, true),
            ),
          );
      }

      return db
        .insert(reviewPipelineTemplates)
        .values({
          companyId,
          name: data.name,
          description: data.description ?? null,
          stages: data.stages,
          isDefault: data.isDefault ?? false,
        })
        .returning()
        .then((r) => r[0]);
    },

    updateTemplate: async (id: string, data: Record<string, unknown>) => {
      const sets: Record<string, unknown> = { updatedAt: new Date() };
      if (data.name !== undefined) sets.name = data.name;
      if (data.description !== undefined) sets.description = data.description;
      if (data.stages !== undefined) sets.stages = data.stages;
      if (data.isDefault !== undefined) {
        sets.isDefault = data.isDefault;
        // If setting as default, unset others
        if (data.isDefault) {
          const tpl = await db
            .select()
            .from(reviewPipelineTemplates)
            .where(eq(reviewPipelineTemplates.id, id))
            .then((r) => r[0] ?? null);
          if (tpl) {
            await db
              .update(reviewPipelineTemplates)
              .set({ isDefault: false })
              .where(
                and(
                  eq(reviewPipelineTemplates.companyId, tpl.companyId),
                  eq(reviewPipelineTemplates.isDefault, true),
                ),
              );
          }
        }
      }

      return db
        .update(reviewPipelineTemplates)
        .set(sets)
        .where(eq(reviewPipelineTemplates.id, id))
        .returning()
        .then((r) => r[0] ?? null);
    },

    deleteTemplate: async (id: string) =>
      db
        .delete(reviewPipelineTemplates)
        .where(eq(reviewPipelineTemplates.id, id))
        .returning()
        .then((r) => r[0] ?? null),

    // ── Project defaults ─────────────────────────────────────────────

    getProjectDefault: async (projectId: string) =>
      db
        .select()
        .from(projectReviewDefaults)
        .where(eq(projectReviewDefaults.projectId, projectId))
        .then((r) => r[0] ?? null),

    setProjectDefault: async (
      projectId: string,
      companyId: string,
      templateId: string,
    ) => {
      // Upsert
      const existing = await db
        .select()
        .from(projectReviewDefaults)
        .where(eq(projectReviewDefaults.projectId, projectId))
        .then((r) => r[0] ?? null);

      if (existing) {
        return db
          .update(projectReviewDefaults)
          .set({
            reviewPipelineTemplateId: templateId,
            updatedAt: new Date(),
          })
          .where(eq(projectReviewDefaults.projectId, projectId))
          .returning()
          .then((r) => r[0]);
      }

      return db
        .insert(projectReviewDefaults)
        .values({
          projectId,
          companyId,
          reviewPipelineTemplateId: templateId,
        })
        .returning()
        .then((r) => r[0]);
    },
  };
}
