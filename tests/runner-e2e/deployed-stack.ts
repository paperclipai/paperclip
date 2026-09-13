import fs from "node:fs";
import assert from "node:assert/strict";
import type { WorkFolderListing } from "../../packages/shared/src/work-folders.js";

/** Find one entry without assuming a shared folder fits in the first page. */
export async function findDeployedWorkFile(
  api: Pick<DeployedStackApi, "json">,
  folderPath: string,
  filePath: string,
  trash = false,
) {
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: "200", trash: String(trash) });
    if (cursor) query.set("cursor", cursor);
    const listing: WorkFolderListing = await api.json(`${folderPath}?${query}`);
    const file = listing.files.find((entry) => entry.path === filePath);
    if (file) return file;
    cursor = listing.nextCursor;
    if (cursor) {
      assert(!cursors.has(cursor), "Work-folder listing repeated its cursor");
      cursors.add(cursor);
    }
  } while (cursor);
  return undefined;
}

// A separate target contract deliberately has no local-server fallback.
export function isStagingOrigin(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".staging.paperclip.app")
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch { return false; }
}
export interface DeployedStack {
  baseURL: string; stackId: string; commit: string; appImage: string; migratorVersion: string; sandboxImage: string;
  companyId: string; taskId: string; agentId: string; projectId: string; userId: string;
  excludedAdapters?: Array<{ adapterType: string; reason: string }>;
  profiles: Array<{ id: string; adapterType: string; engine: string; model: string; qualification: string; agentId: string }>;
}

/** Derive coverage from the live configuration, never a manifest's label. */
export function deployedAgentEngine(agent: { adapterType: string; adapterConfig: Record<string, unknown> }): string {
  const config = agent.adapterConfig;
  if (agent.adapterType === "paperclip_runner") {
    assert(config.provider === "codex" || config.provider === "opencode" || config.provider === "acpx", "Unknown native provider");
    if (config.provider !== "acpx") return config.provider;
    assert(typeof config.acpxAgent === "string" && config.acpxAgent.length > 0, "Missing native ACPX engine");
    return `acpx:${config.acpxAgent}`;
  }
  assert(config.engine === undefined || config.engine === "cli" || config.engine === "acp", "Unknown legacy engine");
  return config.engine === "acp" ? "acp" : "cli";
}

export function loadDeployedStack(): DeployedStack {
  const filename = process.env.PAPERCLIP_DEPLOYED_STACK_MANIFEST;
  if (!filename) throw new Error("PAPERCLIP_DEPLOYED_STACK_MANIFEST is required");
  const manifest = JSON.parse(fs.readFileSync(filename, "utf8")) as DeployedStack;
  assert(manifest && typeof manifest === "object", "Invalid manifest");
  for (const key of ["baseURL", "stackId", "commit", "appImage", "migratorVersion", "sandboxImage", "companyId", "taskId", "agentId", "projectId", "userId"] as const) {
    assert(typeof manifest[key] === "string" && manifest[key].length > 0, `Missing manifest ${key}`);
  }
  assert(isStagingOrigin(manifest.baseURL), "Use the dedicated HTTPS staging tenant origin");
  assert(/^[a-f0-9]{40}$/.test(manifest.commit), "Expected full commit SHA");
  assert(/@sha256:[a-f0-9]{64}$/.test(manifest.sandboxImage), "Expected immutable sandbox image");
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  for (const key of ["companyId", "taskId", "agentId", "projectId"] as const) assert(uuid.test(manifest[key]), `Invalid ${key}`);
  assertDeployedAdapterExclusions(manifest.excludedAdapters);
  assert(Array.isArray(manifest.profiles) && manifest.profiles.length >= 7, "The seven baseline profiles are required");
  for (const profile of manifest.profiles) {
    for (const key of ["id", "adapterType", "engine", "model", "qualification", "agentId"] as const) {
      assert(typeof profile[key] === "string" && profile[key].length > 0, `Missing profile ${key}`);
    }
    assert(uuid.test(profile.agentId), "Invalid profile agent ID");
  }
  if (new Set(manifest.profiles.map((profile) => profile.id)).size !== manifest.profiles.length) {
    throw new Error("Duplicate deployed profile IDs");
  }
  return manifest;
}

export class DeployedStackApi {
  private readonly token: string;
  constructor(readonly stack: DeployedStack) {
    const filename = process.env.PAPERCLIP_DEPLOYED_STACK_AUTH;
    if (!filename || (fs.statSync(filename).mode & 0o077) !== 0) {
      throw new Error("PAPERCLIP_DEPLOYED_STACK_AUTH must name a private (0600) credentials file");
    }
    const auth = JSON.parse(fs.readFileSync(filename, "utf8"));
    assert(typeof auth?.baseURL === "string" && typeof auth.boardApiToken === "string" && auth.boardApiToken.length > 0, "Invalid stack credentials");
    if (new URL(auth.baseURL).origin !== new URL(stack.baseURL).origin) throw new Error("Credentials belong to another stack");
    this.token = auth.boardApiToken;
  }
  // Node fetch keeps credentials out of Playwright traces, request attachments,
  // and serialized reporter configuration. Error bodies may contain run secrets.
  async request(path: string, options: RequestInit = {}): Promise<Response> {
    if (!path.startsWith("/api/") || path.includes("\\") || path.includes("..")) throw new Error("Invalid tenant API path");
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    return fetch(new URL(path, this.stack.baseURL), {
      ...options, headers, redirect: "error", signal: AbortSignal.timeout(60_000),
    });
  }
  async json<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await this.request(path, { method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${path.split("?")[0]} returned ${response.status}; body withheld`);
    return response.json() as Promise<T>;
  }
}

/** User-approved scope for this acceptance campaign; core engines cannot be excluded. */
export function assertDeployedAdapterExclusions(exclusions: DeployedStack["excludedAdapters"]) {
  if (exclusions === undefined) return;
  assert(Array.isArray(exclusions), "Invalid adapter exclusions");
  for (const entry of exclusions) {
    assert(["cursor", "gemini_local", "grok_local", "kimi_local"].includes(entry.adapterType), "Core acceptance adapters cannot be excluded");
    assert(typeof entry.reason === "string" && entry.reason.trim().length > 0, "Exclusions require an explicit reason");
  }
}
