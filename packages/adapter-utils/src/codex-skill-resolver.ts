import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext } from "./types.js";

/** Reconcile legacy Paperclip host routes after this home's skills are materialized. */
export async function reconcileCodexSkillResolver(
  skillsHome: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<void> {
  const resolverPath = path.join(skillsHome, "RESOLVER.md");
  try {
    // Never follow a resolver symlink into a user-owned document.
    const stat = await fs.lstat(resolverPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat?.isFile()) return;
    const original = await fs.readFile(resolverPath, "utf8");
    if (original.split(/\r?\n/, 1)[0] !== "# Paperclip Codex host skill routes") return;
    const lines = original.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const kept: string[] = [];
    let removed = 0;
    for (const line of lines) {
      const match = line.match(/^\|[^|]*\|\s*`skills\/([a-zA-Z0-9_-][a-zA-Z0-9._-]*)\/SKILL\.md`\s*\|\s*$/);
      if (match) {
        try {
          await fs.access(path.join(skillsHome, match[1], "SKILL.md"));
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // Permission and I/O failures are not evidence that a skill is missing.
          if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
          removed += 1;
          continue;
        }
      }
      kept.push(line);
    }
    if (removed === 0) return;
    await fs.writeFile(resolverPath, kept.join(""), "utf8");
    await onLog("stdout", `[paperclip] Pruned ${removed} missing Codex skill route(s) from ${resolverPath}\n`);
  } catch (error) {
    await onLog("stderr", `[paperclip] Failed to reconcile Codex skill routes: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
