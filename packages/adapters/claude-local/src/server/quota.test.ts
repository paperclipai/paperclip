import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeClaudeCliShellProbe } from "./quota.js";

const fixturePath = fileURLToPath(
  new URL("./__fixtures__/quota-probe-child.cjs", import.meta.url),
);
const supportsScriptPty =
  process.platform !== "win32"
  && spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;

const temporaryDirectories: string[] = [];

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function readLines(filePath: string): Promise<string[]> {
  try {
    return (await fs.readFile(filePath, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function waitForLines(filePath: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const lines = await readLines(filePath);
    if (lines.length >= count) return lines;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${count} lines in ${filePath}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function expectProcessesGone(pids: number[]): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessAlive(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const survivors = pids.filter(isProcessAlive);
  const processDetails = spawnSync(
    "ps",
    ["-o", "pid=,ppid=,pgid=,sid=,stat=,args=", "-p", survivors.join(",")],
    { encoding: "utf8" },
  ).stdout.trim();
  expect(
    survivors,
    `probe descendants still alive: ${processDetails}`,
  ).toEqual([]);
}

async function runTimedOutProbe(mode: "accept" | "ignore") {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-quota-probe-"));
  temporaryDirectories.push(temporaryDirectory);
  const pidFile = path.join(temporaryDirectory, "pids");
  const signalFile = path.join(temporaryDirectory, "signals");
  const childCommand = [
    `echo $$ >> ${quoteForShell(pidFile)}; exec`,
    quoteForShell(process.execPath),
    quoteForShell(fixturePath),
    mode,
    quoteForShell(pidFile),
    quoteForShell(signalFile),
  ].join(" ");
  const command = [
    `sh -c ${quoteForShell(`echo $$ >> ${quoteForShell(pidFile)}; exec sleep 30`)}`,
    "|",
    `sh -c ${quoteForShell(`echo $$ >> ${quoteForShell(pidFile)}; exec script -q -e -f -c ${quoteForShell(childCommand)} /dev/null`)}`,
  ].join(" ");

  const killSpy = vi.spyOn(process, "kill");
  const execution = executeClaudeCliShellProbe(command, {
    env: process.env,
    timeoutMs: 500,
    terminationGraceMs: 300,
  });
  const pids = (await waitForLines(pidFile, 3)).map(Number);

  await expect(execution).rejects.toThrow("timed out after 500ms");
  await expectProcessesGone(pids);

  return {
    signals: await readLines(signalFile),
    dispatchedSignals: killSpy.mock.calls
      .map(([, signal]) => signal)
      .filter((signal) => signal === "SIGTERM" || signal === "SIGKILL"),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe.skipIf(!supportsScriptPty)("executeClaudeCliShellProbe process groups", () => {
  it("uses SIGTERM only and leaves no descendants when the pty child accepts it", async () => {
    const result = await runTimedOutProbe("accept");

    expect(result.signals).toEqual(["SIGTERM"]);
    expect(result.dispatchedSignals.length).toBeGreaterThan(0);
    expect(result.dispatchedSignals.every((signal) => signal === "SIGTERM")).toBe(true);
  });

  it("uses SIGTERM before SIGKILL and leaves no descendants when the pty child ignores TERM", async () => {
    const result = await runTimedOutProbe("ignore");

    expect(result.signals[0]).toBe("SIGTERM");
    expect(result.dispatchedSignals[0]).toBe("SIGTERM");
    expect(result.dispatchedSignals).toContain("SIGKILL");
  });
});
