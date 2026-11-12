import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveCodexCommand } from "./codex-command.js";
import { createSanitizedCodexEnvironment } from "./app-server-transport.js";
import { codexCommandEnvironment, codexExecutableReadOnlyRoots, createIsolatedCodexAppServerArgs } from "./codex-security-config.js";

it.runIf(process.platform === "win32")("projects required Windows environment variables regardless of source casing", () => {
  expect(codexCommandEnvironment({ SYSTEMROOT: "C:\\Windows", SYSTEMDRIVE: "C:", path: "fixture", PRIVATE_TOKEN: "secret" }))
    .toEqual({ SystemRoot: "C:\\Windows", SystemDrive: "C:", PATH: "fixture" });
});

it("selects MXC for a native Windows process without weakening the filesystem policy", () => {
  const args = createIsolatedCodexAppServerArgs({});
  expect(args.includes('windows.sandbox="mxc"')).toBe(process.platform === "win32");
  expect(args.join("\n")).toContain('\":root\"=\"none\"');
  expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(createIsolatedCodexAppServerArgs({ PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "1" })).not.toContain('windows.sandbox="mxc"');
});

it.runIf(process.platform === "win32" && process.env.PAPERCLIP_LIVE_WINDOWS_MXC === "1")(
  "runs the real Windows sandbox, writes inside the workspace and denies an outside read",
  () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "paperclip-mxc-live-")));
    const home = join(root, "provider"), cwd = join(root, "workspace");
    try {
      mkdirSync(home); mkdirSync(cwd);
      writeFileSync(join(root, "private.txt"), "private fixture");
      const command = resolveCodexCommand();
      const environment = createSanitizedCodexEnvironment({ ...process.env, HOME: home, CODEX_HOME: home, NODE_OPTIONS: "", NODE_PATH: "", PAPERCLIP_RUNNER_NETWORK_ACCESS: "enabled" });
      expect(environment.SystemDrive).toBeTruthy();
      const args = createIsolatedCodexAppServerArgs(environment, codexExecutableReadOnlyRoots(environment, command)).slice(0, -1);
      const script = 'const fs=require("fs");fs.writeFileSync("inside.txt","ok");let denied=false;try{fs.readFileSync("../private.txt")}catch{denied=true}if(!denied)throw Error("outside read was permitted");console.log("MXC_CONFINED")';
      const output = execFileSync(command, [...args, "sandbox", "--permission-profile", "paperclip-runner-workspace-only", "--", process.execPath, "-e", script],
        { cwd, env: environment, windowsHide: true, timeout: 30_000, encoding: "utf8", maxBuffer: 64 * 1024 });
      expect(output.trim()).toBe("MXC_CONFINED");
      expect(readFileSync(join(cwd, "inside.txt"), "utf8")).toBe("ok");
      expect(readFileSync(join(root, "private.txt"), "utf8")).toBe("private fixture");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000,
);
