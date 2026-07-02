import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { isCursorCloudAgentId } from "./cursor-run-events.js";

export { isCursorCloudAgentId };

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

function normalizeEnvType(raw: string | null | undefined): "cloud" | "pool" | "machine" {
  const value = (raw ?? "cloud").trim().toLowerCase();
  if (value === "pool" || value === "machine") return value;
  return "cloud";
}

export function sessionIdentityMatches(
  session: Record<string, unknown> | null,
  identity: {
    envType: "cloud" | "pool" | "machine";
    envName: string | null;
    repos: Array<{ url: string; startingRef?: string; prUrl?: string }>;
  },
): boolean {
  const normalized = normalize(session);
  if (!normalized) return false;
  const sessionEnvType = normalizeEnvType(readString(normalized.envType));
  const sessionEnvName = readString(normalized.envName);
  const sessionRepos = readRepos(normalized.repos);
  if (sessionEnvType !== identity.envType) return false;
  if ((sessionEnvName ?? null) !== identity.envName) return false;
  if (sessionRepos.length !== identity.repos.length) return false;
  return sessionRepos.every((repo, index) => {
    const next = identity.repos[index];
    return (
      repo.url === next.url
      && (repo.startingRef ?? null) === (next.startingRef ?? null)
      && (repo.prUrl ?? null) === (next.prUrl ?? null)
    );
  });
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
