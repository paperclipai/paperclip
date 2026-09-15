import { describe, expect, it } from "vitest";
import {
  buildSshRunCommandTarget,
  buildSshRunnerRemoteCommand,
  buildSshSpawnTarget,
} from "./ssh.js";

const ARGV_CANARY = "paperclip-argv-canary";
const TEST_ENV = {
  PAPERCLIP_API_KEY: ARGV_CANARY,
  PAPERCLIP_AGENT_ID: "agent-fixture",
  MULTILINE_VALUE: "first\nsecond\tGrüße",
  EMPTY_VALUE: "",
};

function parseEnvPrefix(input: string): { env: Record<string, string>; rest: string } {
  const terminator = "\nPAPERCLIP_SSH_ENV_END\n";
  const end = input.indexOf(terminator);
  expect(end).toBeGreaterThan(-1);

  const lines = input.slice(0, end).split("\n");
  expect(lines.shift()).toBe("PAPERCLIP_SSH_ENV_V1");
  const env: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf("\t");
    expect(separator).toBeGreaterThan(0);
    env[line.slice(0, separator)] = Buffer.from(line.slice(separator + 1), "base64").toString("utf8");
  }
  return { env, rest: input.slice(end + terminator.length) };
}

function expectNoEnvironmentInArgv(argv: readonly string[]): void {
  const rendered = argv.join("\0");
  expect(rendered).not.toContain(ARGV_CANARY);
  expect(rendered).not.toContain(Buffer.from(ARGV_CANARY, "utf8").toString("base64"));
  for (const key of Object.keys(TEST_ENV)) {
    expect(rendered).not.toContain(`${key}=`);
  }
  expect(rendered).not.toContain("exec env ");
}

describe("SSH environment argv isolation", () => {
  it("keeps the runSshCommand path environment off argv and preserves payload stdin", () => {
    const remoteCommand = buildSshRunnerRemoteCommand({
      command: "sh",
      args: ["-c", "cat"],
      cwd: "/srv/paperclip/workspace",
    });
    const target = buildSshRunCommandTarget({ remoteCommand, env: TEST_ENV });

    expectNoEnvironmentInArgv([target.remoteArgument]);
    expect(target.remoteArgument).toContain("exec sh -c");

    const payload = "payload-line-1\npayload-line-2\n";
    const decoded = parseEnvPrefix(`${target.stdinPrefix ?? ""}${payload}`);
    expect(decoded.env).toEqual(TEST_ENV);
    expect(decoded.rest).toBe(payload);
  });

  it("keeps the buildSshSpawnTarget path environment off argv", async () => {
    const target = await buildSshSpawnTarget({
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        remoteCwd: "/srv/paperclip/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
      command: "node",
      args: ["runner.js"],
      env: TEST_ENV,
    });

    try {
      expectNoEnvironmentInArgv(target.args);
      expect(target.args.at(-1)).toContain("exec");
      expect(parseEnvPrefix(target.stdinPrefix ?? "").env).toEqual(TEST_ENV);
    } finally {
      await target.cleanup();
    }
  });

  it("does not allocate a stdin prefix when no environment is injected", async () => {
    const runTarget = buildSshRunCommandTarget({ remoteCommand: "true" });
    expect(runTarget.stdinPrefix).toBeUndefined();

    const spawnTarget = await buildSshSpawnTarget({
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        remoteCwd: "/srv/paperclip/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
      command: "true",
      args: [],
      env: {},
    });
    try {
      expect(spawnTarget.stdinPrefix).toBeUndefined();
    } finally {
      await spawnTarget.cleanup();
    }
  });

  it.each(["BAD KEY", "PAPERCLIP_SSH_ENV_END", "__paperclip_env_complete"])(
    "rejects invalid or protocol-reserved environment key %s before building either argv",
    async (key) => {
      expect(() => buildSshRunCommandTarget({
        remoteCommand: "true",
        env: { [key]: "fixture" },
      })).toThrow(`Invalid SSH environment variable key: ${key}`);

      await expect(buildSshSpawnTarget({
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "paperclip",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          remoteCwd: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
        command: "true",
        args: [],
        env: { [key]: "fixture" },
      })).rejects.toThrow(`Invalid SSH environment variable key: ${key}`);
    },
  );
});
