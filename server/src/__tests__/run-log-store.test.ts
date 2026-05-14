import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { createLocalFileRunLogStore } from "../services/run-log-store.js";

const tempDirs: string[] = [];

async function makeTempRunLogDir() {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-run-log-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("run log store", () => {
  it("redacts secret-shaped command output before storing retained log content", async () => {
    const root = await makeTempRunLogDir();
    await mkdir(root, { recursive: true });
    const store = createLocalFileRunLogStore(root);
    const handle = await store.begin({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });

    await store.append(handle, {
      stream: "stdout",
      ts: "2026-05-02T00:00:00.000Z",
      chunk: [
        'PAPERCLIP_API_KEY="paperclip-api-key-value"',
        "POSTGRES_PASSWORD='postgres-password-value'",
        "SAFE_VALUE=visible",
      ].join("\n"),
    });

    const result = await store.read(handle);
    const storedEvent = JSON.parse(result.content.trim()) as { chunk: string };

    expect(storedEvent.chunk).toContain(`PAPERCLIP_API_KEY="${REDACTED_EVENT_VALUE}"`);
    expect(storedEvent.chunk).toContain(`POSTGRES_PASSWORD='${REDACTED_EVENT_VALUE}'`);
    expect(storedEvent.chunk).toContain("SAFE_VALUE=visible");
    expect(result.content).not.toContain("paperclip-api-key-value");
    expect(result.content).not.toContain("postgres-password-value");
  });
});
