import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { admitToolInputSchema, canonicalToolInputSchema, TOOL_INPUT_SCHEMA_MAX_BYTES } from "../../vendor/paperclip-runner/index.js";
import { deduplicateToolDescriptors, ToolGatewayHttpError, type ToolGatewayDescriptor, type ToolGatewayService } from "../tool-gateway.js";

type WorkMode = "standard" | "planning" | "ask" | "skill_test";
type ToolDefinition = Record<string, unknown>;

const SEARCH_TOOL = "paperclip_search_assigned_tools";
const CALL_TOOL = "paperclip_call_assigned_tool";
// A single valid runner schema can be 512 KiB. Leave room for its description
// while keeping the complete result below the 768 KiB provider-result bound.
const SEARCH_PAGE_BYTES = 640 * 1024;
const SCHEMA_CHUNK_CHARACTERS = 64 * 1024;
const ON_DEMAND_TOOLS: ToolDefinition[] = [
  {
    name: SEARCH_TOOL,
    description: "Search your assigned app tools by name or description and read their input schemas. Pass {\"query\":\"search terms\"}, or an empty query to browse. Use limit from 1 to 20 (default 5). Omit unused optional fields instead of sending null. To fetch the next page, pass the returned nextOffset as offset. A large definition returns inputSchemaRef: set schemaTool to that name with an empty query, then pass the returned nextSchemaOffset as schemaOffset until null. Concatenate schemaJson chunks and parse JSON. Use paperclip_call_assigned_tool with a returned name and arguments matching its inputSchema.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        query: { type: "string", maxLength: 200 },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 5, description: "Maximum results per page (1 to 20; default 5)." },
        schemaTool: { type: "string", description: "Exact inputSchemaRef from a search result. Omit or leave blank for a normal tool search." },
        schemaOffset: { type: "integer", minimum: 0, description: "Schema chunk offset. A positive offset requires an exact inputSchemaRef in schemaTool." },
      },
      required: ["query"],
    },
  },
  {
    name: CALL_TOOL,
    description: "Call an assigned app tool discovered with paperclip_search_assigned_tools. Use its exact returned name and arguments matching its inputSchema. The same permissions, approvals, and audit rules apply as for direct app tools.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { name: { type: "string" }, arguments: { type: "object", additionalProperties: true } },
      required: ["name", "arguments"],
    },
  },
];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("assigned_mcp_tool_invalid_arguments");
  }
  return value as Record<string, unknown>;
}

// Execution must use the app's configured gateway, including deployment
// restrictions, OAuth refresh, and approval delivery. Never fall back to an
// isolated gateway whose defaults differ from the running instance.
const assignedMcpGateways = new WeakMap<Db, ToolGatewayService>();

export function registerAssignedMcpGateway(db: Db, gateway: ToolGatewayService): void {
  assignedMcpGateways.set(db, gateway);
}

export function getAssignedMcpGateway(db: Db): ToolGatewayService {
  const gateway = assignedMcpGateways.get(db);
  if (!gateway) throw new Error("assigned_mcp_gateway_unavailable");
  return gateway;
}

/** No configured gateway means no authorized connection tools or instructions. */
export async function resolveAssignedConnectionInstructionsForRun(db: Db, binding: { companyId: string; agentId: string; runId: string }) {
  const gateway = assignedMcpGateways.get(db);
  return gateway ? gateway.resolveConnectionInstructionsForRun(binding) : null;
}

/** MCP Skills: approved skills of the agent's usable connections; none without a configured gateway. */
export async function resolveMcpConnectionSkillsForRun(db: Db, binding: { companyId: string; agentId: string; runId: string }) {
  const gateway = assignedMcpGateways.get(db);
  return gateway ? gateway.resolveConnectionSkillsForRun(binding) : null;
}

/** The name native runners give a gateway tool; transcripts show this name. */
export function assignedToolName(name: string): string {
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const separator = name.lastIndexOf(":");
  const readable = separator >= 0
    ? `${sanitize(name.slice(0, separator)).slice(0, 20) || "tool"}_${sanitize(name.slice(separator + 1)).slice(-26) || "action"}`
    : sanitize(name).slice(0, 47) || "tool";
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `app_${readable}_${digest}`;
}

export const ASSIGNED_SCHEMA_LISTING_BUDGET_BYTES = 768 * 1024;
export const ASSIGNED_SCHEMA_ADMISSION_CACHE_ENTRIES = 1024;

type AssignedSchemaOutcome = { ok: true } | { ok: false; reason: string };
type AssignedSchemaAdmission = { ok: true; schema: Record<string, unknown> } | { ok: false; reason: string };
const assignedSchemaOutcomes = new Map<string, AssignedSchemaOutcome>();

export function assignedSchemaAdmissionCacheSize(): number {
  return assignedSchemaOutcomes.size;
}

async function admitAssignedToolSchema(key: string, schema: Record<string, unknown>): Promise<AssignedSchemaAdmission> {
  let outcome = assignedSchemaOutcomes.get(key);
  if (!outcome) {
    await new Promise<void>(resolve => setImmediate(resolve));
    outcome = assignedSchemaOutcomes.get(key);
  }
  if (!outcome) {
    const admission = admitToolInputSchema(schema);
    outcome = admission.ok ? { ok: true } : { ok: false, reason: admission.reason };
  }
  assignedSchemaOutcomes.delete(key);
  assignedSchemaOutcomes.set(key, outcome);
  while (assignedSchemaOutcomes.size > ASSIGNED_SCHEMA_ADMISSION_CACHE_ENTRIES) {
    assignedSchemaOutcomes.delete(assignedSchemaOutcomes.keys().next().value!);
  }
  return outcome.ok ? { ok: true, schema: canonicalToolInputSchema(schema)!.schema } : outcome;
}

type AssignedTool = Readonly<{ name: string; displayName: string; description: string; risk: ToolGatewayDescriptor["risk"] }>;
type AssignedCatalogTool = Readonly<{ tool: AssignedTool; schema: Readonly<Record<string, unknown>>; definition: Readonly<ToolDefinition> }>;
type AssignedCatalog = Readonly<{
  identity: string;
  bytes: number;
  tools: ReadonlyMap<string, AssignedCatalogTool>;
  definitions: readonly Readonly<ToolDefinition>[];
  readDefinitions: readonly Readonly<ToolDefinition>[];
  unavailable: readonly Readonly<{ tool: string; reason: string }>[];
  unchecked: readonly string[];
}>;
type AssignedListingEntry = { name: string; tool: AssignedTool; raw: Record<string, unknown>; bytes: number; digest: string };
type SharedCatalogEntry = { bytes: number; catalog: WeakRef<AssignedCatalog>; holders: number };

export const ASSIGNED_CATALOG_CACHE_ENTRIES = 512;
export const ASSIGNED_CATALOG_CACHE_BYTES = 256 * 1024 * 1024;

const sharedCatalogs = new Map<string, SharedCatalogEntry>();
const pendingCatalogs = new Map<string, Promise<AssignedCatalog>>();
let sharedCatalogBytes = 0;
const collectedSessions = new FinalizationRegistry<() => void>(release => release());
const collectedCatalogs = new FinalizationRegistry<{ key: string; catalog: WeakRef<AssignedCatalog> }>(({ key, catalog }) => {
  if (sharedCatalogs.get(key)?.catalog === catalog) forgetSharedCatalog(key);
});

function forgetSharedCatalog(key: string): void {
  const entry = sharedCatalogs.get(key);
  if (!entry) return;
  sharedCatalogs.delete(key);
  sharedCatalogBytes -= entry.bytes;
}

export function assignedCatalogCacheStats(): { entries: number; bytes: number } {
  return { entries: sharedCatalogs.size, bytes: sharedCatalogBytes };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function buildAssignedCatalog(identity: string, listing: readonly AssignedListingEntry[]): Promise<AssignedCatalog> {
  const tools = new Map<string, AssignedCatalogTool>();
  const unavailable: Array<{ tool: string; reason: string }> = [];
  const unchecked: string[] = [];
  let listingSchemaBytes = 0;
  let bytes = identity.length;
  for (const entry of listing) {
    const compilable = entry.bytes <= TOOL_INPUT_SCHEMA_MAX_BYTES
      && (listingSchemaBytes += entry.bytes) <= ASSIGNED_SCHEMA_LISTING_BUDGET_BYTES;
    let schema: Record<string, unknown>;
    if (compilable) {
      const admission = await admitAssignedToolSchema(entry.digest, entry.raw);
      if (!admission.ok) {
        unavailable.push({ tool: entry.tool.name, reason: admission.reason });
        continue;
      }
      schema = admission.schema;
    } else {
      schema = structuredClone(entry.raw);
      unchecked.push(entry.tool.name);
    }
    const definition = Object.freeze({
      name: entry.name, description: `${entry.tool.displayName}: ${entry.tool.description}`, inputSchema: deepFreeze(schema),
    });
    bytes += entry.bytes + definition.description.length;
    tools.set(entry.name, Object.freeze({ tool: entry.tool, schema: definition.inputSchema, definition }));
  }
  const entries = [...tools.values()];
  return Object.freeze({
    identity, bytes, tools,
    definitions: Object.freeze(entries.map(entry => entry.definition)),
    readDefinitions: Object.freeze(entries.filter(entry => entry.tool.risk === "read").map(entry => entry.definition)),
    unavailable: deepFreeze(unavailable),
    unchecked: Object.freeze(unchecked),
  });
}

function sharedAssignedCatalog(key: string, identity: string): AssignedCatalog | undefined {
  const entry = sharedCatalogs.get(key);
  const catalog = entry?.catalog.deref();
  if (!entry || catalog?.identity !== identity) return undefined;
  sharedCatalogs.delete(key);
  sharedCatalogs.set(key, entry);
  return catalog;
}

function shareAssignedCatalog(key: string, catalog: AssignedCatalog): void {
  if (catalog.bytes > ASSIGNED_CATALOG_CACHE_BYTES) return;
  forgetSharedCatalog(key);
  const reference = new WeakRef(catalog);
  sharedCatalogs.set(key, { bytes: catalog.bytes, catalog: reference, holders: 0 });
  sharedCatalogBytes += catalog.bytes;
  collectedCatalogs.register(catalog, { key, catalog: reference });
  for (const oldest of sharedCatalogs.keys()) {
    if (sharedCatalogs.size <= ASSIGNED_CATALOG_CACHE_ENTRIES && sharedCatalogBytes <= ASSIGNED_CATALOG_CACHE_BYTES) break;
    forgetSharedCatalog(oldest);
  }
}

async function resolveAssignedCatalog(companyId: string | undefined, listing: readonly AssignedListingEntry[]) {
  const identity = JSON.stringify([companyId ?? null, listing.map(entry =>
    [entry.name, entry.tool.name, entry.tool.displayName, entry.tool.description, entry.tool.risk, entry.digest])]);
  if (!companyId) return { catalog: await buildAssignedCatalog(identity, listing), release: () => {} };
  const key = sha256(identity);
  let catalog = sharedAssignedCatalog(key, identity);
  const pending = catalog ? undefined : pendingCatalogs.get(key);
  if (pending) {
    const joined = await pending;
    catalog = joined.identity === identity ? joined : undefined;
  }
  if (!catalog) {
    const building = buildAssignedCatalog(identity, listing);
    pendingCatalogs.set(key, building);
    try {
      catalog = await building;
    } finally {
      if (pendingCatalogs.get(key) === building) pendingCatalogs.delete(key);
    }
    if (sharedAssignedCatalog(key, identity) !== catalog) shareAssignedCatalog(key, catalog);
  }
  const holder = sharedCatalogs.get(key);
  if (!holder || holder.catalog.deref() !== catalog) return { catalog, release: () => {} };
  holder.holders += 1;
  let released = false;
  return {
    catalog,
    release: () => {
      if (released) return;
      released = true;
      holder.holders -= 1;
      if (holder.holders === 0 && sharedCatalogs.get(key) === holder) forgetSharedCatalog(key);
    },
  };
}

/** Server-owned MCP bindings projected into the runner's existing tool channel. */
export async function createAssignedMcpTools(input: {
  gateway: ToolGatewayService;
  gatewayPublicId: string;
  bearerToken: string;
  companyId?: string;
  workMode?: WorkMode;
  /** Bound provider grammar complexity independently of protocol byte capacity. */
  delivery?: "on_demand";
}) {
  const listed = await input.gateway.listToolsForNamedGateway({
    gatewayPublicId: input.gatewayPublicId,
    bearerToken: input.bearerToken,
  });
  const listing: AssignedListingEntry[] = [];
  const listedNames = new Map<string, string>();
  for (const descriptor of deduplicateToolDescriptors(listed)) {
    const name = assignedToolName(descriptor.name);
    const previous = listedNames.get(name);
    if (previous !== undefined) {
      throw new ToolGatewayHttpError(409,
        `Assigned MCP tool name collision for ${JSON.stringify([previous, descriptor.name])}.`,
        "assigned_mcp_tool_name_collision");
    }
    listedNames.set(name, descriptor.name);
    const raw = (descriptor.parametersSchema ?? { type: "object", properties: {} }) as Record<string, unknown>;
    const serialized = JSON.stringify(raw);
    listing.push({
      name, raw, bytes: Buffer.byteLength(serialized, "utf8"), digest: sha256(serialized),
      tool: Object.freeze({ name: descriptor.name, displayName: `${descriptor.displayName}`, description: `${descriptor.description}`, risk: descriptor.risk }),
    });
  }
  const { catalog, release } = await resolveAssignedCatalog(input.companyId, listing);
  const { tools, unavailable, unchecked } = catalog;
  if (unavailable.length > 0) {
    logger.warn({ gatewayPublicId: input.gatewayPublicId, unavailable },
      "assigned MCP tools whose input schema the Runner cannot validate are not offered");
  }
  if (unchecked.length > 0) {
    logger.warn({ gatewayPublicId: input.gatewayPublicId, unchecked },
      "assigned MCP tools whose input schema is over the compile budget are offered only through assigned-tool search");
  }
  const permits = (tool: Pick<ToolGatewayDescriptor, "risk">, mode: WorkMode = input.workMode ?? "standard") => mode === "standard" || tool.risk === "read";
  // OpenCode's HTTP bridge returns at most 64K JSON characters. Leave room
  // for the envelope and for JSON escaping when returning a schema chunk.
  // Other harnesses retain the larger PRP page and chunk budgets.
  const searchPageBytes = input.delivery === "on_demand" ? 32 * 1024 : SEARCH_PAGE_BYTES;
  const schemaChunkCharacters = input.delivery === "on_demand" ? 16 * 1024 : SCHEMA_CHUNK_CHARACTERS;

  async function search(argumentsValue: unknown, currentWorkMode?: WorkMode) {
    const args = object(argumentsValue);
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 5;
    const schemaOffset = args.schemaOffset ?? 0;
    const hasSchemaTool = typeof args.schemaTool === "string" && args.schemaTool.trim().length > 0;
    if (typeof args.query !== "string" || args.query.length > 200 ||
      typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 ||
      typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 20 ||
      (args.schemaTool !== undefined && typeof args.schemaTool !== "string") ||
      typeof schemaOffset !== "number" || !Number.isSafeInteger(schemaOffset) || schemaOffset < 0) {
      throw new Error("assigned_mcp_tool_invalid_arguments");
    }
    if (schemaOffset > 0 && !hasSchemaTool) {
      throw new Error("assigned_mcp_tool_invalid_arguments: A positive schemaOffset requires an exact inputSchemaRef in schemaTool. Omit schemaTool and schemaOffset to search assigned tools.");
    }
    // Intersect fresh grants with this session's pinned catalog. Revocations
    // take effect immediately; newly assigned tools require a new session.
    const current = new Map(deduplicateToolDescriptors(await input.gateway.listToolsForNamedGateway({
      gatewayPublicId: input.gatewayPublicId, bearerToken: input.bearerToken,
    })).map(tool => [tool.name, tool]));
    const terms = args.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const authorized = [...tools].filter(([, { tool }]) => {
      const fresh = current.get(tool.name);
      return fresh && permits(tool) && permits(tool, currentWorkMode) &&
        permits(fresh) && permits(fresh, currentWorkMode);
    });
    if (hasSchemaTool) {
      const selected = authorized.find(([name]) => name === args.schemaTool);
      if (!selected) throw new Error("assigned_mcp_tool_unknown: schemaTool must match an authorized inputSchemaRef. Omit schemaTool to search assigned tools, then use an exact inputSchemaRef from the results.");
      const schema = JSON.stringify(selected[1].schema);
      const end = schemaOffset + schemaChunkCharacters;
      return {
        name: selected[0], schemaJson: schema.slice(schemaOffset, end),
        nextSchemaOffset: end < schema.length ? end : null,
      };
    }
    // Keep offsets anchored to the pinned catalog while fresh grants only
    // decide which entries are returned from that stable sequence.
    const authorizedNames = new Set(authorized.map(([name]) => name));
    const matches = [...tools].filter(([, { tool }]) => permits(tool)).filter(([name, { tool }]) =>
      terms.every(term => `${name} ${tool.displayName} ${tool.description}`.toLowerCase().includes(term)))
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const page: ToolDefinition[] = [];
    let nextOffset = offset;
    while (nextOffset < matches.length && page.length < limit) {
      const [name, entry] = matches[nextOffset]!;
      if (!authorizedNames.has(name)) {
        nextOffset += 1;
        continue;
      }
      let next: ToolDefinition = structuredClone(entry.definition);
      if (Buffer.byteLength(JSON.stringify([next]), "utf8") > searchPageBytes) {
        // One large schema must not block browsing the tools after it. Expose
        // a reference whose schema can be fetched in bounded, reauthorized
        // chunks, without weakening the gateway's argument validation.
        next = { name, description: String(next.description).slice(0, 2000), inputSchemaRef: name };
      }
      if (Buffer.byteLength(JSON.stringify([...page, next]), "utf8") > searchPageBytes) {
        break;
      }
      page.push(next);
      nextOffset += 1;
    }
    return { tools: page, nextOffset: nextOffset < matches.length ? nextOffset : null };
  }

  const assigned = {
    definitions(fits?: (definitions: ToolDefinition[]) => boolean): ToolDefinition[] {
      const direct = [...((input.workMode ?? "standard") === "standard" ? catalog.definitions : catalog.readDefinitions)] as ToolDefinition[];
      if (input.delivery !== "on_demand" && unchecked.length === 0 && (!fits || fits(direct))) return direct;
      const compact = structuredClone(ON_DEMAND_TOOLS);
      if (fits && !fits(compact)) throw new Error("assigned_mcp_tool_catalog_capacity_exceeded");
      return compact;
    },
    has(name: string): boolean {
      return tools.has(name) || name === SEARCH_TOOL || name === CALL_TOOL;
    },
    async execute(call: { tool: string; arguments: unknown }, currentWorkMode?: WorkMode): Promise<unknown> {
      if (call.tool === SEARCH_TOOL) return search(call.arguments, currentWorkMode);
      let name = call.tool;
      let parameters = call.arguments;
      if (name === CALL_TOOL) {
        const args = object(parameters);
        if (typeof args.name !== "string") throw new Error("assigned_mcp_tool_invalid_arguments");
        name = args.name;
        parameters = object(args.arguments);
      }
      const descriptor = tools.get(name)?.tool;
      if (!descriptor) throw new Error("assigned_mcp_tool_unknown");
      if (!permits(descriptor) || !permits(descriptor, currentWorkMode)) throw new Error("paperclip_runner_tool_mode_denied");
      // Reauthorize through the existing gateway on every call. Discovery is
      // not a grant: revocation, policy, approval, and audit remain server-owned.
      const result = await input.gateway.executeTool({
        gatewayPublicId: input.gatewayPublicId,
        sessionToken: input.bearerToken,
        tool: descriptor.name,
        parameters,
      });
      if (result.status !== "completed" && result.status !== "replayed") {
        throw new Error("assigned_mcp_tool_execution_incomplete");
      }
      // The gateway normally throws provider errors. Keep a malformed or older
      // provider response from being reported as successful through PRP.
      if (result.result && typeof result.result === "object" && "isError" in result.result && result.result.isError === true) {
        throw new ToolGatewayHttpError(502, "The assigned tool returned an error.", "tool_error");
      }
      return result.result;
    },
    close(): void {
      collectedSessions.unregister(assigned);
      release();
    },
  };
  collectedSessions.register(assigned, release, assigned);
  return assigned;
}
