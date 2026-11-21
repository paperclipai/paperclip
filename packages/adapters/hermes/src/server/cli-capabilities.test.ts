/**
 * Unit coverage for `hermes chat --help` capability probing.
 */

import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  buildProbeEnv,
  buildWindowsCmdProbeTarget,
  buildWindowsTaskkillSpec,
  hasQueryFileFlagInHelp,
  hermesSupportsQueryFile,
} from "./cli-capabilities.js";

describe("hasQueryFileFlagInHelp", () => {
  test("matches supported CLI usage and option forms", () => {
    expect(hasQueryFileFlagInHelp("usage: hermes chat [-h] [-q QUERY | --query-file PATH]")).toBe(true);
    expect(hasQueryFileFlagInHelp("  --query-file PATH  Read query from file")).toBe(true);
    expect(hasQueryFileFlagInHelp("  --query-file=PATH  Read query from file")).toBe(true);
    expect(hasQueryFileFlagInHelp("[--query-file]")).toBe(true);
  });

  test("rejects prose and unrelated or negated flags", () => {
    expect(hasQueryFileFlagInHelp("Pass a query file path on stdin.")).toBe(false);
    expect(hasQueryFileFlagInHelp("  --no-query-file  Disable file query")).toBe(false);
    expect(hasQueryFileFlagInHelp("  --query-file-encoding UTF8")).toBe(false);
  });
});

describe("buildProbeEnv", () => {
  test("strips HERMES_EPHEMERAL_SYSTEM_PROMPT and PAPERCLIP_API_KEY", () => {
    const probeEnv = buildProbeEnv({
      PATH: "/usr/bin",
      HERMES_EPHEMERAL_SYSTEM_PROMPT: "x".repeat(200_000),
      PAPERCLIP_API_KEY: "secret-token",
      KEEP_ME: "yes",
    });

    expect(probeEnv.HERMES_EPHEMERAL_SYSTEM_PROMPT).toBeUndefined();
    expect(probeEnv.PAPERCLIP_API_KEY).toBeUndefined();
    expect(probeEnv.KEEP_ME).toBe("yes");
    expect(probeEnv.PATH).toBe("/usr/bin");
  });
});

describe("Windows cmd/taskkill helpers", () => {
  test("wraps .cmd/.bat targets through cmd.exe /d /s /c", () => {
    const target = buildWindowsCmdProbeTarget(
      "C:\\Program Files\\Hermes\\hermes.cmd",
      ["chat", "--help"],
      { SystemRoot: "C:\\Windows" },
    );

    expect(target).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", '"C:\\Program Files\\Hermes\\hermes.cmd" chat --help'],
    });
  });

  test("builds a process-tree taskkill command with /T /F", () => {
    expect(buildWindowsTaskkillSpec(4321, { SystemRoot: "D:\\Win" })).toEqual({
      command: "D:\\Win\\System32\\taskkill.exe",
      args: ["/PID", "4321", "/T", "/F"],
    });
  });
});

describe("hermesSupportsQueryFile", () => {
  let tempDir = "";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-cli-cap-test-"));
  });

  afterAll(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  async function writeProbeScript(name: string, body: string): Promise<string> {
    const scriptPath = path.join(tempDir, name);
    await writeFile(scriptPath, `#!/usr/bin/env node\n${body}`, "utf8");
    await chmod(scriptPath, 0o755);
    return scriptPath;
  }

  test("returns true when help advertises --query-file and omits sensitive/oversized env", async () => {
    const capturePath = path.join(tempDir, "probe-env.json");
    const cmd = await writeProbeScript(
      "supported.mjs",
      `
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  hasPrompt: "HERMES_EPHEMERAL_SYSTEM_PROMPT" in process.env,
  hasApiKey: "PAPERCLIP_API_KEY" in process.env,
  kept: process.env.KEEP_PROBE_VAR ?? null,
}));
process.stdout.write("usage: hermes chat [-h] [-q QUERY | --query-file PATH]\\n");
`,
    );

    const supported = await hermesSupportsQueryFile({
      command: cmd,
      cwd: tempDir,
      env: {
        PATH: process.env.PATH ?? "",
        HERMES_EPHEMERAL_SYSTEM_PROMPT: "large overlay",
        PAPERCLIP_API_KEY: "secret",
        KEEP_PROBE_VAR: "ok",
      },
    });

    expect(supported).toBe(true);
    const envReport = JSON.parse(await readFile(capturePath, "utf8"));
    expect(envReport).toEqual({
      hasPrompt: false,
      hasApiKey: false,
      kept: "ok",
    });
  });

  test("returns false when help exits 0 without --query-file", async () => {
    const cmd = await writeProbeScript(
      "unsupported.mjs",
      'process.stdout.write("usage: hermes chat [-h] [-q QUERY]\\n");',
    );

    await expect(
      hermesSupportsQueryFile({ command: cmd, cwd: tempDir, env: { PATH: process.env.PATH ?? "" } }),
    ).resolves.toBe(false);
  });

  test("returns null when binary is missing, exits non-zero, times out, or is aborted", async () => {
    const failing = await writeProbeScript(
      "failing.mjs",
      'process.stderr.write("broken install\\n"); process.exit(2);',
    );
    const slow = await writeProbeScript(
      "slow.mjs",
      "setTimeout(() => {}, 10_000);",
    );

    await expect(
      hermesSupportsQueryFile({
        command: path.join(tempDir, "does-not-exist"),
        cwd: tempDir,
        env: { PATH: process.env.PATH ?? "" },
      }),
    ).resolves.toBeNull();

    await expect(
      hermesSupportsQueryFile({
        command: failing,
        cwd: tempDir,
        env: { PATH: process.env.PATH ?? "" },
      }),
    ).resolves.toBeNull();

    await expect(
      hermesSupportsQueryFile({
        command: slow,
        cwd: tempDir,
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 1000,
      }),
    ).resolves.toBeNull();

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      hermesSupportsQueryFile({
        command: failing,
        cwd: tempDir,
        env: { PATH: process.env.PATH ?? "" },
        signal: aborted.signal,
      }),
    ).resolves.toBeNull();

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(
      hermesSupportsQueryFile({
        command: slow,
        cwd: tempDir,
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 10_000,
        signal: controller.signal,
      }),
    ).resolves.toBeNull();
  });

  test.skipIf(process.platform === "win32")(
    "stops a spawned descendant tree before resolving null on cancellation",
    async () => {
      const childPidFile = path.join(tempDir, "descendant.pid");
      const launcher = await writeProbeScript(
        "spawner.mjs",
        `
import { spawn } from "node:child_process";
import fs from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "inherit",
});
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`,
      );

      const isPidAlive = async (pid: number): Promise<boolean> => {
        try {
          process.kill(pid, 0);
        } catch {
          return false;
        }
        try {
          const stat = await readFile(`/proc/${pid}/stat`, "utf8");
          const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
          return state !== "Z" && state !== "X";
        } catch {
          try {
            const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
              encoding: "utf8",
            }).trim();
            return state.length > 0 && !state.startsWith("Z");
          } catch {
            return false;
          }
        }
      };

      const controller = new AbortController();
      const probePromise = hermesSupportsQueryFile({
        command: launcher,
        cwd: tempDir,
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 10_000,
        signal: controller.signal,
      });

      // Wait until the wrapper actually spawns its grandchild before aborting.
      let childPid = 0;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          const raw = await readFile(childPidFile, "utf8");
          const parsed = Number(raw.trim());
          if (Number.isInteger(parsed) && parsed > 0) {
            childPid = parsed;
            break;
          }
        } catch {
          // Not written yet.
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(childPid).toBeGreaterThan(0);

      controller.abort();
      await expect(probePromise).resolves.toBeNull();

      // Descendant process must already be terminated (gone or defunct) when the probe resolves.
      await expect(isPidAlive(childPid)).resolves.toBe(false);
    },
  );
});
