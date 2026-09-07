import { createHash } from "node:crypto";
import { z } from "zod";
import { buildOpenApiDocument } from "../../routes/openapi.js";
import { badRequest, notFound } from "../../errors.js";
import { runnerApiReference } from "./runner-api-reference.js";
import { runnerApiRestriction } from "./runner-api-policy.js";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../../vendor/paperclip-runner/index.js";

type Json = Record<string, any>;
export interface RunnerApiOperation {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  parameters: Json[];
  requestBody?: Json;
  responses: Json;
  authorization: Json;
  transport: "rest" | "protocol";
  dedicatedTools: string[];
  allowedModes: string[];
  skillReference?: { section: string; description?: string; examples?: { body: unknown }[] };
  dedicatedToolGuidance: string;
  dedicatedToolCapabilities?: { name: string; description: string; supportedParameters: string[] }[];
  runnerRestrictions?: string[];
  callPolicy: "rest" | "restricted" | "protocol";
}

const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const SYNONYMS: Record<string, string> = {
  task: "issue", tasks: "issues", employee: "agent", employees: "agents",
  hire: "agent", hiring: "agents", expense: "cost", expenses: "costs",
  cron: "routines", schedule: "routines", recurring: "routines",
  blocker: "dependencies", blockers: "dependencies", files: "attachments",
};

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    .flatMap((word) => [word, ...(SYNONYMS[word] ? [SYNONYMS[word]] : [])])
    .map((word) => word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word);
}

function dedicatedTools(method: string, path: string): string[] {
  if (/\/issues\/\{[^}]+\}\/comments$/.test(path)) return method === "GET" ? ["get_task_history"] : ["report_progress"];
  if (/\/issues\/\{[^}]+\}\/documents/.test(path)) return method === "DELETE" ? [] : method === "GET" ? ["list_documents", "read_document", "list_document_revisions"] : ["write_document"];
  if (/\/issues$/.test(path)) return method === "GET" ? ["search_tasks"] : ["create_task"];
  if (/\/issues\/\{[^}]+\}$/.test(path)) return method === "GET" ? ["get_task_context"] : ["set_dependencies", "finish_task", "block_task", "request_review"];
  if (/\/agents$/.test(path) && method === "GET") return ["list_agents"];
  if (/\/agents\/(me|\{[^}]+\})$/.test(path) && method === "GET") return ["get_agent"];
  if (/\/approvals$/.test(path) && method === "GET") return ["list_approvals"];
  if (/\/approvals\/\{[^}]+\}/.test(path) && method === "GET") return ["get_approval", "get_approval_context"];
  return [];
}

// Descriptions and schemas are documentation, never authorization. Routes remain
// authoritative, including conditional role, company and resource checks.
export function buildRunnerApiCatalog(document: Json = buildOpenApiDocument()): RunnerApiOperation[] {
  function dereference(value: any, seen = new Set<string>()): any {
    if (Array.isArray(value)) return value.map((entry) => dereference(entry, seen));
    if (!value || typeof value !== "object") return value;
    if (typeof value.$ref === "string" && value.$ref.startsWith("#/")) {
      if (seen.has(value.$ref)) return { description: `Recursive schema: ${value.$ref}` };
      const target = value.$ref.slice(2).split("/").reduce((node: any, key: string) => node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], document);
      if (!target) throw new Error(`Unresolved API schema: ${value.$ref}`);
      return dereference(target, new Set([...seen, value.$ref]));
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, dereference(entry, seen)]));
  }
  const result: RunnerApiOperation[] = [];
  for (const [path, item] of Object.entries<Json>(document.paths)) {
    for (const [verb, operation] of Object.entries<Json>(item)) {
      if (!METHODS.has(verb)) continue;
      const method = verb.toUpperCase();
      const restriction = runnerApiRestriction(method, path);
      const skillReference = runnerApiReference[`${method} ${path.replace(/\{[^}]+\}/g, "{}")}`];
      const protocol = !path.startsWith("/api/") || /\/(oauth|auth|runtime-tools|mcp|ws)(\/|$)/.test(path)
        || /\/(claude-login|login-sessions|start-authorization|finalize-oauth-access)(\/|$)/.test(path)
        || /event-stream|websocket/i.test(JSON.stringify(operation.responses));
      result.push({
        operationId: `${method} ${path}`, method, path,
        summary: operation.summary ?? `${method} ${path}`,
        description: operation.description ?? "",
        parameters: dereference([...(item.parameters ?? []), ...(operation.parameters ?? [])]),
        ...(operation.requestBody ? { requestBody: dereference(operation.requestBody) } : {}),
        responses: dereference(operation.responses ?? {}),
        authorization: operation["x-paperclip-authorization"] ?? { actor: "board_or_agent" },
        transport: protocol ? "protocol" : "rest",
        callPolicy: protocol ? "protocol" : restriction ? "restricted" : "rest",
        dedicatedTools: dedicatedTools(method, path),
        dedicatedToolCapabilities: dedicatedTools(method, path).flatMap(name => {
          const descriptor = CAPABILITY_SEMANTIC_TOOL_CATALOG.find(tool => tool.operationId === name);
          return descriptor ? [{ name, description: descriptor.description, supportedParameters: Object.keys((descriptor.inputSchema as Json).properties ?? {}) }] : [];
        }),
        runnerRestrictions: [...(restriction ? [restriction] : []), "Active run and assignment must remain authorized.", "Cannot replace checkout, completion, task status/ownership changes, approval decisions, or runner execution control. Dedicated tools retain their existing permissions."],
        dedicatedToolGuidance: "Use an available dedicated tool for its supported fields. Inspect that tool's advertised schema; call_api may be used for additional API fields, subject to lifecycle restrictions.",
        allowedModes: method === "GET" || method === "HEAD" ? ["standard", "ask", "planning", "skill_test"] : ["standard", "skill_test"],
        ...(skillReference ? { skillReference } : {}),
      });
    }
  }
  for (const [path, summary, actor] of [
    ["/api/companies/{companyId}/events/ws", "Live company events WebSocket; use the existing event client", "board_or_agent"],
    ["/api/runner/v1/connect/{runId}", "Authenticated runner PRP WebSocket; runner-owned transport", "runner"],
    ["/api/environment-custom-image-setup-sessions/{sessionId}/terminal/ws", "Image setup terminal WebSocket; use the existing terminal client", "board"],
  ]) {
    if (result.some(operation => operation.path === path)) continue;
    result.push({ operationId: `GET ${path}`, method: "GET", path, summary,
      description: "WebSocket upgrade. Not callable through call_api.",
      parameters: [...path.matchAll(/\{([^}]+)\}/g)].map(match => ({ in: "path", name: match[1], required: true, schema: { type: "string" } })),
      responses: { "101": { description: "Switching Protocols" } }, authorization: { actor },
      transport: "protocol", callPolicy: "protocol", dedicatedTools: [], dedicatedToolGuidance: "Use the existing protocol client.", allowedModes: [],
    });
  }
  return result.sort((a, b) => a.operationId.localeCompare(b.operationId));
}

let cached: RunnerApiOperation[] | undefined;
let cachedDigest: string | undefined;
export function runnerApiCatalog(): RunnerApiOperation[] { return cached ??= buildRunnerApiCatalog(); }
export function runnerApiOperation(id: string): RunnerApiOperation {
  const operation = runnerApiCatalog().find((entry) => entry.operationId === id);
  if (!operation) throw notFound("Unknown API operation; use search_api to discover its exact operationId");
  return operation;
}

export const runnerApiSearchSchema = z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(10).default(5), cursor: z.string().max(200).optional() }).strict();
export function searchRunnerApi(value: unknown) {
  const parsed = runnerApiSearchSchema.safeParse(value);
  if (!parsed.success) throw badRequest("Invalid API search query or limit");
  const input = parsed.data;
  const { query, limit } = input;
  const catalog = runnerApiCatalog();
  cachedDigest ??= createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
  const fingerprint = createHash("sha256").update(cachedDigest).update(query).digest("hex").slice(0, 16);
  let offset = 0;
  if (input.cursor) {
    const match = /^([a-f0-9]{16}):(\d+)$/.exec(input.cursor);
    if (!match || match[1] !== fingerprint) throw badRequest("Search cursor belongs to a different query or catalog");
    offset = Number(match[2]);
    if (!Number.isSafeInteger(offset)) throw badRequest("Invalid search cursor");
  }
  const exact = catalog.find((entry) => entry.operationId.toLowerCase() === query.trim().toLowerCase());
  const terms = [...new Set(words(query))];
  const matches = exact ? [exact] : catalog.map((entry) => {
    const title = new Set(words(`${entry.method} ${entry.path} ${entry.summary}`));
    const description = new Set(words(`${entry.description} ${entry.skillReference?.description ?? ""} ${entry.skillReference?.section ?? ""}`));
    return { entry, score: terms.reduce((sum, word) => sum + (title.has(word) ? 5 : description.has(word) ? 1 : 0), 0) };
  }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.entry.operationId.localeCompare(b.entry.operationId)).map(({ entry }) => entry);
  const results = matches.slice(offset, offset + limit);
  return {
    results, total: matches.length,
    nextCursor: offset + limit < matches.length ? `${fingerprint}:${offset + limit}` : null,
    guidance: "Prefer an available dedicated tool when it supports the required operation and parameters. API permissions still apply. Protocol endpoints require their existing clients. Ask and Plan permit only reads through call_api.",
  };
}
