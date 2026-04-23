/**
 * Login helper for the copilot_local adapter.
 *
 * Spawns `copilot login` (with optional `--host <gheHost>` for GitHub Enterprise)
 * and streams progress via an `onChunk` callback so callers (e.g. the SSE route)
 * can forward the device-flow code to the UI immediately — before the process
 * exits.
 *
 * Copilot login uses a device-flow: it prints a one-time code and a URL for the
 * user to complete browser-based authentication.  Without streaming the user
 * would only see the code after the 120 s timeout or successful auth, which is
 * too late.
 */
import {
  runChildProcess,
  ensureCommandResolvable,
} from "@paperclipai/adapter-utils/server-utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CopilotLoginResult {
  success: boolean;
  output: string;
  errorMessage: string | null;
}

/** A chunk emitted during the login process. */
export interface CopilotLoginChunk {
  stream: "stdout" | "stderr";
  text: string;
}

export interface CopilotLoginOptions {
  gheHost?: string;
  command?: string;
  /** Called for every stdout/stderr chunk so the caller can stream to the UI. */
  onChunk?: (chunk: CopilotLoginChunk) => void;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function copilotLogin(
  options?: CopilotLoginOptions,
): Promise<CopilotLoginResult> {
  const command = options?.command ?? "copilot";
  const gheHost = options?.gheHost?.trim() ?? "";
  const onChunk = options?.onChunk;

  const cwd = process.cwd();
  const env: Record<string, string> = {};
  const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...env };

  // Ensure the command is resolvable before spawning.
  try {
    await ensureCommandResolvable(command, cwd, mergedEnv);
  } catch (err) {
    const errorMessage =
      err instanceof Error
        ? err.message
        : `Command not found: "${command}"`;
    onChunk?.({ stream: "stderr", text: errorMessage });
    return {
      success: false,
      output: "",
      errorMessage,
    };
  }

  // Build args: `copilot login` or `copilot login --host <gheHost>`
  const args: string[] = ["login"];
  if (gheHost.length > 0) {
    args.push("--host", gheHost);
  }

  const runId = `copilot-login-${Date.now()}`;

  let stdoutChunks = "";
  let stderrChunks = "";

  try {
    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      timeoutSec: 120,
      graceSec: 10,
      onLog: async (stream, chunk) => {
        if (stream === "stdout") {
          stdoutChunks += chunk;
        } else {
          stderrChunks += chunk;
        }
        // Forward to the caller so it can stream to the UI in real-time.
        onChunk?.({ stream, text: chunk });
      },
    });

    const combinedOutput = [proc.stdout, proc.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();

    const exitedCleanly = (proc.exitCode ?? 1) === 0;

    if (exitedCleanly) {
      return {
        success: true,
        output: combinedOutput,
        errorMessage: null,
      };
    }

    // Non-zero exit — treat as failure.
    const errorDetail =
      proc.stderr.trim() || proc.stdout.trim() || `Process exited with code ${proc.exitCode}`;

    return {
      success: false,
      output: combinedOutput,
      errorMessage: errorDetail,
    };
  } catch (err) {
    return {
      success: false,
      output: [stdoutChunks, stderrChunks].filter(Boolean).join("\n").trim(),
      errorMessage:
        err instanceof Error ? err.message : "Unknown error during copilot login",
    };
  }
}
