import type { CreateConfigValues } from "../types";

export interface EmissoCreateConfigValues extends CreateConfigValues {
  repoUrl?: string;
  vcpus?: number;
  timeoutSec?: number;
  snapshotId?: string;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function buildEmissoSandboxConfig(v: CreateConfigValues): Record<string, unknown> {
  const ev = v as EmissoCreateConfigValues;
  const ac: Record<string, unknown> = {};

  if (ev.model) ac.model = ev.model;
  if (ev.repoUrl) ac.repoUrl = ev.repoUrl;
  if (ev.vcpus) ac.vcpus = Number(ev.vcpus);
  if (ev.timeoutSec) ac.timeoutSec = Number(ev.timeoutSec);
  if (ev.maxTurns) ac.maxTurns = Number(ev.maxTurns);
  if (ev.snapshotId) ac.snapshotId = ev.snapshotId;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;

  const mcpServers = parseJsonObject(v.mcpServersJson ?? "");
  if (mcpServers) ac.mcpServers = mcpServers;

  return ac;
}
