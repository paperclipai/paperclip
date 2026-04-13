import type { Db } from "@paperclipai/db";
import { issueAttachments } from "@paperclipai/db";
import type { StorageService } from "../../storage/types.js";
import { assetService } from "../index.js";
import { runSshCommand, type SshRunInput, type SshRunResult } from "./ssh-runner.js";

export interface UploadTraceInput {
  companyId: string;
  issueId: string;
  traceDir: string; // absolute path on the browser-test VPS
  createdByAgentId?: string | null;
  /** Override for tests */
  ssh?: (input: SshRunInput) => Promise<SshRunResult>;
}

export interface UploadTraceResult {
  assetId: string;
  byteSize: number;
}

export interface TraceUploader {
  upload(input: UploadTraceInput): Promise<UploadTraceResult>;
}

/**
 * Pulls a Playwright trace directory off the remote browser-test VPS, uploads it to asset storage,
 * and records an issue_attachments row so the trace is visible in the issue UI.
 *
 * The trace is tarred + gzipped on the remote side and streamed to stdout; we capture stdout as a
 * Buffer via the ssh runner's existing maxBuffer setting (32 MB). Traces typically run 1-5 MB.
 */
export function traceUploader(db: Db, storage: StorageService): TraceUploader {
  const assets = assetService(db);
  return {
    async upload(input) {
      const ssh = input.ssh ?? runSshCommand;
      const host = process.env.BROWSER_TEST_HOST;
      const user = process.env.BROWSER_TEST_USER ?? "root";
      const keyPath = process.env.BROWSER_TEST_SSH_KEY;
      if (!host || !keyPath) {
        throw new Error("BROWSER_TEST_HOST or BROWSER_TEST_SSH_KEY not configured");
      }

      const tarCommand = `tar -czf - -C ${input.traceDir} . 2>/dev/null | base64 -w 0`;

      const sshResult = await ssh({
        host,
        user,
        keyPath,
        command: tarCommand,
        timeoutMs: 60_000,
      });

      if (sshResult.exitCode !== 0) {
        throw new Error(
          `failed to package trace from ${input.traceDir}: exit ${sshResult.exitCode}, stderr: ${sshResult.stderr.slice(0, 500)}`,
        );
      }

      const tarBuffer = Buffer.from(sshResult.stdout.trim(), "base64");
      if (tarBuffer.length === 0) {
        throw new Error(`trace bundle is empty at ${input.traceDir}`);
      }

      const originalFilename = `trace-${input.issueId}-${Date.now()}.tar.gz`;
      const stored = await storage.putFile({
        companyId: input.companyId,
        namespace: "assets/verification-traces",
        originalFilename,
        contentType: "application/gzip",
        body: tarBuffer,
      });

      const asset = await assets.create(input.companyId, {
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: input.createdByAgentId ?? null,
        createdByUserId: null,
      });

      await db
        .insert(issueAttachments)
        .values({
          companyId: input.companyId,
          issueId: input.issueId,
          assetId: asset.id,
        })
        .onConflictDoNothing();

      return { assetId: asset.id, byteSize: stored.byteSize };
    },
  };
}
