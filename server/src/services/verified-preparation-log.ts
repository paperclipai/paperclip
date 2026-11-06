import { createHash } from "node:crypto";
import { isUuidLike } from "@paperclipai/shared";
import { getRunLogStore } from "./run-log-store.js";

const MAX_BYTES = 2048;
const READ_TIMEOUT_MS = 2000;
type PreparationLog = {
  companyId: string; agentId: string; id: string;
  contextSnapshot: Record<string, unknown> | null;
  logStore: string | null; logRef: string | null; logBytes: number | null; logSha256: string | null;
  logCompressed: boolean; stdoutExcerpt: string | null; stderrExcerpt: string | null;
  lastOutputAt: Date | null; lastOutputSeq: number; lastOutputStream: string | null; lastOutputBytes: number | null;
};

export async function hasVerifiedPreparationLog(run: PreparationLog): Promise<boolean> {
  const versions = run.contextSnapshot?.skillVersions;
  if (run.contextSnapshot?.skillSelectionSnapshot !== true || !versions || typeof versions !== "object"
    || Array.isArray(versions) || Object.keys(versions).length === 0
    || run.logStore !== "s3_segments" || run.logRef !== `${run.companyId}/${run.agentId}/${run.id}`
    || !Number.isSafeInteger(run.logBytes) || run.logBytes! <= 0 || run.logBytes! > MAX_BYTES
    || !run.logSha256 || !/^[a-f0-9]{64}$/.test(run.logSha256) || run.logCompressed
    || run.lastOutputSeq !== 1 || run.lastOutputStream !== "stdout" || !run.lastOutputAt
    || run.lastOutputBytes !== run.logBytes || run.stderrExcerpt !== "") return false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = getRunLogStore().read({ store: "s3_segments", logRef: run.logRef },
      { offset: 0, limitBytes: MAX_BYTES + 1, signal: controller.signal });
    const result = await Promise.race([read, new Promise<null>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, READ_TIMEOUT_MS);
      timer.unref();
    })]);
    if (!result || result.nextOffset !== undefined || Buffer.byteLength(result.content) !== run.logBytes
      || createHash("sha256").update(result.content).digest("hex") !== run.logSha256) return false;
    const record = JSON.parse(result.content);
    if (!record || Array.isArray(record) || typeof record !== "object"
      || Object.keys(record).some(key => !["ts", "attemptId", "stream", "chunk", "seq"].includes(key))
      || record.ts !== run.lastOutputAt.toISOString() || !isUuidLike(record.attemptId)
      || record.seq !== 1 || record.stream !== "stdout" || typeof record.chunk !== "string"
      || record.chunk !== run.stdoutExcerpt) return false;
    const prefix = "[paperclip] Enabled run-scoped skills from issue mentions: ";
    if (!record.chunk.startsWith(prefix) || !record.chunk.endsWith("\n")) return false;
    const keys = record.chunk.slice(prefix.length, -1).split(", ");
    return keys.length > 0 && new Set(keys).size === keys.length
      && keys.every(key => {
        const version = (versions as Record<string, unknown>)[key];
        return key.length > 0 && Object.hasOwn(versions, key) && !/[\r\n]/.test(key)
          && typeof version === "string" && isUuidLike(version);
      });
  } catch { return false; }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}
