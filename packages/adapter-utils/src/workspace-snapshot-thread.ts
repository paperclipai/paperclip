import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SerializedDirectorySnapshot } from "./workspace-restore-merge.js";
import type { WorkspacePaths } from "./workspace-manifest.js";

export interface SnapshotThreadRequest {
  rootDir: string;
  exclude?: string[];
  ignoredPaths?: WorkspacePaths;
}

export type SnapshotThreadResponse =
  | { snapshot: SerializedDirectorySnapshot }
  | { error: { name: string; message: string; stack?: string; code?: string; errno?: number; syscall?: string; path?: string } };

let active = 0;
const waiting: Array<() => void> = [];

async function acquire() {
  if (active < 2) { active++; return; }
  await new Promise<void>(resolve => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

export async function runSnapshotThread(request: SnapshotThreadRequest): Promise<{
  snapshot: Extract<SerializedDirectorySnapshot, { version: 2 }>;
  directory: string;
}> {
  await acquire();
  let directory: string | undefined;
  let worker: Worker | undefined;
  let published = false;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-snapshot-thread-"));
    const source = new URL(import.meta.url).pathname.endsWith(".ts");
    const url = new URL(source ? "./workspace-snapshot-thread-worker.ts" : "./workspace-snapshot-thread-worker.js", import.meta.url);
    const options = { workerData: request, env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory } };
    worker = source
      ? new Worker(`import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href)}).then(({tsImport}) => tsImport(${JSON.stringify(url.href)}, ${JSON.stringify(import.meta.url)}));`, { ...options, eval: true })
      : new Worker(url, options);
    const child = worker;
    const response = await new Promise<SnapshotThreadResponse>((resolve, reject) => {
      let result: SnapshotThreadResponse | undefined;
      child.once("message", value => { result = value; });
      child.once("error", reject);
      child.once("exit", code => {
        if (code === 0 && result) resolve(result);
        else reject(new Error(`Workspace snapshot worker exited without a result (${code})`));
      });
    });
    if ("error" in response) {
      const error = Object.assign(new Error(response.error.message), response.error);
      throw error;
    }
    const snapshot = response.snapshot;
    if (snapshot.version !== 2) throw new Error("Workspace snapshot worker returned an in-memory snapshot");
    const relative = path.relative(directory, snapshot.entries.filePath);
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error("Workspace snapshot worker returned an unowned manifest");
    }
    const stat = await fs.lstat(snapshot.entries.filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Workspace snapshot worker manifest is not a regular file");
    published = true;
    return { snapshot, directory };
  } finally {
    try {
      if (worker) await worker.terminate();
      if (directory && !published) await fs.rm(directory, { recursive: true, force: true });
    } finally { release(); }
  }
}
