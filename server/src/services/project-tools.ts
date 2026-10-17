import { projectDiscoverySchema, createProjectSchema, createIssueSchema, setIssueTitleSchema } from "@paperclipai/shared";
import { z } from "zod";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../vendor/paperclip-runner/index.js";
import { badRequest } from "../errors.js";

export const PROJECT_TOOL_NAMES = ["create_project", "list_project_repositories", "list_projects"];
export function projectToolDefinitions(workMode: string, includeTask = false) {
  return CAPABILITY_SEMANTIC_TOOL_CATALOG.filter(tool =>
    (PROJECT_TOOL_NAMES.includes(tool.operationId) || includeTask && ["create_task", "set_task_title"].includes(tool.operationId))
    && tool.allowedModes.includes(workMode as "standard"),
  ).map(tool => ({ name: tool.operationId, description: tool.description + (tool.operationId === "create_task"
      ? " Ownership: omit assigneeActorId to assign yourself; set it to null to leave the task unassigned. For a human-owned commitment, supply assigneeUserId with that person's verified Paperclip user ID. Do not supply both a human and a non-null agent assignee. Recording a human commitment does not complete it."
      : ""),
    inputSchema: tool.operationId === "create_project"
      ? z.toJSONSchema(createProjectSchema.extend({ idempotencyKey: z.string().min(1).max(255) }))
      : tool.operationId === "create_task"
        ? { ...tool.inputSchema, properties: { ...(tool.inputSchema.properties as Record<string, unknown>), assigneeUserId: { type: "string", minLength: 1, description: "Verified Paperclip user ID of the human owner; mutually exclusive with a non-null assigneeActorId." } } }
        : tool.inputSchema,
  }));
}

/** All transports use the normal authenticated API, including its validation and audit path. */
export async function callProjectTool(input: {
  name: string; arguments: Record<string, unknown>; apiUrl: string; token: string;
  companyId: string; issueId: string; agentId: string; conversation: boolean;
}) {
  const args = input.arguments;
  const page = input.name === "list_projects" ? projectDiscoverySchema.parse(args) : null;
  let path = `/companies/${input.companyId}/projects`;
  let body: unknown;
  if (input.name === "set_task_title") {
    path = `/issues/${input.issueId}/title`;
    body = setIssueTitleSchema.parse(args);
  } else if (input.name === "list_project_repositories") path = `/companies/${input.companyId}/project-repositories`;
  else if (page) {
    const query = new URLSearchParams({ view: "summary", limit: String(page.limit) });
    if (page.cursor) query.set("cursor", page.cursor);
    path += `?${query}`;
  }
  else if (input.name === "create_project") {
    body = createProjectSchema.extend({ idempotencyKey: z.string().min(1).max(255) }).parse(args);
  } else if (input.name === "create_task") {
    const key = z.string().min(1).max(150).parse(args.idempotencyKey);
    const humanOwner = args.assigneeUserId === undefined
      ? undefined : z.string().trim().min(1).parse(args.assigneeUserId);
    if (humanOwner && args.assigneeActorId != null) throw badRequest("Choose either a human or an agent assignee");
    path = `/companies/${input.companyId}/issues`;
    body = createIssueSchema.parse({
      title: args.title, description: args.description, priority: args.priority,
      projectId: args.projectId, initialPlan: args.initialPlan,
      assigneeAgentId: humanOwner ? null : args.assigneeActorId === undefined ? input.agentId : args.assigneeActorId,
      ...(humanOwner ? { assigneeUserId: humanOwner } : {}),
      parentId: input.conversation ? null : input.issueId,
      status: Array.isArray(args.blockedByTaskIds) && args.blockedByTaskIds.length ? "blocked" : "todo",
      blockedByIssueIds: args.blockedByTaskIds,
      idempotencyKey: `chat-handoff:${input.issueId}:${key}`,
    });
  } else throw badRequest("Unknown project tool");
  const response = await fetch(`${input.apiUrl.replace(/\/+$/, "").replace(/\/api$/, "")}/api${path}`, {
    method: input.name === "set_task_title" ? "PUT" : body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Project tool failed (${response.status})`);
  return result;
}
