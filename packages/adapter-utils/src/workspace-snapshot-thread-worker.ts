import { parentPort, workerData } from "node:worker_threads";
import { captureDirectorySnapshot, serializeDirectorySnapshot } from "./workspace-restore-merge.js";
import type { SnapshotThreadRequest, SnapshotThreadResponse } from "./workspace-snapshot-thread.js";

if (!parentPort) throw new Error("Workspace snapshot worker requires a parent");
const port = parentPort;
const request = workerData as SnapshotThreadRequest;

async function run() {
  let response: SnapshotThreadResponse;
  try {
    const snapshot = await captureDirectorySnapshot(request.rootDir, {
      exclude: request.exclude,
      ignoredPaths: request.ignoredPaths,
      diskBacked: true,
    });
    response = { snapshot: serializeDirectorySnapshot(snapshot) };
  } catch (value) {
    const error = value as NodeJS.ErrnoException;
    response = { error: {
      name: error.name ?? "Error", message: error.message ?? String(value), stack: error.stack,
      code: error.code, errno: error.errno, syscall: error.syscall, path: error.path,
    } };
  }
  port.postMessage(response);
  port.close();
}

void run();
