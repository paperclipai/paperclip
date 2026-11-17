/**
 * The only extension admitted to the qualified Pi process. The launcher loads
 * this immutable module explicitly; project/global extension discovery is off.
 * Structural types keep this module independent of Pi's optional UI packages.
 */
import { createHash } from "node:crypto";
import { PI_QUESTION_LABEL_MAX_LENGTH, piQuestionLabel, PiToolIdentities } from "./pi-acp-runtime.js";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PI_PERMISSION_TITLE_PREFIX = "paperclip.pi.permission.v1:";
export const PI_PERMISSION_OPTIONS = ["Allow once", "Allow for this session", "Deny"] as const;
export const PI_NATIVE_QUESTION_TOOL = "paperclip_native_question";
const MAX_CONFIGURATION_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TOOLS = 512;
// Match the sidecar safeText error bound; the extension is an immutable standalone module.
const MAX_ERROR_BYTES = 8_192;

interface PiUi {
  select(title: string, options: string[], options_?: { signal?: AbortSignal }): Promise<string | undefined>;
  confirm?(title: string, message: string, options?: { signal?: AbortSignal }): Promise<boolean>;
  input?(title: string, placeholder?: string, options?: { signal?: AbortSignal }): Promise<string | undefined>;
  editor?(title: string, prefill?: string): Promise<string | undefined>;
}

export interface PiExtensionContext { cwd: string; ui: PiUi }
export interface PiToolEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    context?: PiExtensionContext,
  ): Promise<{ content: Array<Record<string, unknown>>; details?: unknown }>;
}

export interface PiExtensionApi {
  registerTool(tool: PiToolDefinition): void;
  registerCommand(name: string, command: { description: string; handler(): Promise<void> }): void;
  on(event: "turn_start" | "turn_end", handler: () => void): void;
  on(event: "tool_call", handler: (
    event: PiToolEvent, context: PiExtensionContext,
  ) => Promise<{ block: true; reason: string } | undefined>): void;
  on(event: "user_bash", handler: () => { result: { output: string; exitCode: number; cancelled: boolean; truncated: boolean } }): void;
  on(event: "cache_warming_decision", handler: () => { action: "stop" }): void;
  on(event: "project_trust", handler: () => { trusted: "no"; remember: false }): void;
  on(event: "before_agent_start", handler: (event: { systemPrompt: string }) => { systemPrompt: string } | undefined): void;
}

export interface PiMcpServer {
  type: "http";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

export interface PiRuntimeConfiguration {
  invocationNamespace: string;
  servers: PiMcpServer[];
  workspace: string;
  /** Canonical server-registered agent_files working copy, never ambient HOME. */
  agentHome?: string;
  readOnly: boolean;
  readRoots: string[];
  protectedRoots: string[];
  instructions: string;
}

/** This environment is synthesized by the verified wrapper, never the model. */
export function readPiRuntimeConfiguration(environment: NodeJS.ProcessEnv): PiRuntimeConfiguration {
  const raw = environment.PAPERCLIP_PI_RUNTIME_CONFIGURATION;
  if (!raw || Buffer.byteLength(raw) > MAX_CONFIGURATION_BYTES) throw new Error("Pi runtime configuration is missing or oversized");
  const value = asRecord(JSON.parse(raw));
  const invocationNamespace = value.invocationNamespace;
  if (typeof invocationNamespace !== "string" || !/^[a-f0-9-]{36}$/.test(invocationNamespace)) throw new Error("Pi invocation namespace is invalid");
  const workspace = absolutePath(value.workspace, "workspace");
  if (typeof value.readOnly !== "boolean") throw new Error("Pi read-only policy is missing");
  if (!Array.isArray(value.servers) || value.servers.length > 16) throw new Error("Pi MCP configuration is invalid");
  const names = new Set<string>();
  const servers = value.servers.map((entry): PiMcpServer => {
    const server = asRecord(entry);
    if (server.type !== "http" || typeof server.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(server.name) || names.has(server.name)) {
      throw new Error("Pi MCP server identity is invalid");
    }
    names.add(server.name);
    if (typeof server.url !== "string") throw new Error("Pi MCP endpoint is invalid");
    const url = new URL(server.url);
    // Only session-bound gateways reach this configuration. Match the host's
    // assigned transport policy: HTTPS remotely, cleartext only on loopback.
    const cleartextLoopback = url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !cleartextLoopback) || url.username || url.password || url.hash) {
      throw new Error("Pi assigned MCP endpoint requires HTTPS or numeric loopback HTTP");
    }
    if (!Array.isArray(server.headers) || server.headers.length !== 1) throw new Error("Pi MCP authentication is invalid");
    const header = asRecord(server.headers[0]);
    if (header.name !== "Authorization" || typeof header.value !== "string" || !/^Bearer [A-Za-z0-9._~-]{16,4096}$/.test(header.value)) {
      throw new Error("Pi MCP authentication is invalid");
    }
    return { type: "http", name: server.name, url: url.href, headers: [{ name: "Authorization", value: header.value }] };
  });
  if (typeof value.instructions !== "string" || Buffer.byteLength(value.instructions) > 32 * 1024) throw new Error("Pi runtime instructions are invalid");
  return {
    invocationNamespace, servers, workspace, readOnly: value.readOnly,
    ...(value.agentHome === undefined ? {} : { agentHome: absolutePath(value.agentHome, "agent home") }),
    readRoots: pathList(value.readRoots, "read roots"),
    protectedRoots: pathList(value.protectedRoots, "protected roots"),
    instructions: value.instructions,
  };
}

function pathList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error(`Pi ${label} are invalid`);
  return value.map((path) => absolutePath(path, label));
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/.test(value) || value === "/") throw new Error(`Pi ${label} path is invalid`);
  return resolve(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Pi runtime record is invalid");
  return value as Record<string, unknown>;
}

function inside(root: string, target: string): boolean {
  const suffix = relative(root, target);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

/** Resolve every existing ancestor, including symlinks, before creating files. */
async function physicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return resolve(await physicalPath(dirname(path)), relative(dirname(path), path));
  }
}

/** Match the pinned Pi 1.0.0 tools/path-utils.js before authorizing a path.
 * Read may select any of its filename fallbacks; validate all of them so an
 * alternate spelling cannot select an unchecked symlink after approval.
 */
export function piNativeToolPaths(value: string, workspace: string, read: boolean): string[] {
  let normalized = value.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
  else if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
  if (/[\0\r\n]/.test(normalized)) throw new Error("Pi tool path is invalid");
  const path = resolve(workspace, normalized);
  if (!read) return [path];
  const nfd = path.normalize("NFD");
  return [...new Set([path, path.replace(/ (AM|PM)\./gi, "\u202F$1."), nfd, path.replace(/'/g, "\u2019"), nfd.replace(/'/g, "\u2019")])];
}

export async function checkPiNativeTool(
  event: PiToolEvent, context: PiExtensionContext, config: PiRuntimeConfiguration,
): Promise<string | null> {
  if (await realpath(context.cwd) !== await realpath(config.workspace)) return "Pi workspace changed after admission";
  if (config.agentHome && await realpath(config.agentHome) !== config.agentHome) return "Pi agent files changed after admission";
  const readTools = new Set(["read", "grep", "find", "ls"]);
  const fileTools = new Set([...readTools, "edit", "write"]);
  if (!fileTools.has(event.toolName) && event.toolName !== "bash") return "Unregistered Pi tool is not admitted";
  if (config.readOnly && !readTools.has(event.toolName)) return "This execution permits reading only";
  // Shell syntax is not a filesystem authorization language. The host sandbox
  // remains authoritative for commands; every command still crosses ACP policy.
  if (event.toolName === "bash") return null;
  const pathValue = event.input.path ?? (readTools.has(event.toolName) ? "." : undefined);
  if (typeof pathValue !== "string" || /[\0\r\n]/.test(pathValue)) return "Pi tool path is invalid";
  for (const logical of piNativeToolPaths(pathValue, config.workspace, event.toolName === "read")) {
    const target = await physicalPath(logical);
    if (!readTools.has(event.toolName)) {
      for (const root of config.readRoots) {
        if (inside(root, logical) || inside(await realpath(root), target)) return "Assigned Pi skills are read-only";
      }
    }
    for (const root of config.protectedRoots) {
      if (inside(root, logical) || inside(await physicalPath(root), target)) return "Pi tool targets protected runtime state";
    }
    const writableRoots = [config.workspace, ...(config.agentHome ? [config.agentHome] : [])];
    const roots = readTools.has(event.toolName) ? [...writableRoots, ...config.readRoots] : writableRoots;
    let admitted = false;
    for (const root of roots) {
      if (inside(root, logical) && inside(await realpath(root), target)) { admitted = true; break; }
    }
    if (!admitted) return "Pi tool path is outside its assigned workspace and agent files";
  }
  return null;
}

async function askPiNativeQuestion(args: Record<string, unknown>, ui: PiUi, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const boundedText = (value: unknown, limit = 16_384): string => {
    if (typeof value !== "string" || Buffer.byteLength(value) > limit) throw new Error("Pi question text is invalid or oversized");
    return value;
  };
  const title = piQuestionLabel(args.title);
  if (!title.trim() || title.startsWith(PI_PERMISSION_TITLE_PREFIX)) throw new Error("Pi question title is invalid");
  const method = args.method;
  const permitted = ["method", "title", ...(method === "select" ? ["options"] : method === "confirm" ? ["message"] : method === "input" ? ["placeholder"] : method === "editor" ? ["prefill"] : [])];
  if (Object.keys(args).some(key => !permitted.includes(key))) throw new Error("Pi question has unsupported fields");
  if (signal?.aborted) return { status: "cancelled" };
  if (method === "select") {
    if (!Array.isArray(args.options) || args.options.length < 1 || args.options.length > 128) throw new Error("Pi question options are invalid");
    const options = args.options.map(value => {
      const option = asRecord(value); const id = boundedText(option.id, 128); const label = piQuestionLabel(option.label);
      if (!/^[A-Za-z0-9_-]+$/.test(id) || !label.trim() || Object.keys(option).some(key => !["id", "label"].includes(key))) throw new Error("Pi question option is invalid");
      return { id, label };
    });
    if (new Set(options.map(option => option.id)).size !== options.length || new Set(options.map(option => option.label)).size !== options.length) throw new Error("Pi question options are ambiguous");
    const answer = await ui.select(title, options.map(option => option.label), { signal });
    if (signal?.aborted || answer === undefined) return { status: "cancelled" };
    const selected = options.find(option => option.label === answer);
    if (!selected) throw new Error("Pi question returned an unoffered option");
    return { status: "answered", optionId: selected.id };
  }
  if (method === "confirm") {
    if (!ui.confirm) throw new Error("Pi native confirmation is unavailable");
    const answer = await ui.confirm(title, boundedText(args.message), { signal });
    if (signal?.aborted) return { status: "cancelled" };
    if (typeof answer !== "boolean") throw new Error("Pi confirmation response is invalid");
    // Native Pi returns false for both No and dismissal. Never invent an answer.
    return { status: answer ? "answered" : "negative_or_cancelled", confirmed: answer };
  }
  if (method !== "input" && method !== "editor") throw new Error("Pi question method is unsupported");
  if (method === "input" && !ui.input || method === "editor" && !ui.editor) throw new Error("Pi native text question is unavailable");
  const value = method === "input"
    ? await ui.input!(title, args.placeholder === undefined ? undefined : boundedText(args.placeholder), { signal })
    : await ui.editor!(title, args.prefill === undefined ? undefined : boundedText(args.prefill));
  return signal?.aborted || value === undefined ? { status: "cancelled" } : { status: "answered", value: boundedText(value, 65_536) };
}

/** Keep authenticated tool validation useful without exposing transport credentials. */
function piMcpToolError(result: Record<string, unknown>, config: PiRuntimeConfiguration): Error {
  const fallback = "Paperclip tool request was rejected";
  if (!Array.isArray(result.content) || result.content.length > MAX_TOOLS) return new Error(`${fallback}: invalid error content`);
  const parts: string[] = [];
  for (const item of result.content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return new Error(`${fallback}: invalid error content`);
    const block = item as Record<string, unknown>;
    if (block.type !== "text" || typeof block.text !== "string") return new Error(`${fallback}: invalid error content`);
    parts.push(block.text);
  }
  if (result.structuredContent !== undefined) {
    if (!result.structuredContent || typeof result.structuredContent !== "object" || Array.isArray(result.structuredContent)) return new Error(`${fallback}: invalid error details`);
    parts.push(JSON.stringify(result.structuredContent));
  }
  let message = `${fallback}: ${parts.join("\n").trim() || "no validation details"}`;
  if (Buffer.byteLength(message) > MAX_ERROR_BYTES) return new Error(`${fallback}: error content exceeds ${MAX_ERROR_BYTES} bytes`);
  const boundSecrets = [process.env.OPENROUTER_API_KEY, ...config.servers.flatMap(server => server.headers.flatMap(header => [header.value, header.value.replace(/^Bearer /, "")]))];
  for (const secret of boundSecrets) if (secret) message = message.split(secret).join("[REDACTED]");
  // Use the same labelled-secret rule as sidecar safeText, also covering JSON
  // quoted keys and bearer values that can occur in gateway error text.
  message = message.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/(key|token|secret|password|authorization)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\]]+)/gi, "$1=[REDACTED]");
  return new Error(Buffer.byteLength(message) <= MAX_ERROR_BYTES ? message : `${fallback}: redacted error content exceeds ${MAX_ERROR_BYTES} bytes`);
}

/** Bounded JSON MCP client for runner-owned HTTP bridges. No redirects or files. */
export async function piMcpRequest(
  server: PiMcpServer,
  method: string,
  params: Record<string, unknown>,
  id: string,
  signal?: AbortSignal,
  fetch_: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const request = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  if (Buffer.byteLength(request) > 1_048_576) throw new Error("Pi MCP request is oversized");
  const timeout = AbortSignal.timeout(method === "tools/call" ? 24 * 60 * 60 * 1000 : 30_000);
  const response = await fetch_(server.url, {
    method: "POST", redirect: "error",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...Object.fromEntries(server.headers.map((h) => [h.name, h.value])) },
    body: request, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok || !response.body) throw new Error(`Pi MCP ${method} failed (HTTP ${response.status})`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error("Pi MCP response is oversized");
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const message = asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (message.jsonrpc !== "2.0" || message.id !== id) throw new Error("Pi MCP response identity mismatch");
  if (message.error) throw new Error(`Pi MCP ${method} was rejected`);
  return asRecord(message.result);
}

export async function installPiRuntimeExtension(
  pi: PiExtensionApi,
  config: PiRuntimeConfiguration,
  request: typeof piMcpRequest = piMcpRequest,
): Promise<void> {
  // Registered names are held in this closure; provider-originated metadata
  // cannot promote a tool to the authenticated Paperclip bridge.
  const identities = new PiToolIdentities(config.invocationNamespace);
  pi.on("turn_start", () => identities.begin());
  pi.on("turn_end", () => identities.end());
  const bridgeTools = new Set<string>();
  const permissionGrants = new Set<string>();
  const agentHomeIdentity = config.agentHome ? await lstat(config.agentHome, { bigint: true }) : undefined;
  if (config.agentHome) {
    if (!agentHomeIdentity!.isDirectory() || await realpath(config.agentHome) !== config.agentHome) throw new Error("Pi agent files are not a canonical registered directory");
    for (const root of config.protectedRoots) {
      const physical = await physicalPath(root);
      if (inside(config.agentHome, physical) || inside(physical, config.agentHome)) throw new Error("Pi agent files overlap protected runtime state");
    }
  }
  const checkPolicy = async (event: PiToolEvent, context: PiExtensionContext): Promise<string | null> => {
    if (config.agentHome && agentHomeIdentity) {
      const named = await lstat(config.agentHome, { bigint: true });
      if (!named.isDirectory() || named.dev !== agentHomeIdentity.dev || named.ino !== agentHomeIdentity.ino) return "Pi agent files were replaced after admission";
    }
    return checkPiNativeTool(event, context, config);
  };
  // Assigned skills are a separate immutable lease. A config or executable
  // directory must never gain readability by being presented as a skill root.
  for (const root of config.readRoots) {
    const physicalRoot = await realpath(root);
    for (const protectedRoot of config.protectedRoots) {
      const physicalProtected = await physicalPath(protectedRoot);
      if (inside(protectedRoot, root) || inside(root, protectedRoot) || inside(physicalProtected, physicalRoot) || inside(physicalRoot, physicalProtected)) {
        throw new Error("Pi assigned skills overlap protected runtime state");
      }
    }
  }
  // Pi 1 defaults to paid streaming cache refreshes. Runner admits only explicit
  // turns; background inference must not outlive or bypass that cost authority.
  pi.on("cache_warming_decision", () => ({ action: "stop" }));
  pi.on("project_trust", () => ({ trusted: "no", remember: false }));
  pi.on("user_bash", () => ({ result: { output: "Interactive shell commands are disabled in Paperclip Runner", exitCode: 1, cancelled: false, truncated: false } }));
  pi.on("before_agent_start", (event) => config.instructions
    ? { systemPrompt: `${event.systemPrompt}\n\n${config.instructions}` } : undefined);
  pi.on("tool_call", async (event, context) => {
    try {
      const toolCallId = identities.bind(event.toolCallId, event.toolName, event.input, true);
      if (bridgeTools.has(event.toolName) || event.toolName === PI_NATIVE_QUESTION_TOOL) return;
      const denial = await checkPolicy(event, context);
      if (denial) return { block: true, reason: denial };
      const detail = JSON.stringify({ toolCallId, ...identities.provenance(toolCallId), toolName: event.toolName, input: event.input });
      if (Buffer.byteLength(detail) > 48 * 1024) return { block: true, reason: "Pi permission request is oversized" };
      // A session grant covers only the identical operation, never a whole
      // tool class or a subsequent path. Paths are still revalidated each time.
      const grantKey = JSON.stringify([event.toolName, event.input]);
      const selection = permissionGrants.has(grantKey) ? "Allow for this session"
        : await context.ui.select(`${PI_PERMISSION_TITLE_PREFIX}${detail}`, [...PI_PERMISSION_OPTIONS]);
      if (selection !== "Allow once" && selection !== "Allow for this session") return { block: true, reason: "Pi operation was denied or cancelled" };
      // Re-check file bindings after a human wait; approval never freezes paths.
      const changed = await checkPolicy(event, context);
      if (!changed && selection === "Allow for this session" && permissionGrants.size < 4096) permissionGrants.add(grantKey);
      return changed ? { block: true, reason: changed } : undefined;
    } catch { return { block: true, reason: "Pi permission boundary is unavailable" }; }
  });
  const questions = new Map<string, Promise<{ content: Array<Record<string, unknown>>; details: unknown }>>();
  pi.registerTool({
    name: PI_NATIVE_QUESTION_TOOL, label: "Ask a native question",
    description: "Ask the human a native Pi select, confirm, input, or editor question. Select is single-choice and returns the supplied stable option ID. This cannot approve tools or a Paperclip Plan. For durable task questions or Plan approval use the assigned Paperclip semantic tools. Cancellation is not an answer; confirm false means No or dismissal.",
    // Model gateways may render only the root properties when describing a
    // tool. Expose the field types there as well as in the strict method
    // branches, so an array of options cannot be mistaken for JSON text.
    parameters: { type: "object", additionalProperties: false, required: ["method", "title"], properties: {
      method: { type: "string", enum: ["select", "confirm", "input", "editor"] },
      title: { type: "string", maxLength: PI_QUESTION_LABEL_MAX_LENGTH },
      options: { type: "array", minItems: 1, maxItems: 128, items: { type: "object", additionalProperties: false, required: ["id", "label"], properties: { id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" }, label: { type: "string", maxLength: PI_QUESTION_LABEL_MAX_LENGTH } } } },
      message: { type: "string", maxLength: 16384 },
      placeholder: { type: "string", maxLength: 16384 },
      prefill: { type: "string", maxLength: 16384 },
    }, anyOf: [
      { type: "object", additionalProperties: false, required: ["method", "title", "options"], properties: {
        method: { const: "select" }, title: { type: "string", maxLength: PI_QUESTION_LABEL_MAX_LENGTH },
        options: { type: "array", minItems: 1, maxItems: 128, items: { type: "object", additionalProperties: false, required: ["id", "label"], properties: { id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" }, label: { type: "string", maxLength: PI_QUESTION_LABEL_MAX_LENGTH } } } },
      } },
      { type: "object", additionalProperties: false, required: ["method", "title", "message"], properties: {
        method: { const: "confirm" }, title: { type: "string", maxLength: PI_QUESTION_LABEL_MAX_LENGTH }, message: { type: "string", maxLength: 16384 },
      } },
      { type: "object", additionalProperties: false, required: ["method", "title"], properties: {
        method: { const: "input" }, title: { type: "string", maxLength: PI_QUESTION_LABEL_MAX_LENGTH }, placeholder: { type: "string", maxLength: 16384 },
      } },
      { type: "object", additionalProperties: false, required: ["method", "title"], properties: {
        method: { const: "editor" }, title: { type: "string", maxLength: PI_QUESTION_LABEL_MAX_LENGTH }, prefill: { type: "string", maxLength: 16384 },
      } },
    ] },
    async execute(callId, args, signal, _onUpdate, context) {
      const id = identities.bind(callId, PI_NATIVE_QUESTION_TOOL, args);
      const previous = questions.get(id); if (previous) return previous;
      if (!context?.ui || questions.size >= 4096) throw new Error("Pi native question context is unavailable or exhausted");
      const pending = askPiNativeQuestion(args, context.ui, signal).then(result => ({ content: [{ type: "text", text: JSON.stringify(result) }], details: result }));
      questions.set(id, pending); return pending;
    },
  });
  let count = 0;
  for (const server of config.servers) {
    await request(server, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "paperclip-pi", version: "1" } }, `pi-init-${server.name}`);
    const catalog = await request(server, "tools/list", {}, `pi-tools-${server.name}`);
    if (!Array.isArray(catalog.tools) || catalog.nextCursor) throw new Error("Pi MCP catalog is incomplete");
    for (const rawTool of catalog.tools) {
      const tool = asRecord(rawTool);
      if (typeof tool.name !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(tool.name)) throw new Error("Pi MCP tool name is invalid");
      const readableName = `mcp__${server.name}__${tool.name}`;
      // MCP names may contain colons/periods and exceed model tool-name limits.
      // Preserve the exact source identity only in the authenticated call closure;
      // a framed digest avoids lossy replacement collisions (a:b versus a_b).
      const nativeName = /^[A-Za-z0-9_-]{1,64}$/.test(readableName) ? readableName
        : `mcp__${createHash("sha256").update(JSON.stringify([server.name, tool.name])).digest("hex").slice(0, 59)}`;
      if (bridgeTools.has(nativeName) || ++count > MAX_TOOLS) throw new Error("Pi MCP catalog is ambiguous or oversized");
      const schema = asRecord(tool.inputSchema);
      if (schema.type !== "object") throw new Error("Pi MCP tool parameters must be an object");
      const sourceName = tool.name;
      const definition: PiToolDefinition = {
        name: nativeName, label: `${server.name}: ${sourceName}`,
        description: typeof tool.description === "string" ? tool.description : sourceName,
        parameters: structuredClone(schema),
        async execute(callId, arguments_, signal) {
          const requestId = identities.bind(callId, nativeName, arguments_);
          const result = await request(server, "tools/call", { name: sourceName, arguments: arguments_ }, requestId, signal);
          if (result.isError !== undefined && typeof result.isError !== "boolean") throw new Error("Pi MCP tool error flag is invalid");
          if (result.isError === true) throw piMcpToolError(result, config);
          if (!Array.isArray(result.content)) throw new Error("Pi MCP tool result is invalid");
          const content = result.content.map((item) => {
            const block = asRecord(item);
            if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
            if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") return { type: "image", data: block.data, mimeType: block.mimeType };
            // Resource links and structured outputs stay visible as data. They
            // never cause the extension to fetch a URL or open a returned path.
            return { type: "text", text: JSON.stringify(block) };
          });
          return { content, ...(result.structuredContent === undefined ? {} : { details: result.structuredContent }) };
        },
      };
      pi.registerTool(definition);
      bridgeTools.add(nativeName);
    }
  }
  // Pi reports extension-load failures and may continue. The wrapper requires
  // this exact sentinel before admitting prompts, so a failed extension cannot
  // silently leave native tools unguarded. Register only after every MCP binds.
  pi.registerCommand("paperclip-runtime-ready-v1", {
    description: "Paperclip runtime gate v1",
    async handler() {},
  });
}

export default async function paperclipPiExtension(pi: PiExtensionApi): Promise<void> {
  const configuration = readPiRuntimeConfiguration(process.env);
  // Do not let the model's shell tool inherit authenticated MCP credentials.
  delete process.env.PAPERCLIP_PI_RUNTIME_CONFIGURATION;
  await installPiRuntimeExtension(pi, configuration);
}
