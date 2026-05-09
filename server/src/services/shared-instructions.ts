import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SHARED_INSTRUCTIONS_SEPARATOR = "\n\n---\n\n";

export function buildMergedSharedInstructions(
  sharedInstructions: string,
  originalContent: string,
): string {
  return `${sharedInstructions}${SHARED_INSTRUCTIONS_SEPARATOR}${originalContent}`;
}

export function sharedInstructionsTempFilePath(agentId: string, runId: string): string {
  return path.join(os.tmpdir(), `paperclip-shared-instructions-${agentId}-${runId}.md`);
}

export type ResolveSharedInstructionsInput = {
  agentId: string;
  runId: string;
  sharedInstructions: string | null;
  optedOut: boolean;
  originalInstructionsFilePath: string | null;
};

export type ResolveSharedInstructionsOutcome =
  | { kind: "skipped"; reason: "no_policy" | "opt_out" | "no_instructions_file" }
  | { kind: "injected"; tempFilePath: string };

/**
 * GLA-873: Materialize a per-run merged instructions file when the company has
 * shared_instructions configured and the agent is not opted out. Returns the
 * temp file path so the caller can swap it into the adapter config and clean
 * it up after the run.
 */
export async function resolveSharedInstructions(
  input: ResolveSharedInstructionsInput,
): Promise<ResolveSharedInstructionsOutcome> {
  if (!input.sharedInstructions) {
    return { kind: "skipped", reason: "no_policy" };
  }
  if (input.optedOut) {
    return { kind: "skipped", reason: "opt_out" };
  }
  if (!input.originalInstructionsFilePath) {
    return { kind: "skipped", reason: "no_instructions_file" };
  }
  const originalContent = await fs.readFile(input.originalInstructionsFilePath, "utf8").catch(() => "");
  const merged = buildMergedSharedInstructions(input.sharedInstructions, originalContent);
  const tempFilePath = sharedInstructionsTempFilePath(input.agentId, input.runId);
  await fs.writeFile(tempFilePath, merged, "utf8");
  return { kind: "injected", tempFilePath };
}
