import os from "node:os";
import path from "node:path";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";

import { HERMES_CLI } from "../shared/constants.js";
import { resolveHermesCommand } from "./execute.js";
import { testEnvironment } from "./test.js";

test("resolveHermesCommand prefers hermesCommand over command", () => {
  expect(resolveHermesCommand({ hermesCommand: "hermes_maximus", command: "hermes_backup" }))
    .toBe("hermes_maximus");
});

test("resolveHermesCommand falls back to command before default hermes binary", () => {
  expect(resolveHermesCommand({ command: "hermes_maximus" })).toBe("hermes_maximus");
  expect(resolveHermesCommand({})).toBe(HERMES_CLI);
});

test("testEnvironment accepts config.command when hermesCommand is absent", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-command-resolution-"));
  const cliPath = path.join(tempDir, "fake-hermes");

  try {
    await writeFile(
      cliPath,
      "#!/bin/sh\necho fake-hermes 1.2.3\n",
      "utf8",
    );
    await chmod(cliPath, 0o755);

    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        command: cliPath,
      },
    });

    expect(result.status).not.toBe("fail");
    expect(result.checks.some((check) => check.code === "hermes_cli_not_found")).toBe(false);
    expect(result.checks.some(
      (check) => check.code === "hermes_version" && check.message.includes("fake-hermes 1.2.3"),
    )).toBe(true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("testEnvironment refuses an unconfined Hermes command before probing it", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-db-isolation-"));
  const cliPath = path.join(tempDir, "fake-hermes");
  const marker = path.join(tempDir, "executed");
  const previous = process.env.PAPERCLIP_DATABASE_URL_FILE;
  try {
    await writeFile(cliPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, "utf8");
    await chmod(cliPath, 0o755);
    process.env.PAPERCLIP_DATABASE_URL_FILE = "/synthetic/service/credential";
    const result = await testEnvironment({
      companyId: "synthetic-company",
      adapterType: "hermes_local",
      config: { command: cliPath },
    });
    expect(result.status).toBe("fail");
    expect(result.checks).toEqual([expect.objectContaining({ code: "hermes_local_requires_isolation", level: "error" })]);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.PAPERCLIP_DATABASE_URL_FILE;
    else process.env.PAPERCLIP_DATABASE_URL_FILE = previous;
    await rm(tempDir, { recursive: true, force: true });
  }
});
