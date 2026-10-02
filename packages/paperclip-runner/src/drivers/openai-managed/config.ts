/** OpenAI's API revision is a protocol pin, not an immutable hosted harness build. */
export const OPENAI_AGENTS_API_REVISION = "agents=v1" as const;
export const OPENAI_MANAGED_MODEL = "gpt-6-astra" as const;
export type OpenAiManagedEnvironment =
  | { type: "none" }
  | {
      type: "openai_hosted";
      container_size: "small" | "medium" | "large";
      network: { access: "disabled" | "enabled" } | { access: "restricted"; allowed_domains: string[] };
      packages?: { python?: string[]; npm?: string[]; system?: string[] };
      setup_commands?: Array<{ command: string; cwd?: string }>;
      files?: Array<{ type: "inline"; path: string; data: string } | { type: "file_id"; path: string; file_id: string }>;
    };
export interface OpenAiManagedProfile {
  profileId: string;
  apiRevision: typeof OPENAI_AGENTS_API_REVISION;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  environment: OpenAiManagedEnvironment;
  maxEstimatedSessionCostUsd: number;
  timeoutSeconds: number;
}
function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !keys.includes(k))) {
    throw new Error(`${label} contains unsupported settings`);
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);
}
function workspacePath(value: unknown): value is string {
  return text(value, 4096) && value.startsWith("/workspace/") && !value.split("/").some((p) => p === "." || p === "..");
}
export function parseOpenAiManagedEnvironment(value: unknown): OpenAiManagedEnvironment {
  const env = object(value, ["type", "container_size", "network", "packages", "setup_commands", "files"], "OpenAI environment");
  if (env.type === "none" && Object.keys(env).length === 1) return { type: "none" };
  if (env.type !== "openai_hosted" || !["small", "medium", "large"].includes(String(env.container_size))) {
    throw new Error("OpenAI environment must select none or an explicit hosted container size");
  }
  const network = object(env.network, ["access", "allowed_domains"], "OpenAI network policy");
  if (network.access === "restricted") {
    if (!Array.isArray(network.allowed_domains) || network.allowed_domains.length < 1 || network.allowed_domains.length > 100 ||
      network.allowed_domains.some((d) => !text(d, 253) || !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(d) || d.includes(".."))) {
      throw new Error("OpenAI restricted network requires 1–100 exact hostnames");
    }
  } else if (!["disabled", "enabled"].includes(String(network.access)) || network.allowed_domains !== undefined) {
    throw new Error("OpenAI hosted network policy must be explicit");
  }
  if (env.packages !== undefined) {
    const packages = object(env.packages, ["python", "npm", "system"], "OpenAI packages");
    for (const list of Object.values(packages)) if (!Array.isArray(list) || list.length > 100 || list.some((v) => !text(v))) {
      throw new Error("OpenAI package lists are invalid");
    }
  }
  if (env.setup_commands !== undefined) {
    if (!Array.isArray(env.setup_commands) || env.setup_commands.length > 50) throw new Error("OpenAI setup commands are invalid");
    for (const entry of env.setup_commands) {
      const command = object(entry, ["command", "cwd"], "OpenAI setup command");
      if (typeof command.command !== "string" || !command.command.trim() || command.command.length > 64_000 || command.command.includes("\0") ||
        (command.cwd !== undefined && command.cwd !== "/workspace" && !workspacePath(command.cwd))) throw new Error("OpenAI setup command is invalid");
    }
  }
  if (env.files !== undefined) {
    if (!Array.isArray(env.files) || env.files.length > 50) throw new Error("OpenAI accepts at most 50 initial files");
    const paths = new Set<string>(); let total = 0;
    for (const entry of env.files) {
      const file = object(entry, ["type", "path", "data", "file_id"], "OpenAI input file");
      if (!workspacePath(file.path) || paths.has(file.path)) throw new Error("OpenAI file paths must be unique and inside /workspace");
      paths.add(file.path);
      if (file.type === "inline" && file.file_id === undefined && typeof file.data === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) {
        const bytes = Buffer.from(file.data, "base64").length; total += bytes;
        if (bytes > 5 * 1024 * 1024) throw new Error("OpenAI inline file exceeds 5 MiB");
      } else if (file.type !== "file_id" || file.data !== undefined || !text(file.file_id) || !/^file[-_a-zA-Z0-9]+$/.test(file.file_id)) {
        throw new Error("OpenAI file must use inline base64 data or a Files API ID");
      }
    }
    if (total > 10 * 1024 * 1024) throw new Error("OpenAI inline files exceed 10 MiB");
  }
  return structuredClone(env) as OpenAiManagedEnvironment;
}
export function parseOpenAiManagedProfile(value: unknown): OpenAiManagedProfile {
  const profile = object(value, ["profileId", "apiRevision", "reasoningEffort", "environment", "maxEstimatedSessionCostUsd", "timeoutSeconds"], "OpenAI managed profile");
  if (!text(profile.profileId) || profile.apiRevision !== OPENAI_AGENTS_API_REVISION ||
    !["low", "medium", "high", "xhigh", "max", "ultra"].includes(String(profile.reasoningEffort)) ||
    typeof profile.maxEstimatedSessionCostUsd !== "number" || !Number.isFinite(profile.maxEstimatedSessionCostUsd) || profile.maxEstimatedSessionCostUsd <= 0 ||
    !Number.isSafeInteger(profile.timeoutSeconds) || Number(profile.timeoutSeconds) < 1 || Number(profile.timeoutSeconds) > 3600) {
    throw new Error("OpenAI managed profile requires a model policy, positive estimated budget, and 1–3600 second timeout");
  }
  return { ...profile, environment: parseOpenAiManagedEnvironment(profile.environment) } as OpenAiManagedProfile;
}
