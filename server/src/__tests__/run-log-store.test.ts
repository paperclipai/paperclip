import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createLocalFileRunLogStore } from "../services/run-log-store.ts";

describe("createLocalFileRunLogStore", () => {
  it("writes a run_bound anchor as the first NDJSON line at file open", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "run-log-store-test-"));
    try {
      const store = createLocalFileRunLogStore(base);
      const companyId = "co-1";
      const agentId = "ag-1";
      const runId = "run-uuid-1";
      const issueId = "iss-anchor-1";
      const wakeReason = "issue_assigned";
      const { handle, initialBytes } = await store.begin({
        companyId,
        agentId,
        runId,
        issueId,
        wakeReason,
      });

      expect(handle.logRef).toMatch(new RegExp(`^${companyId}/${agentId}/${runId}\\.ndjson$`));
      const abs = path.join(base, handle.logRef);
      const raw = await readFile(abs, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      const anchor = JSON.parse(lines[0]!) as {
        kind?: string;
        ts?: string;
        companyId?: string;
        agentId?: string;
        runId?: string;
        issueId?: string | null;
        wakeReason?: string | null;
      };
      expect(anchor.kind).toBe("run_bound");
      expect(anchor.companyId).toBe(companyId);
      expect(anchor.agentId).toBe(agentId);
      expect(anchor.runId).toBe(runId);
      expect(anchor.issueId).toBe(issueId);
      expect(anchor.wakeReason).toBe(wakeReason);
      expect(typeof anchor.ts).toBe("string");
      expect(Buffer.byteLength(`${lines[0]}\n`, "utf8")).toBe(initialBytes);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
