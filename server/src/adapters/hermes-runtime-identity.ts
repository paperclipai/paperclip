import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterRuntimeIdentityContext,
  AdapterRuntimeIdentityResult,
} from "@paperclipai/adapter-utils";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const MANAGED_BY = "paperclip.hermes_local.runtime_identity.v1";
const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,95}$/;

type RuntimeIdentityEnv = Record<string, string | undefined>;

type HermesModelDefaults = {
  model: string;
  provider: string;
  source: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function slugPart(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return slug || "unnamed";
}

function safeExistingSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return SAFE_SLUG_RE.test(trimmed) ? trimmed : null;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

async function writeFileIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await writeFile(filePath, content, { flag: "wx" });
  } catch (err) {
    if (isNodeError(err) && err.code === "EEXIST") return;
    throw err;
  }
}

function parseHermesModelDefaultsFromConfig(content: string, source: string): HermesModelDefaults | null {
  const lines = content.split("\n");
  let inModelSection = false;
  let model = "";
  let provider = "";

  for (const line of lines) {
    const trimmedEnd = line.trimEnd();
    const trimmed = trimmedEnd.trim();
    const indent = line.length - line.trimStart().length;

    if (/^model:\s*$/.test(trimmedEnd) && indent === 0) {
      inModelSection = true;
      continue;
    }

    if (inModelSection && indent === 0 && trimmed && !trimmed.startsWith("#")) {
      inModelSection = false;
    }

    if (!inModelSection) continue;

    const match = trimmedEnd.match(/^\s*(\w+)\s*:\s*(.+)$/);
    if (!match) continue;

    const key = match[1];
    const value = parseYamlScalarString(match[2]);
    if (key === "default") model = value;
    if (key === "provider") provider = value;
  }

  if (!model) return null;
  return { model, provider, source };
}

function parseYamlScalarString(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("\"")) {
    let escaped = false;
    for (let index = 1; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        const quoted = trimmed.slice(0, index + 1);
        try {
          const parsed = JSON.parse(quoted);
          if (typeof parsed === "string") return parsed;
        } catch {
          return quoted.slice(1, -1);
        }
      }
    }
  }
  if (trimmed.startsWith("'")) {
    let scalar = "";
    for (let index = 1; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (char === "'" && trimmed[index + 1] === "'") {
        scalar += "'";
        index += 1;
        continue;
      }
      if (char === "'") return scalar;
      scalar += char;
    }
  }
  return trimmed.replace(/\s+#.*$/, "");
}

function modelDefaultsFromEnv(env: RuntimeIdentityEnv): HermesModelDefaults | null {
  const model = asNonEmptyString(env.HERMES_MODEL) ?? asNonEmptyString(env.HERMES_INFERENCE_MODEL);
  if (!model) return null;
  return {
    model,
    provider: asNonEmptyString(env.HERMES_PROVIDER) ?? asNonEmptyString(env.HERMES_INFERENCE_PROVIDER) ?? "",
    source: "env",
  };
}

async function modelDefaultsFromConfig(
  baseHermesHome: string | null,
  targetHermesHome?: string,
): Promise<HermesModelDefaults | null> {
  if (!baseHermesHome) return null;
  const base = path.resolve(baseHermesHome);
  if (targetHermesHome && base === path.resolve(targetHermesHome)) return null;

  const configPath = path.join(base, "config.yaml");
  try {
    return parseHermesModelDefaultsFromConfig(await readFile(configPath, "utf8"), configPath);
  } catch {
    return null;
  }
}

export async function detectHermesRuntimeModelDefaults(
  options: {
    baseHermesHome?: string | null;
    env?: RuntimeIdentityEnv;
  } = {},
): Promise<HermesModelDefaults | null> {
  const env = options.env ?? process.env;
  const envDefaults = modelDefaultsFromEnv(env);
  if (envDefaults) return envDefaults;
  return await modelDefaultsFromConfig(
    options.baseHermesHome ?? asNonEmptyString(env.HERMES_HOME) ?? asNonEmptyString(env.HERMES_DATA_ROOT),
  );
}

function buildManagedHermesConfig(modelDefaults: HermesModelDefaults | null): string {
  return [
    ...(modelDefaults
      ? [
          "model:",
          ...(modelDefaults.provider ? [`  provider: ${quoteYamlString(modelDefaults.provider)}`] : []),
          `  default: ${quoteYamlString(modelDefaults.model)}`,
          "",
        ]
      : []),
    "dashboard:",
    "  show_token_analytics: true",
    "",
  ].join("\n");
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value);
}

export function deriveHermesProfileSlug(input: {
  companyName: string;
  agentName: string;
  existingSlug: unknown;
}): string {
  const existing = safeExistingSlug(input.existingSlug);
  if (existing) return existing;
  const combined = `${slugPart(input.companyName)}-${slugPart(input.agentName)}`;
  if (combined.length <= 96) return combined;
  const digest = createHash("sha256").update(combined).digest("hex").slice(0, 8);
  return `${combined.slice(0, 87).replace(/-+$/g, "")}-${digest}`;
}

export async function ensureHermesRuntimeIdentity(
  ctx: AdapterRuntimeIdentityContext & {
    instanceRoot?: string;
    now?: string;
    baseHermesHome?: string;
    env?: RuntimeIdentityEnv;
  },
): Promise<AdapterRuntimeIdentityResult> {
  const metadata = isRecord(ctx.metadata) ? { ...ctx.metadata } : {};
  const previousIdentity = isRecord(metadata.runtimeIdentity)
    ? metadata.runtimeIdentity
    : {};
  const profileSlug = deriveHermesProfileSlug({
    companyName: ctx.companyName,
    agentName: ctx.agentName,
    existingSlug: previousIdentity.profileSlug,
  });
  const instanceRoot = ctx.instanceRoot ?? resolvePaperclipInstanceRoot();
  const hermesHome = path.join(instanceRoot, "runtimes", "hermes", "profiles", profileSlug);

  await mkdir(hermesHome, { recursive: true });

  const configPath = path.join(hermesHome, "config.yaml");
  const env = ctx.env ?? process.env;
  let modelDefaults = modelDefaultsFromEnv(env);
  if (!modelDefaults) {
    modelDefaults = await modelDefaultsFromConfig(
      ctx.baseHermesHome ?? asNonEmptyString(env.HERMES_HOME) ?? asNonEmptyString(env.HERMES_DATA_ROOT),
      hermesHome,
    );
  }
  await writeFileIfMissing(
    configPath,
    buildManagedHermesConfig(modelDefaults),
  );

  const adapterEnv = isRecord(ctx.adapterConfig.env)
    ? { ...ctx.adapterConfig.env }
    : {};
  const adapterConfig = {
    ...ctx.adapterConfig,
    env: {
      ...adapterEnv,
      HERMES_HOME: hermesHome,
    },
  };

  return {
    adapterConfig,
    metadata: {
      ...metadata,
      runtimeIdentity: {
        ...previousIdentity,
        adapter: "hermes_local",
        profileSlug,
        hermesHome,
        managedBy: MANAGED_BY,
        createdAt: typeof previousIdentity.createdAt === "string"
          ? previousIdentity.createdAt
          : ctx.now ?? new Date().toISOString(),
      },
    },
    detail: { profileSlug, hermesHome },
  };
}
