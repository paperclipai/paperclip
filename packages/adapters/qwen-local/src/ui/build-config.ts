import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildQwenLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.model) ac.model = v.model;
  // baseUrl + apiKey are the vLLM endpoint coords. Sourced from extra config
  // fields surfaced by the UI form schema (Phase 4 wires them through).
  const extra = (v as unknown as Record<string, unknown>).extraConfig;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    const e = extra as Record<string, unknown>;
    if (typeof e.baseUrl === "string" && e.baseUrl.trim()) ac.baseUrl = e.baseUrl.trim();
    if (typeof e.apiKey === "string" && e.apiKey.trim()) ac.apiKey = e.apiKey.trim();
    if (typeof e.approvalMode === "string" && e.approvalMode.trim()) ac.approvalMode = e.approvalMode.trim();
  }
  ac.timeoutSec = 0;
  ac.graceSec = 10;
  if (v.command) ac.command = v.command;
  if (v.extraArgs) ac.extraArgs = parseCommaArgs(v.extraArgs);
  return ac;
}
