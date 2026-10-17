import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterEnvironmentTestContext, AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { executeWithLocalCodexCommand, testWithLocalCodexCommand } from "../adapters/codex-local-command.js";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), execute: vi.fn(), test: vi.fn() }));
vi.mock("../vendor/paperclip-runner/index.js", () => ({ resolveCodexCommand: mocks.resolve }));
vi.mock("@paperclipai/adapter-codex-local/server", () => ({ execute: mocks.execute, testEnvironment: mocks.test }));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

const context = {
  companyId: "fixture-company", adapterType: "codex_local",
  config: { engine: "cli", cwd: "/fixture", env: { PATH: "/fixture/bin" } },
};

describe.skipIf(process.platform === "win32")("server local Codex command selection", () => {
  it("uses the same installed runtime for the probe and execution without mutating saved config", async () => {
    mocks.resolve.mockReturnValue("/installed/codex.js");
    await testWithLocalCodexCommand(context);
    await executeWithLocalCodexCommand(context as unknown as AdapterExecutionContext);
    const resolved = { ...context, config: { ...context.config, command: "/installed/codex.js" } };
    expect(mocks.test).toHaveBeenCalledWith(resolved, { isResolvedCodexCommand: true });
    expect(mocks.execute).toHaveBeenCalledWith(resolved);
    expect(mocks.resolve).toHaveBeenCalledWith(undefined, expect.objectContaining({ PATH: "/fixture/bin" }), "/fixture");
    expect(context.config).not.toHaveProperty("command");
  });

  it.each([undefined, ""])("restores default search directories when PATH is %j", async (value) => {
    vi.stubEnv("PATH", value);
    vi.stubEnv("Path", undefined);
    mocks.resolve.mockReturnValue("/usr/local/bin/codex");
    const input = { ...context, config: { ...context.config, env: {} } };
    await testWithLocalCodexCommand(input);
    await executeWithLocalCodexCommand(input as unknown as AdapterExecutionContext);
    for (const [, environment] of mocks.resolve.mock.calls) {
      expect(environment.PATH.split(path.delimiter)).toEqual(expect.arrayContaining(["/usr/local/bin", "/opt/homebrew/bin"]));
    }
  });

  it.each(["0.160.0", "0.100.0"])("checks the version and hello of a renamed symlink target (%s)", async (version) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-symlink-"));
    const executable = path.join(root, "renamed-runtime");
    const link = path.join(root, "codex");
    const capture = path.join(root, "calls.jsonl");
    try {
      await fs.writeFile(executable, `#!${process.execPath}
require('node:fs').appendFileSync(process.env.PROBE_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv.includes('--version')) { console.log('codex-cli ${version}'); process.exit(0); }
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'hello'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`, { mode: 0o755 });
      await fs.symlink(executable, link);
      mocks.resolve.mockReturnValue(await fs.realpath(link));
      const adapter = await vi.importActual<typeof import("@paperclipai/adapter-codex-local/server")>("@paperclipai/adapter-codex-local/server");
      mocks.test.mockImplementation(adapter.testEnvironment);
      const result = await testWithLocalCodexCommand({
        ...context,
        config: { engine: "cli", cwd: root, model: "gpt-6.1-sol", env: { OPENAI_API_KEY: "fixture-key", PROBE_CAPTURE: capture } },
      });
      const calls = (await fs.readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
      expect(calls[0]).toEqual(["--version"]);
      if (version === "0.160.0") {
        expect(result.checks).toContainEqual(expect.objectContaining({ code: "codex_hello_probe_passed" }));
        expect(calls[1]).toContain("exec");
      } else {
        expect(result.checks).toContainEqual(expect.objectContaining({ code: "codex_cli_version_incompatible" }));
        expect(calls).toHaveLength(1);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { ...context, config: { engine: "acp" } },
    { ...context, config: {} },
    { ...context, config: { engine: "cli", command: "/custom/codex" } },
    { ...context, config: { engine: "cli", command: "codex" } },
    { ...context, executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/remote" } },
  ])("preserves explicit commands and other execution lanes: %j", async (input) => {
    await testWithLocalCodexCommand(input as AdapterEnvironmentTestContext);
    await executeWithLocalCodexCommand(input as unknown as AdapterExecutionContext);
    expect(mocks.resolve.mock.calls.length).toBe(0);
    expect(mocks.test).toHaveBeenCalledWith(input);
    expect(mocks.execute).toHaveBeenCalledWith(input);
  });

  it("fails both entrypoints before provider work if dependency resolution fails", async () => {
    mocks.resolve.mockImplementation(() => { throw new Error("Broken dependency fixture"); });
    expect(await testWithLocalCodexCommand(context)).toMatchObject({ status: "fail", checks: [{ code: "codex_command_unresolvable" }] });
    expect(await executeWithLocalCodexCommand(context as unknown as AdapterExecutionContext)).toMatchObject({ exitCode: 1, errorCode: "codex_command_unresolvable" });
    expect(mocks.test).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("resolves PATH fallbacks relative to the actual execution workspace", async () => {
    mocks.resolve.mockReturnValue("/installed/codex.js");
    await executeWithLocalCodexCommand({ ...context, context: { paperclipWorkspace: { cwd: "/task/workspace" } } } as unknown as AdapterExecutionContext);
    expect(mocks.resolve.mock.calls[0]?.[2]).toBe("/task/workspace");
  });
});
