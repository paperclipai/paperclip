import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { CODEX_SKILLLESS_BASE_INSTRUCTIONS } from "../contracts/codex.js";
import type { NativeExecutionInput } from "../contracts/native-execution.js";
import { composeNativeSystemInstructions } from "../contracts/runtime-context.js";

export function nativeSystemInstructions(input: NativeExecutionInput): string {
  if (!("runtimeContext" in input)) return CODEX_SKILLLESS_BASE_INSTRUCTIONS;
  const configuredRoot = resolve(input.runtimeContext.instructions.bundle.rootPath);
  const bundleRoot = realpathSync(configuredRoot);
  const entryPath = realpathSync(resolve(
    configuredRoot,
    input.runtimeContext.instructions.entryPath,
  ));
  const pathFromRoot = relative(bundleRoot, entryPath);
  if (
    pathFromRoot === ".."
    || pathFromRoot.startsWith(`..${sep}`)
    || isAbsolute(pathFromRoot)
  ) {
    throw new Error("native_runtime_context_entry_outside_bundle");
  }
  const entry = readFileSync(entryPath, "utf8");
  return composeNativeSystemInstructions(input.runtimeContext, entry);
}

export function nativeTaskConstraints(input: NativeExecutionInput): string[] {
  const finalResponseConstraint =
    "Invoke paperclip_finish or paperclip_block exactly once before writing the complete user-facing final response. After the semantic tool succeeds, write that response exactly once and do not call another tool.";
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
