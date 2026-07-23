#!/usr/bin/env npx tsx
import fs from "node:fs/promises";
import path from "node:path";

type ManifestEntry = {
  agentId: string;
  sourceFile: string;
  entryFile?: string;
  label?: string;
};

type Manifest = {
  agents: ManifestEntry[];
};

type AgentFileResponse = {
  content: string;
};

function parseArgs(argv: string[]) {
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const [flag, inlineValue] = token.split("=", 2);
    if (inlineValue !== undefined) {
      flags.set(flag, inlineValue);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(flag, true);
      continue;
    }
    flags.set(flag, next);
    index += 1;
  }

  const manifestPath = flags.get("--manifest");
  if (typeof manifestPath !== "string" || manifestPath.trim().length === 0) {
    throw new Error("Missing required --manifest <path> option.");
  }

  const apiBase = typeof flags.get("--api-base") === "string"
    ? String(flags.get("--api-base")).trim()
    : process.env.PAPERCLIP_API_URL?.trim();
  if (!apiBase) {
    throw new Error("Missing API base. Pass --api-base or set PAPERCLIP_API_URL.");
  }

  const token = typeof flags.get("--token") === "string"
    ? String(flags.get("--token")).trim()
    : process.env.PAPERCLIP_API_KEY?.trim();
  if (!token) {
    throw new Error("Missing API token. Pass --token or set PAPERCLIP_API_KEY.");
  }

  return {
    manifestPath,
    apiBase,
    token,
    json: flags.has("--json"),
  };
}

function ensureManifest(value: unknown): Manifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Manifest must be a JSON object with an agents array.");
  }
  const agents = (value as { agents?: unknown }).agents;
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error("Manifest agents array is required and cannot be empty.");
  }
  return value as Manifest;
}

function resolveFromManifest(manifestDir: string, targetPath: string) {
  if (path.isAbsolute(targetPath)) return targetPath;
  return path.resolve(manifestDir, targetPath);
}

async function requestJson<T>(apiBase: string, token: string, targetPath: string): Promise<T> {
  const response = await fetch(new URL(targetPath, apiBase), {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GET ${targetPath} failed: ${response.status} ${body}`);
  }
  return response.json() as Promise<T>;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestAbsolutePath = path.resolve(options.manifestPath);
  const manifestDir = path.dirname(manifestAbsolutePath);
  const manifestRaw = await fs.readFile(manifestAbsolutePath, "utf8");
  const manifest = ensureManifest(JSON.parse(manifestRaw));

  const results: Array<{
    agentId: string;
    label: string;
    sourceFile: string;
    status: "match" | "missing_source" | "drift";
  }> = [];

  for (const entry of manifest.agents) {
    const entryFile = entry.entryFile?.trim() || "AGENTS.md";
    const label = entry.label?.trim() || entry.agentId;
    const sourceFile = resolveFromManifest(manifestDir, entry.sourceFile);
    const liveFile = await requestJson<AgentFileResponse>(
      options.apiBase,
      options.token,
      `/api/agents/${entry.agentId}/instructions-bundle/file?path=${encodeURIComponent(entryFile)}`,
    );

    let localContent: string;
    try {
      localContent = await fs.readFile(sourceFile, "utf8");
    } catch {
      results.push({ agentId: entry.agentId, label, sourceFile, status: "missing_source" });
      continue;
    }

    results.push({
      agentId: entry.agentId,
      label,
      sourceFile,
      status: localContent === liveFile.content ? "match" : "drift",
    });
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: results.every((entry) => entry.status === "match"), results }, null, 2)}\n`);
  } else {
    for (const result of results) {
      console.log(`${result.status.toUpperCase()}: ${result.label} -> ${result.sourceFile}`);
    }
  }

  if (results.some((entry) => entry.status !== "match")) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
