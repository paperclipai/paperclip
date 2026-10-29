import { and, asc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { workflows, type Db } from "@paperclipai/db";
import type { z } from "zod";
import type { createWorkflowSchema, updateWorkflowSchema } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { instanceSettingsService } from "./instance-settings.js";
import { authorizeCaseCreation } from "./case-mutation-authorization.js";
import type { AuthorizationActor } from "./authorization.js";
import { persistActivity, publishActivity } from "./activity-log.js";

export async function requireCasesEnabled(db: Db) {
  if (!(await instanceSettingsService(db).getExperimental()).enableCases) throw forbidden("Cases are disabled");
}

export async function getWorkflow(db: Db, companyId: string, id: string) {
  const [row] = await db.select().from(workflows).where(and(eq(workflows.companyId, companyId), eq(workflows.id, id)));
  if (!row) throw notFound("Workflow not found");
  return row;
}

export async function getWorkflowMetadata(db: Db, companyId: string, id: string) {
  const [row] = await db.select({ id: workflows.id, name: workflows.name }).from(workflows)
    .where(and(eq(workflows.companyId, companyId), eq(workflows.id, id)));
  if (!row) throw notFound("Workflow not found");
  return row;
}

export function workflowService(db: Db) {
  return {
    list: (companyId: string, options: { limit: number; offset: number }) => db.select({
      id: workflows.id, companyId: workflows.companyId, name: workflows.name,
      createdAt: workflows.createdAt, updatedAt: workflows.updatedAt,
    }).from(workflows).where(eq(workflows.companyId, companyId)).orderBy(asc(workflows.name), asc(workflows.id))
      .limit(options.limit).offset(options.offset),
    async read(companyId: string, id: string, expectedSnapshot?: string) {
      const workflow = await getWorkflow(db, companyId, id);
      const snapshot = createHash("sha256").update(JSON.stringify(workflow)).digest("hex");
      if (expectedSnapshot && expectedSnapshot !== snapshot) throw conflict("Workflow changed; restart read_workflow at offset zero without snapshot");
      return { workflow, snapshot };
    },
    async write(companyId: string, actor: AuthorizationActor, input: z.infer<typeof createWorkflowSchema> | z.infer<typeof updateWorkflowSchema>, id?: string) {
      const result = await db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        await requireCasesEnabled(tx);
        await authorizeCaseCreation(tx, actor, { companyId });
        if (id) await getWorkflow(tx, companyId, id);
        const who = actor.type === "agent" ? { actorType: "agent" as const, actorId: actor.agentId!, agentId: actor.agentId! }
          : { actorType: "user" as const, actorId: actor.userId ?? "board" };
        const [row] = id
          ? await tx.update(workflows).set({ ...input, updatedAt: new Date() })
            .where(and(eq(workflows.id, id), eq(workflows.companyId, companyId))).returning()
          : await tx.insert(workflows).values({ companyId, ...input as z.infer<typeof createWorkflowSchema>,
            createdByAgentId: actor.type === "agent" ? actor.agentId : null,
            createdByUserId: actor.type === "board" ? actor.userId : null }).returning();
        if (!row) throw notFound("Workflow not found");
        const { publication } = await persistActivity(tx, { companyId, ...who, runId: actor.runId ?? null,
          action: id ? "workflow.updated" : "workflow.created", entityType: "workflow", entityId: row.id,
          details: { name: row.name, promptChanged: input.prompt !== undefined } });
        return { row, publication };
      });
      publishActivity(result.publication);
      return result.row;
    },
  };
}
