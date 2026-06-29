import fs from "node:fs/promises";
import path from "node:path";
import { joinPromptSections, renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  normalizeAgentRunContextBundle,
  renderAgentRunContextBundlePrompt,
  writeAgentRunContextBundleFiles,
} from "../services/agent-run-context-bundle.js";

const HERMES_COORDINATION_GUIDANCE = [
  "Paperclip coordination (token-efficient):",
  "Follow the synced `paperclip` skill. Prefer MCP tools or `inbox-lite` / `heartbeat-context` over full issue dumps.",
  "Do not use terminal curl for Paperclip API in headless runs.",
  "Bearer $PAPERCLIP_API_KEY and X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on direct API writes.",
].join("\n");

const HERMES_TIMER_HEARTBEAT = [
  "## Paperclip Timer Heartbeat",
  "",
  "No scoped wake payload. Use `GET /api/agents/me/inbox-lite` (or MCP `list_issues` with a low limit).",
  "Prefer `GET /api/issues/{id}/heartbeat-context` over full comment threads. Exit if nothing assigned.",
].join("\n");

const HERMES_RESUME_NOTE = [
  "Paperclip session resumed — static agent instructions were already loaded in this Hermes session.",
  "Follow HEARTBEAT.md and the wake delta below. Do not refetch full threads unless `fallbackFetchNeeded` is true.",
].join("\n");

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readSessionId(runtime: unknown): string {
  if (typeof runtime !== "object" || runtime === null) return "";
  const record = runtime as Record<string, unknown>;
  const sessionParams = record.sessionParams;
  if (typeof sessionParams === "object" && sessionParams !== null) {
    const fromParams = asString((sessionParams as Record<string, unknown>).sessionId, "").trim();
    if (fromParams) return fromParams;
  }
  return asString(record.sessionId, "").trim();
}

export async function buildHermesPaperclipPrompt(input: {
  adapterConfig: Record<string, unknown>;
  context: Record<string, unknown>;
  runtime: unknown;
}): Promise<{
  promptTemplate: string;
  instructionsRootPath: string | null;
  logNotes: string[];
}> {
  const config = input.adapterConfig;
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const configuredRoot = asString(config.instructionsRootPath, "").trim();
  const instructionsRootPath = configuredRoot
    || (instructionsFilePath ? path.dirname(instructionsFilePath) : null);

  const resumedSession = readSessionId(input.runtime).length > 0;
  const wakePrompt = renderPaperclipWakePrompt(input.context.paperclipWake, { resumedSession });
  const scopedWake = wakePrompt.length > 0;
  const shouldSkipStaticInstructions = resumedSession && scopedWake;

  let instructionsPrefix = "";
  const logNotes: string[] = [];
  if (shouldSkipStaticInstructions) {
    instructionsPrefix = HERMES_RESUME_NOTE;
    logNotes.push("Skipped static instruction reinjection for resumed scoped wake (token-efficient delta prompt).");
  } else if (resumedSession) {
    instructionsPrefix = [
      HERMES_RESUME_NOTE,
      instructionsRootPath
        ? `Instruction bundle root: ${instructionsRootPath} (read HEARTBEAT.md only if needed).`
        : "",
    ].filter(Boolean).join("\n");
    logNotes.push("Skipped full AGENTS.md reinjection for resumed Hermes session.");
  } else if (instructionsFilePath) {
    try {
      const contents = await fs.readFile(instructionsFilePath, "utf8");
      const instructionsDir = `${path.dirname(instructionsFilePath)}/`;
      instructionsPrefix =
        `${contents}\n\n` +
        `Loaded from Paperclip bundle ${instructionsFilePath}. Resolve relative paths from ${instructionsDir}.\n`;
      logNotes.push(`Loaded Paperclip managed instructions from ${instructionsFilePath}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logNotes.push(
        `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read: ${reason}`,
      );
    }
  } else {
    logNotes.push(
      "No instructionsFilePath configured. Set up a managed instructions bundle in Paperclip for this agent.",
    );
  }

  const heartbeatSection = scopedWake ? "" : HERMES_TIMER_HEARTBEAT;
  const legacyPromptTemplate = asString(config.promptTemplate, "").trim();
  const runContextBundle = normalizeAgentRunContextBundle(input.context.paperclipRunContext);
  const runContextPrompt = runContextBundle
    ? renderAgentRunContextBundlePrompt(runContextBundle)
    : "";
  if (runContextBundle) {
    try {
      const contextRootPath = await writeAgentRunContextBundleFiles(runContextBundle);
      if (contextRootPath) {
        logNotes.push(`Wrote Paperclip Agent Run Context Bundle files to ${contextRootPath}`);
      } else {
        logNotes.push("Skipped Paperclip Agent Run Context Bundle files because no absolute workspace path is available.");
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logNotes.push(`Paperclip Agent Run Context Bundle files could not be written: ${reason}`);
    }
  }

  const promptTemplate = joinPromptSections([
    instructionsPrefix,
    shouldSkipStaticInstructions ? "" : HERMES_COORDINATION_GUIDANCE,
    runContextPrompt,
    wakePrompt,
    heartbeatSection,
    legacyPromptTemplate,
  ]);

  return { promptTemplate, instructionsRootPath, logNotes };
}
