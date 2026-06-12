import fs from "node:fs";
import path from "node:path";

export interface TripwireContext {
  command: string;
  args: string[];
  issueId: string | null;
  agentId: string;
  adapterType: "claude_local" | "opencode_local";
}

/**
 * Parse the HARD-BLOCK and REJECT table sections from a denylist markdown file
 * and compile a single case-insensitive regex from all listed repo/vendor patterns.
 * Stops before "## Overrides" or "## Changelog" so changelog rows are never included.
 */
export function buildDenylistRegex(markdownContent: string): RegExp | null {
  const stopRe = /^##\s+(?:Overrides|Changelog)/;
  const sectionStartRe = /^##\s+(?:HARD-BLOCK|REJECT)/;
  const anySectionRe = /^##\s+/;
  const separatorRowRe = /^\s*\|[-|\s:]+\|\s*$/;

  const patterns: string[] = [];
  let inSection = false;

  for (const rawLine of markdownContent.split("\n")) {
    const line = rawLine.trim();
    if (stopRe.test(line)) break;
    if (sectionStartRe.test(line)) { inSection = true; continue; }
    if (anySectionRe.test(line)) { inSection = false; continue; }
    if (!inSection || !line.startsWith("|")) continue;
    if (separatorRowRe.test(line)) continue;

    // First cell: text between the first and second pipe
    const firstCell = line.split("|")[1];
    if (!firstCell) continue;

    // Extract all backtick-quoted strings from the first cell
    const backtickRe = /`([^`]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = backtickRe.exec(firstCell)) !== null) {
      const val = m[1].trim();
      if (val) patterns.push(val);
    }
  }

  if (patterns.length === 0) return null;

  // Escape regex metacharacters (except *), then convert * to .*
  const parts = patterns.map((p) =>
    p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"),
  );
  return new RegExp(parts.join("|"), "i");
}

/** Build a reusable tripwire checker function bound to a compiled regex. */
export function createTripwireChecker(regex: RegExp | null) {
  return async function checkDenylistTripwire(ctx: TripwireContext): Promise<void> {
    if (process.env.PAPERCLIP_DENYLIST_TRIPWIRE === "false") return;
    if (!regex) return;

    const { command, args, issueId, agentId, adapterType } = ctx;
    const fullCmd = [command, ...args].join(" ");
    const match = regex.exec(fullCmd);
    if (!match) return;

    const matchedPattern = match[0];
    const timestamp = new Date().toISOString();
    const commandExcerpt = fullCmd.slice(0, 200);

    process.stderr.write(
      JSON.stringify({
        event: "denylist_tripwire",
        issueId,
        agentId,
        adapterType,
        commandExcerpt,
        matchedPattern,
        timestamp,
      }) + "\n",
    );

    const apiUrl = process.env.PAPERCLIP_API_URL;
    const companyId = process.env.PAPERCLIP_COMPANY_ID;
    const apiKey = process.env.PAPERCLIP_API_KEY;
    const runId = process.env.PAPERCLIP_RUN_ID;

    if (apiUrl && companyId && apiKey) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      };
      if (runId) headers["X-Paperclip-Run-Id"] = runId;

      const sendAlert = (assigneeAgentId: string) => {
        fetch(`${apiUrl}/api/companies/${companyId}/issues`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: `[TRIPWIRE] Denylisted tool invoked by ${agentId}: ${matchedPattern}`,
            description: `Issue: ${issueId ?? "unknown"}\nAdapter: ${adapterType}\nCommand: ${fullCmd}\nTimestamp: ${timestamp}`,
            priority: "high",
            assigneeAgentId,
          }),
        }).catch(() => {});
      };

      sendAlert("f3c48afc-c339-4e43-b47b-a42a0891229d"); // CTO
      sendAlert("b0f67cc2-259e-477b-ac89-d0ff4e7c8e89"); // CEO
    }
  };
}

// Singleton compiled once at module init (eager, one per process boot).
const _denylistRegex: RegExp | null = (() => {
  const configDir = process.env.PAPERCLIP_CONFIG_DIR;
  const denylistPath = configDir
    ? path.join(configDir, "config", "tool-denylist.md")
    : path.resolve(process.cwd(), "config", "tool-denylist.md");
  try {
    return buildDenylistRegex(fs.readFileSync(denylistPath, "utf-8"));
  } catch {
    return null;
  }
})();

/** Fire-and-forget tripwire check against the module-level denylist singleton. */
export const checkDenylistTripwire = createTripwireChecker(_denylistRegex);
