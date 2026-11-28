import { describe, expect, it } from "vitest";
import { withoutLegacyRunLines } from "./issue-continuation-summary.js";

const runId = "5a1d0c2e-7f3b-4c41-9b0a-0d3c8e9f1a21";

const storedBeforeUpgrade = [
  "# Continuation Summary",
  "",
  "- Issue: PAP-31 — Two small files",
  "- Status: done",
  "- Priority: medium",
  "- Current mode: review",
  `- Last updated by run: ${runId}`,
  "- Agent: File Agent (paperclip_runner)",
  "",
  "## Recent Concrete Actions",
  "",
  `- Run \`${runId}\` finished with status \`succeeded\` at 2026-11-25T01:39:07.135Z.`,
  "- Created a.txt and b.txt.",
  "",
  "## Commands Run",
  "",
  `- Heartbeat run \`${runId}\` invoked adapter \`paperclip_runner\`.`,
  "- Detailed shell/tool commands remain in the run log and transcript.",
  "",
  "## Blockers / Decisions",
  "",
  "- No new blocker was recorded by the latest run.",
].join("\n");

describe("withoutLegacyRunLines", () => {
  it("removes the run-id lines an older server stored in the summary", () => {
    const body = withoutLegacyRunLines(storedBeforeUpgrade);
    expect(body).not.toContain(runId);
    expect(body).not.toContain("run log");
    expect(body).not.toContain("## Commands Run");
    expect(body).toContain("- The latest run finished with status `succeeded` at 2026-11-25T01:39:07.135Z.");
    expect(body).toContain("- Created a.txt and b.txt.\n\n## Blockers / Decisions");
    expect(body).toContain("- Agent: File Agent (paperclip_runner)");
  });

  it("leaves a current summary unchanged", () => {
    const current = storedBeforeUpgrade
      .split("\n")
      .filter((line) => !line.includes(runId) && !line.includes("run log") && line !== "## Commands Run")
      .join("\n");
    expect(withoutLegacyRunLines(current)).toBe(current);
  });
});
