import { execFile as execFileCallback } from "node:child_process";
import { lookup } from "node:dns/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { approvals } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { AutonomyJsonValue } from "@paperclipai/shared";
import type {
  ApprovalAuditInput,
  CommitVerificationInput,
  EvidenceValidatorAdapters,
  FileVerificationInput,
  UrlVerificationInput,
} from "./validators.js";

const execFile = promisify(execFileCallback);
const GIT_VERIFY_TIMEOUT_MS = 3_000;
const URL_VERIFY_TIMEOUT_MS = 5_000;
const MAX_URL_RESPONSE_BYTES = 64 * 1024;

const CONTENT_TYPES_BY_EXT: Record<string, string> = {
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mdx": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
};

function payloadRecord(input: { candidate: { payload?: Record<string, AutonomyJsonValue> | null } }): Record<string, AutonomyJsonValue> | null {
  return input.candidate.payload ?? null;
}

function stringPayload(payload: Record<string, AutonomyJsonValue> | null | undefined, ...keys: string[]): string | null {
  if (!payload) return null;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeFilePath(value: string): string {
  if (value.startsWith("file://")) {
    try {
      return new URL(value).pathname;
    } catch {
      return value;
    }
  }
  return value;
}

function resolveWithinBase(inputPath: string, basePath: string | null): { absolutePath: string | null; reason?: string } {
  const normalizedInput = normalizeFilePath(inputPath);
  const absolutePath = path.isAbsolute(normalizedInput)
    ? path.normalize(normalizedInput)
    : basePath
      ? path.resolve(basePath, normalizedInput)
      : null;
  if (!absolutePath) return { absolutePath: null, reason: "Evidence path is relative but no workspace base path was supplied." };

  if (basePath) {
    const resolvedBase = path.resolve(basePath);
    const relative = path.relative(resolvedBase, absolutePath);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return { absolutePath };
    }
    return { absolutePath: null, reason: "Evidence path resolves outside the supplied workspace base path." };
  }

  return { absolutePath };
}

function inferContentType(filePath: string): string | null {
  return CONTENT_TYPES_BY_EXT[path.extname(filePath).toLowerCase()] ?? null;
}

function literalIpIsPrivate(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^(?:127|10)\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (host === "0.0.0.0" || host === "::" || host === "::1" || /^fe80:/i.test(host) || /^fc/i.test(host) || /^fd/i.test(host)) return true;
  return false;
}

async function urlHostIsPrivate(url: URL): Promise<boolean> {
  if (literalIpIsPrivate(url.hostname)) return true;
  try {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    return addresses.some((address) => literalIpIsPrivate(address.address));
  } catch {
    return true;
  }
}

function validateHttpEvidenceUrl(inputUrl: string): { url: URL; reason?: string } {
  try {
    const url = new URL(inputUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { url, reason: "Rejected URL evidence: only HTTP(S) URLs are supported." };
    }
    return { url };
  } catch {
    return { url: new URL("http://invalid.invalid"), reason: "Rejected URL evidence: URL is not parseable." };
  }
}

async function verifyCommit(input: CommitVerificationInput) {
  const payload = payloadRecord(input);
  const repoPath = stringPayload(payload, "repoPath", "workspacePath", "cwd", "repositoryPath");
  if (!repoPath) return { exists: false, reason: "Rejected commit evidence: no repository workspace path was supplied." };
  const { absolutePath, reason } = resolveWithinBase(repoPath, null);
  if (!absolutePath) return { exists: false, reason };

  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isDirectory()) return { exists: false, reason: "Rejected commit evidence: repository path is not a directory." };
    await execFile("git", ["-C", absolutePath, "cat-file", "-e", `${input.sha}^{commit}`], { timeout: GIT_VERIFY_TIMEOUT_MS });
    return { exists: true, ok: true };
  } catch {
    return { exists: false, reason: "Rejected commit evidence: repository verifier did not confirm the commit exists." };
  }
}

async function verifyFile(input: FileVerificationInput) {
  const payload = payloadRecord(input);
  const basePath = stringPayload(payload, "workspacePath", "cwd", "repoPath", "basePath");
  const { absolutePath, reason } = resolveWithinBase(input.path, basePath);
  if (!absolutePath) return { exists: false, reason };

  try {
    const stat = await fs.stat(absolutePath);
    return {
      exists: stat.isFile() || stat.isDirectory(),
      ok: stat.isFile() || stat.isDirectory(),
      contentType: stat.isDirectory() ? "inode/directory" : inferContentType(absolutePath),
    };
  } catch {
    return { exists: false, reason: "Rejected file evidence: file verifier did not confirm existence." };
  }
}

async function verifyUrl(input: UrlVerificationInput) {
  let current = input.url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_VERIFY_TIMEOUT_MS);
  try {
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      const { url, reason } = validateHttpEvidenceUrl(current);
      if (reason) return { ok: false, reason };
      if (await urlHostIsPrivate(url)) {
        return { ok: false, reason: "Rejected URL evidence: private or localhost URLs are not accepted by the default verifier." };
      }

      let response = await fetch(url, { method: "HEAD", redirect: "manual", signal: controller.signal });
      if (response.status === 405 || response.status === 501) {
        response = await fetch(url, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { range: `bytes=0-${MAX_URL_RESPONSE_BYTES - 1}` },
        });
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return { ok: false, status: response.status, reason: "Rejected URL evidence: redirect response did not include a location." };
        if (redirectCount === 5) return { ok: false, status: response.status, reason: "Rejected URL evidence: redirect limit exceeded." };
        current = new URL(location, url).toString();
        continue;
      }

      return {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get("content-type"),
      };
    }
    return { ok: false, reason: "Rejected URL evidence: redirect limit exceeded." };
  } catch {
    return { ok: false, reason: "Rejected URL evidence: URL verifier request failed." };
  } finally {
    clearTimeout(timer);
  }
}

async function verifyApprovalDecision(db: Db, input: ApprovalAuditInput) {
  if (!input.decision || !["approved", "rejected"].includes(input.decision)) {
    return { ok: false, decisionId: input.decisionId, reason: "Rejected approval evidence: decision is not auditable." };
  }
  const payload = payloadRecord(input);
  const companyId = stringPayload(payload, "companyId");
  if (!companyId) return { ok: false, decisionId: input.decisionId, reason: "Rejected approval evidence: no company id was supplied for audit lookup." };

  const [approval] = await db
    .select({ id: approvals.id, status: approvals.status, decidedAt: approvals.decidedAt })
    .from(approvals)
    .where(and(eq(approvals.companyId, companyId), eq(approvals.id, input.decisionId)))
    .limit(1);

  if (!approval) return { ok: false, decisionId: input.decisionId, reason: "Rejected approval evidence: approval decision id was not found." };
  if (approval.status !== input.decision) return { ok: false, decisionId: input.decisionId, reason: "Rejected approval evidence: recorded approval status does not match candidate decision." };
  if (!approval.decidedAt) return { ok: false, decisionId: input.decisionId, reason: "Rejected approval evidence: approval decision has not been finalized." };
  return { ok: true, exists: true, decisionId: input.decisionId };
}

export function createDefaultEvidenceValidatorAdapters(db: Db): EvidenceValidatorAdapters {
  return {
    verifyCommit,
    verifyFile,
    verifyUrl,
    verifyApprovalDecision: (input) => verifyApprovalDecision(db, input),
  };
}
