import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getStorageService } from "../storage/index.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceRevisionManifest {
  revisionId: string;
  issueId: string;
  companyId: string;
  parentRevisionId: string | null;
  overlayRef: string;
  patchRef: string | null;
  sizeBytesCompressed: number;
  fileCount: number;
  createdByRunId: string;
  createdAt: string;
}

export async function composeWorkspaceRevision(input: {
  companyId: string;
  issueId: string;
  revisionId: string;
  parentRevisionId: string | null;
  createdByRunId: string;
  workspaceDir: string;
  generatePatch: boolean;
}): Promise<WorkspaceRevisionManifest> {
  const storage = getStorageService();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-"));
  try {
    const tarballPath = path.join(tmpDir, "overlay.tar.gz");
    await execFileAsync("tar", ["-czf", tarballPath, "-C", input.workspaceDir, "."]);
    const tarball = await fs.readFile(tarballPath);
    const overlayRef = `${input.companyId}/issues/${input.issueId}/workspaces/${input.revisionId}/overlay.tar.gz`;
    await storage.putObjectDirect({
      companyId: input.companyId,
      objectKey: overlayRef,
      body: tarball,
      contentType: "application/gzip",
    });

    // Count files
    const { stdout: lsOut } = await execFileAsync("tar", ["-tzf", tarballPath]).catch(() => ({ stdout: "" }));
    const fileCount = lsOut.split("\n").filter((l) => l && !l.endsWith("/")).length;

    let patchRef: string | null = null;
    if (input.generatePatch) {
      const { stdout: diffOut } = await execFileAsync("git", ["diff", "HEAD"], { cwd: input.workspaceDir }).catch(
        () => ({ stdout: "" }),
      );
      if (diffOut) {
        const diffBuf = Buffer.from(diffOut, "utf8");
        patchRef = `${input.companyId}/issues/${input.issueId}/workspaces/${input.revisionId}/patch.diff`;
        await storage.putObjectDirect({
          companyId: input.companyId,
          objectKey: patchRef,
          body: diffBuf,
          contentType: "text/plain",
        });
      }
    }

    return {
      revisionId: input.revisionId,
      issueId: input.issueId,
      companyId: input.companyId,
      parentRevisionId: input.parentRevisionId,
      overlayRef,
      patchRef,
      sizeBytesCompressed: tarball.length,
      fileCount,
      createdByRunId: input.createdByRunId,
      createdAt: new Date().toISOString(),
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export async function hydrateWorkspaceRevision(input: {
  companyId: string;
  issueId: string;
  revisionId: string;
  overlayRef: string;
  targetDir: string;
}): Promise<{ fileCount: number; bytes: number }> {
  const storage = getStorageService();
  const result = await storage.getObject(input.companyId, input.overlayRef);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    result.stream.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    result.stream.on("error", reject);
    result.stream.on("end", resolve);
  });
  const tarball = Buffer.concat(chunks);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hydrate-"));
  try {
    const tarballPath = path.join(tmpDir, "overlay.tar.gz");
    await fs.writeFile(tarballPath, tarball);
    await fs.mkdir(input.targetDir, { recursive: true });
    await execFileAsync("tar", ["-xzf", tarballPath, "-C", input.targetDir]);
    const { stdout: lsOut } = await execFileAsync("tar", ["-tzf", tarballPath]).catch(() => ({ stdout: "" }));
    const fileCount = lsOut.split("\n").filter((l) => l && !l.endsWith("/")).length;
    return { fileCount, bytes: tarball.length };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

const RUN_BUFFER_TTL_MS = 30 * 60 * 1000; // 30 minutes

type RunBufferEntry = { ts: string; stream: "stdout" | "stderr"; chunk: string };
type RunBuffer = { entries: RunBufferEntry[]; lastAccessedAt: number };

// In-memory buffers keyed by companyId::runId
const runBuffers = new Map<string, RunBuffer>();

function runKey(companyId: string, runId: string) {
  return `${companyId}::${runId}`;
}

function evictStaleRunBuffers() {
  const cutoff = Date.now() - RUN_BUFFER_TTL_MS;
  for (const [key, buf] of runBuffers) {
    if (buf.lastAccessedAt < cutoff) runBuffers.delete(key);
  }
}

export async function appendRunLogChunk(input: {
  companyId: string;
  runId: string;
  chunk: string;
  stream: "stdout" | "stderr";
  ts: string;
}): Promise<void> {
  evictStaleRunBuffers();
  const key = runKey(input.companyId, input.runId);
  let buf = runBuffers.get(key);
  if (!buf) {
    buf = { entries: [], lastAccessedAt: Date.now() };
    runBuffers.set(key, buf);
  }
  buf.lastAccessedAt = Date.now();
  buf.entries.push({ ts: input.ts, stream: input.stream, chunk: input.chunk });
}

export async function finalizeRunArtifacts(input: {
  companyId: string;
  runId: string;
  issueId: string;
}): Promise<{
  stdoutRef: string;
  stderrRef: string;
  summaryRef: string | null;
  bytes: number;
  sha256: string;
}> {
  const storage = getStorageService();
  const key = runKey(input.companyId, input.runId);
  const buf = runBuffers.get(key)?.entries ?? [];
  runBuffers.delete(key);

  const stdoutLines = buf.filter((e) => e.stream === "stdout");
  const stderrLines = buf.filter((e) => e.stream === "stderr");

  function toNdjson(lines: typeof buf) {
    return Buffer.from(lines.map((e) => JSON.stringify(e)).join("\n") + (lines.length ? "\n" : ""), "utf8");
  }

  const stdoutBody = toNdjson(stdoutLines);
  const stderrBody = toNdjson(stderrLines);
  const allBody = toNdjson(buf);

  const stdoutRef = `${input.companyId}/runs/${input.runId}/stdout.ndjson`;
  const stderrRef = `${input.companyId}/runs/${input.runId}/stderr.ndjson`;

  await storage.putObjectDirect({
    companyId: input.companyId,
    objectKey: stdoutRef,
    body: stdoutBody,
    contentType: "application/x-ndjson",
  });
  await storage.putObjectDirect({
    companyId: input.companyId,
    objectKey: stderrRef,
    body: stderrBody,
    contentType: "application/x-ndjson",
  });

  const sha256 = createHash("sha256").update(allBody).digest("hex");
  return {
    stdoutRef,
    stderrRef,
    summaryRef: null,
    bytes: allBody.length,
    sha256,
  };
}
