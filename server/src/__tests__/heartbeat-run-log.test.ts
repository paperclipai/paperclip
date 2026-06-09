import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compactRunLogChunk } from "../services/heartbeat.js";
import { getRunLogStore, resetRunLogStoreForTests } from "../services/run-log-store.js";

describe("compactRunLogChunk", () => {
  it("redacts inline base64 image data from structured log chunks", () => {
    const base64 = "A".repeat(4096);
    const chunk = `{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","data":"${base64}"}}]}}\n`;

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).not.toContain(base64);
    expect(compacted).toContain("[omitted base64 image data: 4096 chars]");
  });

  it("truncates oversized chunks after sanitizing them", () => {
    const chunk = `${"x".repeat(90_000)}tail`;

    const compacted = compactRunLogChunk(chunk, 16_384);

    expect(compacted.length).toBeLessThan(chunk.length);
    expect(compacted).toContain("[paperclip truncated run log chunk:");
    expect(compacted.endsWith("tail")).toBe(true);
  });

  it("redacts Paperclip credential shapes before persisting run-log chunks", () => {
    const chunk = [
      "Authorization: Bearer live-bearer-token-value",
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `payload {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      "--paperclip-api-key=paperclip-flag-secret",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("***REDACTED***");
    expect(compacted).not.toContain("live-bearer-token-value");
    expect(compacted).not.toContain("paperclip-shell-secret");
    expect(compacted).not.toContain("paperclip-json-secret");
    expect(compacted).not.toContain("paperclip-flag-secret");
  });

  it("redacts run-log NDJSON at the store boundary and creates owner-only artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-redaction-"));
    const bearerValue = ["live", "bearer", "token", "value"].join("-");
    const previousRunLogBasePath = process.env.RUN_LOG_BASE_PATH;
    process.env.RUN_LOG_BASE_PATH = root;
    resetRunLogStoreForTests();

    try {
      const store = getRunLogStore();
      const handle = await store.begin({
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
      });
      await store.append(handle, {
        ts: "2026-06-07T00:00:00.000Z",
        stream: "stdout",
        chunk: `Authorization: Bearer ${bearerValue}`,
      });

      const artifactPath = path.join(root, handle.logRef);
      const mode = (await fs.stat(artifactPath)).mode & 0o777;
      const persisted = await fs.readFile(artifactPath, "utf8");

      expect(mode).toBe(0o600);
      expect(persisted).toContain("[REDACTED:bearer-token:");
      expect(persisted).not.toContain(bearerValue);
    } finally {
      if (previousRunLogBasePath === undefined) delete process.env.RUN_LOG_BASE_PATH;
      else process.env.RUN_LOG_BASE_PATH = previousRunLogBasePath;
      resetRunLogStoreForTests();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
