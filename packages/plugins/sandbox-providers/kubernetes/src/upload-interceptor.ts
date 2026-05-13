/**
 * Fast-upload interceptor for the chunked-shell file transfer protocol used by
 * `@paperclipai/adapter-utils` command-managed runtimes.
 *
 * The normal path writes files through many shell execs:
 *   1. mkdir/rm/touch `<target>.paperclip-upload.b64`
 *   2. append many base64 chunks with printf
 *   3. base64-decode the temp file into the final target
 *
 * On Kubernetes each exec is a new WebSocket round trip. This state machine
 * recognizes that exact protocol, buffers the base64 chunks in the plugin
 * worker, and lets the caller flush the final payload through one exec.
 * Pattern drift or missing state falls through to the original exec path.
 */
import { posix as pathPosix } from "node:path";

const INIT_RE =
  /^mkdir -p '([^']+)' && rm -f '([^']+)\.paperclip-upload\.b64' && : > '\2\.paperclip-upload\.b64'$/;
const CHUNK_RE =
  /^printf '%s' '([A-Za-z0-9+/=]+)' >> '([^']+)\.paperclip-upload\.b64'$/;
const FINALIZE_RE =
  /^base64 -d < '([^']+)\.paperclip-upload\.b64' > '\1' && rm -f '\1\.paperclip-upload\.b64'$/;

const MAX_BUFFER_BYTES = 100 * 1024 * 1024;

export interface FastUploadFlush {
  targetPath: string;
  payload: Buffer;
}

export type FastUploadDecision =
  | { action: "ack"; reason: string }
  | { action: "flush"; flush: FastUploadFlush }
  | { action: "error"; message: string }
  | { action: "passthrough"; reason: string };

interface BufferedUpload {
  targetPath: string;
  chunks: string[];
  totalBase64Chars: number;
}

export class FastUploadInterceptor {
  private readonly buffers = new Map<string, BufferedUpload>();

  constructor(private readonly maxBufferBytes = MAX_BUFFER_BYTES) {}

  decide(command: string): FastUploadDecision {
    const initMatch = INIT_RE.exec(command);
    if (initMatch) {
      const dir = initMatch[1];
      const targetPath = initMatch[2];
      if (pathPosix.dirname(targetPath) !== dir) {
        return { action: "passthrough", reason: "init dir/target mismatch" };
      }

      this.buffers.set(`${targetPath}.paperclip-upload.b64`, {
        targetPath,
        chunks: [],
        totalBase64Chars: 0,
      });
      return { action: "ack", reason: `init upload to ${targetPath}` };
    }

    const chunkMatch = CHUNK_RE.exec(command);
    if (chunkMatch) {
      const base64Chunk = chunkMatch[1];
      const targetPath = chunkMatch[2];
      const tempPath = `${targetPath}.paperclip-upload.b64`;
      const upload = this.buffers.get(tempPath);
      if (!upload) {
        return { action: "passthrough", reason: "chunk without prior init" };
      }

      if (upload.totalBase64Chars + base64Chunk.length > (this.maxBufferBytes * 4) / 3) {
        this.buffers.delete(tempPath);
        return {
          action: "error",
          message: `Fast upload buffer cap exceeded for ${upload.targetPath}; retry the upload with a smaller payload.`,
        };
      }

      upload.chunks.push(base64Chunk);
      upload.totalBase64Chars += base64Chunk.length;
      return { action: "ack", reason: `buffered ${base64Chunk.length} base64 chars` };
    }

    const finalizeMatch = FINALIZE_RE.exec(command);
    if (finalizeMatch) {
      const targetPath = finalizeMatch[1];
      const tempPath = `${targetPath}.paperclip-upload.b64`;
      const upload = this.buffers.get(tempPath);
      if (!upload) {
        return { action: "passthrough", reason: "finalize without buffered state" };
      }

      this.buffers.delete(tempPath);
      return {
        action: "flush",
        flush: {
          targetPath: upload.targetPath,
          payload: Buffer.from(upload.chunks.join(""), "base64"),
        },
      };
    }

    return { action: "passthrough", reason: "no upload pattern" };
  }

  reset(): void {
    this.buffers.clear();
  }

  get pendingCount(): number {
    return this.buffers.size;
  }
}
