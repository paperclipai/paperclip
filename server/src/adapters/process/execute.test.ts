import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

it("refuses a legacy process run before it can read a file-backed service credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "paperclip-process-db-isolation-"));
  const credential = join(root, "credential");
  const accessed = join(root, "accessed");
  const previous = process.env.PAPERCLIP_DATABASE_URL_FILE;
  await writeFile(credential, "synthetic-service-secret", { mode: 0o600 });
  process.env.PAPERCLIP_DATABASE_URL_FILE = credential;
  const onMeta = vi.fn();
  try {
    await expect(execute({
      runId: "synthetic-run",
      agent: {
        id: "synthetic-agent",
        companyId: "synthetic-company",
        name: "Synthetic process agent",
        adapterType: "process",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: process.execPath,
        args: ["-e", `require("node:fs").readFileSync(${JSON.stringify(credential)}); require("node:fs").writeFileSync(${JSON.stringify(accessed)}, "ran")`],
      },
      context: {},
      onLog: async () => {},
      onMeta,
    })).rejects.toThrow("Process adapter cannot run with file-backed database credentials");
    expect(existsSync(accessed)).toBe(false);
    expect(onMeta).not.toHaveBeenCalled();

    const check = await testEnvironment({
      companyId: "synthetic-company",
      adapterType: "process",
      config: { command: process.execPath },
    });
    expect(check.status).toBe("fail");
    expect(check.checks).toEqual([expect.objectContaining({ code: "process_adapter_requires_isolation", level: "error" })]);
  } finally {
    if (previous === undefined) delete process.env.PAPERCLIP_DATABASE_URL_FILE;
    else process.env.PAPERCLIP_DATABASE_URL_FILE = previous;
    await rm(root, { recursive: true, force: true });
  }
});
