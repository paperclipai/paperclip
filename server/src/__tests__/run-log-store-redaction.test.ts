import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getRunLogStore } from "../services/run-log-store.js";

describe("run log store redaction", () => {
  let tempDir: string;
  let previousBasePath: string | undefined;
  let previousJwtSecret: string | undefined;
  let runCounter = 0;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-redaction-"));
    previousBasePath = process.env.RUN_LOG_BASE_PATH;
    process.env.RUN_LOG_BASE_PATH = tempDir;
  });

  beforeEach(() => {
    previousJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "redaction-test-secret-value-1234567890";
  });

  afterEach(() => {
    if (previousJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousJwtSecret;
  });

  afterAll(async () => {
    if (previousBasePath === undefined) delete process.env.RUN_LOG_BASE_PATH;
    else process.env.RUN_LOG_BASE_PATH = previousBasePath;

    await rm(tempDir, { recursive: true, force: true });
  });

  async function createRunLog() {
    const store = getRunLogStore();
    const handle = await store.begin({
      companyId: "company",
      agentId: "agent",
      runId: `run-${runCounter++}`,
    });
    return { store, handle, logPath: path.join(tempDir, handle.logRef) };
  }

  it("redacts mirrored env-var values and creates run logs with mode 600", async () => {
    const { store, handle, logPath } = await createRunLog();

    await store.append(handle, {
      ts: "2026-05-13T00:00:00.000Z",
      stream: "stdout",
      chunk: `PAPERCLIP_AGENT_JWT_SECRET=${process.env.PAPERCLIP_AGENT_JWT_SECRET}\n`,
    });

    const persisted = await readFile(logPath, "utf8");
    const mode = (await stat(logPath)).mode & 0o777;
    expect(persisted).not.toContain(process.env.PAPERCLIP_AGENT_JWT_SECRET);
    expect(persisted).toContain("PAPERCLIP_AGENT_JWT_SECRET=<REDACTED>");
    expect(mode).toBe(0o600);
  });

  it("redacts quoted sensitive env assignments in command payloads", async () => {
    const { store, handle, logPath } = await createRunLog();
    const syntheticValue = "quoted-redaction-test-value-ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    await store.append(handle, {
      ts: "2026-05-13T00:00:00.000Z",
      stream: "stdout",
      chunk: `{"command":"KEL92_SYNTHETIC_SECRET='${syntheticValue}' sh -c env"}`,
    });

    const persisted = await readFile(logPath, "utf8");
    expect(persisted).not.toContain(syntheticValue);
    expect(persisted).toContain("KEL92_SYNTHETIC_SECRET='<REDACTED>'");
  });

  it("redacts generic unquoted sensitive env assignments", async () => {
    const { store, handle, logPath } = await createRunLog();
    const syntheticValue = "generic-redaction-test-value-ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    await store.append(handle, {
      ts: "2026-05-13T00:00:00.000Z",
      stream: "stderr",
      chunk: `KEL92_GENERIC_SECRET=${syntheticValue} node ./scripts/task.js`,
    });

    const persisted = await readFile(logPath, "utf8");
    expect(persisted).not.toContain(syntheticValue);
    expect(persisted).toContain("KEL92_GENERIC_SECRET=<REDACTED>");
  });
});
