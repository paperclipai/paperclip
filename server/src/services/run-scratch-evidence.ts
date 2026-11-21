import path from "node:path";
import { resolveWalkerOps, openVerifiedDirectory } from "./run-scratch-walker.js";

export const HEARTBEAT_RUN_SCRATCH_MARKER = ".paperclip-run-scratch.json";
export const RUN_SCRATCH_QUARANTINE_RECEIPT = ".paperclip-quarantine.json";

export interface HeartbeatRunScratchMetadata {
  version: 1;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  createdAt: string;
}

/** Attestations are sandbox-writable: never follow a name or read an unbounded file. */
async function readScratchEvidenceFile(p: string): Promise<string> {
  const ops = resolveWalkerOps();
  const parent = await openVerifiedDirectory(path.dirname(p), ops);
  if (!parent) throw new Error("scratch evidence directory cannot be verified");
  try {
    const name = path.basename(p);
    const stats = await ops.lstatEntry(parent.fd, name);
    return await ops.readEntryRegular(parent.fd, name, stats);
  } finally { await ops.closeDir(parent.fd); }
}

export async function readMarker(markerPath: string): Promise<HeartbeatRunScratchMetadata | null> {
  try {
    const parsed = JSON.parse(await readScratchEvidenceFile(markerPath)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    if (
      rec.version !== 1 ||
      typeof rec.companyId !== "string" ||
      typeof rec.agentId !== "string" ||
      typeof rec.runId !== "string" ||
      typeof rec.createdAt !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      companyId: rec.companyId,
      agentId: rec.agentId,
      runId: rec.runId,
      issueId: typeof rec.issueId === "string" ? rec.issueId : null,
      issueIdentifier: typeof rec.issueIdentifier === "string" ? rec.issueIdentifier : null,
      createdAt: rec.createdAt,
    };
  } catch {
    return null;
  }
}

export interface RunScratchQuarantineReceipt {
  version: 1;
  /** What kind of tree was quarantined: a marked run scratch dir or a managed home. */
  kind: "scratch" | "home";
  companyId: string | null;
  agentId: string | null;
  runId: string | null;
  /** Name the tree carried before the quarantine rename. */
  originalName: string;
  createdAt: string;
}

/**
 * Evidence that this runner's own cleanup code quarantined a `-rm-` remnant:
 * the receipt is written — exclusively, through the verified directory fd —
 * right before the quarantine rename, after the ownership, liveness and
 * retention gates of that removal had passed. Retries and sweeps re-derive
 * those gates from the receipt instead of trusting the remnant's name.
 */
export async function readQuarantineReceipt(p: string): Promise<RunScratchQuarantineReceipt | null> {
  try {
    return parseQuarantineReceipt(await readScratchEvidenceFile(p));
  } catch {
    return null;
  }
}

export function parseQuarantineReceipt(data: string): RunScratchQuarantineReceipt | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    if (
      rec.version !== 1 ||
      (rec.kind !== "scratch" && rec.kind !== "home") ||
      typeof rec.originalName !== "string" ||
      typeof rec.createdAt !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      kind: rec.kind,
      companyId: typeof rec.companyId === "string" ? rec.companyId : null,
      agentId: typeof rec.agentId === "string" ? rec.agentId : null,
      runId: typeof rec.runId === "string" ? rec.runId : null,
      originalName: rec.originalName,
      createdAt: rec.createdAt,
    };
  } catch {
    return null;
  }
}

