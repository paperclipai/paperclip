/** Forward bounded tool activity without inventing a host-call identity or arguments. */
export function openCodeProxyToolNotification(input: {
  eventType: string; threadId: string; turnId?: string; payload: Record<string, unknown>;
}): { method: string; params: Record<string, unknown> } | null {
  const phase = ({ "tool.execution.started": "started", "tool.execution.progressed": "updated", "tool.execution.completed": "completed" } as Record<string, string>)[input.eventType];
  if (!phase) return null;
  const p = input.payload;
  if (!input.turnId || typeof p.executionId !== "string" || !p.executionId || p.schema !== "paperclip.tool.execution.v1")
    throw new Error("OpenCode tool activity omitted its bound identity");
  const type = ({ builtin: "builtinToolCall", mcp: "mcpToolCall", dynamic: "dynamicToolCall", process: "commandExecution" } as Record<string, string>)[String(p.transport)];
  if (!type) throw new Error("OpenCode tool activity has an unsupported transport");
  return { method: `item/${phase}`, params: {
    threadId: input.threadId, turnId: input.turnId, itemId: p.executionId,
    item: { id: p.executionId, type, tool: p.name, server: p.namespace,
      readOnlyHint: p.readOnly, status: p.status, durationMs: p.durationMs, exitCode: p.exitCode,
      // This is the already bounded provider-visible result, not raw input or a private trace.
      output: typeof p.output === "string" ? p.output.slice(0, 16_384) : "",
    },
  } };
}

export function shouldForwardOpenCodeProxyItem(input: {
  turnId?: string;
  kind?: unknown;
}): boolean {
  return !(input.turnId === undefined && input.kind === "model");
}

export function openCodeProxyAssistantText(
  payload: Record<string, unknown>,
): string | null {
  return (payload.kind === "agentMessage" || payload.kind === "text") &&
    typeof payload.text === "string"
    ? payload.text
    : null;
}

export function openCodeProxyItemNotification(input: {
  eventType: "item.started" | "item.delta" | "item.completed";
  threadId: string;
  turnId?: string;
  itemId?: string;
  payload: Record<string, unknown>;
}): { method: string; params: Record<string, unknown> } {
  const assistantText = openCodeProxyAssistantText(input.payload);
  const method =
    input.eventType === "item.delta" && assistantText !== null
      ? "item/agentMessage/delta"
      : input.eventType.replace(".", "/");
  const providerItem = record(input.payload.item);
  const item =
    assistantText === null
      ? (input.payload.item ?? {
          id: input.itemId,
          type: input.payload.kind,
          text: input.payload.text,
        })
      : {
          ...providerItem,
          id: input.itemId,
          type: "agentMessage",
          text: assistantText,
        };
  return {
    method,
    params: {
      threadId: input.threadId,
      turnId: input.turnId,
      itemId: input.itemId,
      ...input.payload,
      item,
      ...(method === "item/agentMessage/delta" ? { delta: assistantText } : {}),
    },
  };
}

export function shouldAnnounceOpenCodeProxyTurn(
  announcedTurnIds: Set<string>,
  turnId: string,
): boolean {
  if (announcedTurnIds.has(turnId)) return false;
  announcedTurnIds.add(turnId);
  return true;
}

const MAX_TERMINAL_ERROR_BYTES = 64 * 1024;
const MAX_TERMINAL_ERROR_TEXT_CHARS = 4_000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown, maxChars: number): string | undefined {
  return typeof value === "string" && value.length > 0
    ? [...value].slice(0, maxChars).join("")
    : undefined;
}

/**
 * Keeps the provider's actionable failure payload on the Codex-facade frame.
 * The OpenCode driver already bounds native payloads, but the proxy is a
 * separate process boundary and must enforce its own limit before writing to
 * runnerd's JSON-RPC stream.
 */
export function boundedOpenCodeTerminalError(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  try {
    const encoded = JSON.stringify(value);
    if (
      encoded !== undefined &&
      Buffer.byteLength(encoded, "utf8") <= MAX_TERMINAL_ERROR_BYTES
    ) {
      return value;
    }
  } catch {
    // Fall through to the bounded diagnostic below.
  }

  const object = record(value);
  const code = boundedText(object?.code, 160);
  const message = boundedText(
    object?.message ??
      object?.reason ??
      (typeof value === "string" ? value : undefined),
    MAX_TERMINAL_ERROR_TEXT_CHARS,
  );
  return {
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    omitted: true,
    reason: "payload_limit",
  };
}

export function openCodeProxyTerminalNotification(input: {
  eventType:
    "turn.completed" | "turn.failed" | "turn.interrupted" | "turn.cancelled";
  threadId: string;
  turnId?: string;
  payload: Record<string, unknown>;
}): { method: string; params: Record<string, unknown> } {
  const status = input.eventType.slice("turn.".length);
  const error =
    input.eventType === "turn.failed"
      ? boundedOpenCodeTerminalError(input.payload.error)
      : undefined;
  return {
    method: input.eventType.replace(".", "/"),
    params: {
      threadId: input.threadId,
      turnId: input.turnId,
      turn: {
        id: input.turnId,
        status,
        ...(error === undefined ? {} : { error }),
      },
    },
  };
}
