import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WINDOWS_PROCESS_JOB_SOURCE } from "./windows-process-job-source.js";

const execFileAsync = promisify(execFile);
let supervisor: Promise<string> | undefined;

async function supervisorPath(): Promise<string> {
  supervisor ??= (async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-supervisor-"));
    const source = path.join(dir, "ProcessJob.cs");
    const executable = path.join(dir, "ProcessJob.exe");
    try {
      await fs.writeFile(source, WINDOWS_PROCESS_JOB_SOURCE);
      const root = process.env.SystemRoot ?? "C:\\Windows";
      let compiler = path.join(root, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
      if (!(await fs.stat(compiler).catch(() => null))?.isFile()) {
        compiler = path.join(root, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe");
      }
      await execFileAsync(compiler, ["/nologo", "/target:exe", `/out:${executable}`, source], { windowsHide: true, timeout: 30_000 });
      return executable;
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  })().catch((error) => { supervisor = undefined; throw error; });
  return supervisor;
}

export async function prepareWindowsTerminalJob(command: string, args: string[]) {
  const executable = await supervisorPath();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-terminal-job-"));
  const receipt = path.join(dir, "settled");
  const token = randomUUID();
  const event = `Local\\paperclip-stop-${randomUUID()}`;
  return {
    command: executable,
    args: ["run", event, receipt, token, command, ...args],
    stop() {
      const child = spawn(executable, ["stop", event], { windowsHide: true, stdio: "ignore" });
      child.on("error", () => {});
    },
    async settle(): Promise<boolean> {
      const settled = await fs.readFile(receipt, "utf8").then((value) => value === token, () => false);
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return settled;
    },
  };
}
