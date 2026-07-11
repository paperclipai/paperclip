import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";

import { HERMES_CLI } from "../shared/constants.js";
import { execute, resolveHermesCommand, splitHermesGlobalExtraArgs } from "./execute.js";
import { testEnvironment } from "./test.js";

test("resolveHermesCommand prefers hermesCommand over command", () => {
  expect(resolveHermesCommand({ hermesCommand: "hermes_maximus", command: "hermes_backup" }))
    .toBe("hermes_maximus");
});

test("resolveHermesCommand falls back to command before default hermes binary", () => {
  expect(resolveHermesCommand({ command: "hermes_maximus" })).toBe("hermes_maximus");
  expect(resolveHermesCommand({})).toBe(HERMES_CLI);
});

test("splitHermesGlobalExtraArgs places profile args before chat", () => {
  expect(splitHermesGlobalExtraArgs(["-p", "profile-a", "--max-tokens", "2000"]))
    .toEqual({
      preCommandArgs: ["-p", "profile-a"],
      postCommandArgs: ["--max-tokens", "2000"],
    });

  expect(splitHermesGlobalExtraArgs(["--profile", "profile-b"])).toEqual({
    preCommandArgs: ["--profile", "profile-b"],
    postCommandArgs: [],
  });

  expect(splitHermesGlobalExtraArgs(["--profile=profile-c"])).toEqual({
    preCommandArgs: ["--profile=profile-c"],
    postCommandArgs: [],
  });

  expect(splitHermesGlobalExtraArgs(["-p profile-d"])).toEqual({
    preCommandArgs: ["-p", "profile-d"],
    postCommandArgs: [],
  });
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
  hermesConfig?: string,
): Promise<{ args: string[]; resultModel: string | null | undefined }> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-execute-args-"));
  const cliPath = path.join(tempDir, "fake-hermes");
  const argsPath = path.join(tempDir, "args.txt");
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousHomeDrive = process.env.HOMEDRIVE;
  const previousHomePath = process.env.HOMEPATH;

  try {
    await writeFile(
      cliPath,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > \"$HERMES_ARGS_FILE\"",
        "printf 'ok\\n\\nsession_id: session-test\\n'",
      ].join("\n") + "\n",
      "utf8",
    );
    await chmod(cliPath, 0o755);

    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    delete process.env.HOMEDRIVE;
    delete process.env.HOMEPATH;

    if (hermesConfig) {
      await mkdir(path.join(tempDir, ".hermes"), { recursive: true });
      await writeFile(path.join(tempDir, ".hermes", "config.yaml"), hermesConfig, "utf8");
    }

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

    const args = (await readFile(argsPath, "utf8")).trim().split("\n");
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

test("execute passes Hermes profile args before chat and leaves command args after chat", async () => {
  const { args } = await runExecuteWithFakeHermes({
    extraArgs: ["-p", "profile-a", "--max-tokens", "2000"],
  });

  expect(args.slice(0, 3)).toEqual(["-p", "profile-a", "chat"]);
  expect(args.slice(-2)).toEqual(["--max-tokens", "2000"]);
});

test("execute omits --model when Hermes model config is auto", async () => {
  const { args, resultModel } = await runExecuteWithFakeHermes({ model: "auto" });

  expect(args).not.toContain("-m");
  expect(args).not.toContain("auto");
  expect(resultModel).toBe("auto");
});

test("execute uses Hermes config model when adapter model is auto", async () => {
  const { args, resultModel } = await runExecuteWithFakeHermes(
    { model: "auto" },
    [
      "model:",
      "  default: gpt-5.5",
      "  provider: openai-codex",
    ].join("\n"),
  );

  const modelFlagIndex = args.indexOf("-m");
  expect(modelFlagIndex).toBeGreaterThanOrEqual(0);
  expect(args[modelFlagIndex + 1]).toBe("gpt-5.5");
  expect(resultModel).toBe("gpt-5.5");
});
