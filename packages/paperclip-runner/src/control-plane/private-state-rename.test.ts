import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { atomicPrivateWrite } from "./durable-prp-control-plane.js";

it.runIf(process.platform === "win32").each([25, 500])("preserves atomic state replacement across a %sms Windows reader lock", async holdMs => {
  const root = mkdtempSync(join(tmpdir(), "runner-private-rename-"));
  const target = join(root, "control-plane-state.json");
  writeFileSync(target, "old receipt");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$file=[IO.File]::Open($env:PAPERCLIP_RENAME_TEST_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine('locked'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; [Console]::WriteLine('releasing'); [Console]::Out.Flush(); [Threading.Thread]::Sleep([int]$env:PAPERCLIP_RENAME_TEST_HOLD_MS); $file.Dispose()"],
    { env: { ...process.env, PAPERCLIP_RENAME_TEST_FILE: target, PAPERCLIP_RENAME_TEST_HOLD_MS: String(holdMs) }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Lock fixture exited ${code}`)));
  });
  void exited.catch(() => undefined);
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", chunk => { if (String(chunk).includes("locked")) resolve(); });
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Lock fixture did not become ready")));
    });
    expect(readFileSync(target, "utf8")).toBe("old receipt");
    const releasing = new Promise<void>(resolve => child.stdout.on("data", chunk => { if (String(chunk).includes("releasing")) resolve(); }));
    await new Promise<void>(resolve => child.stdin.end("release\n", resolve));
    await releasing;
    if (holdMs === 25) atomicPrivateWrite(target, "new receipt");
    else expect(() => atomicPrivateWrite(target, "new receipt")).toThrow(/EPERM|EACCES|EBUSY/);
    await exited;
    expect(readFileSync(target, "utf8")).toBe(holdMs === 25 ? "new receipt" : "old receipt");
    expect(readdirSync(root)).toEqual(["control-plane-state.json"]);
  } finally {
    if (child.exitCode === null) child.kill();
    await exited.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
