/** Source for the helper embedded in patches/pi-acp@0.0.33.patch. */
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";

const PERMISSION_PREFIX = "paperclip.pi.permission.v1:";
const PERMISSION_CHOICES = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_always", name: "Allow for this session", kind: "allow_always" },
  { optionId: "reject_once", name: "Deny", kind: "reject_once" },
];
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Pi runtime record");
  return value as RecordValue;
}
function text(value: unknown, max = 16_384): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > max) throw new Error("Invalid Pi runtime text");
  return value;
}

export const PI_ACP_FEATURES = Object.freeze({
  version: 1, steering: true, queuedFollowUp: true,
  questions: ["select", "confirm", "input", "editor"],
  nativePermissions: true, promptUsage: true, nativePlan: false,
  pendingRequestRecovery: "live-process-only",
});

export interface PiAssistantBoundary {
  messageId: string;
  phase: "start" | "delta" | "end";
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
}

/** Pi 1 RPC serializes message_update without message/partial. Reconstruct only
 * the streaming view, anchored to the actual message_start; message_end remains
 * the native authoritative receipt. Never infer an executable tool from text. */
export class PiRpcMessageDeltas {
  private active: RecordValue | null = null;
  private blocks = new Map<number, { kind: string; ended: boolean; id?: string; name?: string; json: string; final?: string }>();
  private streamedBytes = 0;
  private failed = false;
  private fail(): never { this.failed = true; throw new Error("Pi RPC message delta boundary is invalid"); }
  normalize(event: RecordValue): RecordValue {
    if (this.failed) return this.fail();
    if (event.type === "message_start" && event.message && typeof event.message === "object" && (event.message as RecordValue).role === "assistant") {
      if (this.active) return this.fail();
      this.active = event.message as RecordValue; this.blocks.clear(); this.streamedBytes = 0;
      return event;
    }
    if (event.type === "message_end" && event.message && typeof event.message === "object" && (event.message as RecordValue).role === "assistant") {
      const message = event.message as RecordValue;
      if (!this.active || message.timestamp !== this.active.timestamp) return this.fail();
      if (!["error", "aborted"].includes(String(message.stopReason)) && [...this.blocks.values()].some(block => !block.ended)) return this.fail();
      for (const [index, block] of this.blocks) if (block.ended) {
        const final = Array.isArray(message.content) ? message.content[index] : undefined;
        if (!final || typeof final !== "object") return this.fail();
        if (block.kind === "toolcall") {
          if (final.type !== "toolCall" || toolSignature(final.id, final.name, final.arguments) !== block.final) return this.fail();
        } else if (final.type !== block.kind || final[block.kind === "text" ? "text" : "thinking"] !== block.json) return this.fail();
      }
      this.active = null; this.blocks.clear(); return event;
    }
    if (event.type !== "message_update") return event;
    if (!this.active || event.message !== undefined || !event.assistantMessageEvent || typeof event.assistantMessageEvent !== "object" || Array.isArray(event.assistantMessageEvent)) return this.fail();
    const update = event.assistantMessageEvent as RecordValue;
    if (update.partial !== undefined || typeof update.type !== "string") return this.fail();
    const match = /^(text|thinking|toolcall)_(start|delta|end)$/.exec(update.type);
    const index = update.contentIndex;
    if (!match || !Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= 4096) return this.fail();
    const [, kind, phase] = match;
    let block = this.blocks.get(index as number);
    if (phase === "start") {
      if (block) return this.fail();
      block = { kind: kind!, ended: false, json: "" };
      if (kind === "toolcall") {
        if (typeof update.id !== "string" || Buffer.byteLength(update.id) > 256 || typeof update.toolName !== "string" || Buffer.byteLength(update.toolName) > 256) return this.fail();
        if (update.id && [...this.blocks.values()].some(other => other.id === update.id)) return this.fail();
        block.id = update.id; block.name = update.toolName;
      }
      this.blocks.set(index as number, block);
    } else if (!block || block.ended || block.kind !== kind) return this.fail();
    if (phase === "delta") {
      if (typeof update.delta !== "string" || Buffer.byteLength(update.delta) > 262_144) return this.fail();
      this.streamedBytes += Buffer.byteLength(update.delta);
      if (this.streamedBytes > 4 * 1024 * 1024) return this.fail();
      block!.json += update.delta;
      if (kind === "toolcall" && Buffer.byteLength(block!.json) > 1_048_576) return this.fail();
    }
    let toolCall: RecordValue | undefined;
    if (kind === "toolcall") {
      if (phase === "end") {
        if (!update.toolCall || typeof update.toolCall !== "object" || Array.isArray(update.toolCall)) return this.fail();
        const final = update.toolCall as RecordValue;
        if (final.type !== "toolCall" || typeof final.id !== "string" || !final.id || Buffer.byteLength(final.id) > 256 || typeof final.name !== "string" || !final.name || Buffer.byteLength(final.name) > 256
          || block!.id && block!.id !== final.id || block!.name && block!.name !== final.name
          || [...this.blocks.entries()].some(([otherIndex, other]) => otherIndex !== index && other.id === final.id)
          || !final.arguments || typeof final.arguments !== "object" || Array.isArray(final.arguments) || Buffer.byteLength(JSON.stringify(final.arguments)) > 1_048_576) return this.fail();
        block!.id = final.id; block!.name = final.name; block!.final = toolSignature(final.id, final.name, final.arguments); toolCall = final;
      } else toolCall = { type: "toolCall", id: block!.id, name: block!.name, partialArgs: block!.json };
    }
    if (phase === "end") {
      if (kind !== "toolcall" && (typeof update.content !== "string" || update.content !== block!.json)) return this.fail();
      block!.ended = true;
    }
    return { ...event, message: { ...this.active, content: [] }, assistantMessageEvent: { ...update, ...(toolCall ? { toolCall } : {}) } };
  }
}

function toolSignature(id: unknown, name: unknown, args: unknown): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  return JSON.stringify([id, name, canonical(args)]);
}

/** A closed diagnostic vocabulary: raw exception text, paths, provider bodies
 * and credentials never cross the wrapper boundary. Unknown failures stay
 * generic rather than masquerading as a known local or provider condition. */
export function piNativeFailure(value: unknown): { reason: string; summary: string } {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  const known: Record<string, string> = {
    "Pi RPC message delta boundary is invalid": "rpc_delta_boundary_invalid",
    "Pi native assistant message boundary is invalid": "assistant_boundary_invalid",
    "Pi native tool invocation identity conflict": "tool_identity_conflict",
    "Pi model iteration identity is ambiguous": "model_iteration_ambiguous",
    "Pi model iteration identity is unavailable": "model_iteration_unavailable",
    "Pi tool invocation has no active model iteration": "tool_iteration_missing",
    "Pi tool identity is outside its iteration bound": "tool_iteration_bound",
    "Pi RPC frame exceeds its bound": "rpc_frame_oversized",
    "Pi RPC stream ended inside a frame": "rpc_frame_incomplete",
    "Pi usage receipt is invalid": "usage_receipt_invalid",
    "Pi process exited before its next request": "provider_process_exited",
  };
  if (Object.hasOwn(known, message)) return { reason: known[message]!, summary: message };
  const status = /^(?:pi prompt failed: )?(401|403|429|500|502|503|504)(?::|\b)/.exec(message.slice(0, 128))?.[1];
  if (status) return { reason: `provider_http_${status}`, summary: `Pi provider request failed (HTTP ${status})` };
  return { reason: "unknown_native_failure", summary: "Pi native runtime failed; diagnostic details were withheld" };
}

/** IDs are allocated only at actual SDK assistant message_start events. Tool
 * iterations, retries, notices and ACP prompts cannot create assistant IDs. */
export class PiAssistantMessages {
  private ordinal = 0;
  private active: { messageId: string; timestamp: number } | null = null;
  private poisoned = false;
  private readonly namespace: string;
  constructor(namespace: string) {
    this.namespace = namespace;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(namespace)) throw new Error("Pi assistant namespace is invalid");
  }
  private fail(): never { this.poisoned = true; throw new Error("Pi native assistant message boundary is invalid"); }
  normalize(event: RecordValue): RecordValue {
    if (this.poisoned) return this.fail();
    if (event.type === "agent_settled") {
      if (this.active) return this.fail();
      return event;
    }
    if (!["message_start", "message_update", "message_end"].includes(String(event.type))) return event;
    const message = event.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) return this.fail();
    const native = message as RecordValue;
    if (native.role !== "assistant") {
      if (event.type === "message_update" || this.active || !["user", "toolResult", "system"].includes(String(native.role))) return this.fail();
      // Pi 1 records prompt/tool declaration updates as structural system messages.
      // They never receive an assistant occurrence or become final-answer content.
      if (native.role === "system" && (typeof native.content !== "string" || !Number.isSafeInteger(native.timestamp) || (native.timestamp as number) < 0)) return this.fail();
      return event;
    }
    if (!Number.isSafeInteger(native.timestamp) || (native.timestamp as number) < 0 || !Array.isArray(native.content)) return this.fail();
    let boundary: PiAssistantBoundary;
    if (event.type === "message_start") {
      if (this.active || this.ordinal >= Number.MAX_SAFE_INTEGER) return this.fail();
      const messageId = `pi-message-${createHash("sha256").update(JSON.stringify([this.namespace, ++this.ordinal])).digest("hex")}`;
      this.active = { messageId, timestamp: native.timestamp as number };
      boundary = { messageId, phase: "start" };
    } else {
      if (!this.active || this.active.timestamp !== native.timestamp) return this.fail();
      boundary = { messageId: this.active.messageId, phase: event.type === "message_end" ? "end" : "delta" };
      if (event.type === "message_end") {
        if (!["stop", "length", "toolUse", "error", "aborted"].includes(String(native.stopReason))) return this.fail();
        boundary.stopReason = native.stopReason as PiAssistantBoundary["stopReason"];
        this.active = null;
      }
    }
    return { ...event, paperclipAssistantMessage: boundary };
  }
}

export function piAssistantChunk(boundaryValue: unknown, textValue: unknown = "", thought = false): RecordValue {
  const boundary = record(boundaryValue);
  const messageId = text(boundary.messageId, 96);
  if (!/^pi-message-[a-f0-9]{64}$/.test(messageId) || !["start", "delta", "end"].includes(String(boundary.phase))) throw new Error("Pi assistant chunk lacks native provenance");
  if (boundary.phase === "end" && !["stop", "length", "toolUse", "error", "aborted"].includes(String(boundary.stopReason))) throw new Error("Pi assistant chunk end is invalid");
  const content = text(textValue, 262_144);
  if (boundary.phase !== "delta" && (content || thought)) throw new Error("Pi assistant boundary cannot carry synthetic content");
  return { sessionUpdate: thought ? "agent_thought_chunk" : "agent_message_chunk", messageId,
    content: { type: "text", text: content },
    _meta: { origin: "pi-native-assistant", source: "pi-rpc-message-v1", kind: boundary.phase === "end" ? `end:${boundary.stopReason}` : boundary.phase },
  };
}

export function piHistoricalAssistantChunk(sessionId: string, messageIndex: number, value: string): RecordValue {
  if (!sessionId || !Number.isSafeInteger(messageIndex) || messageIndex < 0) throw new Error("Pi historical assistant identity is invalid");
  return { sessionUpdate: "agent_message_chunk",
    messageId: `pi-history-message-${createHash("sha256").update(JSON.stringify([text(sessionId, 1024), messageIndex])).digest("hex")}`,
    content: { type: "text", text: text(value, 262_144) },
    _meta: { origin: "pi-history-assistant", source: "pi-session-history-v1", kind: "history" },
  };
}

/** One trusted Pi model iteration, not one ACP prompt. Pi resets its own turnIndex
 * on warm prompts; our ordinal is monotonic for the lifetime of the child. */
export class PiToolIdentities {
  private ordinal = 0;
  private active = false;
  private poisoned = false;
  private entries = new Map<string, { id: string; nativeId: string; fingerprint?: string; claimed: boolean }>();
  private namespace: string;
  constructor(namespace: string) {
    this.namespace = namespace;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(namespace)) throw new Error("Pi invocation namespace is invalid");
  }
  private fail(message: string): never { this.poisoned = true; throw new Error(message); }
  begin(): void {
    if (this.poisoned || this.active || this.ordinal >= Number.MAX_SAFE_INTEGER) this.fail("Pi model iteration identity is ambiguous");
    this.ordinal++; this.active = true; this.entries.clear();
  }
  end(): void {
    if (this.poisoned || !this.active) this.fail("Pi model iteration identity is unavailable");
    this.active = false;
  }
  identity(nativeId: unknown): string {
    if (this.poisoned || this.ordinal === 0) this.fail("Pi model iteration identity is unavailable");
    let native: string;
    try { native = text(nativeId, 256); } catch { return this.fail("Pi native tool identity is invalid"); }
    if (!native) this.fail("Pi native tool identity is missing");
    const prior = this.entries.get(native);
    if (prior) return prior.id;
    if (!this.active || this.entries.size >= 4096) this.fail("Pi tool identity is outside its iteration bound");
    const id = `pi-${createHash("sha256").update(JSON.stringify([this.namespace, this.ordinal, native])).digest("hex")}`;
    this.entries.set(native, { id, nativeId: native, claimed: false });
    return id;
  }
  bind(nativeId: string, name: string, args: unknown, claim = false): string {
    if (this.poisoned || !this.active) this.fail("Pi tool invocation has no active model iteration");
    const id = this.identity(nativeId); const entry = this.entries.get(nativeId)!;
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
    let encoded: string;
    try { encoded = JSON.stringify([text(name, 256), canonical(args)]); }
    catch { return this.fail("Pi tool invocation is invalid"); }
    if (Buffer.byteLength(encoded) > 1_048_576) this.fail("Pi tool invocation is oversized");
    const fingerprint = createHash("sha256").update(encoded).digest("hex");
    if ((claim && entry.claimed) || (entry.fingerprint !== undefined && entry.fingerprint !== fingerprint)) this.fail("Pi native tool invocation identity conflict");
    entry.fingerprint = fingerprint; if (claim) entry.claimed = true;
    return id;
  }
  provenance(id: string): RecordValue | undefined {
    for (const entry of this.entries.values()) if (entry.id === id) return { nativeToolCallId: entry.nativeId, modelIteration: this.ordinal, identityScope: "native-model-iteration" };
    return undefined;
  }
  normalize(event: RecordValue): RecordValue {
    if (event.type === "turn_start") { this.begin(); return event; }
    if (event.type === "turn_end") { this.end(); return event; }
    if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(String(event.type))) {
      const native = text(event.toolCallId, 256);
      const id = event.type === "tool_execution_start" ? this.bind(native, text(event.toolName, 256), event.args, true) : this.identity(native);
      return { ...event, toolCallId: id };
    }
    if (event.type === "message_update" && event.assistantMessageEvent) {
      const update = record(event.assistantMessageEvent);
      const normalizeTool = (value: unknown, direct = false): unknown => {
        if (!value || typeof value !== "object") return value;
        const block = record(value);
        // Empty IDs during initial streaming do not identify an executable call.
        return (direct || block.type === "toolCall") && typeof block.id === "string" && block.id
          ? { ...block, id: direct && update.type === "toolcall_end"
            ? this.bind(block.id, text(block.name, 256), block.arguments) : this.identity(block.id) } : value;
      };
      const partial = update.partial && typeof update.partial === "object" ? record(update.partial) : undefined;
      return { ...event, assistantMessageEvent: { ...update,
        ...(update.toolCall ? { toolCall: normalizeTool(update.toolCall, true) } : {}),
        ...(partial && Array.isArray(partial.content) ? { partial: { ...partial, content: partial.content.map((block) => normalizeTool(block)) } } : {}),
      } };
    }
    return event;
  }
}

/** Session history is presentation-only and must never acquire a live delivery ID. */
export function piHistoricalToolIdentity(sessionId: string, messageIndex: number, nativeId: string): { id: string; provenance: RecordValue } {
  const session = text(sessionId, 1024); const native = text(nativeId, 256);
  if (!session || !native || !Number.isSafeInteger(messageIndex) || messageIndex < 0) throw new Error("Pi history tool identity is invalid");
  return { id: `pi-history-${createHash("sha256").update(JSON.stringify([session, messageIndex, native])).digest("hex")}`,
    provenance: { nativeToolCallId: native, historyMessageIndex: messageIndex, identityScope: "history-display-only" } };
}

/** Strict LF framing: Unicode line separators inside JSON are ordinary text. */
export class PiRpcFrames {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private readonly receive: (value: RecordValue) => void;
  private readonly limit: number;
  constructor(receive: (value: RecordValue) => void, limit = 4 * 1024 * 1024) { this.receive = receive; this.limit = limit; }
  write(chunk: Uint8Array): void {
    this.pending += this.decoder.write(Buffer.from(chunk));
    for (;;) {
      const index = this.pending.indexOf("\n");
      if (index < 0) break;
      const line = this.pending.slice(0, index).replace(/\r$/, "");
      this.pending = this.pending.slice(index + 1);
      if (Buffer.byteLength(line) > this.limit) throw new Error("Pi RPC frame exceeds its bound");
      if (line.trim()) this.receive(record(JSON.parse(line)));
    }
    if (Buffer.byteLength(this.pending) > this.limit) throw new Error("Pi RPC frame exceeds its bound");
  }
  end(): void {
    this.pending += this.decoder.end();
    if (this.pending.trim()) throw new Error("Pi RPC stream ended inside a frame");
  }
}

function requiredFile(environment: NodeJS.ProcessEnv, name: string): string {
  const path = environment[name];
  if (!path || !isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error(`Missing verified Pi launch binding: ${name}`);
  // This checks the handoff shape. The runner command lease verifies all bytes,
  // retains their directory identity, and owns the subprocess lifetime.
  if (!lstatSync(path).isFile()) throw new Error(`Invalid verified Pi launch binding: ${name}`);
  return path;
}
function pathArray(raw: string | undefined): string[] {
  const paths: unknown = JSON.parse(raw ?? "[]");
  if (!Array.isArray(paths) || paths.length > 128 || paths.some((p) => typeof p !== "string" || !isAbsolute(p) || /[\0\r\n]/.test(p))) throw new Error("Invalid Pi runtime paths");
  return paths;
}

/** Provider tool events are untrusted; diff projection cannot read host files. */
export function snapshotPiWorkspaceFile(cwd: string, path: string, environment: NodeJS.ProcessEnv = process.env): string {
  const root = realpathSync(cwd);
  const logical = resolve(root, path);
  const physical = realpathSync(logical);
  const within = (base: string, target: string): boolean => {
    const suffix = relative(base, target);
    return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
  };
  if (!within(root, logical) || !within(root, physical)) throw new Error("Pi diff escaped its workspace");
  for (const protectedPath of pathArray(environment.PAPERCLIP_PI_PROTECTED_ROOTS)) {
    if (within(protectedPath, logical)) throw new Error("Pi diff targets protected state");
    let protectedPhysical: string;
    try { protectedPhysical = realpathSync(protectedPath); } catch { continue; }
    if (within(protectedPhysical, physical)) throw new Error("Pi diff targets protected state");
  }
  const fd = openSync(physical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 4n * 1024n * 1024n) throw new Error("Pi diff file is unsupported");
    const result = readFileSync(fd, "utf8");
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(physical, { bigint: true });
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.ctimeNs !== after.ctimeNs || named.ino !== before.ino || named.dev !== before.dev || realpathSync(logical) !== physical) throw new Error("Pi diff file changed during capture");
    return result;
  } finally { closeSync(fd); }
}

export function createPiLaunchSpec(
  params: { cwd: string; mcpServers?: unknown[]; sessionPath?: string },
  environment: NodeJS.ProcessEnv,
): { command: string; args: string[]; env: NodeJS.ProcessEnv; invocationNamespace: string } {
  if (environment.PAPERCLIP_ACPX_ISOLATED_CONTEXT !== "1") throw new Error("Pi requires an isolated runner launch");
  const command = requiredFile(environment, "PAPERCLIP_PI_NODE_EXECUTABLE");
  const entrypoint = requiredFile(environment, "PAPERCLIP_PI_ENTRYPOINT");
  const extension = requiredFile(environment, "PAPERCLIP_PI_EXTENSION_PATH");
  if (environment.PAPERCLIP_PI_READ_ONLY !== "0" && environment.PAPERCLIP_PI_READ_ONLY !== "1") throw new Error("Pi requires an explicit read-only policy");
  const readRoots = pathArray(environment.PAPERCLIP_PI_READ_ROOTS);
  const protectedRoots = pathArray(environment.PAPERCLIP_PI_PROTECTED_ROOTS);
  const workspace = realpathSync(params.cwd);
  const suppliedAgentHome = environment.PAPERCLIP_PI_AGENT_HOME;
  let agentHome: string | undefined;
  if (suppliedAgentHome !== undefined) {
    if (!isAbsolute(suppliedAgentHome) || /[\0\r\n]/.test(suppliedAgentHome) || suppliedAgentHome === "/" || !lstatSync(suppliedAgentHome).isDirectory() || realpathSync(suppliedAgentHome) !== suppliedAgentHome) throw new Error("Pi agent files require a canonical registered directory");
    agentHome = suppliedAgentHome;
  }
  const invocationNamespace = randomUUID();
  const configuration = JSON.stringify({
    invocationNamespace, workspace, servers: params.mcpServers ?? [],
    readOnly: environment.PAPERCLIP_PI_READ_ONLY === "1",
    readRoots, protectedRoots,
    ...(agentHome ? { agentHome } : {}),
    instructions: environment.PAPERCLIP_PI_SYSTEM_INSTRUCTIONS ?? "",
  });
  if (Buffer.byteLength(configuration) > 64 * 1024) throw new Error("Pi launch configuration exceeds its bound");
  const guard = environment.PAPERCLIP_PI_MODULE_GUARD_PATH === undefined ? []
    : ["--require", requiredFile(environment, "PAPERCLIP_PI_MODULE_GUARD_PATH")];
  const args = [...guard, entrypoint, "--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "--offline", "-e", extension];
  for (const root of readRoots) args.push("--skill", root);
  if (params.sessionPath) {
    const home = environment.PI_CODING_AGENT_DIR;
    if (!home) throw new Error("Pi session home is missing");
    const sessionRoot = realpathSync(resolve(home, "sessions"));
    const sessionPath = realpathSync(params.sessionPath);
    const suffix = relative(sessionRoot, sessionPath);
    if (!suffix || isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`) || !lstatSync(params.sessionPath).isFile()) throw new Error("Pi session escaped its private home");
    args.push("--session", sessionPath);
  }
  const env: NodeJS.ProcessEnv = { ...environment, PAPERCLIP_PI_RUNTIME_CONFIGURATION: configuration };
  // Ambient AGENT_HOME never grants filesystem authority. Only the runner's
  // authenticated working-copy binding reaches both the model and tool gate.
  if (agentHome) env.AGENT_HOME = agentHome; else delete env.AGENT_HOME;
  return { command, args, invocationNamespace, env };
}

// Same UTF-16 character bound as the canonical question-set title/header/label.
export const PI_QUESTION_LABEL_MAX_LENGTH = 1_000;
export function piQuestionLabel(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > PI_QUESTION_LABEL_MAX_LENGTH) throw new Error("Pi question label is invalid or oversized");
  return value;
}

interface UiConnection {
  requestPermission(params: RecordValue): Promise<unknown>;
  unstable_createElicitation(params: RecordValue): Promise<unknown>;
}
interface UiProcess { sendExtensionUiResponse(response: RecordValue): Promise<unknown> }

/** Live promises never become authority to replay an answer after provider death. */
export class PiUiBridge {
  private readonly pending = new Map<string, { cancel(): void }>();
  private readonly seen = new Set<string>();
  private readonly sessionId: string;
  private readonly connection: UiConnection;
  private readonly process: UiProcess;
  constructor(sessionId: string, connection: UiConnection, process: UiProcess) { this.sessionId = sessionId; this.connection = connection; this.process = process; }

  cancelAll(): void { for (const value of this.pending.values()) value.cancel(); }

  async handle(event: RecordValue): Promise<void> {
    const id = text(event.id, 256);
    const method = text(event.method, 64);
    if (!["select", "confirm", "input", "editor"].includes(method)) return;
    if (this.seen.has(id)) return;
    if (this.seen.size >= 4096) throw new Error("Pi UI request history exceeds its bound");
    this.seen.add(id);
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = async (response: RecordValue): Promise<void> => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      this.pending.delete(id);
      await this.process.sendExtensionUiResponse({ id, ...response });
    };
    this.pending.set(id, { cancel: () => { void finish({ cancelled: true }).catch(() => {}); } });
    if (typeof event.timeout === "number" && Number.isFinite(event.timeout)) {
      timeout = setTimeout(() => { void finish({ cancelled: true }).catch(() => {}); }, Math.max(0, Math.min(event.timeout, 2_147_483_647)));
      timeout.unref?.();
    }
    try {
      const title = text(event.title ?? "Additional information needed", 65_536);
      if (method === "select" && title.startsWith(PERMISSION_PREFIX)) {
        const permission = record(JSON.parse(title.slice(PERMISSION_PREFIX.length)));
        const toolCallId = text(permission.toolCallId, 256);
        const toolName = text(permission.toolName, 128);
        const input = record(permission.input);
        const result = record(await this.connection.requestPermission({
          sessionId: this.sessionId,
          toolCall: { toolCallId, _meta: { paperclipPi: { nativeToolCallId: text(permission.nativeToolCallId, 256), modelIteration: permission.modelIteration } }, title: `Pi ${toolName}`, kind: toolName === "bash" ? "execute" : ["write", "edit"].includes(toolName) ? "edit" : "read", status: "pending", rawInput: input },
          options: PERMISSION_CHOICES,
        }));
        const outcome = record(result.outcome);
        const selected = outcome.outcome === "selected" ? PERMISSION_CHOICES.find((option) => option.optionId === outcome.optionId) : undefined;
        await finish(selected ? { value: selected.name } : { cancelled: true });
        return;
      }
      piQuestionLabel(title);
      const property: RecordValue = { type: method === "confirm" ? "boolean" : "string", title };
      if (method === "select") {
        if (!Array.isArray(event.options) || event.options.length < 1 || event.options.length > 128) throw new Error("Invalid Pi question options");
        property.enum = event.options.map((option) => piQuestionLabel(option));
        if (new Set(property.enum as string[]).size !== event.options.length) throw new Error("Ambiguous Pi question options");
      }
      if (method === "input" && typeof event.placeholder === "string") property.description = text(event.placeholder);
      if (method === "editor" && typeof event.prefill === "string") property.default = text(event.prefill);
      const result = record(await this.connection.unstable_createElicitation({
        sessionId: this.sessionId, mode: "form", message: typeof event.message === "string" ? text(event.message) : title,
        requestedSchema: { type: "object", title, properties: { answer: property }, required: ["answer"] },
        _meta: { paperclipPi: { version: 1, requestId: id, method } },
      }));
      if (result.action !== "accept") { await finish({ cancelled: true }); return; }
      const answer = record(result.content).answer;
      if (method === "confirm") {
        if (typeof answer !== "boolean") throw new Error("Invalid Pi confirmation response");
        await finish({ confirmed: answer });
      } else {
        const value = text(answer, 65_536);
        if (method === "select" && !(property.enum as string[]).includes(value)) throw new Error("Invalid Pi question response");
        await finish({ value });
      }
    } catch {
      if (done) return; // An expired request cannot fail a later live session.
      await finish({ cancelled: true }).catch(() => {});
      throw new Error("Pi structured question is unsupported or invalid");
    }
  }
}

/** Sum native usage receipts; preserve missing fields and label catalog pricing. */
export class PiTurnUsage {
  private seen = new Set<string>();
  private total = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 0 };
  private cost = 0;
  private unknown = new Set<keyof typeof this.total>();
  private costObserved = false;
  private costIncomplete = false;
  private compactionObserved = false;
  private failed = false;
  private observed = false;
  reset(): void { this.seen.clear(); this.total = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 0 }; this.cost = 0; this.unknown.clear(); this.costObserved = false; this.costIncomplete = false; this.compactionObserved = false; this.failed = false; this.observed = false; }
  accept(value: unknown): void {
    const message = record(value);
    if (message.role !== "assistant") return;
    if (!message.usage || typeof message.usage !== "object") {
      this.failed = message.stopReason === "error";
      return;
    }
    const key = JSON.stringify([message.timestamp, message.id, message.usage, message.content]);
    if (this.seen.has(key)) return;
    if (this.seen.size >= 8192) throw new Error("Pi usage receipts exceed their bound");
    this.seen.add(key);
    this.failed = message.stopReason === "error";
    const usage = record(message.usage);
    const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    const fields = ["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens"] as const;
    const numbers = ["input", "output", "cacheRead", "cacheWrite"].map((name) => usage[name]);
    for (const [index, name] of fields.entries()) {
      const value = numbers[index];
      if (valid(value)) { this.total[name] += value; this.observed = true; }
      else this.unknown.add(name);
    }
    const total = valid(usage.totalTokens) ? usage.totalTokens
      : numbers.every(valid) ? (numbers as number[]).reduce((sum, value) => sum + value, 0) : undefined;
    if (valid(total)) this.total.totalTokens += total;
    else this.unknown.add("totalTokens");
    const cost = usage.cost && typeof usage.cost === "object" ? record(usage.cost).total : undefined;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
      this.cost += cost; this.costObserved = true;
    } else this.costIncomplete = true;
  }

  markIncomplete(): void {
    for (const name of Object.keys(this.total)) this.unknown.add(name as keyof typeof this.total);
    this.costIncomplete = true;
  }

  acceptCompaction(value: unknown): void {
    this.compactionObserved = true;
    const result = value && typeof value === "object" && !Array.isArray(value) ? record(value) : {};
    if (!result.usage || typeof result.usage !== "object") {
      // A compaction may consume tokens even if its terminal receipt is absent.
      // Known assistant counters alone cannot establish the complete turn.
      this.markIncomplete();
      return;
    }
    const previousFailure = this.failed;
    this.accept({ role: "assistant", id: "compaction", timestamp: result.firstKeptEntryId,
      content: [result.tokensBefore, result.summary], usage: result.usage });
    // A successful summary is not proof that an earlier failed model turn recovered.
    this.failed = previousFailure;
  }

  response(stopReason?: "end_turn" | "cancelled"): RecordValue {
    return {
      ...(this.observed ? { usage: { ...Object.fromEntries(Object.entries(this.total).filter(([name]) => !this.unknown.has(name as keyof typeof this.total))), _meta: { paperclipPi: { provenance: this.compactionObserved ? "assistant_message_and_compaction_receipts" : "assistant_message_receipts", ...(this.costObserved && !this.costIncomplete ? { costUsd: this.cost, costSource: "pi_pricing_estimate" } : {}) } } } } : {}),
      ...(this.failed && stopReason !== "cancelled" ? { _meta: { jetbrains: { air: { version: 1, sessionFailure: { severity: "error", category: "service", title: "Pi provider request failed" } } } } } : {}),
    };
  }
}
