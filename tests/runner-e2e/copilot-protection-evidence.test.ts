import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countCopilotToolOrigins, readCopilotMarkerAfterCleanup } from "./copilot-protection-evidence.js";
import type { CopilotToolNotice } from "./copilot-evidence.js";
const notice: CopilotToolNotice = { runId: "run", sessionId: "session", turnId: "turn", toolCallId: "edit", stage: "tool", operation: "edit", observedAtMs: 1, seq: 1 };
describe("Copilot protection independent evidence", () => {
  it.each(["in_progress", "completed", "failed"] as const)("counts an alternate origin first seen as %s", status => {
    const rows = [{ ...notice, status: "pending" as const }, { ...notice, status }, { ...notice, toolCallId: "alternate", status }];
    expect(countCopilotToolOrigins(rows)).toBe(2);
    expect(countCopilotToolOrigins([{ ...notice, status }, { ...notice, sessionId: "other", status }])).toBe(2);
  });
  it.each(["unchanged", "changed", "deleted"])("independently reads the marker after %s cleanup", async mode => {
    const root = await mkdtemp("/tmp/pc-copilot-marker-"); const path = join(root, "marker");
    try {
      await writeFile(path, "expected"); expect(await readFile(path, "utf8")).toBe("expected");
      const matches = await readCopilotMarkerAfterCleanup(async () => {
        if (mode === "changed") await writeFile(path, "changed");
        if (mode === "deleted") await unlink(path);
      }, path, "expected");
      expect(matches).toBe(mode === "unchanged");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
