import type { TranscriptEntry } from "@paperclipai/adapter-utils";

type PiMessageRole = "assistant" | "user" | "toolResult";
type PiTextKind = "assistant" | "thinking";

interface PiTextBlockState {
  itemId: string;
  kind: PiTextKind;
  text: string;
  emitted: boolean;
}

interface PiMessageState {
  id: string;
  role: PiMessageRole;
  providerMessageId: string | null;
  providerTimestamp: string | null;
  blocks: Map<string, PiTextBlockState>;
  toolCallIdsByContentIndex: Map<number, string>;
  toolCallId: string | null;
  userEmitted: boolean;
}

interface PiToolCallState {
  toolName: string;
  args: unknown;
}

interface PiUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

interface PiParserState {
  messages: PiMessageState[];
  activeMessage: PiMessageState | null;
  turnMessageStart: number;
  nextMessageSequence: number;
  nextToolSequence: number;
  toolCalls: Map<string, PiToolCallState>;
  emittedToolCalls: Set<string>;
  emittedToolResults: Set<string>;
  latestUsage: PiUsage | null;
  resultEmitted: boolean;
  sawRenderableMessage: boolean;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeContentType(value: unknown): string {
  return asString(value)
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replaceAll("-", "_");
}

function messageRole(message: Record<string, unknown>): PiMessageRole | null {
  const role = asString(message.role);
  if (role === "assistant" || role === "user") return role;
  if (role === "toolResult" || role === "tool_result" || role === "tool") return "toolResult";
  return null;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  let text = "";
  for (const value of content) {
    const block = asRecord(value);
    if (normalizeContentType(block?.type) === "text") {
      text += asString(block?.text);
    }
  }
  return text;
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    const text = extractTextContent(result);
    if (text) return text;
  }

  const resultRecord = asRecord(result);
  if (resultRecord && Array.isArray(resultRecord.content)) {
    const text = extractTextContent(resultRecord.content);
    if (text) return text;
  }

  const serialized = JSON.stringify(result);
  return serialized ?? String(result);
}

function createParserState(): PiParserState {
  return {
    messages: [],
    activeMessage: null,
    turnMessageStart: 0,
    nextMessageSequence: 1,
    nextToolSequence: 1,
    toolCalls: new Map(),
    emittedToolCalls: new Set(),
    emittedToolResults: new Set(),
    latestUsage: null,
    resultEmitted: false,
    sawRenderableMessage: false,
  };
}

function createMessage(state: PiParserState, role: PiMessageRole): PiMessageState {
  const message: PiMessageState = {
    id: `pi-message-${state.nextMessageSequence++}`,
    role,
    providerMessageId: null,
    providerTimestamp: null,
    blocks: new Map(),
    toolCallIdsByContentIndex: new Map(),
    toolCallId: null,
    userEmitted: false,
  };
  state.messages.push(message);
  return message;
}

function textBlock(
  message: PiMessageState,
  kind: PiTextKind,
  contentIndex: number,
): PiTextBlockState {
  const key = `${kind}:${contentIndex}`;
  const existing = message.blocks.get(key);
  if (existing) return existing;

  const block: PiTextBlockState = {
    itemId: `${message.id}:${key}`,
    kind,
    text: "",
    emitted: false,
  };
  message.blocks.set(key, block);
  return block;
}

function textEntry(
  block: PiTextBlockState,
  ts: string,
  text: string,
  delta = false,
): TranscriptEntry {
  if (block.kind === "assistant") {
    return {
      kind: "assistant",
      ts,
      text,
      itemId: block.itemId,
      ...(delta ? { delta: true } : {}),
    };
  }
  return {
    kind: "thinking",
    ts,
    text,
    itemId: block.itemId,
    ...(delta ? { delta: true } : {}),
  };
}

function appendTextDelta(
  state: PiParserState,
  message: PiMessageState,
  kind: PiTextKind,
  contentIndex: number,
  delta: string,
  ts: string,
): TranscriptEntry[] {
  if (!delta) return [];
  const block = textBlock(message, kind, contentIndex);
  block.text += delta;
  block.emitted = true;
  state.sawRenderableMessage = true;
  return [textEntry(block, ts, delta, true)];
}

function reconcileTextBlock(
  state: PiParserState,
  message: PiMessageState,
  kind: PiTextKind,
  contentIndex: number,
  snapshot: string,
  ts: string,
): TranscriptEntry[] {
  if (!snapshot) return [];
  const block = textBlock(message, kind, contentIndex);

  if (!block.emitted) {
    block.text = snapshot;
    block.emitted = true;
    state.sawRenderableMessage = true;
    return [textEntry(block, ts, snapshot)];
  }

  if (block.text === snapshot) return [];

  if (snapshot.startsWith(block.text)) {
    const suffix = snapshot.slice(block.text.length);
    block.text = snapshot;
    if (!suffix) return [];
    return [textEntry(block, ts, suffix, true)];
  }

  // Terminal snapshots are authoritative. The transcript assembler reconciles
  // this non-delta entry by itemId, replacing the partial streamed block.
  block.text = snapshot;
  return [textEntry(block, ts, snapshot)];
}

function fallbackToolCallId(
  state: PiParserState,
  message: PiMessageState | null,
  contentIndex: number | null,
): string {
  if (message && contentIndex !== null) {
    const existing = message.toolCallIdsByContentIndex.get(contentIndex);
    if (existing) return existing;
    const id = `${message.id}:tool:${contentIndex}`;
    message.toolCallIdsByContentIndex.set(contentIndex, id);
    return id;
  }
  return `pi-tool-${state.nextToolSequence++}`;
}

function rememberToolCall(
  state: PiParserState,
  toolCallId: string,
  toolName: string,
  args: unknown,
): PiToolCallState {
  const previous = state.toolCalls.get(toolCallId);
  const call = {
    toolName: toolName || previous?.toolName || "tool",
    args: args ?? previous?.args ?? {},
  };
  state.toolCalls.set(toolCallId, call);
  return call;
}

function emitToolCall(
  state: PiParserState,
  toolCallId: string,
  toolName: string,
  args: unknown,
  ts: string,
): TranscriptEntry[] {
  const call = rememberToolCall(state, toolCallId, toolName, args);
  if (state.emittedToolCalls.has(toolCallId)) return [];
  state.emittedToolCalls.add(toolCallId);
  state.sawRenderableMessage = true;
  return [{
    kind: "tool_call",
    ts,
    name: call.toolName,
    input: call.args,
    toolUseId: toolCallId,
  }];
}

function emitToolResult(
  state: PiParserState,
  toolCallId: string,
  toolName: string,
  result: unknown,
  isError: boolean,
  ts: string,
): TranscriptEntry[] {
  const call = rememberToolCall(state, toolCallId, toolName, undefined);
  if (state.emittedToolResults.has(toolCallId)) return [];
  state.emittedToolResults.add(toolCallId);
  state.sawRenderableMessage = true;
  return [{
    kind: "tool_result",
    ts,
    toolUseId: toolCallId,
    toolName: call.toolName,
    content: stringifyToolResult(result),
    isError,
  }];
}

function reconcileAssistantSnapshot(
  state: PiParserState,
  messageState: PiMessageState,
  message: Record<string, unknown>,
  ts: string,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const content = message.content;

  if (typeof content === "string") {
    entries.push(...reconcileTextBlock(state, messageState, "assistant", 0, content, ts));
  } else if (Array.isArray(content)) {
    content.forEach((value, contentIndex) => {
      const block = asRecord(value);
      if (!block) return;
      const type = normalizeContentType(block.type);
      if (type === "text") {
        entries.push(
          ...reconcileTextBlock(
            state,
            messageState,
            "assistant",
            contentIndex,
            asString(block.text),
            ts,
          ),
        );
        return;
      }
      if (type === "thinking") {
        entries.push(
          ...reconcileTextBlock(
            state,
            messageState,
            "thinking",
            contentIndex,
            asString(block.thinking, asString(block.text)),
            ts,
          ),
        );
        return;
      }
      if (type === "tool_call" || type === "toolcall") {
        const explicitId = asString(block.id, asString(block.toolCallId));
        const toolCallId =
          explicitId || fallbackToolCallId(state, messageState, contentIndex);
        messageState.toolCallIdsByContentIndex.set(contentIndex, toolCallId);
        entries.push(
          ...emitToolCall(
            state,
            toolCallId,
            asString(block.name, asString(block.toolName)),
            block.arguments ?? block.args ?? block.input,
            ts,
          ),
        );
      }
    });
  }

  const usage = extractUsage(message);
  if (usage) state.latestUsage = usage;
  return entries;
}

function reconcileUserSnapshot(
  state: PiParserState,
  messageState: PiMessageState,
  message: Record<string, unknown>,
  ts: string,
): TranscriptEntry[] {
  const text = extractTextContent(message.content);
  if (!text) return [];
  if (messageState.userEmitted) return [];
  messageState.userEmitted = true;
  state.sawRenderableMessage = true;
  return [{ kind: "user", ts, text }];
}

function reconcileToolResultSnapshot(
  state: PiParserState,
  messageState: PiMessageState,
  message: Record<string, unknown>,
  ts: string,
): TranscriptEntry[] {
  const explicitId = asString(message.toolCallId, asString(message.id));
  const toolCallId = explicitId || fallbackToolCallId(state, null, null);
  messageState.toolCallId = toolCallId;
  return emitToolResult(
    state,
    toolCallId,
    asString(message.toolName, asString(message.name)),
    message.content ?? message.result,
    message.isError === true,
    ts,
  );
}

function reconcileMessageSnapshot(
  state: PiParserState,
  messageState: PiMessageState,
  message: Record<string, unknown>,
  ts: string,
): TranscriptEntry[] {
  const providerMessageId = asString(
    message.id,
    asString(message.messageId, asString(message.responseId)),
  );
  if (providerMessageId) messageState.providerMessageId = providerMessageId;
  if (
    (typeof message.timestamp === "string" && message.timestamp) ||
    (typeof message.timestamp === "number" && Number.isFinite(message.timestamp))
  ) {
    messageState.providerTimestamp = String(message.timestamp);
  }
  if (messageState.role === "assistant") {
    return reconcileAssistantSnapshot(state, messageState, message, ts);
  }
  if (messageState.role === "user") {
    return reconcileUserSnapshot(state, messageState, message, ts);
  }
  return reconcileToolResultSnapshot(state, messageState, message, ts);
}

function extractUsage(message: Record<string, unknown>): PiUsage | null {
  const usage = asRecord(message.usage);
  if (!usage) return null;
  const cost = asRecord(usage.cost);
  const value = {
    inputTokens: asNumber(usage.inputTokens ?? usage.input),
    outputTokens: asNumber(usage.outputTokens ?? usage.output),
    cachedTokens: asNumber(usage.cachedInputTokens ?? usage.cacheRead),
    costUsd: asNumber(cost?.total ?? usage.costUsd),
  };
  return value.inputTokens !== 0 ||
    value.outputTokens !== 0 ||
    value.cachedTokens !== 0 ||
    value.costUsd !== 0
    ? value
    : null;
}

function emitUsageResult(
  state: PiParserState,
  usage: PiUsage | null,
  ts: string,
): TranscriptEntry[] {
  if (!usage || state.resultEmitted) return [];
  state.resultEmitted = true;
  return [{
    kind: "result",
    ts,
    text: "Run completed",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: usage.cachedTokens,
    costUsd: usage.costUsd,
    subtype: "end",
    isError: false,
    errors: [],
  }];
}

function currentTurnAssistantMessage(
  state: PiParserState,
  snapshot: Record<string, unknown>,
): PiMessageState | null {
  for (let index = state.messages.length - 1; index >= state.turnMessageStart; index -= 1) {
    const message = state.messages[index];
    if (message && sameHistoryIdentity(message, "assistant", snapshot)) return message;
  }
  return null;
}

function sameHistoryIdentity(
  messageState: PiMessageState,
  role: PiMessageRole,
  snapshot: Record<string, unknown>,
): boolean {
  if (messageState.role !== role) return false;
  const snapshotMessageId = asString(
    snapshot.id,
    asString(snapshot.messageId, asString(snapshot.responseId)),
  );
  if (
    messageState.providerMessageId &&
    snapshotMessageId &&
    messageState.providerMessageId !== snapshotMessageId
  ) {
    return false;
  }
  const snapshotTimestamp =
    (typeof snapshot.timestamp === "string" && snapshot.timestamp) ||
    (typeof snapshot.timestamp === "number" && Number.isFinite(snapshot.timestamp)
      ? String(snapshot.timestamp)
      : "");
  if (
    messageState.providerTimestamp &&
    snapshotTimestamp &&
    messageState.providerTimestamp !== snapshotTimestamp
  ) {
    return false;
  }
  if (role !== "toolResult") return true;
  const snapshotToolCallId = asString(snapshot.toolCallId, asString(snapshot.id));
  return !snapshotToolCallId || !messageState.toolCallId || snapshotToolCallId === messageState.toolCallId;
}

function alignAgentHistory(
  state: PiParserState,
  snapshots: Record<string, unknown>[],
): Array<PiMessageState | null> {
  const roles = snapshots.map(messageRole);
  if (
    snapshots.length === state.messages.length &&
    roles.every((role, index) =>
      role !== null && sameHistoryIdentity(state.messages[index]!, role, snapshots[index]!))
  ) {
    return state.messages;
  }

  const aligned = new Array<PiMessageState | null>(snapshots.length).fill(null);
  let stateIndex = state.messages.length - 1;
  for (let snapshotIndex = snapshots.length - 1; snapshotIndex >= 0; snapshotIndex -= 1) {
    const role = roles[snapshotIndex];
    if (!role) continue;
    for (let candidateIndex = stateIndex; candidateIndex >= 0; candidateIndex -= 1) {
      const candidate = state.messages[candidateIndex]!;
      if (sameHistoryIdentity(candidate, role, snapshots[snapshotIndex]!)) {
        aligned[snapshotIndex] = candidate;
        stateIndex = candidateIndex - 1;
        break;
      }
    }
  }
  return aligned;
}

function reconcileAgentHistory(
  state: PiParserState,
  value: unknown,
  ts: string,
): TranscriptEntry[] {
  if (!Array.isArray(value)) return [];
  const snapshots = value.map(asRecord).filter((message): message is Record<string, unknown> => message !== null);
  const aligned = alignAgentHistory(state, snapshots);
  const entries: TranscriptEntry[] = [];

  snapshots.forEach((snapshot, index) => {
    const role = messageRole(snapshot);
    if (!role) return;
    const messageState = aligned[index] ?? createMessage(state, role);
    entries.push(...reconcileMessageSnapshot(state, messageState, snapshot, ts));
  });

  return entries;
}

function resolveToolExecutionId(
  state: PiParserState,
  event: Record<string, unknown>,
): string {
  const explicitId = asString(event.toolCallId, asString(event.id));
  if (explicitId) return explicitId;
  const toolName = asString(event.toolName, asString(event.name));
  let matchingToolCallId: string | null = null;
  for (const [toolCallId, call] of state.toolCalls) {
    if (call.toolName === toolName) matchingToolCallId = toolCallId;
  }
  return matchingToolCallId ?? fallbackToolCallId(state, null, null);
}

function parsePiLine(
  line: string,
  ts: string,
  state: PiParserState,
): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    const trimmed = line.trim();
    return trimmed ? [{ kind: "stdout", ts, text: trimmed }] : [];
  }

  const type = asString(parsed.type);
  if (
    type === "response" ||
    type === "extension_ui_request" ||
    type === "extension_ui_response" ||
    type === "extension_error"
  ) {
    return [];
  }

  if (type === "agent_start") {
    return [{ kind: "system", ts, text: "🚀 Pi agent started" }];
  }

  if (type === "agent_end") {
    const entries = reconcileAgentHistory(state, parsed.messages, ts);
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages.map(asRecord).filter((message): message is Record<string, unknown> => message !== null)
      : [];
    const lastAssistant = messages.findLast((message) => messageRole(message) === "assistant");
    entries.push(
      ...emitUsageResult(
        state,
        (lastAssistant ? extractUsage(lastAssistant) : null) ?? state.latestUsage,
        ts,
      ),
    );
    if (entries.length === 0 && !state.sawRenderableMessage) {
      entries.push({ kind: "system", ts, text: "✅ Pi agent finished" });
    }
    state.activeMessage = null;
    return entries;
  }

  if (type === "turn_start") {
    state.activeMessage = null;
    state.turnMessageStart = state.messages.length;
    return [];
  }

  if (type === "turn_end") {
    const entries: TranscriptEntry[] = [];
    const message = asRecord(parsed.message);
    if (message) {
      const role = messageRole(message);
      if (role) {
        const messageState =
          role === "assistant"
            ? currentTurnAssistantMessage(state, message) ?? createMessage(state, role)
            : createMessage(state, role);
        entries.push(...reconcileMessageSnapshot(state, messageState, message, ts));
      }
    }

    if (Array.isArray(parsed.toolResults)) {
      for (const value of parsed.toolResults) {
        const toolResult = asRecord(value);
        if (!toolResult) continue;
        const toolCallId = resolveToolExecutionId(state, toolResult);
        entries.push(
          ...emitToolResult(
            state,
            toolCallId,
            asString(toolResult.toolName, asString(toolResult.name)),
            toolResult.content ?? toolResult.result,
            toolResult.isError === true,
            ts,
          ),
        );
      }
    }

    state.activeMessage = null;
    state.turnMessageStart = state.messages.length;
    return entries;
  }

  if (type === "message_start") {
    const message = asRecord(parsed.message);
    if (!message) return [];
    const role = messageRole(message);
    if (!role) return [{ kind: "stdout", ts, text: line }];
    const messageState = createMessage(state, role);
    state.activeMessage = messageState;
    return reconcileMessageSnapshot(state, messageState, message, ts);
  }

  if (type === "message_update") {
    const assistantEvent = asRecord(parsed.assistantMessageEvent);
    if (!assistantEvent) return [];
    const message =
      state.activeMessage?.role === "assistant"
        ? state.activeMessage
        : createMessage(state, "assistant");
    state.activeMessage = message;
    const eventType = normalizeContentType(assistantEvent.type);
    const rawContentIndex = assistantEvent.contentIndex;
    const contentIndex =
      Number.isSafeInteger(rawContentIndex) && (rawContentIndex as number) >= 0
        ? (rawContentIndex as number)
        : 0;

    if (eventType === "thinking_start") {
      textBlock(message, "thinking", contentIndex);
      return [];
    }
    if (eventType === "thinking_delta") {
      return appendTextDelta(
        state,
        message,
        "thinking",
        contentIndex,
        asString(assistantEvent.delta),
        ts,
      );
    }
    if (eventType === "thinking_end") {
      return reconcileTextBlock(
        state,
        message,
        "thinking",
        contentIndex,
        asString(assistantEvent.content),
        ts,
      );
    }
    if (eventType === "text_start") {
      textBlock(message, "assistant", contentIndex);
      return [];
    }
    if (eventType === "text_delta") {
      return appendTextDelta(
        state,
        message,
        "assistant",
        contentIndex,
        asString(assistantEvent.delta),
        ts,
      );
    }
    if (eventType === "text_end") {
      return reconcileTextBlock(
        state,
        message,
        "assistant",
        contentIndex,
        asString(assistantEvent.content),
        ts,
      );
    }
    if (eventType === "toolcall_start" || eventType === "tool_call_start") {
      const explicitId = asString(assistantEvent.id, asString(assistantEvent.toolCallId));
      const toolCallId = explicitId || fallbackToolCallId(state, message, contentIndex);
      message.toolCallIdsByContentIndex.set(contentIndex, toolCallId);
      rememberToolCall(
        state,
        toolCallId,
        asString(assistantEvent.toolName, asString(assistantEvent.name)),
        assistantEvent.arguments ?? assistantEvent.args,
      );
      return [];
    }
    if (eventType === "toolcall_end" || eventType === "tool_call_end") {
      const toolCall = asRecord(assistantEvent.toolCall);
      const explicitId = asString(
        toolCall?.id,
        asString(toolCall?.toolCallId, asString(assistantEvent.id, asString(assistantEvent.toolCallId))),
      );
      const toolCallId =
        explicitId ||
        message.toolCallIdsByContentIndex.get(contentIndex) ||
        fallbackToolCallId(state, message, contentIndex);
      message.toolCallIdsByContentIndex.set(contentIndex, toolCallId);
      return emitToolCall(
        state,
        toolCallId,
        asString(
          toolCall?.name,
          asString(toolCall?.toolName, asString(assistantEvent.toolName, asString(assistantEvent.name))),
        ),
        toolCall?.arguments ??
          toolCall?.args ??
          assistantEvent.arguments ??
          assistantEvent.args,
        ts,
      );
    }
    return [];
  }

  if (type === "message_end") {
    const message = asRecord(parsed.message);
    if (!message) return [];
    const role = messageRole(message);
    if (!role) return [{ kind: "stdout", ts, text: line }];
    const messageState =
      state.activeMessage && sameHistoryIdentity(state.activeMessage, role, message)
        ? state.activeMessage
        : createMessage(state, role);
    const entries = reconcileMessageSnapshot(state, messageState, message, ts);
    state.activeMessage = null;
    return entries;
  }

  if (type === "tool_execution_start") {
    const toolCallId =
      asString(parsed.toolCallId, asString(parsed.id)) ||
      fallbackToolCallId(state, null, null);
    return emitToolCall(
      state,
      toolCallId,
      asString(parsed.toolName, asString(parsed.name)),
      parsed.args ?? parsed.arguments,
      ts,
    );
  }

  if (type === "tool_execution_update") {
    return [];
  }

  if (type === "tool_execution_end") {
    const toolCallId = resolveToolExecutionId(state, parsed);
    const entries = emitToolResult(
      state,
      toolCallId,
      asString(parsed.toolName, asString(parsed.name)),
      parsed.result,
      parsed.isError === true,
      ts,
    );
    return entries;
  }

  return [{ kind: "stdout", ts, text: line }];
}

export function createPiStdoutParser() {
  let state = createParserState();
  return {
    parseLine: (line: string, ts: string): TranscriptEntry[] =>
      parsePiLine(line, ts, state),
    reset: () => {
      state = createParserState();
    },
  };
}

// Stateless fallback for one-line callers. Transcript consumers should use
// createPiStdoutParser so lifecycle snapshots reconcile within one run.
export function parsePiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return parsePiLine(line, ts, createParserState());
}
