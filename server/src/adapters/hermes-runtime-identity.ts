import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterRuntimeIdentityContext,
  AdapterRuntimeIdentityResult,
} from "@paperclipai/adapter-utils";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const MANAGED_BY = "paperclip.hermes_local.runtime_identity.v1";
const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,95}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  await writeFileIfMissing(
    configPath,
    [
      "dashboard:",
      "  show_token_analytics: true",
      "",
    ].join("\n"),
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
