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
  inheritedHermesHome?: string,
): Promise<{ args: string[]; resultModel: string | null | undefined }> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-execute-args-"));
  const cliPath = path.join(tempDir, "fake-hermes");
  const argsPath = path.join(tempDir, "args.txt");
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousHomeDrive = process.env.HOMEDRIVE;
  const previousHomePath = process.env.HOMEPATH;
  const previousHermesHome = process.env.HERMES_HOME;

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
    if (inheritedHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = inheritedHermesHome;

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
        env: { ...(config.env as Record<string, string>), HERMES_ARGS_FILE: argsPath },
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
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHermesHome;
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

test("execute lets a selected Hermes profile resolve its own model", async () => {
  const { args, resultModel } = await runExecuteWithFakeHermes(
    { model: "auto", extraArgs: ["--profile", "profile-a"] },
    [
      "model:",
      "  default: gpt-5.5",
      "  provider: openai-codex",
    ].join("\n"),
  );

  expect(args.slice(0, 3)).toEqual(["--profile", "profile-a", "chat"]);
  expect(args).not.toContain("-m");
  expect(args).not.toContain("gpt-5.5");
  expect(resultModel).toBe("auto");
});

test("execute does not inherit the detected provider for a selected Hermes profile", async () => {
  const { args } = await runExecuteWithFakeHermes(
    { model: "auto", extraArgs: ["--profile", "profile-a"] },
    [
      "model:",
      "  default: gpt-5.5",
      "  provider: openai-codex",
    ].join("\n"),
  );

  expect(args).not.toContain("--provider");
  expect(args).not.toContain("openai-codex");
});

const defaultHermesConfig = "model:\n  default: gpt-5.5\n  provider: openai-codex\n";

for (const [selection, config] of [
  ["profile", { extraArgs: ["--profile", "profile-a"] }],
  ["HOME", { env: { HOME: "/private/qa/other-home" } }],
  ["HERMES_HOME", { env: { HERMES_HOME: "/private/qa/other-hermes" } }],
] as const) {
  test(`execute defers auto model and provider selection for ${selection}`, async () => {
    const { args, resultModel } = await runExecuteWithFakeHermes(
      { ...config, model: "auto" }, defaultHermesConfig,
    );
    expect(args).not.toContain("-m");
    expect(args).not.toContain("--provider");
    expect(resultModel).toBe("auto");
  });

  test(`execute preserves a concrete model without inferring a provider for ${selection}`, async () => {
    const { args, resultModel } = await runExecuteWithFakeHermes(
      { ...config, model: "gpt-5.5" }, defaultHermesConfig,
    );
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.5");
    expect(args).not.toContain("--provider");
    expect(resultModel).toBe("gpt-5.5");
  });

  test(`execute preserves explicit model and provider overrides for ${selection}`, async () => {
    const { args } = await runExecuteWithFakeHermes(
      { ...config, model: "gpt-5.5", provider: "anthropic" }, defaultHermesConfig,
    );
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.5");
    expect(args[args.indexOf("--provider") + 1]).toBe("anthropic");
  });
}

test("execute defers selection for an inherited HERMES_HOME", async () => {
  const { args, resultModel } = await runExecuteWithFakeHermes(
    { model: "auto" }, defaultHermesConfig, "/private/qa/inherited-hermes",
  );
  expect(args).not.toContain("-m");
  expect(args).not.toContain("--provider");
  expect(resultModel).toBe("auto");
});

test("execute preserves default-home provider detection for a concrete model", async () => {
  const { args } = await runExecuteWithFakeHermes(
    { model: "gpt-5.5" }, defaultHermesConfig,
  );
  expect(args[args.indexOf("--provider") + 1]).toBe("openai-codex");
});

test("execute renders prompt API base from adapter env PAPERCLIP_API_URL", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-prompt-api-url-"));
  const cliPath = path.join(tempDir, "fake-hermes");
  const argvPath = path.join(tempDir, "argv.txt");
  const originalApiUrl = process.env.PAPERCLIP_API_URL;

  try {
    process.env.PAPERCLIP_API_URL = "https://public.example.com/api";
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
          PAPERCLIP_API_URL: { type: "plain", value: "http://127.0.0.1:3101" },
        },
      },
      runtime: {},
      onLog: async () => {},
    } as any);

    const argv = await readFile(argvPath, "utf8");
    expect(argv).toContain("- API base: http://127.0.0.1:3101/api");
    expect(argv).not.toContain("https://public.example.com/api");
  } finally {
    if (originalApiUrl === undefined) {
      delete process.env.PAPERCLIP_API_URL;
    } else {
      process.env.PAPERCLIP_API_URL = originalApiUrl;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
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
