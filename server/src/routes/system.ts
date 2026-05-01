/**
 * System-level routes — shut down and restart the running paperclip server
 * from the Plugin Manager / Settings UI instead of forcing operators to drop
 * to the launcher scripts in `~/.paperclip/launchers/`.
 *
 * Design notes
 * ============
 *
 * **Shutdown** is straightforward: send SIGTERM to ourselves so the existing
 * graceful-shutdown handler (in server/src/index.ts) runs. That stops the
 * worker manager, closes the embedded postgres if we own it, flushes
 * telemetry, and exits cleanly.
 *
 * **Restart** is harder: a Node process can't restart itself directly because
 * the process holding the listen port has to release it before a fresh server
 * can bind. We use a detached "trampoline" — spawn a small helper that
 * survives our exit, waits for the port to free, then re-launches paperclip.
 *
 *   Preferred trampoline: `~/.paperclip/launchers/launch-paperclip.bat`
 *   (Windows operators usually have one; matches the console-window UX they
 *   already know.)
 *
 *   Fallback: re-exec the same node binary + argv that started us. Works on
 *   any platform but doesn't reattach to the launcher's console window.
 *
 * Both routes require instance-admin authority — these are destructive
 * actions for everyone connected to this paperclip instance.
 */
import { Router } from "express";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertInstanceAdmin } from "./authz.js";

const SHUTDOWN_DELAY_MS = 250;
const RESTART_TRAMPOLINE_DELAY_MS = 2000;

function launcherScriptPath(): string {
  // Convention: launch-paperclip.bat sits in ~/.paperclip/launchers/.
  // Falls back to nothing if missing.
  return path.join(os.homedir(), ".paperclip", "launchers", "launch-paperclip.bat");
}

function spawnRestartTrampoline(): void {
  // The trampoline waits for the parent (this process) to exit and release
  // the listen port, then launches a fresh server. Always uses a Node
  // process to host the delay + spawn — that lets us avoid the cmd.exe
  // quoting hell that `cmd /c "timeout & start "" "<bat>""` runs into when
  // a path contains nested quotes.
  const launcher = launcherScriptPath();
  const useLauncher = process.platform === "win32" && existsSync(launcher);

  let spawnCmd: string;
  let spawnArgs: string[];
  let spawnOpts: Record<string, unknown>;

  if (useLauncher) {
    // Open the launcher .bat in a brand-new console window. On Windows,
    // `cmd /c start "" "<bat>"` opens the bat in its own window and lets
    // the spawned cmd die. We pass the path as a separate argv element
    // (not interpolated into a command string) so quoting can't bite.
    spawnCmd = "cmd.exe";
    spawnArgs = ["/c", "start", "", launcher];
    spawnOpts = {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      // Run the bat from the user's home dir so its `cd /d "%PAPERCLIP_SRC%"`
      // is unambiguous regardless of where this server's cwd happened to be.
      cwd: os.homedir(),
    };
  } else {
    // Cross-platform fallback: re-exec the same node binary + flags + script
    // + args. No new console window — useful for headless deploys.
    spawnCmd = process.execPath;
    spawnArgs = [...process.execArgv, ...process.argv.slice(1)];
    spawnOpts = {
      cwd: process.cwd(),
      env: { ...process.env },
      detached: true,
      stdio: "inherit",
    };
  }

  // Host the wait inside a Node process so port-release timing is robust
  // and we don't depend on Windows `timeout` semantics. The trampoline
  // sleeps RESTART_TRAMPOLINE_DELAY_MS and then spawns the actual launcher.
  const trampolineSrc = `
    setTimeout(() => {
      const { spawn } = require('node:child_process');
      const child = spawn(
        ${JSON.stringify(spawnCmd)},
        ${JSON.stringify(spawnArgs)},
        ${JSON.stringify(spawnOpts)},
      );
      child.unref();
    }, ${RESTART_TRAMPOLINE_DELAY_MS});
  `;

  const child = spawn(process.execPath, ["-e", trampolineSrc], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function killSelfGracefully(): void {
  // SIGTERM triggers the shutdown handler in server/src/index.ts.
  // On Windows, SIGTERM still routes through Node's signal emulation and
  // fires the same once("SIGTERM") listener.
  setTimeout(() => {
    process.kill(process.pid, "SIGTERM");
  }, SHUTDOWN_DELAY_MS);
}

export function systemRoutes() {
  const router = Router();

  /**
   * POST /api/system/shutdown
   *
   * Stop the paperclip server. After the response is sent, SIGTERM is sent
   * to ourselves so the graceful shutdown handler runs.
   */
  router.post("/system/shutdown", (req, res) => {
    assertInstanceAdmin(req);
    res.json({
      ok: true,
      action: "shutdown",
      message: "Paperclip is shutting down. The server will exit in a moment.",
    });
    killSelfGracefully();
  });

  /**
   * POST /api/system/restart
   *
   * Restart the paperclip server. Spawns a detached trampoline that will
   * launch a fresh server after the current one exits, then SIGTERMs
   * ourselves so the graceful shutdown handler runs and frees the port.
   */
  router.post("/system/restart", (req, res) => {
    assertInstanceAdmin(req);

    let trampolineErr: string | null = null;
    try {
      spawnRestartTrampoline();
    } catch (err) {
      trampolineErr = err instanceof Error ? err.message : String(err);
    }

    if (trampolineErr) {
      res.status(500).json({
        ok: false,
        action: "restart",
        error: `Failed to schedule restart: ${trampolineErr}. Server is still running.`,
      });
      return;
    }

    res.json({
      ok: true,
      action: "restart",
      message:
        "Paperclip is restarting. The server will exit and a fresh instance will boot in a few seconds.",
      usedLauncher:
        process.platform === "win32" && existsSync(launcherScriptPath()),
    });
    killSelfGracefully();
  });

  return router;
}
