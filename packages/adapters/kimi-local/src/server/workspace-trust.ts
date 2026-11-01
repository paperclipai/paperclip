import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asString } from "@paperclipai/adapter-utils/server-utils";

/**
 * Resolve the Kimi data directory (where `workspace-trust/` lives). Mirrors
 * kimi's own resolution and the adapter skills home: KIMI_CODE_HOME (config
 * env, then process env) wins, else $HOME/.kimi-code.
 */
export function resolveKimiCodeHome(envConfig: Record<string, unknown>): string {
  const configured =
    asString(envConfig.KIMI_CODE_HOME, "") ||
    asString(process.env.KIMI_CODE_HOME, "");
  if (configured) return path.resolve(configured);
  const configuredHome = asString(envConfig.HOME, "") || asString(process.env.HOME, "");
  return path.join(configuredHome ? path.resolve(configuredHome) : os.homedir(), ".kimi-code");
}

/**
 * Reproduce kimi's `trackKey(root)` (agent-core-v2 `encodeWorkDirKey`):
 * `wd_<slug(basename(root))>_<sha256(root)[0:12]>`. Byte-for-byte compatible
 * with kimi 2.1.1's workspace-trust document store so a seeded record is read
 * as an existing trust entry.
 */
export function kimiWorkspaceTrustKey(root: string): string {
  const normalized = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const last = normalized.split("/").pop() ?? normalized;
  let slug = last
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 40)
    .replaceAll(/^-+|-+$/g, "");
  if (slug === "" || slug === "." || slug === "..") slug = "workspace";
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `wd_${slug}_${hash}`;
}

export interface KimiWorkspaceTrustSeedResult {
  seeded: boolean;
  reason?: string;
  file?: string | null;
}

/**
 * COR-4191 Fix B: pre-approve workspace trust for a Paperclip-provisioned run
 * root. Without this, Kimi starts untrusted in each fresh worktree, so it skips
 * the project `.mcp.json` supabase server and prints the warning that also
 * masked real failures. Seed only the run's own provisioned workspace root —
 * never an arbitrary folder. Best-effort: a seeding failure must never abort
 * the run.
 */
export async function seedKimiWorkspaceTrust(input: {
  cwd: string;
  envConfig: Record<string, unknown>;
  provisionedWorkspace: boolean;
}): Promise<KimiWorkspaceTrustSeedResult> {
  const logical = path.resolve(input.cwd);
  if (logical === "/" || !input.provisionedWorkspace) {
    return { seeded: false, reason: input.provisionedWorkspace ? "root" : "no-workspace-context" };
  }
  // Kimi keys trust on the child's `process.cwd()`, which the OS reports as the
  // PHYSICAL path (symlinks resolved). Seed both the logical and physical forms
  // so a symlinked workspace path (e.g. /tmp -> /private/tmp) still matches.
  const roots = new Set([logical]);
  try {
    roots.add(await fs.realpath(logical));
  } catch {
    // Keep the logical form only.
  }
  const trustDir = path.join(resolveKimiCodeHome(input.envConfig), "workspace-trust");
  let seeded = false;
  let firstFile: string | null = null;
  try {
    for (const root of roots) {
      if (root === "/") continue;
      const key = kimiWorkspaceTrustKey(root);
      const file = path.join(trustDir, key);
      firstFile = firstFile ?? file;
      const existing = await fs.readFile(file, "utf8").catch(() => null);
      if (existing) {
        try {
          const parsed: unknown = JSON.parse(existing);
          if (parsed && typeof parsed === "object" && (parsed as { root?: unknown }).root === root) {
            continue;
          }
        } catch {
          // Malformed record: rewrite it below.
        }
      }
      await fs.mkdir(trustDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(file, JSON.stringify({ root, trustedAt: Date.now() }), { mode: 0o600 });
      seeded = true;
    }
    return { seeded, reason: seeded ? undefined : "already-trusted", file: firstFile };
  } catch (error) {
    return { seeded: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
