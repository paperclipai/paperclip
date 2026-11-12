import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { WINDOWS_PROCESS_JOB_SOURCE } from "./windows-process-job-source.js";

const execute = promisify(execFile);

it.skipIf(process.platform !== "win32")("receipts a cancelled suspended Windows job without starting the provider", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-prestart-stop-"));
  const source = path.join(directory, "ProcessJob.cs");
  const supervisor = path.join(directory, "ProcessJob.exe");
  const marker = path.join(directory, "provider-started");
  const receipt = path.join(directory, "settled");
  const event = `Local\\paperclip-stop-${randomUUID()}`;
  const token = randomUUID();
  const compiler = path.join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const resume = "if (ResumeThread(child.Thread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());";
  expect(WINDOWS_PROCESS_JOB_SOURCE).toContain(resume);
  await writeFile(source, WINDOWS_PROCESS_JOB_SOURCE.replace(resume, `${resume}\nSystem.Threading.Thread.Sleep(750);`));
  await execute(compiler, ["/nologo", "/target:exe", `/out:${supervisor}`, source], { windowsHide: true, timeout: 30_000 });
  const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$event = [System.Threading.EventWaitHandle]::new($true, [System.Threading.EventResetMode]::ManualReset, '${event}'); [Console]::Out.WriteLine('ready'); [Console]::In.ReadLine() | Out-Null; $event.Dispose()`,
  ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  try {
    const ready = once(holder.stdout, "data");
    const exited = once(holder, "exit").then(() => { throw new Error("Event holder exited before readiness"); });
    await Promise.race([ready, exited]);
    const result = await execute(supervisor, ["run", event, receipt, token, process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`], { windowsHide: true, timeout: 15_000 }).catch(error => error as { code: number });
    expect("code" in result ? result.code : 0).toBe(143);
    expect(await readFile(receipt, "utf8")).toBe(token);
    expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
  } finally {
    holder.stdin.end("release\n");
    if (holder.exitCode === null) await once(holder, "exit");
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
