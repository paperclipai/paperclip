import { eq, and, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowTemplates } from "@paperclipai/db";
import type {
  CreateWorkflowTemplate,
  UpdateWorkflowTemplate,
  WorkflowInvokeInput,
} from "@paperclipai/shared";
import type {
  WorkflowTemplate,
  WorkflowTemplateNode,
  WorkflowInvokeResponse,
} from "@paperclipai/shared";
import { issueService } from "./issues.js";
import { notFound, unprocessable } from "../errors.js";

function validateDAG(nodes: WorkflowTemplateNode[]): void {
  const nodeIds = new Set(nodes.map((n) => n.tempId));
  for (const node of nodes) {
    for (const depId of node.blockedByTempIds) {
      if (!nodeIds.has(depId)) {
        throw unprocessable(`Node "${node.tempId}" references unknown blocker "${depId}"`);
      }
    }
    if (node.parentTempId && !nodeIds.has(node.parentTempId)) {
      throw unprocessable(`Node "${node.tempId}" references unknown parent "${node.parentTempId}"`);
    }
  }

  // Topological sort to detect cycles
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const adj = new Map<string, string[]>();
  for (const node of nodes) {
    adj.set(node.tempId, node.blockedByTempIds);
  }

  function dfs(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw unprocessable(`Cycle detected in workflow template involving node "${id}"`);
    }
    visiting.add(id);
    for (const dep of adj.get(id) ?? []) {
      dfs(dep);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const node of nodes) {
    dfs(node.tempId);
  }
}

export function workflowTemplateService(db: Db) {
  const issueSvc = issueService(db);

  return {
    list: async (companyId: string): Promise<WorkflowTemplate[]> => {
      return db
        .select()
        .from(workflowTemplates)
        .where(eq(workflowTemplates.companyId, companyId))
        .orderBy(desc(workflowTemplates.createdAt)) as unknown as Promise<WorkflowTemplate[]>;
    },

    get: async (id: string): Promise<WorkflowTemplate | null> => {
      const rows = await db
        .select()
        .from(workflowTemplates)
        .where(eq(workflowTemplates.id, id));
      return (rows[0] as unknown as WorkflowTemplate) ?? null;
    },

    create: async (
      companyId: string,
      input: CreateWorkflowTemplate,
      actor: { agentId?: string | null; userId?: string | null },
    ): Promise<WorkflowTemplate> => {
      const nodesCasted = input.nodes as unknown as WorkflowTemplateNode[];
      validateDAG(nodesCasted);

      const [created] = await db
        .insert(workflowTemplates)
        .values({
          companyId,
          name: input.name,
          description: input.description ?? null,
          nodes: nodesCasted,
          createdByUserId: actor.userId ?? null,
          createdByAgentId: actor.agentId ?? null,
        })
        .returning();

      return created as unknown as WorkflowTemplate;
    },

    update: async (
      id: string,
      input: UpdateWorkflowTemplate,
    ): Promise<WorkflowTemplate | null> => {
      if (input.nodes) {
        validateDAG(input.nodes as unknown as WorkflowTemplateNode[]);
      }

      const [updated] = await db
        .update(workflowTemplates)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description ?? null } : {}),
          ...(input.nodes !== undefined ? { nodes: input.nodes as unknown as WorkflowTemplateNode[] } : {}),
          updatedAt: new Date(),
        })
        .where(eq(workflowTemplates.id, id))
        .returning();

      return (updated as unknown as WorkflowTemplate) ?? null;
    },

    remove: async (id: string): Promise<boolean> => {
      const result = await db
        .delete(workflowTemplates)
        .where(eq(workflowTemplates.id, id))
        .returning({ id: workflowTemplates.id });

      return result.length > 0;
    },

    invoke: async (
      companyId: string,
      templateId: string,
      input: WorkflowInvokeInput,
      actor: { agentId?: string | null; userId?: string | null },
    ): Promise<WorkflowInvokeResponse> => {
      const rows = await db
        .select()
        .from(workflowTemplates)
        .where(and(eq(workflowTemplates.id, templateId), eq(workflowTemplates.companyId, companyId)));

      const template = (rows[0] as unknown as WorkflowTemplate) ?? null;

      if (!template) throw notFound("Workflow template not found");

      const nodes: WorkflowTemplateNode[] = template.nodes;
      validateDAG(nodes);

      // Build tempId → node lookup
      const nodeMap = new Map<string, WorkflowTemplateNode>();
      for (const node of nodes) {
        nodeMap.set(node.tempId, node);
      }

      // Step 1: Create all issues in a transaction
      const tempIdToIssue = new Map<string, { id: string; title: string }>();

      return db.transaction(async (tx) => {
        const txIssueSvc = issueService(tx as unknown as Db);

        // Create issues (no blockers/parent wiring yet)
        for (const node of nodes) {
          let description = node.description ?? null;
          if (input.context && description) {
            description = `Context: ${input.context}\n\n${description}`;
          } else if (input.context && !description) {
            description = `Context: ${input.context}`;
          }

          const overrides = input.nodeOverrides?.[node.tempId];

          const issue = await txIssueSvc.create(companyId, {
            title: node.title,
            description,
            status: "backlog", // temporary, will be set to todo/blocked below
            priority: overrides?.priority ?? node.defaultPriority ?? "medium",
            assigneeAgentId: overrides?.assigneeAgentId ?? node.defaultAssigneeAgentId ?? input.defaultAssigneeAgentId ?? null,
            assigneeUserId: overrides?.assigneeUserId ?? null,
            projectId: overrides?.projectId ?? node.defaultProjectId ?? input.projectId ?? null,
            goalId: overrides?.goalId ?? input.goalId ?? null,
            billingCode: overrides?.billingCode ?? null,
            executionPolicy: (overrides?.executionPolicy ?? node.executionPolicy ?? null) as any,
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
            originKind: "workflow" as any,
          });

          tempIdToIssue.set(node.tempId, { id: issue.id, title: issue.title });
        }

        // Step 2: Wire relations (blockers + parent)
        for (const node of nodes) {
          const issue = tempIdToIssue.get(node.tempId)!;
          const blockedByIssueIds = node.blockedByTempIds
            .map((depId) => tempIdToIssue.get(depId)?.id)
            .filter((id): id is string => !!id);

          const parentId = node.parentTempId
            ? tempIdToIssue.get(node.parentTempId)?.id ?? null
            : null;

          const hasBlockers = blockedByIssueIds.length > 0;
          const targetStatus = hasBlockers ? "blocked" : "todo";

          await txIssueSvc.update(issue.id, {
            blockedByIssueIds,
            ...(parentId ? { parentId } : {}),
            status: targetStatus,
            actorAgentId: actor.agentId ?? null,
            actorUserId: actor.userId ?? null,
          }, tx);
        }

        // Step 3: Build response
        const rootNode = nodes.find((n: WorkflowTemplateNode) => !n.parentTempId && n.blockedByTempIds.length === 0);
        const rootIssueId = rootNode
          ? tempIdToIssue.get(rootNode.tempId)!.id
          : tempIdToIssue.values().next().value!.id;

        const createdIssues = nodes.map((node: WorkflowTemplateNode) => {
          const issue = tempIdToIssue.get(node.tempId)!;
          const hasBlockers = node.blockedByTempIds.length > 0;
          const overrides = input.nodeOverrides?.[node.tempId];
          return {
            tempId: node.tempId,
            issueId: issue.id,
            title: issue.title,
            status: (hasBlockers ? "blocked" : "todo") as "todo" | "blocked",
            assigneeAgentId: overrides?.assigneeAgentId ?? node.defaultAssigneeAgentId ?? input.defaultAssigneeAgentId ?? null,
          };
        });

        return { rootIssueId, createdIssues };
      });
    },
  };
}
