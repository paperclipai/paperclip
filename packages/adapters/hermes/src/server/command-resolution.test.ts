import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("testEnvironment isolates command probes from server-only environment variables", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-command-env-"));
  const cliPath = path.join(tempDir, "fake-hermes");
  const capturePath = path.join(tempDir, "captured-env.txt");
  const previous = {
    capturePath: process.env.TEST_CAPTURE_PATH,
    databaseUrl: process.env.DATABASE_URL,
    jwtSecret: process.env.PAPERCLIP_AGENT_JWT_SECRET,
    explicit: process.env.EXPLICIT_TEST_SETTING,
  };
  process.env.TEST_CAPTURE_PATH = capturePath;
  process.env.DATABASE_URL = "postgres://server-only";
  process.env.PAPERCLIP_AGENT_JWT_SECRET = "server-signing-secret";
  process.env.EXPLICIT_TEST_SETTING = "server-setting";

  try {
    await writeFile(
      cliPath,
      [
        "#!/bin/sh",
        'printf "%s|%s|%s\\n" "${DATABASE_URL-unset}" "${PAPERCLIP_AGENT_JWT_SECRET-unset}" "${EXPLICIT_TEST_SETTING-unset}" > "$TEST_CAPTURE_PATH"',
        "echo fake-hermes 1.2.3",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(cliPath, 0o755);

    await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        command: cliPath,
        env: {
          TEST_CAPTURE_PATH: capturePath,
          EXPLICIT_TEST_SETTING: "agent-setting",
        },
      },
    });

    expect(await readFile(capturePath, "utf8")).toBe("unset|unset|agent-setting\n");
  } finally {
    if (previous.capturePath === undefined) delete process.env.TEST_CAPTURE_PATH;
    else process.env.TEST_CAPTURE_PATH = previous.capturePath;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
    if (previous.jwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous.jwtSecret;
    if (previous.explicit === undefined) delete process.env.EXPLICIT_TEST_SETTING;
    else process.env.EXPLICIT_TEST_SETTING = previous.explicit;
    await rm(tempDir, { recursive: true, force: true });
  }
});
