import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_SKILLLESS_BASE_INSTRUCTIONS } from "../contracts/codex.js";
import type { NativeExecutionInput } from "../contracts/native-execution.js";
import { composeNativeSystemInstructions } from "../contracts/runtime-context.js";

export function nativeSystemInstructions(input: NativeExecutionInput): string {
  if (!("runtimeContext" in input)) return CODEX_SKILLLESS_BASE_INSTRUCTIONS;
  const entry = readFileSync(join(input.runtimeContext.instructions.bundle.rootPath, input.runtimeContext.instructions.entryPath), "utf8");
  return composeNativeSystemInstructions(input.runtimeContext, entry);
}

export function nativeTaskConstraints(input: NativeExecutionInput): string[] {
  const finalResponseConstraint =
    "Write the complete user-facing final response exactly once before invoking paperclip_finish or paperclip_block. Treat that semantic completion tool as the last action and do not emit a trailing acknowledgement.";
  if (!("runtimeContext" in input)) {
    return [
      "Do not discover or invoke skills.",
      "Do not call a control-plane API.",
      finalResponseConstraint,
    ];
  }
  return [
    "Use only the assigned skills and provider-native tools.",
    "Use Paperclip semantic tools for coordination and finalization.",
    finalResponseConstraint,
  ];
}
