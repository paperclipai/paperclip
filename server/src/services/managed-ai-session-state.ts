import { createHash } from "node:crypto";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

/** Link only provider transcript directories; auth/config files stay per-run. */
export async function linkManagedAiSessionState(input: {
  home: string;
  companyId: string;
  agentId: string;
  grantId: string;
  responsibleUserId: string | null;
  provider: string;
}): Promise<void> {
  const directories = input.provider === "anthropic" ? ["projects"]
    : input.provider === "openai" ? ["sessions", "archived_sessions"] : [];
  if (!directories.length) return;
  // Hash a tuple rather than interpolate IDs into paths. Include the responsible
  // user even for shared grants so another user's run cannot load these sessions.
  const scope = createHash("sha256").update(JSON.stringify([
    input.companyId, input.agentId, input.grantId, input.responsibleUserId, input.provider,
  ])).digest("hex");
  const root = path.join(resolvePaperclipInstanceRoot(), "managed-ai-sessions", scope);
  for (const directory of directories) {
    const target = path.join(root, directory);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await symlink(target, path.join(input.home, "provider", directory), "dir");
  }
}
