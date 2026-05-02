import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE } from "../redaction.js";

let tmpDir: string;
let getRunLogStore: typeof import("../services/run-log-store.js").getRunLogStore;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-redaction-"));
  process.env.RUN_LOG_BASE_PATH = tmpDir;
  // Import after env var is set so the singleton picks up our tmp basePath.
  ({ getRunLogStore } = await import("../services/run-log-store.js"));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("RunLogStore.append() secret redaction", () => {
  it("redacts ghp_ tokens from chunks before writing to NDJSON on disk", async () => {
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company-redaction",
      agentId: "agent-redaction",
      runId: "run-ghp-1",
    });

    const token = `ghp_${"A".repeat(36)}`;
    const ts = "2026-05-01T12:00:00.000Z";
    await store.append(handle, {
      stream: "stdout",
      ts,
      chunk: `leaked token: ${token} after`,
    });

    const absPath = path.resolve(tmpDir, handle.logRef);
    const persisted = await fs.readFile(absPath, "utf8");

    // File on disk must not contain the plaintext token.
    expect(persisted).not.toContain(token);

    // NDJSON line should preserve schema shape (ts, stream, chunk) and contain the redaction marker.
    const lines = persisted.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toEqual({
      ts,
      stream: "stdout",
      chunk: `leaked token: ${REDACTED_EVENT_VALUE} after`,
    });
  });

  it("preserves non-secret chunk content unchanged", async () => {
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company-redaction",
      agentId: "agent-redaction",
      runId: "run-ghp-2",
    });

    const ts = "2026-05-01T12:00:01.000Z";
    const chunk = "ordinary plugin output: hello world\n";
    await store.append(handle, { stream: "stderr", ts, chunk });

    const absPath = path.resolve(tmpDir, handle.logRef);
    const persisted = await fs.readFile(absPath, "utf8");
    const parsed = JSON.parse(persisted.trim());
    expect(parsed).toEqual({ ts, stream: "stderr", chunk });
  });
});
