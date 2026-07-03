import fsSync from "node:fs";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterInvocationMeta,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
} from "@paperclipai/adapter-utils/server-utils";
import { parseStringMapConfig, unresolvedBindingWarning } from "./gateway-execute.js";
import {
  looksLikeEveProject,
  pickFreePort,
  spawnEveServer,
  stopEveServer,
  waitForReady,
  type EveServerHandle,
} from "./local-runtime.js";
import {
  buildEvePrompt,
  errorResult,
  eventLine,
  formatError,
  readSession,
  runEveTurn,
  trimNullable,
} from "./run-turn.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_READY_TIMEOUT_MS = 90_000;
const DEFAULT_COMMAND = "eve";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, onLog, onMeta, onSpawn } = ctx;
  let handle: EveServerHandle | null = null;

  try {
    const projectDir = asString(config.projectDir, "").trim();
    if (!projectDir) {
      return errorResult({
        errorMessage: "eve_local requires projectDir in adapterConfig (absolute path to the Eve project).",
      });
    }
    if (!fsSync.existsSync(projectDir) || !fsSync.statSync(projectDir).isDirectory()) {
      return errorResult({
        errorMessage: `eve_local projectDir does not exist or is not a directory: ${projectDir}`,
      });
    }
    if (!looksLikeEveProject(projectDir)) {
      return errorResult({
        errorMessage: `eve_local projectDir does not look like an Eve project (missing agent/instructions.md and agent.ts): ${projectDir}. Run \`npx eve init\` in the project directory, or double-check the path.`,
      });
    }

    const command = asString(config.command, DEFAULT_COMMAND).trim() || DEFAULT_COMMAND;
    const configuredArgs = asStringArray(config.commandArgs);
    const configuredPort = asNumber(config.port, 0);
    const port = configuredPort > 0 ? Math.floor(configuredPort) : await pickFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const args =
      configuredArgs.length > 0
        ? configuredArgs
        : ["dev", "--no-ui", "--port", String(port), "--host", "127.0.0.1"];
    const { map: configEnv, skippedKeys: skippedEnvKeys } = parseStringMapConfig(config.env);
    if (skippedEnvKeys.length > 0) {
      await onLog("stderr", unresolvedBindingWarning("env", skippedEnvKeys));
    }
    const readyTimeoutMs = asNumber(config.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS);
    const timeoutMs = asNumber(config.timeoutMs, DEFAULT_TIMEOUT_MS);
    const runTimeoutMs = asNumber(config.runTimeoutMs, DEFAULT_RUN_TIMEOUT_MS);
    const configModel = trimNullable(config.model);

    const priorSession = readSession(runtime.sessionParams);
    const resumedSession = priorSession !== null;

    const promptBuild = await buildEvePrompt({ ctx, config, resumedSession });
    const { finalPrompt, instructions, renderedBootstrapPrompt, wakePrompt, renderedPrompt } = promptBuild;

    const childEnv: Record<string, string> = {
      ...configEnv,
      ...buildPaperclipEnv(agent),
      PAPERCLIP_RUN_ID: runId,
      PORT: String(port),
    };

    const commandNotes = [
      ...instructions.notes,
      resumedSession
        ? `Resuming Eve session ${priorSession?.eveSessionId} (session durability across local server restarts is best-effort; stale sessions fall back to a fresh one)`
        : "Starting a new Eve session",
      `Spawning local Eve server in ${projectDir} on ${baseUrl}`,
    ];

    if (onMeta) {
      const meta: AdapterInvocationMeta = {
        adapterType: "eve_local",
        command,
        commandArgs: args,
        cwd: projectDir,
        commandNotes,
        prompt: finalPrompt,
        promptMetrics: {
          promptChars: finalPrompt.length,
          instructionsChars: instructions.chars,
          bootstrapPromptChars: renderedBootstrapPrompt.length,
          wakePromptChars: wakePrompt.length,
          heartbeatPromptChars: renderedPrompt.length,
        },
        context: {
          eveLocal: {
            projectDir,
            baseUrl,
            port,
            resumedSession,
          },
        },
      };
      await onMeta(meta);
    }

    handle = await spawnEveServer({
      projectDir,
      command,
      args,
      port,
      env: childEnv,
      onLog,
      ...(onSpawn ? { onSpawn } : {}),
    });

    await waitForReady({ baseUrl, headers: {}, timeoutMs: readyTimeoutMs });

    return await runEveTurn({
      baseUrl,
      headers: {},
      finalPrompt,
      priorSession,
      configModel,
      timeoutMs,
      runTimeoutMs,
      onLog,
    });
  } catch (err) {
    const reason = formatError(err);
    const priorSession = readSession(runtime.sessionParams);
    try {
      await onLog("stdout", eventLine({ type: "eve.result", status: "error", error: reason }));
    } catch {
      // Best effort only.
    }
    return errorResult({
      errorMessage: reason,
      session: priorSession,
      resultJson: {
        status: "error",
        ...(priorSession ? { eveSessionId: priorSession.eveSessionId } : {}),
        error: reason,
      },
    });
  } finally {
    if (handle) {
      try {
        await stopEveServer(handle);
      } catch (err) {
        // stopEveServer never throws, but keep teardown failures out of the result.
        try {
          await onLog("stderr", `[paperclip] Failed to stop local Eve server: ${formatError(err)}\n`);
        } catch {
          // Best effort only.
        }
      }
    }
  }
}
