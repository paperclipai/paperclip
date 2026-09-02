import type { NativeUserMessage } from "../../contracts/types.js";
import {
  CODEX_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA,
  CODEX_BLOCK_TOOL_NAME,
  CODEX_COMPLETION_TOOL_NAME,
  CODEX_RESULT_PROVIDER_INPUT_SCHEMA,
} from "../../contracts/codex.js";
import {
  validatePrpStructuredRunResult,
  type PrpStructuredRunResult,
} from "../../protocol/replay-contract.js";
import { boundedCodexValue, isRetainableCodexPayload } from "./codex-boundaries.js";

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function boundedText(
  value: unknown,
  fallback = "unknown",
  maxCharacters = 1024,
): string {
  const candidate = text(value, fallback);
  return candidate.length <= maxCharacters
    ? candidate
    : `${candidate.slice(0, maxCharacters)}...[truncated]`;
}

export function itemFromParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  return record(params.item);
}

export function itemText(item: Record<string, unknown>): string {
  for (const key of ["text", "aggregatedOutput", "patch", "delta"]) {
    if (typeof item[key] === "string") return item[key];
  }
  return "";
}

export function userInput(message: NativeUserMessage): Record<string, unknown> {
  return { type: "text", text: message.text, text_elements: [] };
}

export function terminalState(
  status: string,
): "completed" | "failed" | "interrupted" | "cancelled" {
  if (status === "failed") return "failed";
  if (status === "interrupted") return "interrupted";
  if (status === "cancelled") return "cancelled";
  return "completed";
}

export function tryParseResult(value: unknown): PrpStructuredRunResult | null {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const validation = validatePrpStructuredRunResult(candidate);
  return validation.ok ? validation.result : null;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = record(value);
  if (
    Object.keys(object).length > 0 ||
    (typeof value === "object" && value !== null)
  ) {
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function differingJsonPaths(
  left: unknown,
  right: unknown,
  prefix = "",
  limit = 12,
): string[] {
  if (canonicalJson(left) === canonicalJson(right)) return [];
  if (limit <= 0) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    const paths: string[] = [];
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      paths.push(...differingJsonPaths(
        left[index],
        right[index],
        `${prefix}[${index}]`,
        limit - paths.length,
      ));
      if (paths.length >= limit) break;
    }
    return paths.length > 0 ? paths : [prefix || "result"];
  }
  const leftRecord = record(left);
  const rightRecord = record(right);
  if (
    (typeof left === "object" && left !== null) &&
    (typeof right === "object" && right !== null) &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const paths: string[] = [];
    const keys = [...new Set([
      ...Object.keys(leftRecord),
      ...Object.keys(rightRecord),
    ])].sort();
    for (const key of keys) {
      paths.push(...differingJsonPaths(
        leftRecord[key],
        rightRecord[key],
        prefix ? `${prefix}.${key}` : key,
        limit - paths.length,
      ));
      if (paths.length >= limit) break;
    }
    return paths.length > 0 ? paths : [prefix || "result"];
  }
  return [prefix || "result"];
}

function finishToolSpec(): Record<string, unknown> {
  return {
    name: CODEX_COMPLETION_TOOL_NAME,
    description: "Return the one semantic completion result for this task.",
    inputSchema: CODEX_RESULT_PROVIDER_INPUT_SCHEMA,
  };
}

function blockToolSpec(): Record<string, unknown> {
  return {
    name: CODEX_BLOCK_TOOL_NAME,
    description:
      "Return the one semantic result when the task cannot continue.",
    inputSchema: CODEX_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA,
  };
}

export function codexSemanticToolSpecs(): readonly Readonly<
  Record<string, unknown>
>[] {
  return [finishToolSpec(), blockToolSpec()];
}

export function dynamicToolResponse(value: unknown): Record<string, unknown> {
  return {
    success: true,
    contentItems: [
      {
        type: "inputText",
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
  };
}
