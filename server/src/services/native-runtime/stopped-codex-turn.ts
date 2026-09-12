import { parse } from "acorn";
import { canonicalNativeJson } from "./canonical.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

export interface CompletedTaskControlCall { callId: string; input: unknown }

// Interpret only JSON literals in one completion call. Never evaluate provider
// JavaScript, and never infer safety merely from a script containing a tool name.
function completionScriptInput(source: unknown): unknown {
  if (typeof source !== "string" || source.length > 65536) throw new Error("script unavailable");
  const program = parse(source, { ecmaVersion: 2022, sourceType: "module" }) as unknown as Record<string, unknown>;
  const body = program.body as Record<string, unknown>[];
  if (body.length !== 2) throw new Error("unknown script");
  const first = body[0]!;
  const declarations = first.declarations as Record<string, unknown>[] | undefined;
  if (first.type !== "VariableDeclaration" || first.kind !== "const" || declarations?.length !== 1) throw new Error("unknown declaration");
  const declaration = declarations[0]!;
  const binding = record(declaration.id);
  const awaited = record(declaration.init);
  const call = record(awaited.argument);
  const callee = record(call.callee);
  const output = record(body[1]!.expression);
  const args = call.arguments as unknown[] | undefined;
  const outputArgs = output.arguments as unknown[] | undefined;
  if (binding.type !== "Identifier" || awaited.type !== "AwaitExpression" || call.type !== "CallExpression" ||
      callee.type !== "MemberExpression" || callee.computed || callee.optional || call.optional ||
      record(callee.object).type !== "Identifier" || record(callee.object).name !== "tools" ||
      record(callee.property).name !== "paperclip_finish" || args?.length !== 1 ||
      body[1]!.type !== "ExpressionStatement" || output.type !== "CallExpression" || output.optional ||
      record(output.callee).type !== "Identifier" || record(output.callee).name !== "text" ||
      outputArgs?.length !== 1 || record(outputArgs[0]).type !== "Identifier" || record(outputArgs[0]).name !== binding.name)
    throw new Error("unknown effect");
  let nodes = 0;
  const literal = (value: unknown, depth = 0): unknown => {
    if (++nodes > 4096 || depth > 32) throw new Error("literal too large");
    const node = record(value);
    if (node.type === "Literal" && (node.value === null || ["string", "boolean", "number"].includes(typeof node.value)) && !node.regex && !node.bigint)
      return node.value;
    if (node.type === "ArrayExpression") return (node.elements as unknown[]).map(v => literal(v, depth + 1));
    if (node.type !== "ObjectExpression") throw new Error("nonliteral input");
    const result: Record<string, unknown> = Object.create(null);
    for (const raw of node.properties as unknown[]) {
      const property = record(raw), key = record(property.key);
      const name = key.type === "Identifier" ? key.name : key.type === "Literal" ? key.value : null;
      if (property.type !== "Property" || property.kind !== "init" || property.method || property.computed || property.shorthand ||
          typeof name !== "string" || ["__proto__", "constructor", "prototype"].includes(name) || name in result)
        throw new Error("unknown property");
      result[name] = literal(property.value, depth + 1);
    }
    return result;
  };
  return literal(args[0]);
}

/** A closed, text-only turn can be continued without replaying an unknown action.
 * This is deliberately a closed inventory, not a search for known bad tools.
 * The caller must independently authenticate the session and contain its processes.
 */
export function stoppedCodexTurnIsTextOnly(input: {
  rows: unknown[];
  threadId: string;
  turnId: string;
  cwd: string;
  completedTaskControlCalls?: CompletedTaskControlCall[];
}): boolean {
  const rows = input.rows.map(record);
  const meta = rows[0];
  if (!input.threadId || !input.turnId || meta?.type !== "session_meta" ||
      record(meta.payload).id !== input.threadId || record(meta.payload).cwd !== input.cwd)
    return false;
  const starts = rows.flatMap((row, index) => row.type === "event_msg" &&
    record(row.payload).type === "task_started" && record(row.payload).turn_id === input.turnId
    ? [index] : []);
  if (starts.length !== 1) return false;
  const turn = rows.slice(starts[0]!);
  let contextSeen = false;
  let aborted = false;
  const completedCalls = input.completedTaskControlCalls ?? [];
  const scripts = new Set<string>();
  const seenCalls = new Set<string>();
  const outputs = new Set<string>();
  for (let index = 0; index < turn.length; index++) {
    const row = turn[index]!;
    const payload = record(row.payload);
    if (aborted) return false;
    switch (row.type) {
      case "turn_context":
        if (contextSeen || payload.turn_id !== input.turnId || payload.cwd !== input.cwd) return false;
        contextSeen = true;
        break;
      case "response_item":
        if (payload.type === "custom_tool_call") {
          try {
            if (payload.name !== "exec" || typeof payload.call_id !== "string" || scripts.has(payload.call_id) ||
                !completedCalls.some(call => canonicalNativeJson(call.input) === canonicalNativeJson(completionScriptInput(payload.input)))) return false;
          } catch { return false; }
          scripts.add(payload.call_id as string);
          break;
        }
        if (payload.type === "custom_tool_call_output") {
          if (typeof payload.call_id !== "string" || !scripts.has(payload.call_id) || outputs.has(payload.call_id)) return false;
          outputs.add(payload.call_id);
          break;
        }
        if (!["message", "reasoning"].includes(String(payload.type))) return false;
        break;
      case "world_state":
      case "token_usage_record":
        break;
      case "event_msg":
        switch (payload.type) {
          case "task_started":
            if (index !== 0 || payload.turn_id !== input.turnId) return false;
            break;
          case "turn_aborted":
            if (payload.turn_id !== input.turnId || payload.reason !== "interrupted") return false;
            aborted = true;
            break;
          case "token_count":
            break;
          case "item_completed":
            if (payload.thread_id !== input.threadId || payload.turn_id !== input.turnId) return false;
            if (record(payload.item).type === "DynamicToolCall") {
              const item = record(payload.item);
              if (item.tool !== "paperclip_finish" || item.status !== "completed" || item.success !== true ||
                  typeof item.id !== "string" || seenCalls.has(item.id) ||
                  !completedCalls.some(call => call.callId === item.id && canonicalNativeJson(call.input) === canonicalNativeJson(item.arguments))) return false;
              seenCalls.add(item.id);
            } else if (!["AgentMessage", "UserMessage", "Reasoning"].includes(String(record(payload.item).type))) return false;
            break;
          default: return false;
        }
        break;
      default: return false;
    }
  }
  return contextSeen && aborted && scripts.size === outputs.size && scripts.size === completedCalls.length && seenCalls.size === completedCalls.length;
}
