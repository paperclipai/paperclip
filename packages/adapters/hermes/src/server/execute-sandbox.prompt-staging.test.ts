/**
 * TECH-8174: the Hermes sandbox launch exec stages the prompt file and run home itself (one exec
 * instead of a separate staging exec). These tests run the generated script in a real `sh`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  HERMES_SANDBOX_PROMPT_STAGING_EXIT_CODE,
  buildHermesSandboxPromptStagingLaunch,
} from "./execute-sandbox.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "hermes-stage-")));
  dirs.push(dir);
  return dir;
}

function run(command: string, args: string[], stdin: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

// Stands in for Hermes: records its argv, what is left on stdin, and its umask.
const FAKE_HERMES = [
  'out="$1"; shift',
  'printf "%s\\n" "$@" > "$out.args"',
  'cat > "$out.stdin"',
  'umask > "$out.umask"',
  'printf "hermes ran\\n"',
].join("\n");

describe("buildHermesSandboxPromptStagingLaunch (real shell)", () => {
  it("writes the prompt from stdin to the query file, creates the run home, then execs the launch with stdin at EOF", async () => {
    const root = await tmp();
    const queryPath = path.join(root, "runtime", "query.txt");
    const homeRoot = path.join(root, "runtime", "home");
    await fs.mkdir(path.dirname(queryPath));
    const prompt = "TASK-BODY-SENTINEL line 1\nline 2 with 'quotes' and $HOME and `ticks`\n";
    const record = path.join(root, "hermes");
    const launch = buildHermesSandboxPromptStagingLaunch({
      queryPath,
      homeRoot,
      command: "sh",
      args: ["-c", FAKE_HERMES, "fake-hermes", record, "chat", "--query-file", queryPath, "-m", "a b"],
    });

    // The prompt is never in argv.
    expect(JSON.stringify([launch.command, launch.args])).not.toContain("TASK-BODY-SENTINEL");

    const result = await run(launch.command, launch.args, prompt);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hermes ran\n");
    expect(launch.stagingFailed({ exitCode: result.exitCode, timedOut: false, stderr: result.stderr })).toBe(false);

    expect(await fs.readFile(queryPath, "utf8")).toBe(prompt);
    expect((await fs.stat(queryPath)).mode & 0o777).toBe(0o600);
    for (const sub of ["", "config", "data", "cache", "state", "tmp", "runtime"]) {
      const stat = await fs.stat(path.join(homeRoot, sub));
      expect(stat.isDirectory()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o700);
    }
    // The launch got its argv verbatim, nothing left on stdin, and not the staging umask.
    expect(await fs.readFile(`${record}.args`, "utf8")).toBe(`chat\n--query-file\n${queryPath}\n-m\na b\n`);
    expect(await fs.readFile(`${record}.stdin`, "utf8")).toBe("");
    expect((await fs.readFile(`${record}.umask`, "utf8")).trim()).not.toBe("0077");
  });

  it("reports a failed staging step as such and never starts the launch", async () => {
    const root = await tmp();
    // The run home's parent is a regular file, so mkdir fails.
    await fs.writeFile(path.join(root, "blocker"), "x");
    const queryPath = path.join(root, "query.txt");
    const record = path.join(root, "hermes");
    const launch = buildHermesSandboxPromptStagingLaunch({
      queryPath,
      homeRoot: path.join(root, "blocker", "home"),
      command: "sh",
      args: ["-c", FAKE_HERMES, "fake-hermes", record],
    });

    const result = await run(launch.command, launch.args, "prompt");
    expect(result.exitCode).toBe(HERMES_SANDBOX_PROMPT_STAGING_EXIT_CODE);
    expect(result.stderr).toContain("Could not stage the Hermes prompt in the sandbox.");
    expect(launch.stagingFailed({ exitCode: result.exitCode, timedOut: false, stderr: result.stderr })).toBe(true);
    await expect(fs.stat(`${record}.args`)).rejects.toThrow();
    await expect(fs.stat(queryPath)).rejects.toThrow();
  });

  it("does not mistake a Hermes exit with the same code for a staging failure", async () => {
    const root = await tmp();
    const launch = buildHermesSandboxPromptStagingLaunch({
      queryPath: path.join(root, "query.txt"),
      homeRoot: path.join(root, "home"),
      command: "sh",
      args: ["-c", `echo "[hermes] Could not stage the Hermes prompt in the sandbox. (stage 0000)" >&2; exit ${HERMES_SANDBOX_PROMPT_STAGING_EXIT_CODE}`],
    });
    const result = await run(launch.command, launch.args, "prompt");
    expect(result.exitCode).toBe(HERMES_SANDBOX_PROMPT_STAGING_EXIT_CODE);
    expect(launch.stagingFailed({ exitCode: result.exitCode, timedOut: false, stderr: result.stderr })).toBe(false);
    expect(launch.stagingFailed({ exitCode: null, timedOut: true, stderr: "" })).toBe(false);
  });
});
