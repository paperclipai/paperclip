import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "./catalog.js";
import { decideCapabilitySemanticAuthorization } from "./policy.js";
import type {
  CapabilitySemanticOperationId,
  CapabilitySemanticPolicyContext,
  CapabilitySemanticToolDefinition,
  CapabilitySemanticToolDescriptor,
} from "./types.js";

export type CapabilityToolExposureMode = "eager" | "lazy";

export interface CapabilityDiscoveryResult {
  readonly schema: "paperclip.capability-discovery.v1";
  readonly query: string;
  readonly namespace: string | null;
  readonly operations: readonly CapabilitySemanticToolDefinition[];
  readonly truncated: boolean;
}

const MAX_DISCOVERY_RESULTS = 10;

const NAMESPACE: Readonly<Record<CapabilitySemanticOperationId, string>> = Object.freeze({
  get_task_context: "active_task", get_task_history: "active_task",
  list_documents: "documents", read_document: "documents", list_document_revisions: "documents",
  report_progress: "active_task", answer_status_question: "active_task", write_document: "documents",
  request_human_input: "documents", register_deliverable: "documents", finish_task: "active_task",
  block_task: "active_task", request_review: "active_task", search_tasks: "discovery",
  list_agents: "discovery", get_agent: "discovery", create_task: "delegation",
  set_dependencies: "delegation", list_approvals: "governance", get_approval: "governance",
  get_approval_context: "governance", request_approval: "governance",
  decide_approval: "governance", comment_on_approval: "governance",
  get_workspace_runtime: "workspace", control_workspace_service: "workspace",
  schedule_wake: "continuation", generic_api_request: "test_infrastructure",
});

export const CAPABILITY_DISCOVERY_NAMESPACES = Object.freeze([
  { name: "discovery", description: "Find company tasks and agents." },
  { name: "delegation", description: "Create bounded child work and task dependencies." },
  { name: "governance", description: "Read, request, discuss, and decide approvals." },
  { name: "workspace", description: "Inspect and control active-task workspace services." },
  { name: "continuation", description: "Schedule a bounded continuation wake." },
]);

export const CAPABILITY_DISCOVERY_GATEWAY_DEFINITIONS = Object.freeze([{
  name: "discover_capabilities",
  title: "Discover optional capabilities",
  description: `Search authorized optional Paperclip capabilities. Namespaces: ${CAPABILITY_DISCOVERY_NAMESPACES.map((item) => `${item.name} (${item.description})`).join("; ")}`,
  inputSchema: {
    type: "object", properties: {
      query: { type: "string", minLength: 1, maxLength: 500 },
      namespace: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: MAX_DISCOVERY_RESULTS },
    }, required: ["query"], additionalProperties: false,
  },
  outputSchema: {
    type: "object", properties: {
      schema: { const: "paperclip.capability-discovery.v1" },
      query: { type: "string" }, namespace: { type: ["string", "null"] },
      operations: { type: "array", items: { type: "object", additionalProperties: true } },
      truncated: { type: "boolean" },
    }, required: ["schema", "query", "namespace", "operations", "truncated"], additionalProperties: false,
  },
}, {
  name: "invoke_discovered_capability",
  title: "Invoke a discovered capability",
  description: "Invoke one optional Paperclip operation returned by discover_capabilities. Authority is rechecked at invocation.",
  inputSchema: {
    type: "object", properties: {
      operationId: { type: "string" }, input: { type: "object", additionalProperties: true },
    }, required: ["operationId", "input"], additionalProperties: false,
  },
  outputSchema: {
    type: "object", properties: {
      success: { type: "boolean" },
      contentItems: { type: "array", items: { type: "object", additionalProperties: true } },
    }, required: ["success", "contentItems"], additionalProperties: false,
  },
}] as const);

export function capabilityToolNamespace(operationId: CapabilitySemanticOperationId): string {
  return NAMESPACE[operationId];
}

export function alwaysCapabilityDefinitions(): readonly CapabilitySemanticToolDefinition[] {
  return CAPABILITY_SEMANTIC_TOOL_CATALOG.filter((item) => item.exposure === "always").map(toDefinition);
}

export function discoverCapabilityDefinitions(
  query: string,
  context: CapabilitySemanticPolicyContext,
  options: { namespace?: string; limit?: number } = {},
): CapabilityDiscoveryResult {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) throw new Error("discovery_query_empty");
  const limit = Math.max(
    1,
    Math.min(options.limit ?? 5, MAX_DISCOVERY_RESULTS),
  );
  const tokens = normalized.split(/[^a-z0-9]+/).filter((token) => token.length > 1);
  const permitted = CAPABILITY_SEMANTIC_TOOL_CATALOG
    .filter((descriptor) => descriptor.exposure === "optional")
    .filter((descriptor) => options.namespace === undefined || capabilityToolNamespace(descriptor.operationId) === options.namespace)
    .filter((descriptor) => decideCapabilitySemanticAuthorization(descriptor, context, "exposure").allowed)
    .map((descriptor) => ({ descriptor, score: score(descriptor, tokens, normalized) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.descriptor.operationId.localeCompare(right.descriptor.operationId));
  return Object.freeze({
    schema: "paperclip.capability-discovery.v1",
    query,
    namespace: options.namespace ?? null,
    operations: Object.freeze(permitted.slice(0, limit).map(({ descriptor }) => toDefinition(descriptor))),
    truncated: permitted.length > limit,
  });
}

function score(descriptor: CapabilitySemanticToolDescriptor, tokens: readonly string[], query: string): number {
  const namespace = capabilityToolNamespace(descriptor.operationId);
  const id = descriptor.operationId.toLowerCase();
  const haystack = `${id} ${descriptor.title} ${descriptor.description} ${namespace}`.toLowerCase();
  let value = id === query ? 100 : namespace === query ? 50 : 0;
  for (const token of tokens) {
    if (id.includes(token)) value += 12;
    if (namespace.includes(token)) value += 8;
    if (haystack.includes(token)) value += 3;
  }
  return value;
}

function toDefinition(descriptor: CapabilitySemanticToolDescriptor): CapabilitySemanticToolDefinition {
  return {
    name: descriptor.operationId, description: descriptor.description,
    inputSchema: descriptor.inputSchema, outputSchema: descriptor.outputSchema,
    annotations: {
      semanticContract: descriptor.schema, operationId: descriptor.operationId,
      version: descriptor.version, exposure: descriptor.exposure,
      requiredClaims: descriptor.requiredClaims,
    },
  };
}
