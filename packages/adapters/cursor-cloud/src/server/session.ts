import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readRepos(value: unknown): Array<{ url: string; startingRef?: string; prUrl?: string }> {
  if (!Array.isArray(value)) return [];
  const repos: Array<{ url: string; startingRef?: string; prUrl?: string }> = [];
  for (const entry of value) {
    const repo = asRecord(entry);
    if (!repo) continue;
    const url = readString(repo.url);
    if (!url) continue;
    const startingRef = readString(repo.startingRef);
    const prUrl = readString(repo.prUrl);
    repos.push({
      url,
      ...(startingRef ? { startingRef } : {}),
      ...(prUrl ? { prUrl } : {}),
    });
  }
  return repos;
}

function normalize(raw: unknown): Record<string, unknown> | null {
  const record = asRecord(raw);
  if (!record) return null;
  const cursorAgentId =
    readString(record.cursorAgentId) ??
    readString(record.agentId) ??
    readString(record.sessionId);
  if (!cursorAgentId) return null;
  const latestRunId = readString(record.latestRunId) ?? readString(record.runId);
  const runtime = readString(record.runtime) ?? "cloud";
  const envType = readString(record.envType);
  const envName = readString(record.envName);
  const repos = readRepos(record.repos);
  return {
    cursorAgentId,
    ...(latestRunId ? { latestRunId } : {}),
    runtime,
    ...(envType ? { envType } : {}),
    ...(envName ? { envName } : {}),
    ...(repos.length > 0 ? { repos } : {}),
  };
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize: normalize,
  serialize: normalize,
  getDisplayId(params) {
    const normalized = normalize(params);
    return normalized ? String(normalized.cursorAgentId) : null;
  },
};
