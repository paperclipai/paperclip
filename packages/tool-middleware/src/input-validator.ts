/**
 * Input validator — enforces a byte ceiling on tool call inputs.
 *
 * Exceeding the ceiling causes the tool call to be rejected with an
 * instructive error telling the agent to use a file path + line range instead.
 */

export interface InputValidationResult {
  valid: boolean;
  errorMessage?: string;
  inputBytes: number;
}

/**
 * Validate that a tool call's input is within the byte ceiling.
 *
 * @param toolName - The name of the tool being called.
 * @param toolInput - The tool input object.
 * @param maxInputBytes - Maximum allowed byte count (default 10,000).
 */
export function validateToolInput(
  toolName: string,
  toolInput: Record<string, unknown>,
  maxInputBytes = 10_000,
): InputValidationResult {
  const serialized = JSON.stringify(toolInput);
  const inputBytes = Buffer.byteLength(serialized, "utf8");

  if (inputBytes <= maxInputBytes) {
    return { valid: true, inputBytes };
  }

  const errorMessage =
    `Tool input for "${toolName}" is ${inputBytes} bytes, exceeding the ${maxInputBytes}-byte ceiling. ` +
    `Use a file path + line range instead of embedding raw content in the tool input. ` +
    `Example: read_file(path="...", start_line=1, end_line=100) rather than passing the full file content.`;

  return { valid: false, errorMessage, inputBytes };
}

/**
 * Build the JSON response a PreToolUse hook should print to stdout to block the call.
 * Claude Code interprets a non-zero exit code OR a "block" decision as a rejection.
 */
export function buildBlockResponse(errorMessage: string): string {
  return JSON.stringify({ decision: "block", reason: errorMessage });
}
