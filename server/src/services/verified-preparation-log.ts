import { createHash } from "node:crypto";
import { isUuidLike } from "@paperclipai/shared";
import { getRunLogStore } from "./run-log-store.js";

const MAX_BYTES = 2048;
const MAX_RECORDS = 4;
const READ_TIMEOUT_MS = 2000;
const SKILLS_PREFIX = "[paperclip] Enabled run-scoped skills from issue mentions: ";
const HOST_WORKSPACE_NOTICES = [
  /^\[paperclip\] Execution workspace reuse freshness action "[a-z_]+" because [^\r\n]+\.\n$/,
  /^\[paperclip\] Skipping saved session resume (?:for task "[^"\r\n]+" )?because [^\r\n]+\.\n$/,
];
type PreparationLog = {
  companyId: string; agentId: string; id: string;
  contextSnapshot: Record<string, unknown> | null;
  logStore: string | null; logRef: string | null; logBytes: number | null; logSha256: string | null;
  logCompressed: boolean; stdoutExcerpt: string | null; stderrExcerpt: string | null;
  lastOutputAt: Date | null; lastOutputSeq: number; lastOutputStream: string | null; lastOutputBytes: number | null;
};

function isMentionedSkillsNotice(chunk: string, context: Record<string, unknown> | null) {
  const versions = context?.skillVersions;
  if (context?.skillSelectionSnapshot !== true || !versions || typeof versions !== "object"
    || Array.isArray(versions) || Object.keys(versions).length === 0
    || !chunk.startsWith(SKILLS_PREFIX) || !chunk.endsWith("\n")) return false;
  const keys = chunk.slice(SKILLS_PREFIX.length, -1).split(", ");
  return keys.length > 0 && new Set(keys).size === keys.length
    && keys.every(key => {
      const version = (versions as Record<string, unknown>)[key];
      return key.length > 0 && Object.hasOwn(versions, key) && !/[\r\n]/.test(key)
        && typeof version === "string" && isUuidLike(version);
    });
}

export async function hasVerifiedPreparationLog(run: PreparationLog): Promise<boolean> {
  if (run.logStore !== "s3_segments" || run.logRef !== `${run.companyId}/${run.agentId}/${run.id}`
    || !Number.isSafeInteger(run.logBytes) || run.logBytes! <= 0 || run.logBytes! > MAX_BYTES
    || !run.logSha256 || !/^[a-f0-9]{64}$/.test(run.logSha256) || run.logCompressed
    || !Number.isSafeInteger(run.lastOutputSeq) || run.lastOutputSeq < 1 || run.lastOutputSeq > MAX_RECORDS
    || run.lastOutputStream !== "stdout" || !run.lastOutputAt
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
      || createHash("sha256").update(result.content).digest("hex") !== run.logSha256
      || !result.content.endsWith("\n")) return false;
    const records = result.content.slice(0, -1).split("\n").map(line => JSON.parse(line) as Record<string, unknown> | null);
    if (records.length !== run.lastOutputSeq) return false;
    const attemptId = records[0]?.attemptId;
    let excerpt = "";
    for (const [index, record] of records.entries()) {
      if (!record || Array.isArray(record) || typeof record !== "object"
        || Object.keys(record).some(key => !["ts", "attemptId", "stream", "chunk", "seq"].includes(key))
        || typeof record.ts !== "string" || !Number.isFinite(Date.parse(record.ts))
        || typeof record.attemptId !== "string" || !isUuidLike(record.attemptId) || record.attemptId !== attemptId
        || record.seq !== index + 1 || record.stream !== "stdout" || typeof record.chunk !== "string") return false;
      const chunk = record.chunk;
      const notice = index === 0 && isMentionedSkillsNotice(chunk, run.contextSnapshot)
        || HOST_WORKSPACE_NOTICES.some(pattern => pattern.test(chunk));
      if (!notice) return false;
      excerpt += chunk;
    }
    return records.at(-1)!.ts === run.lastOutputAt.toISOString() && excerpt === run.stdoutExcerpt;
  } catch { return false; }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}
