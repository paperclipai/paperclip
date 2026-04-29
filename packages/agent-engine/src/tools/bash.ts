import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { TextToolResult, Tool, ToolExecutionContext } from "../types.js";

const execFile = promisify(execFileCallback);

export interface BashParams {
  /** Bash command to execute. */
  command: string;
  /** Timeout in seconds (optional, no default timeout). */
  timeout?: number;
}

/**
 * Execute a bash command in the agent's working directory.
 * Output is truncated to last 2000 lines or 50KB.
 */
export async function bashCommand(
  params: BashParams,
  ctx: ToolExecutionContext,
): Promise<TextToolResult> {
  try {
    const { stdout, stderr } = await execFile("bash", ["-c", params.command], {
      cwd: ctx.cwd,
      env: { ...process.env, ...ctx.env },
      timeout: params.timeout ? params.timeout * 1000 : undefined,
      killSignal: "SIGTERM",
    });

    const combined = stdout + (stderr ? `\n${stderr}` : "");

    const MAX_LINES = 2000;
    const MAX_BYTES = 50 * 1024;

    let output = combined;

    const lines = output.split("\n");
    if (lines.length > MAX_LINES) {
      output = lines.slice(-MAX_LINES).join("\n");
      output = `[truncated to last ${MAX_LINES} lines]\n${output}`;
    }

    if (output.length > MAX_BYTES) {
      output = output.slice(-MAX_BYTES);
      output = `[truncated to last ${MAX_BYTES} bytes]\n${output}`;
    }

    return { content: output || "(no output)" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stdout = (err as { stdout?: string }).stdout ?? "";
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const combined = stdout + (stderr ? `\n${stderr}` : "");
    return {
      content: `Error: ${message}\n${combined}`.trim(),
      isError: true,
    };
  }
}

export function createBashTool(): Tool<BashParams, TextToolResult> {
  return {
    name: "bash",
    displayName: "Bash",
    description:
      "Execute a bash command in the current working directory. " +
      "Output is truncated to last 2000 lines or 50KB.",
    parametersSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Bash command to execute.",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (optional, no default timeout).",
        },
      },
      required: ["command"],
    },
    execute: bashCommand,
  };
}
