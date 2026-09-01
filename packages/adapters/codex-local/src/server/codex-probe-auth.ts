import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { readSubscriptionAccountId } from "./codex-auth-cache.js";

const MAX_CODEX_PROBE_AUTH_BYTES = 1024 * 1024;

export type CodexProbeAuthKind = "api_key" | "subscription" | "unsupported";

export function classifyCodexProbeAuth(bytes: Buffer): CodexProbeAuthKind {
  let parsed: Record<string, unknown>;
  try {
    const candidate = JSON.parse(bytes.toString("utf8")) as unknown;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return "unsupported";
    }
    parsed = candidate as Record<string, unknown>;
    if (
      typeof parsed.OPENAI_API_KEY === "string" &&
      parsed.OPENAI_API_KEY.trim() &&
      Object.keys(parsed).every((key) => key === "OPENAI_API_KEY")
    ) {
      return "api_key";
    }
  } catch {
    return "unsupported";
  }
  return readSubscriptionAccountId(bytes) ? "subscription" : "unsupported";
}

export interface DurableCodexProbeAuthSnapshot {
  bytes: Buffer;
  kind: CodexProbeAuthKind;
}

async function readBoundedRegularFile(filePath: string): Promise<Buffer> {
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CODEX_PROBE_AUTH_BYTES) {
      throw new Error("codex_probe_auth_source_invalid");
    }
    const bounded = Buffer.allocUnsafe(MAX_CODEX_PROBE_AUTH_BYTES + 1);
    let offset = 0;
    while (offset < bounded.length) {
      const { bytesRead } = await handle.read(
        bounded,
        offset,
        bounded.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_CODEX_PROBE_AUTH_BYTES) {
      throw new Error("codex_probe_auth_source_invalid");
    }
    return Buffer.from(bounded.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

export async function snapshotDurableCodexProbeAuth(
  sourceHome: string,
): Promise<DurableCodexProbeAuthSnapshot> {
  const resolved = await fs.realpath(path.join(sourceHome, "auth.json"));
  const bytes = await readBoundedRegularFile(resolved);
  const kind = classifyCodexProbeAuth(bytes);
  return {
    bytes,
    kind,
  };
}
