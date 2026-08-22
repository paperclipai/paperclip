import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";

import { HERMES_CLI } from "../shared/constants.js";
import {
  execute,
  extractHermesProfileFromArgs,
  resolveHermesCommand,
  resolveHermesConfigPath,
} from "./execute.js";
import { testEnvironment } from "./test.js";

test("resolveHermesCommand prefers hermesCommand over command", () => {
  expect(resolveHermesCommand({ hermesCommand: "hermes_maximus", command: "hermes_backup" }))
    .toBe("hermes_maximus");
});

test("resolveHermesCommand falls back to command before default hermes binary", () => {
  expect(resolveHermesCommand({ command: "hermes_maximus" })).toBe("hermes_maximus");
  expect(resolveHermesCommand({})).toBe(HERMES_CLI);
});

test("extractHermesProfileFromArgs accepts separate, equals, and combined profile args", () => {
  expect(extractHermesProfileFromArgs(["--profile", "research"])).toBe("research");
  expect(extractHermesProfileFromArgs(["-p", "ops"])).toBe("ops");
  expect(extractHermesProfileFromArgs(["--profile=default"])).toBe("default");
  expect(extractHermesProfileFromArgs(["-p=worker"])).toBe("worker");
  expect(extractHermesProfileFromArgs(["--profile studio"])).toBe("studio");
  expect(extractHermesProfileFromArgs(["-p consulting"])).toBe("consulting");
});

test("extractHermesProfileFromArgs uses the last repeated profile arg", () => {
  expect(extractHermesProfileFromArgs(["--profile", "base", "--profile", "research"]))
    .toBe("research");
  expect(extractHermesProfileFromArgs(["--profile=base", "-p=ops", "--profile studio"]))
    .toBe("studio");
});

test("resolveHermesConfigPath uses configured HERMES_HOME and profile args", () => {
  expect(resolveHermesConfigPath({
    env: {
      HERMES_HOME: "/tmp/hermes-home",
    },
  }, undefined)).toBe(path.join("/tmp/hermes-home", "config.yaml"));

  expect(resolveHermesConfigPath({
    env: {
      HERMES_HOME: { type: "plain", value: "/tmp/hermes-home" },
    },
  }, ["--profile", "research"])).toBe(
    path.join("/tmp/hermes-home", "profiles", "research", "config.yaml"),
  );
});

test("resolveHermesConfigPath rejects profile path traversal", () => {
  const config = {
    env: {
      HERMES_HOME: "/tmp/hermes-home",
    },
  };

  for (const profile of [".", "..", "../outside", "nested/profile", "nested\\profile", "/absolute"]) {
    expect(() => resolveHermesConfigPath(config, ["--profile", profile])).toThrow(
      "Hermes profile must be a single directory name",
    );
  }
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

test("execute detects model and provider from configured Hermes profile config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-profile-config-"));
  const cliPath = path.join(tempDir, "fake-hermes");
  const argvPath = path.join(tempDir, "argv.txt");
  const hermesHome = path.join(tempDir, "hermes-home");
  const profileConfigDir = path.join(hermesHome, "profiles", "research");

  try {
    await mkdir(profileConfigDir, { recursive: true });
    await writeFile(
      path.join(profileConfigDir, "config.yaml"),
      [
        "model:",
        "  default: gpt-5.5",
        "  provider: openai-codex",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      cliPath,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > ${JSON.stringify(argvPath)}`,
        "printf 'done\\n\\nsession_id: test-session\\n'",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(cliPath, 0o755);

    await execute({
      runId: "run-test",
      agent: {
        id: "agent-test",
        name: "Hermes Test Agent",
        companyId: "company-test",
      },
      config: {
        hermesCommand: cliPath,
        env: {
          HERMES_HOME: { type: "plain", value: hermesHome },
        },
        extraArgs: ["--profile", "research"],
      },
      runtime: {},
      onLog: async () => {},
    } as any);

    const argv = await readFile(argvPath, "utf8");
    expect(argv).toContain("-m\ngpt-5.5\n");
    expect(argv).toContain("--provider\nopenai-codex\n");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
