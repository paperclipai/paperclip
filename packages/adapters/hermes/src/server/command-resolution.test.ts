import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { HERMES_CLI } from "../shared/constants.js";
import { execute, resolveHermesCommand } from "./execute.js";
import { testEnvironment } from "./test.js";

let testHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  testHome = await mkdtemp(path.join(os.tmpdir(), "hermes-test-home-"));
  process.env.HOME = testHome;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(testHome, { recursive: true, force: true });
});

async function writeExecutable(filePath: string, contents: string) {
  await writeFile(filePath, contents, "utf8");
  await chmod(filePath, 0o755);
}

test("resolveHermesCommand prefers hermesCommand over command", () => {
  expect(resolveHermesCommand({ hermesCommand: "hermes_maximus", command: "hermes_backup" }))
    .toBe("hermes_maximus");
});

test("delivers managed MCP through the isolated Hermes home and removes its token", async () => {
  vi.stubEnv("PAPERCLIP_API_URL", undefined);
  vi.stubEnv("PAPERCLIP_BASE_URL", undefined);
  const home = path.join(testHome, "managed");
  await mkdir(home);
  const configPath = path.join(home, "config.yaml");
  const original = 'model:\n  provider: "custom"\n  base_url: "https://provider.example"\n';
  await writeFile(configPath, original, { mode: 0o644 });
  const cli = path.join(testHome, "hermes");
  const snapshot = path.join(testHome, "snapshot");
  const argvPath = path.join(testHome, "argv");
  await writeExecutable(cli, `#!/bin/sh\ncat "$HERMES_HOME/config.yaml" > ${JSON.stringify(snapshot)}\nprintf '%s\\n' "$@" > ${JSON.stringify(argvPath)}\nprintf 'done\\n'\n`);
  const logs: unknown[] = [];
  const meta: unknown[] = [];
  const result = await execute({
    runId: "managed-mcp", agent: { id: "agent", companyId: "company", name: "Hermes" },
    config: { command: cli, provider: "auto", managedAiConnection: { provider: "openai" },
      promptTemplate: "{{context.paperclipManagedMcp.gateways}}",
      env: { HERMES_HOME: home, PAPERCLIP_API_URL: "https://ignored.example/api" } },
    runtime: {}, context: { paperclipManagedMcp: { managedMcpOnly: true, apiBaseUrl: "https://paperclip.example/api",
      gateways: [
        { name: "Assigned!", endpointPath: "/mcp/gateways/gw_test", bearerToken: "fixture-managed-token" },
        { name: "assigned", endpointPath: "/mcp/gateways/gw_other", bearerToken: "fixture-other-token" },
      ] } },
    onLog: async (...args: unknown[]) => { logs.push(args); }, onMeta: async (data: unknown) => { meta.push(data); },
  } as any);
  expect(result.exitCode).toBe(0);
  const captured = await readFile(snapshot, "utf8");
  expect(captured).toContain(original);
  expect(captured).toContain("https://paperclip.example/mcp/gateways/gw_test");
  expect(captured).toContain("Bearer fixture-managed-token");
  expect(captured).toContain('"paperclip-assigned-2"');
  expect(captured).toContain("Bearer fixture-other-token");
  expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  expect(await readFile(configPath, "utf8")).toBe(original);
  expect(await readFile(argvPath, "utf8")).not.toContain("fixture-managed-token");
  expect(JSON.stringify([logs, meta, result])).not.toContain("fixture-managed-token");
  expect(JSON.stringify([logs, meta, result])).not.toContain("fixture-other-token");
});

test("refuses managed MCP without an isolated home or with existing MCP configuration", async () => {
  const home = path.join(testHome, "managed");
  await mkdir(home);
  const configPath = path.join(home, "config.yaml");
  const existing = 'model:\n  provider: "custom"\nmcp_servers:\n  foreign:\n    url: "https://foreign.example"\n';
  await writeFile(configPath, existing);
  const base = {
    runId: "managed-mcp", agent: { id: "agent", companyId: "company", name: "Hermes" },
    config: { command: "unused", provider: "auto", env: { HERMES_HOME: home } },
    runtime: {}, context: { paperclipManagedMcp: { managedMcpOnly: true, apiBaseUrl: "https://paperclip.example",
      gateways: [{ name: "assigned", endpointPath: "/mcp/gateways/gw_test", bearerToken: "fixture-managed-token" }] } },
    onLog: async () => {},
  };
  await expect(execute(base as any)).rejects.toThrow("isolated Hermes home");
  await expect(execute({ ...base, config: { ...base.config, managedAiConnection: {} } } as any))
    .rejects.toThrow("Cannot safely add managed MCP");
  expect(await readFile(configPath, "utf8")).toBe(existing);
});

test("empty managed selection refuses foreign MCP and writes an empty selection otherwise", async () => {
  vi.stubEnv("PAPERCLIP_API_URL", undefined);
  vi.stubEnv("PAPERCLIP_BASE_URL", undefined);
  const home = path.join(testHome, "managed");
  await mkdir(home);
  const configPath = path.join(home, "config.yaml");
  const foreign = 'mcp_servers:\n  foreign:\n    url: "https://foreign.example"\n';
  await writeFile(configPath, foreign);
  const cli = path.join(testHome, "hermes");
  const snapshot = path.join(testHome, "snapshot");
  await writeExecutable(cli, `#!/bin/sh\ncat "$HERMES_HOME/config.yaml" > ${JSON.stringify(snapshot)}\n`);
  const input = {
    runId: "empty", agent: { id: "agent", companyId: "company", name: "Hermes" },
    config: { command: cli, provider: "auto", managedAiConnection: {}, env: { HERMES_HOME: home } },
    runtime: {}, context: { paperclipManagedMcp: { managedMcpOnly: true, gateways: [] } }, onLog: async () => {},
  };
  await expect(execute(input as any)).rejects.toThrow("Cannot safely add managed MCP");
  expect(await readFile(configPath, "utf8")).toBe(foreign);
  const provider = 'model:\n  provider: "custom"\n';
  await writeFile(configPath, provider);
  await execute(input as any);
  expect(await readFile(snapshot, "utf8")).toContain("mcp_servers: {}");
  expect(await readFile(configPath, "utf8")).toBe(provider);
});

test("rejects a missing effective API origin before delivering a Hermes token", async () => {
  vi.stubEnv("PAPERCLIP_API_URL", undefined);
  vi.stubEnv("PAPERCLIP_BASE_URL", undefined);
  const home = path.join(testHome, "managed");
  await mkdir(home);
  const logs: unknown[] = [];
  await expect(execute({
    runId: "origin", agent: { id: "agent", companyId: "company", name: "Hermes" },
    config: { command: "unused", provider: "auto", managedAiConnection: {}, env: { HERMES_HOME: home, PAPERCLIP_API_URL: "https://forged.example" } },
    runtime: {}, context: { paperclipManagedMcp: { managedMcpOnly: true, gateways: [
      { name: "assigned", endpointPath: "/mcp/gateways/gw_test", bearerToken: "fixture-origin-token" },
    ] } }, onLog: async (...args: unknown[]) => { logs.push(args); },
  } as any)).rejects.toThrow("PAPERCLIP_API_URL");
  expect(JSON.stringify(logs).includes("fixture-origin-token")).toBe(false);
  await expect(stat(path.join(home, "config.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
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
    await writeExecutable(path.join(tempDir, "python3"), "#!/bin/sh\necho Python 3.12.0\n");

    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        command: cliPath,
        env: { PATH: tempDir },
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

test("preflight uses configured PATH and environment for CLI and Python checks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-preflight-env-"));
  const originalPath = process.env.PATH;
  const originalMarker = process.env.HERMES_HOME;
  const originalCleared = process.env.PYTHONUNBUFFERED;
  try {
    const ambientDir = path.join(tempDir, "ambient");
    const configuredDir = path.join(tempDir, "configured");
    await mkdir(ambientDir);
    await mkdir(configuredDir);
    await writeExecutable(path.join(ambientDir, "python3"), "#!/bin/sh\necho Python 3.9.0\n");
    await writeExecutable(path.join(configuredDir, "python3"), "#!/bin/sh\necho Python 3.12.0\n");
    await writeExecutable(path.join(configuredDir, "fake-hermes"),
      '#!/bin/sh\n[ "$HERMES_HOME" = "configured-home" ] || exit 1\n[ "${PYTHONUNBUFFERED+x}" = "x" ] || exit 1\n[ "$PYTHONUNBUFFERED" = "" ] || exit 1\necho configured-hermes 1.2.3\n');
    process.env.PATH = ambientDir;
    process.env.HERMES_HOME = "ambient-home";
    process.env.PYTHONUNBUFFERED = "ambient-value";
    const config = {
      command: "fake-hermes",
      env: { PATH: configuredDir, HERMES_HOME: "configured-home", PYTHONUNBUFFERED: "" },
    };
    const result = await testEnvironment({ companyId: "test", adapterType: "hermes_local", config });
    expect(result.status).not.toBe("fail");
    expect(result.checks.some((check) => check.code === "hermes_cli_not_found")).toBe(false);
    expect(result.checks.some((check) =>
      check.code === "hermes_version" && check.message.includes("configured-hermes 1.2.3"),
    )).toBe(true);
    expect(result.checks.some((check) => check.code === "hermes_python_old")).toBe(false);

    await writeExecutable(path.join(configuredDir, "python3"), "#!/bin/sh\necho Python 3.9.0\n");
    await writeExecutable(path.join(ambientDir, "python3"), "#!/bin/sh\necho Python 3.12.0\n");
    const oldPython = await testEnvironment({ companyId: "test", adapterType: "hermes_local", config });
    expect(oldPython.status).toBe("fail");
    expect(oldPython.checks.some((check) => check.code === "hermes_python_old")).toBe(true);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalMarker === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalMarker;
    if (originalCleared === undefined) delete process.env.PYTHONUNBUFFERED;
    else process.env.PYTHONUNBUFFERED = originalCleared;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("normal probes receive runtime selection but no configured or ambient credentials", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-probe-credentials-"));
  const originalAnthropic = process.env.ANTHROPIC_API_KEY;
  const originalCustom = process.env.CUSTOM_SECRET;
  try {
    process.env.ANTHROPIC_API_KEY = "fixture-ambient-provider-key";
    process.env.CUSTOM_SECRET = "fixture-ambient-custom-secret";
    await writeExecutable(path.join(tempDir, "fake-hermes"), [
      "#!/bin/sh",
      'echo "fake-hermes $OPENAI_API_KEY $ANTHROPIC_API_KEY $PAPERCLIP_GATEWAY_TOKEN $CUSTOM_SECRET $HERMES_SECRET $PYTHON_TOKEN"',
    ].join("\n"));
    await writeExecutable(path.join(tempDir, "python3"), [
      "#!/bin/sh",
      '[ "$HERMES_RUNTIME_DIR" = "runtime-dir" ] || exit 1',
      '[ "$PYTHONHOME" = "python-home" ] || exit 1',
      '[ "$XDG_CONFIG_HOME" = "xdg-config" ] || exit 1',
      'if [ "${OPENAI_API_KEY+x}${ANTHROPIC_API_KEY+x}${PAPERCLIP_GATEWAY_TOKEN+x}${CUSTOM_SECRET+x}${HERMES_SECRET+x}${PYTHON_TOKEN+x}" != "" ]; then echo Python 3.9.0; else echo Python 3.12.0; fi',
    ].join("\n"));
    const result = await testEnvironment({
      companyId: "test",
      adapterType: "hermes_local",
      config: {
        command: "fake-hermes",
        env: {
          PATH: tempDir, HERMES_RUNTIME_DIR: "runtime-dir", PYTHONHOME: "python-home",
          XDG_CONFIG_HOME: "xdg-config", OPENAI_API_KEY: "fixture-configured-provider-key",
          PAPERCLIP_GATEWAY_TOKEN: "fixture-gateway-token",
          HERMES_SECRET: "fixture-hermes-secret", PYTHON_TOKEN: "fixture-python-token",
        },
      },
    });
    const checks = JSON.stringify(result.checks);
    for (const value of [
      "fixture-configured-provider-key", "fixture-ambient-provider-key", "fixture-gateway-token",
      "fixture-ambient-custom-secret", "fixture-hermes-secret", "fixture-python-token",
    ]) expect(checks).not.toContain(value);
    expect(result.checks.some((check) => check.code === "hermes_version" && check.message.includes("fake-hermes"))).toBe(true);
    expect(result.checks.some((check) => check.code === "hermes_api_keys_found")).toBe(true);
    expect(result.checks.some((check) => check.code === "hermes_python_old" || check.code === "hermes_python_missing")).toBe(false);
  } finally {
    if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropic;
    if (originalCustom === undefined) delete process.env.CUSTOM_SECRET;
    else process.env.CUSTOM_SECRET = originalCustom;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("preflight inherits the parent environment when adapter env is absent", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-preflight-parent-"));
  const originalPath = process.env.PATH;
  const originalMarker = process.env.HERMES_HOME;
  try {
    await writeExecutable(path.join(tempDir, "python3"), "#!/bin/sh\necho Python 3.12.0\n");
    await writeExecutable(path.join(tempDir, "fake-hermes"),
      '#!/bin/sh\n[ "$HERMES_HOME" = "parent-home" ] || exit 1\necho parent-hermes 1.2.3\n');
    process.env.PATH = tempDir;
    process.env.HERMES_HOME = "parent-home";
    const result = await testEnvironment({
      companyId: "test", adapterType: "hermes_local", config: { command: "fake-hermes" },
    });
    expect(result.status).not.toBe("fail");
    expect(result.checks.some((check) =>
      check.code === "hermes_version" && check.message.includes("parent-hermes 1.2.3"),
    )).toBe(true);
    expect(result.checks.some((check) => check.code === "hermes_python_old")).toBe(false);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalMarker === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalMarker;
    await rm(tempDir, { recursive: true, force: true });
  }
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

test("executes delegated native OpenAI with the selected key and openai-api provider", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-managed-openai-"));
  const cliPath = path.join(tempDir, "fake-hermes");
  const argvPath = path.join(tempDir, "argv.txt");
  try {
    await writeExecutable(cliPath, [
      "#!/bin/sh",
      '[ "$OPENAI_API_KEY" = "fixture-selected-key" ] || exit 1',
      `printf '%s\\n' "$@" > ${JSON.stringify(argvPath)}`,
      "printf 'done\\n\\nsession_id: test-session\\n'",
    ].join("\n"));
    const result = await execute({
      runId: "managed-openai",
      agent: { id: "agent-test", name: "Hermes Test Agent", companyId: "company-test" },
      config: { hermesCommand: cliPath, model: "gpt-4.1", provider: "openai-api",
        managedAiConnection: { provider: "openai", method: "api_key", mode: "delegated" },
        env: { OPENAI_API_KEY: "fixture-selected-key" } },
      runtime: {}, onLog: async () => {},
    } as any);
    expect(result.exitCode).toBe(0);
    const argv = (await readFile(argvPath, "utf8")).split("\n");
    expect(argv[argv.indexOf("--provider") + 1]).toBe("openai-api");
    expect(argv).not.toContain("openai-codex");
    expect(argv).not.toContain("openrouter");
  } finally { await rm(tempDir, { recursive: true, force: true }); }
});
