import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issues,
  issueAntecedents,
  recordLinks,
  taskSetMembers,
  taskSets,
} from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";

const VALID_RECORD_KINDS = ["loan", "company", "person", "loan_tape", "investment_deal"] as const;

type RecordKind = typeof VALID_RECORD_KINDS[number];

export function createTaskSetService(db: Db) {
  return {
    create: async (companyId: string, input: {
      title: string;
      description?: string | null;
      info?: string | null;
      templateId?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      if (input.templateId) {
        const template = await db.select({ id: taskSets.id, companyId: taskSets.companyId })
          .from(taskSets)
          .where(eq(taskSets.id, input.templateId))
          .then((r) => r[0] ?? null);
        if (!template || template.companyId !== companyId) {
          throw notFound("Template not found");
        }
      }
      const now = new Date();
      const [created] = await db.insert(taskSets).values({
        companyId,
        title: input.title,
        description: input.description ?? null,
        info: input.info ?? null,
        templateId: input.templateId ?? null,
        createdByAgentId: input.createdByAgentId ?? null,
        createdByUserId: input.createdByUserId ?? null,
        createdAt: now,
        updatedAt: now,
      }).returning();
      return created;
    },

    list: async (companyId: string, filters?: { isTemplate?: boolean }) => {
      const conditions = [eq(taskSets.companyId, companyId)];
      if (filters?.isTemplate === true) {
        conditions.push(isNull(taskSets.templateId));
      } else if (filters?.isTemplate === false) {
        conditions.push(sql<boolean>`${taskSets.templateId} IS NOT NULL`);
      }
      return db.select().from(taskSets).where(and(...conditions)).orderBy(desc(taskSets.updatedAt));
    },

    getById: async (companyId: string, id: string) => {
      const set = await db.select().from(taskSets)
        .where(and(eq(taskSets.id, id), eq(taskSets.companyId, companyId)))
        .then((r) => r[0] ?? null);
      if (!set) throw notFound("Task set not found");
      const members = await db.select({
        id: taskSetMembers.id,
        issueId: taskSetMembers.issueId,
        sortOrder: taskSetMembers.sortOrder,
        templateIssueId: taskSetMembers.templateIssueId,
        createdAt: taskSetMembers.createdAt,
        issueTitle: issues.title,
        issueStatus: issues.status,
        issueIdentifier: issues.identifier,
        issuePriority: issues.priority,
        issueAssigneeAgentId: issues.assigneeAgentId,
        issueAssigneeUserId: issues.assigneeUserId,
      })
        .from(taskSetMembers)
        .innerJoin(issues, eq(issues.id, taskSetMembers.issueId))
        .where(eq(taskSetMembers.taskSetId, id))
        .orderBy(taskSetMembers.sortOrder);
      const links = await db.select().from(recordLinks)
        .where(and(eq(recordLinks.ownerKind, "task_set"), eq(recordLinks.ownerId, id)));
      return { ...set, members, recordLinks: links };
    },

    update: async (companyId: string, id: string, patch: {
      title?: string;
      description?: string | null;
      info?: string | null;
    }) => {
      const existing = await db.select({ id: taskSets.id }).from(taskSets)
        .where(and(eq(taskSets.id, id), eq(taskSets.companyId, companyId)))
        .then((r) => r[0] ?? null);
      if (!existing) throw notFound("Task set not found");
      const [updated] = await db.update(taskSets)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(taskSets.id, id), eq(taskSets.companyId, companyId)))
        .returning();
      return updated;
    },

    delete: async (companyId: string, id: string) => {
      const existing = await db.select({ id: taskSets.id }).from(taskSets)
        .where(and(eq(taskSets.id, id), eq(taskSets.companyId, companyId)))
        .then((r) => r[0] ?? null);
      if (!existing) throw notFound("Task set not found");
      await db.delete(taskSets).where(and(eq(taskSets.id, id), eq(taskSets.companyId, companyId)));
      return true;
    },

    addMember: async (companyId: string, taskSetId: string, issueId: string, sortOrder = 0) => {
      const [set, issue] = await Promise.all([
        db.select({ id: taskSets.id, companyId: taskSets.companyId }).from(taskSets)
          .where(and(eq(taskSets.id, taskSetId), eq(taskSets.companyId, companyId)))
          .then((r) => r[0] ?? null),
        db.select({ id: issues.id }).from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
          .then((r) => r[0] ?? null),
      ]);
      if (!set) throw notFound("Task set not found");
      if (!issue) throw notFound("Issue not found");
      const [member] = await db.insert(taskSetMembers)
        .values({ taskSetId, issueId, sortOrder })
        .onConflictDoNothing()
        .returning();
      return member ?? null;
    },

    removeMember: async (companyId: string, taskSetId: string, issueId: string) => {
      const set = await db.select({ id: taskSets.id }).from(taskSets)
        .where(and(eq(taskSets.id, taskSetId), eq(taskSets.companyId, companyId)))
        .then((r) => r[0] ?? null);
      if (!set) throw notFound("Task set not found");
      const deleted = await db.delete(taskSetMembers)
        .where(and(eq(taskSetMembers.taskSetId, taskSetId), eq(taskSetMembers.issueId, issueId)))
        .returning({ id: taskSetMembers.id })
        .then((r) => r[0] ?? null);
      return Boolean(deleted);
    },

    initiate: async (companyId: string, templateId: string, input: {
      assigneeUserId?: string | null;
      assigneeAgentId?: string | null;
      attachedRecordKind: string;
      attachedRecordId: string;
      initiatorUserId?: string | null;
      initiatorAgentId?: string | null;
    }) => {
      if (!VALID_RECORD_KINDS.includes(input.attachedRecordKind as RecordKind)) {
        throw unprocessable(`Invalid record kind: ${input.attachedRecordKind}`);
      }
      if (!input.assigneeUserId && !input.assigneeAgentId) {
        throw unprocessable("Either assigneeUserId or assigneeAgentId is required");
      }

      return db.transaction(async (tx) => {
        const template = await tx.select().from(taskSets)
          .where(and(eq(taskSets.id, templateId), eq(taskSets.companyId, companyId), isNull(taskSets.templateId)))
          .then((r) => r[0] ?? null);
        if (!template) throw notFound("Template not found");

        const templateMembers = await tx.select({
          id: taskSetMembers.id,
          issueId: taskSetMembers.issueId,
          sortOrder: taskSetMembers.sortOrder,
        }).from(taskSetMembers).where(eq(taskSetMembers.taskSetId, templateId));

        // Fetch template issues
        const templateIssueIds = templateMembers.map((m) => m.issueId);
        const templateIssues = templateIssueIds.length > 0
          ? await tx.select().from(issues).where(
              sql<boolean>`${issues.id} = ANY(${sql.raw(`ARRAY[${templateIssueIds.map((id) => `'${id}'::uuid`).join(",")}]`)})`,
            )
          : [];

        const issueById = new Map(templateIssues.map((i) => [i.id, i]));
        const oldToNew = new Map<string, string>();

        // Copy issues
        const now = new Date();
        for (const member of templateMembers) {
          const original = issueById.get(member.issueId);
          if (!original) continue;
          const assigneeUserId = original.assigneeUserId ?? input.assigneeUserId ?? null;
          const assigneeAgentId = original.assigneeAgentId ?? input.assigneeAgentId ?? null;
          const [newIssue] = await tx.insert(issues).values({
            companyId,
            goalId: original.goalId,
            parentId: original.parentId,
            title: original.title,
            description: original.description,
            status: "todo",
            priority: original.priority,
            assigneeUserId,
            assigneeAgentId,
            originKind: "task_set_initiation",
            originId: templateId,
            requestDepth: 0,
            createdByAgentId: input.initiatorAgentId ?? null,
            createdByUserId: input.initiatorUserId ?? null,
            createdAt: now,
            updatedAt: now,
          }).returning({ id: issues.id });
          if (newIssue) {
            oldToNew.set(member.issueId, newIssue.id);
          }
        }

        // Remap antecedents
        if (templateIssueIds.length > 0) {
          const antecedentRows = await tx.select().from(issueAntecedents).where(
            sql<boolean>`${issueAntecedents.issueId} = ANY(${sql.raw(`ARRAY[${templateIssueIds.map((id) => `'${id}'::uuid`).join(",")}]`)})`,
          );
          for (const row of antecedentRows) {
            const newIssueId = oldToNew.get(row.issueId);
            const newAntecedentId = oldToNew.get(row.antecedentIssueId);
            if (newIssueId && newAntecedentId) {
              await tx.insert(issueAntecedents)
                .values({ issueId: newIssueId, antecedentIssueId: newAntecedentId })
                .onConflictDoNothing();
            }
          }
        }

        // Create the live task set
        const [liveSet] = await tx.insert(taskSets).values({
          companyId,
          title: template.title,
          description: template.description,
          info: template.info,
          templateId,
          createdByAgentId: input.initiatorAgentId ?? null,
          createdByUserId: input.initiatorUserId ?? null,
          createdAt: now,
          updatedAt: now,
        }).returning();

        // Create task_set_members
        for (const member of templateMembers) {
          const newIssueId = oldToNew.get(member.issueId);
          if (!newIssueId || !liveSet) continue;
          await tx.insert(taskSetMembers).values({
            taskSetId: liveSet.id,
            issueId: newIssueId,
            sortOrder: member.sortOrder,
            templateIssueId: member.issueId,
            createdAt: now,
          });
        }

        // Create record link
        if (liveSet) {
          await tx.insert(recordLinks).values({
            companyId,
            ownerKind: "task_set",
            ownerId: liveSet.id,
            recordKind: input.attachedRecordKind,
            recordId: input.attachedRecordId,
            createdByAgentId: input.initiatorAgentId ?? null,
            createdByUserId: input.initiatorUserId ?? null,
            createdAt: now,
          }).onConflictDoNothing();
        }

        return liveSet!;
      });
    },
  };
}

export type TaskSetService = ReturnType<typeof createTaskSetService>;
