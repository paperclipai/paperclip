#!/usr/bin/env npx tsx
import fs from "node:fs/promises";
import path from "node:path";

type ManifestEntry = {
  agentId: string;
  sourceFile: string;
  entryFile?: string;
  legacyFile?: string;
  label?: string;
};

type Manifest = {
  agents: ManifestEntry[];
};

type AgentFileResponse = {
  path: string;
  content: string;
};

type AgentBundleResponse = {
  mode: "managed" | "external" | null;
  rootPath: string | null;
  entryFile: string;
  files: Array<{ path: string }>;
};

type AgentRecord = {
  agentId: string;
  label: string;
  sourceFile: string;
  entryFile: string;
  wroteSourceFile: boolean;
  movedLegacyFile: string | null;
  switchedMode: boolean;
  verification: "skipped" | "ok";
  notes: string[];
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
    writeFiles: flags.has("--write-files"),
    switchMode: flags.has("--switch-mode"),
    removeLegacy: flags.has("--remove-legacy"),
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
  for (const [index, entry] of agents.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`Manifest agents[${index}] must be an object.`);
    }
    const agentId = (entry as { agentId?: unknown }).agentId;
    const sourceFile = (entry as { sourceFile?: unknown }).sourceFile;
    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      throw new Error(`Manifest agents[${index}].agentId is required.`);
    }
    if (typeof sourceFile !== "string" || sourceFile.trim().length === 0) {
      throw new Error(`Manifest agents[${index}].sourceFile is required.`);
    }
  }
  return value as Manifest;
}

function resolveFromManifest(manifestDir: string, targetPath: string) {
  if (path.isAbsolute(targetPath)) return targetPath;
  return path.resolve(manifestDir, targetPath);
}

async function requestJson<T>(apiBase: string, token: string, targetPath: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(targetPath, apiBase), {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${init?.method ?? "GET"} ${targetPath} failed: ${response.status} ${body}`);
  }

  return response.json() as Promise<T>;
}

async function pathExists(targetPath: string) {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function maybeReadUtf8(targetPath: string) {
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch {
    return null;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestAbsolutePath = path.resolve(options.manifestPath);
  const manifestDir = path.dirname(manifestAbsolutePath);
  const manifestRaw = await fs.readFile(manifestAbsolutePath, "utf8");
  const manifest = ensureManifest(JSON.parse(manifestRaw));
  const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const results: AgentRecord[] = [];

  for (const entry of manifest.agents) {
    const entryFile = entry.entryFile?.trim() || "AGENTS.md";
    const sourceFile = resolveFromManifest(manifestDir, entry.sourceFile);
    const legacyFile = resolveFromManifest(
      manifestDir,
      entry.legacyFile?.trim() || path.join(path.dirname(entry.sourceFile), "AGENT.md"),
    );
    const label = entry.label?.trim() || entry.agentId;

    const notes: string[] = [];
    const liveFile = await requestJson<AgentFileResponse>(
      options.apiBase,
      options.token,
      `/api/agents/${entry.agentId}/instructions-bundle/file?path=${encodeURIComponent(entryFile)}`,
    );
    const currentSource = await maybeReadUtf8(sourceFile);
    let wroteSourceFile = false;
    let movedLegacyFile: string | null = null;

    if (currentSource !== liveFile.content) {
      notes.push(currentSource === null ? "source file missing" : "source file drifted from live bundle");
      if (options.writeFiles) {
        await fs.mkdir(path.dirname(sourceFile), { recursive: true });
        await fs.writeFile(sourceFile, liveFile.content, "utf8");
        wroteSourceFile = true;
      }
    }

    if (legacyFile !== sourceFile && await pathExists(legacyFile)) {
      if (options.writeFiles) {
        if (options.removeLegacy) {
          await fs.rm(legacyFile, { force: true });
          movedLegacyFile = "(removed)";
        } else {
          const backupPath = `${legacyFile}.bak.${timestamp}`;
          await fs.rename(legacyFile, backupPath);
          movedLegacyFile = backupPath;
        }
      } else {
        notes.push(`legacy file present at ${legacyFile}`);
      }
    }

    let switchedMode = false;
    if (options.switchMode) {
      const bundle = await requestJson<AgentBundleResponse>(
        options.apiBase,
        options.token,
        `/api/agents/${entry.agentId}/instructions-bundle`,
        {
          method: "PATCH",
          body: JSON.stringify({
            mode: "external",
            rootPath: path.dirname(sourceFile),
            entryFile: path.basename(sourceFile),
            clearLegacyPromptTemplate: true,
          }),
        },
      );
      switchedMode = bundle.mode === "external"
        && bundle.rootPath === path.dirname(sourceFile)
        && bundle.entryFile === path.basename(sourceFile);
      if (!switchedMode) {
        throw new Error(`Agent ${label} did not switch to the requested external bundle root.`);
      }
    }

    let verification: AgentRecord["verification"] = "skipped";
    if (options.writeFiles || options.switchMode) {
      const verifiedBundle = await requestJson<AgentBundleResponse>(
        options.apiBase,
        options.token,
        `/api/agents/${entry.agentId}/instructions-bundle`,
      );
      const verifiedSource = await fs.readFile(sourceFile, "utf8");
      if (verifiedSource !== liveFile.content) {
        throw new Error(`Verification failed for ${label}: source file does not match exported bundle content.`);
      }
      if (options.switchMode) {
        if (
          verifiedBundle.mode !== "external"
          || verifiedBundle.rootPath !== path.dirname(sourceFile)
          || verifiedBundle.entryFile !== path.basename(sourceFile)
        ) {
          throw new Error(`Verification failed for ${label}: bundle metadata does not point at the external source file.`);
        }
      }
      verification = "ok";
    }

    results.push({
      agentId: entry.agentId,
      label,
      sourceFile,
      entryFile,
      wroteSourceFile,
      movedLegacyFile,
      switchedMode,
      verification,
      notes,
    });
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
    return;
  }

  for (const result of results) {
    console.log(`== ${result.label} ==`);
    console.log(`source: ${result.sourceFile}`);
    console.log(`wrote source: ${result.wroteSourceFile ? "yes" : "no"}`);
    console.log(`legacy moved: ${result.movedLegacyFile ?? "no"}`);
    console.log(`switched mode: ${result.switchedMode ? "yes" : "no"}`);
    console.log(`verification: ${result.verification}`);
    if (result.notes.length > 0) {
      console.log(`notes: ${result.notes.join("; ")}`);
    }
    console.log("");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
