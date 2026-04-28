import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { RUN_LOG_CREDENTIAL_REDACTION_TOKEN } from "../log-redaction.js";
import { createLocalFileRunLogStore } from "../services/run-log-store.js";

describe("run log store", () => {
  it("redacts credential-shaped values before persisting local log chunks", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-"));
    const apiKey = "fake-paperclip-key-value";
    const bearer = "fake-bearer-token-value";

    try {
      const store = createLocalFileRunLogStore(dir);
      const handle = await store.begin({
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
      });

      await store.append(handle, {
        stream: "stdout",
        ts: "2026-04-13T00:00:00.000Z",
        chunk: [
          "starting run",
          `PAPERCLIP_API_KEY=${apiKey}`,
          `Authorization: Bearer ${bearer}`,
          "finished run",
        ].join("\n"),
      });

      const result = await store.read(handle);
      const [line] = result.content.trim().split(/\r?\n/);
      const entry = JSON.parse(line!) as { chunk: string };

      expect(entry.chunk).toContain("starting run");
      expect(entry.chunk).toContain(`PAPERCLIP_API_KEY=${RUN_LOG_CREDENTIAL_REDACTION_TOKEN}`);
      expect(entry.chunk).toContain(`Authorization: Bearer ${RUN_LOG_CREDENTIAL_REDACTION_TOKEN}`);
      expect(entry.chunk).toContain("finished run");
      expect(result.content).not.toContain(apiKey);
      expect(result.content).not.toContain(bearer);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
