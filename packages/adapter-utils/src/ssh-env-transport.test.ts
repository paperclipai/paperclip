import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSshRunCommandTarget, buildSshRunnerRemoteCommand, buildSshSpawnTarget } from "./ssh.js";

// The sshd-backed assertions in ssh-fixture.test.ts self-skip wherever `sshd`
// is absent, so on most runners nothing ever executes the remote reader
// script. These tests run the exact script that ssh would hand to the remote
// login shell through a local `sh` instead: same text, same framed stdin, no
// sshd required. That keeps the POSIX transport contract covered everywhere.

const ARGV_CANARY = "paperclip-argv-canary-value";
const TRANSPORT_ENV = {
  PAPERCLIP_API_KEY: ARGV_CANARY,
  PAPERCLIP_AGENT_ID: "agent-fixture",
  MULTILINE_VALUE: "first\nsecond\tGrüße",
  TRAILING_NEWLINE_VALUE: "keep-me\n",
  EMPTY_VALUE: "",
};

const PAYLOAD = "payload-line-1\npayload-line-2\n";

// Report every variable and the payload back through stdout, then exit with a
// distinctive status so exit-code propagation is proven too.
const REPORT_SCRIPT = [
  'printf "API=[%s]\\n" "$PAPERCLIP_API_KEY"',
  'printf "AGENT=[%s]\\n" "$PAPERCLIP_AGENT_ID"',
  'printf "MULTILINE=[%s]\\n" "$MULTILINE_VALUE"',
  'printf "TRAILING=[%s]\\n" "$TRAILING_NEWLINE_VALUE"',
  'printf "EMPTY=[%s]\\n" "$EMPTY_VALUE"',
  'printf "PAYLOAD=["',
  "cat",
  'printf "]\\n"',
  "exit 23",
].join("; ");

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createRemoteCwd(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-env-transport-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Run the remote-side script the way ssh does: the login shell receives it as
 * a single argument, and stdin carries the framed environment prefix followed
 * by the caller payload.
 */
async function runRemoteScript(
  remoteArgument: string,
  stdin: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", remoteArgument], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function expectNoEnvironmentInArgv(argv: readonly string[]): void {
  const rendered = argv.join("\0");
  expect(rendered).not.toContain(ARGV_CANARY);
  expect(rendered).not.toContain(Buffer.from(ARGV_CANARY, "utf8").toString("base64"));
  expect(rendered).not.toContain("exec env ");
  for (const key of Object.keys(TRANSPORT_ENV)) {
    expect(rendered).not.toContain(`${key}=`);
  }
}

function expectReportedEnvironment(stdout: string): void {
  expect(stdout).toContain(`API=[${ARGV_CANARY}]`);
  expect(stdout).toContain("AGENT=[agent-fixture]");
  expect(stdout).toContain("MULTILINE=[first\nsecond\tGrüße]");
  expect(stdout).toContain("TRAILING=[keep-me\n]");
  expect(stdout).toContain("EMPTY=[]");
  expect(stdout).toContain(`PAYLOAD=[${PAYLOAD}]`);
}

describe("SSH environment stdin transport (no sshd required)", () => {
  it("installs the environment and forwards payload stdin on the runSshCommand path", async () => {
    const cwd = await createRemoteCwd();
    const remoteCommand = buildSshRunnerRemoteCommand({
      command: "sh",
      args: ["-c", REPORT_SCRIPT],
      cwd,
    });
    const target = buildSshRunCommandTarget({ remoteCommand, env: TRANSPORT_ENV });

    expectNoEnvironmentInArgv([target.remoteArgument]);
    expect(target.stdinPrefix).toBeDefined();

    const result = await runRemoteScript(
      target.remoteArgument,
      `${target.stdinPrefix ?? ""}${PAYLOAD}`,
    );

    expect(result.stderr).toBe("");
    expect(result.code).toBe(23);
    expectReportedEnvironment(result.stdout);
    // The reader must consume exactly its own frame and nothing else.
    expect(result.stdout).not.toContain("PAPERCLIP_SSH_ENV_V1");
  });

  it("installs the environment and forwards payload stdin on the spawn path", async () => {
    const cwd = await createRemoteCwd();
    const target = await buildSshSpawnTarget({
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: cwd,
        remoteCwd: cwd,
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
      command: "sh",
      args: ["-c", REPORT_SCRIPT],
      env: TRANSPORT_ENV,
    });

    try {
      expectNoEnvironmentInArgv(target.args);
      expect(target.stdinPrefix).toBeDefined();

      const remoteArgument = target.args.at(-1);
      expect(typeof remoteArgument).toBe("string");

      const result = await runRemoteScript(
        remoteArgument as string,
        `${target.stdinPrefix ?? ""}${PAYLOAD}`,
      );

      expect(result.stderr).toBe("");
      expect(result.code).toBe(23);
      expectReportedEnvironment(result.stdout);
      expect(result.stdout).not.toContain("PAPERCLIP_SSH_ENV_V1");
    } finally {
      await target.cleanup();
    }
  });

  it("runs the command unchanged when no environment is injected", async () => {
    const cwd = await createRemoteCwd();
    const remoteCommand = buildSshRunnerRemoteCommand({
      command: "sh",
      args: ["-c", 'printf "PAYLOAD=["; cat; printf "]\\n"; exit 7'],
      cwd,
    });
    const target = buildSshRunCommandTarget({ remoteCommand });

    expect(target.stdinPrefix).toBeUndefined();

    const result = await runRemoteScript(target.remoteArgument, PAYLOAD);

    expect(result.code).toBe(7);
    expect(result.stdout).toBe(`PAYLOAD=[${PAYLOAD}]\n`);
  });

  it("fails closed when the framed environment prefix is missing or truncated", async () => {
    const cwd = await createRemoteCwd();
    const remoteCommand = buildSshRunnerRemoteCommand({
      command: "sh",
      args: ["-c", 'printf "SHOULD-NOT-RUN\\n"'],
      cwd,
    });
    const target = buildSshRunCommandTarget({ remoteCommand, env: TRANSPORT_ENV });
    const prefix = target.stdinPrefix as string;

    const missing = await runRemoteScript(target.remoteArgument, PAYLOAD);
    expect(missing.code).toBe(1);
    expect(missing.stdout).not.toContain("SHOULD-NOT-RUN");

    // Drop the terminator line so the frame never completes.
    const truncated = await runRemoteScript(
      target.remoteArgument,
      prefix.replace("\nPAPERCLIP_SSH_ENV_END\n", "\n"),
    );
    expect(truncated.code).toBe(1);
    expect(truncated.stdout).not.toContain("SHOULD-NOT-RUN");
  });
});
