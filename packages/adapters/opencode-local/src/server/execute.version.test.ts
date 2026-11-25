import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length) await fs.rm(directories.pop()!, { recursive: true, force: true });
});

async function fixture(major: 1 | 2, variant: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-version-"));
  directories.push(root);
  const cwd = path.join(root, "workspace");
  const home = path.join(root, "home");
  const command = path.join(root, "opencode");
  await fs.mkdir(cwd);
  await fs.mkdir(home);
  await fs.writeFile(command, `#!/usr/bin/env node
const args = process.argv.slice(2);
const major = ${major};
const variant = ${JSON.stringify(variant)};
const expectedCwd = process.env.OPENCODE_TEST_EXPECTED_CWD;
if (args[0] === "--version") {
  console.log(major === 1 ? "1.18.34" : "opencode v2.3.2");
} else if (args[0] === "models") {
  console.log("openai/fixture");
} else if (args[0] === "run") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => input += chunk);
  process.stdin.on("end", () => {
    const model = args[args.indexOf("--model") + 1];
    const isProbe = input === "Respond with hello.";
    const expectedModel = major === 2 && variant ? "openai/fixture#" + variant : "openai/fixture";
    const invalid = model !== expectedModel ||
      (major === 2 && (args.includes("--dir") || args.includes("--variant") || process.env.PWD !== expectedCwd)) ||
      (major === 1 && process.env.PWD !== process.env.OPENCODE_TEST_ORIGINAL_PWD) ||
      (major === 1 && variant && args[args.indexOf("--variant") + 1] !== variant) ||
      (major === 1 && !isProbe && args[args.indexOf("--dir") + 1] !== expectedCwd);
    if (invalid) {
      console.error(JSON.stringify({ major, args, cwd: process.cwd(), pwd: process.env.PWD, isProbe }));
      process.exitCode = 2;
      return;
    }
    console.log(JSON.stringify({ type: "text", sessionID: "fixture-session", part: { text: "hello" } }));
  });
} else {
  process.exitCode = 2;
}
`, { mode: 0o755 });
  return {
    cwd,
    config: {
      command,
      cwd,
      model: "openai/fixture",
      ...(variant ? { variant } : {}),
      dangerouslySkipPermissions: false,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, "config"),
        PWD: path.join(root, "unrelated"),
        OPENCODE_TEST_ORIGINAL_PWD: path.join(root, "unrelated"),
        OPENCODE_TEST_EXPECTED_CWD: cwd,
        OPENCODE_ALLOW_ALL_MODELS: "1",
      },
    },
  };
}

describe("OpenCode CLI versions", () => {
  it.each([
    [1, "high"],
    [2, ""],
    [2, "high"],
  ] as const)("runs OpenCode %i in the assigned workspace with variant %s", async (major, variant) => {
    const { cwd, config } = await fixture(major, variant);
    const result = await execute({
      runId: "fixture-run",
      agent: { id: "agent", companyId: "company", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config,
      context: {},
      onLog: async () => {},
    });
    expect(result.exitCode, result.errorMessage ?? "").toBe(0);
    expect(result.summary).toBe("hello");
    expect(result.sessionParams).toMatchObject({ sessionId: "fixture-session", cwd });
  });

  it("resumes an OpenCode 2 session in the same workspace", async () => {
    const { cwd, config } = await fixture(2, "high");
    let args: string[] = [];
    const result = await execute({
      runId: "fixture-run",
      agent: { id: "agent", companyId: "company", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: "fixture-session", sessionParams: { sessionId: "fixture-session", cwd },
        sessionDisplayId: null, taskKey: null },
      config,
      context: {},
      onLog: async () => {},
      onMeta: async (meta) => { args = meta.commandArgs ?? []; },
    });
    expect(result.exitCode).toBe(0);
    expect(args).toContain("--session");
    expect(args).toContain("fixture-session");
    expect(result.sessionParams).toMatchObject({ sessionId: "fixture-session", cwd });
  });

  it.each([[1, "high"], [2, ""], [2, "high"]] as const)(
    "uses OpenCode %i workspace and variant syntax in the environment probe (%s)", async (major, variant) => {
    const { config } = await fixture(major, variant);
    const result = await testEnvironment({ companyId: "company", adapterType: "opencode_local", config });
    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "opencode_hello_probe_passed" }),
    ]));
    },
  );
});
