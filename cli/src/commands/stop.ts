import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { describeLocalInstancePaths, resolvePaperclipInstanceId } from "../config/home.js";

interface StopOptions {
  instance?: string;
  force?: boolean;
}

const GRACEFUL_WAIT_MS = 10_000;
const POLL_INTERVAL_MS = 200;

export async function stopCommand(opts: StopOptions): Promise<void> {
  const instanceId = resolvePaperclipInstanceId(opts.instance);
  const paths = describeLocalInstancePaths(instanceId);
  const pidFile = path.join(paths.instanceRoot, "server.pid");

  p.intro(pc.bgCyan(pc.black(" paperclipai stop ")));
  p.log.message(pc.dim(`Instance: ${instanceId}`));

  if (!fs.existsSync(pidFile)) {
    p.log.warn(`No PID file found at ${pidFile}. Is the server running?`);
    process.exit(1);
  }

  const rawPid = fs.readFileSync(pidFile, "utf-8").trim();
  const pid = parseInt(rawPid, 10);

  if (isNaN(pid) || pid <= 0) {
    p.log.error(`PID file contains invalid value: ${JSON.stringify(rawPid)}`);
    fs.rmSync(pidFile);
    process.exit(1);
  }

  if (!isProcessAlive(pid)) {
    p.log.warn(`Process ${pid} is not running. Removing stale PID file.`);
    fs.rmSync(pidFile);
    process.exit(0);
  }

  p.log.step(`Sending SIGTERM to process ${pid}...`);

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ESRCH") {
      p.log.warn(`Process ${pid} already exited. Removing stale PID file.`);
      fs.rmSync(pidFile);
      process.exit(0);
    }
    throw err;
  }

  const spinner = p.spinner();
  spinner.start(`Waiting for process ${pid} to exit (up to ${GRACEFUL_WAIT_MS / 1000}s)...`);

  const deadline = Date.now() + GRACEFUL_WAIT_MS;
  let exited = false;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (!isProcessAlive(pid)) {
      exited = true;
      break;
    }
  }

  if (exited) {
    spinner.stop(`Process ${pid} exited cleanly.`);
    if (fs.existsSync(pidFile)) {
      fs.rmSync(pidFile);
    }
    p.outro(pc.green("Paperclip server stopped."));
  } else {
    spinner.stop(pc.yellow(`Process ${pid} did not exit within ${GRACEFUL_WAIT_MS / 1000}s.`));
    p.log.warn(
      `The server is still running. You can force-kill it with: kill -9 ${pid}`,
    );
    process.exit(1);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    return code !== "ESRCH";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
