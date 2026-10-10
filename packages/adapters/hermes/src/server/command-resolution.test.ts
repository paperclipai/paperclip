import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";

import { HERMES_CLI } from "../shared/constants.js";
import { execute, resolveHermesCommand } from "./execute.js";
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

async function runExecuteWithFakeHermes(
  config: Record<string, unknown>,
): Promise<{ args: string[]; resultModel: string | null | undefined }> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-execute-args-"));
  const cliPath = path.join(tempDir, "fake-hermes");
  const argsPath = path.join(tempDir, "args.bin");
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousHomeDrive = process.env.HOMEDRIVE;
  const previousHomePath = process.env.HOMEPATH;

  try {
    await writeFile(
      cliPath,
      [
        "#!/bin/sh",
        "printf '%s\\0' \"$@\" > \"$HERMES_ARGS_FILE\"",
        "printf 'ok\\n\\nsession_id: session-test\\n'",
      ].join("\n") + "\n",
      "utf8",
    );
    await chmod(cliPath, 0o755);

    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;

    const result = await execute({
      runId: "run-test",
      agent: {
        id: "agent-test",
        name: "Hermes Test Agent",
        companyId: "company-test",
        adapterConfig: {},
      },
      config: {
        ...config,
        hermesCommand: cliPath,
        cwd: tempDir,
        env: { HERMES_ARGS_FILE: argsPath },
      },
      runtime: {},
      onLog: async () => {},
    } as any);

    const args = (await readFile(argsPath))
      .toString("utf8")
      .split("\0")
      .filter((arg) => arg.length > 0);
    return { args, resultModel: result.model };
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousHomeDrive === undefined) delete process.env.HOMEDRIVE;
    else process.env.HOMEDRIVE = previousHomeDrive;
    if (previousHomePath === undefined) delete process.env.HOMEPATH;
    else process.env.HOMEPATH = previousHomePath;
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("execute omits --model when Hermes model config is blank or missing", async () => {
  for (const config of [{}, { model: "" }, { model: "   " }]) {
    const { args, resultModel } = await runExecuteWithFakeHermes(config);

    expect(args).not.toContain("-m");
    expect(args).not.toContain("auto");
    expect(resultModel).toBeNull();
  }
});

test("execute passes an explicit Hermes model override", async () => {
  const { args, resultModel } = await runExecuteWithFakeHermes({
    model: "claude-sonnet-4",
  });

  const modelFlagIndex = args.indexOf("-m");
  expect(modelFlagIndex).toBeGreaterThanOrEqual(0);
  expect(args[modelFlagIndex + 1]).toBe("claude-sonnet-4");
  expect(resultModel).toBe("claude-sonnet-4");
});

test("managed connections probe the selected environment without falling back to host keys", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-managed-probe-"));
  const cliPath = path.join(tempDir, "fake-hermes");
  try {
    await writeFile(cliPath, '#!/bin/sh\n[ "$HERMES_HOME" = "' + tempDir + '" ] || exit 1\n[ "$OPENAI_API_KEY" = "selected-key" ] || exit 1\n[ "$ANTHROPIC_API_KEY" = "" ] || exit 1\n[ "$1" = "chat" ] || exit 1\necho hello\n');
    await chmod(cliPath, 0o755);
    const config = { command: cliPath, managedAiRouting: true, model: "custom/model", provider: "auto", env: { HERMES_HOME: tempDir, OPENAI_API_KEY: "selected-key", ANTHROPIC_API_KEY: "" } };
    const passed = await testEnvironment({ companyId: "test", adapterType: "hermes_local", config });
    expect(passed.status).toBe("pass");
    expect(passed.checks[0]?.code).toBe("hermes_hello_probe_passed");
    const failed = await testEnvironment({ companyId: "test", adapterType: "hermes_local", config: { ...config, env: { ...config.env, OPENAI_API_KEY: "wrong-key" } } });
    expect(failed.status).toBe("fail");
    expect(failed.checks[0]?.code).toBe("hermes_hello_probe_failed");
    expect(JSON.stringify(failed)).not.toContain("wrong-key");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
