import { buildAdapterEnvConfig, type CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "../index.js";

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildGeminiLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.geminiEngine === "cli" || v.geminiEngine === "acp") ac.engine = v.geminiEngine;
  if (v.geminiEngine === "acp") {
    if (v.geminiAcpAgentCommand) ac.agentCommand = v.geminiAcpAgentCommand;
    ac.mode = v.geminiAcpMode ?? "persistent";
    ac.nonInteractivePermissions = v.geminiAcpNonInteractivePermissions ?? "deny";
    if (v.geminiAcpStateDir) ac.stateDir = v.geminiAcpStateDir;
    ac.warmHandleIdleMs = v.geminiAcpWarmHandleIdleMs ?? 0;
  }
  ac.model = v.model || DEFAULT_GEMINI_LOCAL_MODEL;
  ac.timeoutSec = 0;
  ac.graceSec = 15;
  const env = buildAdapterEnvConfig(v.envBindings, v.envVars);
  if (Object.keys(env).length > 0) ac.env = env;
  ac.sandbox = !v.dangerouslyBypassSandbox;

  if (v.command) ac.command = v.command;
  if (v.extraArgs) ac.extraArgs = parseCommaArgs(v.extraArgs);
  return ac;
}
