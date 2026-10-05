import { createProjectSchema, createIssueSchema, setIssueTitleSchema } from "@paperclipai/shared";
import { z } from "zod";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../vendor/paperclip-runner/index.js";
import { badRequest } from "../errors.js";

export const PROJECT_TOOL_NAMES = ["create_project", "list_project_repositories", "list_projects"];
const listProjectsSchema = z.object({
  limit: z.number().int().min(1).max(50).default(50),
  cursor: z.string().uuid().optional(),
}).strict();

/** Discovery is bounded independently of project descriptions and workspace configuration. */
function projectDiscoveryPage(projects: Array<Record<string, unknown>>, page: z.infer<typeof listProjectsSchema>) {
  const ordered = projects.filter(project => !page.cursor || String(project.id) > page.cursor)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const selected = ordered.slice(0, page.limit);
  return {
    projects: selected.map(project => {
      const description = typeof project.description === "string" ? project.description : null;
      return {
        id: project.id,
        name: String(project.name).slice(0, 500),
        status: project.status,
        description: description?.slice(0, 1_000) ?? null,
        descriptionTruncated: (description?.length ?? 0) > 1_000,
      };
    }),
    nextCursor: ordered.length > selected.length ? selected.at(-1)!.id : null,
  };
}
export function projectToolDefinitions(workMode: string, includeTask = false) {
  return CAPABILITY_SEMANTIC_TOOL_CATALOG.filter(tool =>
    (PROJECT_TOOL_NAMES.includes(tool.operationId) || includeTask && ["create_task", "set_task_title"].includes(tool.operationId))
    && tool.allowedModes.includes(workMode as "standard"),
  ).map(tool => ({ name: tool.operationId, description: tool.description,
    inputSchema: tool.operationId === "create_project"
      ? z.toJSONSchema(createProjectSchema.extend({ idempotencyKey: z.string().min(1).max(255) }))
      : tool.inputSchema,
  }));
}

/** All transports use the normal authenticated API, including its validation and audit path. */
export async function callProjectTool(input: {
  name: string; arguments: Record<string, unknown>; apiUrl: string; token: string;
  companyId: string; issueId: string; agentId: string; conversation: boolean;
}) {
  const args = input.arguments;
  const page = input.name === "list_projects" ? listProjectsSchema.parse(args) : null;
  let path = `/companies/${input.companyId}/projects`;
  let body: unknown;
  if (input.name === "set_task_title") {
    path = `/issues/${input.issueId}/title`;
    body = setIssueTitleSchema.parse(args);
  } else if (input.name === "list_project_repositories") path = `/companies/${input.companyId}/project-repositories`;
  else if (input.name === "list_projects") { /* read projects */ }
  else if (input.name === "create_project") {
    body = createProjectSchema.extend({ idempotencyKey: z.string().min(1).max(255) }).parse(args);
  } else if (input.name === "create_task") {
    const key = z.string().min(1).max(150).parse(args.idempotencyKey);
    path = `/companies/${input.companyId}/issues`;
    body = createIssueSchema.parse({
      title: args.title, description: args.description, priority: args.priority,
      projectId: args.projectId, initialPlan: args.initialPlan,
      assigneeAgentId: args.assigneeActorId ?? input.agentId,
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
  return page ? projectDiscoveryPage(result, page) : result;
}
