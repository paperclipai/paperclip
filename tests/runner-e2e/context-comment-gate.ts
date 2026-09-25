import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

const GATE_DIR = "context-comment-gates";
const HELD_FILE = "held";
const RELEASE_FILE = "release";

export function canonicalDocumentIssueId(url: string | undefined, body: unknown, originalUrl?: string): string | undefined {
  const documentIssueId = (originalUrl ?? url)?.match(/\/api\/issues\/([^/]+)\/documents\/[^/?]+(?:\?|$)/)?.[1];
  if (!documentIssueId) return undefined;
  let parsed: any;
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    try { parsed = JSON.parse(body.toString()); } catch { /* fall through to URL */ }
  }
  if (typeof parsed?.issueId === "string" && parsed.issueId.length > 0) return parsed.issueId;
  return documentIssueId;
}

function privateDir(): string {
  const value = process.env.PAPERCLIP_RUNNER_E2E_PRIVATE_DIR?.trim();
  if (!value) throw new Error("PAPERCLIP_RUNNER_E2E_PRIVATE_DIR is required for the context comment gate");
  return value;
}

function issueDir(issueId: string): string {
  return path.join(privateDir(), GATE_DIR, encodeURIComponent(issueId));
}

async function touchExclusive(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    const handle = await open(file, "wx");
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function contextCommentGateSelected(executionIds: readonly string[] = JSON.parse(process.env.PAPERCLIP_RUNNER_E2E_EXECUTION_IDS ?? "[]")): boolean {
  return executionIds.some((id) => id.endsWith(".ordered-comment-continuation"));
}

export async function waitUntilHeld(issueId: string, deadlineAt: number): Promise<void> {
  const file = path.join(issueDir(issueId), HELD_FILE);
  while (Date.now() < deadlineAt) {
    if (await exists(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for context comment gate for issue ${issueId}`);
}

export async function release(issueId: string): Promise<void> {
  await touchExclusive(path.join(issueDir(issueId), RELEASE_FILE));
}

export async function clear(issueId: string): Promise<void> {
  await rm(issueDir(issueId), { recursive: true, force: true });
}

/** Holds an already-committed initial document write until the flow releases it. */
export async function holdCommittedDocumentResponse(issueId: string, deadlineAt = Date.now() + 90_000): Promise<void> {
  const directory = issueDir(issueId);
  await touchExclusive(path.join(directory, HELD_FILE));
  while (Date.now() < deadlineAt) {
    if (await exists(path.join(directory, RELEASE_FILE))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for context comment gate release for issue ${issueId}`);
}
