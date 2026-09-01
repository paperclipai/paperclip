import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  executionWorkspaces,
  formalQaCheckouts,
  formalQaIssuances,
  formalQaPolicies,
  formalQaPreparations,
  formalQaReviews,
  heartbeatRuns,
} from "@paperclipai/db";
import { conflict } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { redactEventPayload, redactSensitiveText } from "../redaction.js";
import { formalQaCheckoutService } from "./formal-qa-checkouts.js";

export const FORMAL_QA_REVIEW_CONTEXT_SCHEMA = "paperclip.formal-qa-review-context/v1";
export const FORMAL_QA_REVIEW_CONTRACT_SCHEMA = "paperclip.formal-qa-review-contract/v1";

const REVIEW_CONTRACT = Object.freeze({
  schema: FORMAL_QA_REVIEW_CONTRACT_SCHEMA,
  objective: "Independently review the exact sealed pull-request head for correctness, security, regressions, and test gaps.",
  constraints: [
    "Treat the supplied source as read-only review input.",
    "Do not push, merge, publish statuses, mutate Paperclip records, or request credentials.",
    "Base every finding on the exact head and tree named by the contract.",
    "Return exactly one terminal JSON artifact matching the contract schema.",
  ],
  output: {
    schema: "paperclip.formal-qa-review-decision/v1",
    decision: ["approved", "rejected"],
    required: ["schema", "reviewId", "runId", "headSha", "treeSha", "contractSha256", "decision", "summary", "findings"],
    finding: {
      required: ["severity", "title", "body", "path", "line"],
      severity: ["info", "low", "medium", "high", "critical"],
    },
  },
});

const execFileAsync = promisify(execFile);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const FORMAL_QA_REVIEW_CONTRACT_SHA256 = createHash("sha256")
  .update(canonicalJson(REVIEW_CONTRACT))
  .digest("hex");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type FormalQaSourceSnapshot = Readonly<{
  schema: "paperclip.formal-qa-review-source/v1";
  preparationId: string;
  issuanceId: string;
  checkoutId: string;
  policyId: string;
  policyVersion: number;
  reviewerAgentId: string;
  repository: string;
  prNumber: number;
  headSha: string;
  baseRef: string;
  baseSha: string;
  treeSha: string;
  checkoutPath: string;
  issuanceSha256: string;
  checkoutSha256: string;
  contractSha256: string;
  reviewerConfigSha256: string;
  sourceManifestSha256: string;
}>;

function buildSourceSnapshot(input: {
  authority: Awaited<ReturnType<ReturnType<typeof formalQaCheckoutService>["verifyForDispatch"]>>;
  contractSha256: string;
  reviewerConfigSha256: string;
  sourceManifestSha256: string;
}): FormalQaSourceSnapshot {
  const { preparation, issuance, checkout, policy } = input.authority;
  return {
    schema: "paperclip.formal-qa-review-source/v1",
    preparationId: preparation.id,
    issuanceId: issuance.id,
    checkoutId: checkout.id,
    policyId: policy.id,
    policyVersion: policy.version,
    reviewerAgentId: policy.reviewerAgentId,
    repository: preparation.repository,
    prNumber: preparation.prNumber,
    headSha: preparation.headSha,
    baseRef: preparation.baseRef,
    baseSha: preparation.baseSha,
    treeSha: preparation.treeSha,
    checkoutPath: checkout.checkoutPath,
    issuanceSha256: issuance.snapshotSha256,
    checkoutSha256: checkout.checkoutSha256,
    contractSha256: input.contractSha256,
    reviewerConfigSha256: input.reviewerConfigSha256,
    sourceManifestSha256: input.sourceManifestSha256,
  };
}

function assertSourceSnapshot(input: {
  review: typeof formalQaReviews.$inferSelect;
  authority: Awaited<ReturnType<ReturnType<typeof formalQaCheckoutService>["verifyForDispatch"]>>;
}) {
  const expected = buildSourceSnapshot({
    authority: input.authority,
    contractSha256: input.review.contractSha256,
    reviewerConfigSha256: input.review.reviewerConfigSha256,
    sourceManifestSha256: input.review.sourceManifestSha256,
  });
  const canonical = canonicalJson(expected);
  if (input.review.sourceSnapshotJson !== canonical ||
      input.review.sourceSnapshotSha256 !== sha256(canonical)) {
    throw conflict("Formal-QA review source snapshot changed before execution", {
      code: "formal_qa_review_source_snapshot_mismatch",
    });
  }
  return expected;
}

const SOURCE_MANIFEST_MAX_ENTRIES = 10_000;
const SOURCE_MANIFEST_MAX_BYTES = 32 * 1024 * 1024;
const GIT_BLOB_RE = /^[0-9a-f]{40,64}$/;
const TRUSTED_GIT_BINARY = "/usr/bin/git";
let trustedGitBinaryCheck: Promise<void> | null = null;
type FormalQaSourceEntry = Readonly<{ path: string; mode: "100644" | "100755"; blobSha: string; sha256: string; size: number }>;
type FormalQaSourceManifest = Readonly<{
  schema: "paperclip.formal-qa-source-manifest/v1";
  headSha: string;
  treeSha: string;
  entries: readonly FormalQaSourceEntry[];
}>;

function assertTrustedGitBinary(): Promise<void> {
  trustedGitBinaryCheck ??= (async () => {
    const stats = await fs.lstat(TRUSTED_GIT_BINARY);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== 0 || (stats.mode & 0o022) !== 0) {
      throw conflict("Formal-QA trusted Git binary is unavailable", { code: "formal_qa_review_source_snapshot_mismatch" });
    }
  })();
  return trustedGitBinaryCheck;
}

async function gitBuffer(args: string[], cwd: string): Promise<Buffer> {
  try {
    await assertTrustedGitBinary();
    const result = await execFileAsync(TRUSTED_GIT_BINARY, [
      "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesfile=/dev/null",
      "-c", "protocol.file.allow=never", "-c", "protocol.allow=never", ...args,
    ], {
      cwd,
      encoding: "buffer",
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1" },
      timeout: 30_000,
      maxBuffer: SOURCE_MANIFEST_MAX_BYTES + 1024 * 1024,
    });
    return result.stdout as unknown as Buffer;
  } catch {
    throw conflict("Formal-QA exact Git object could not be read", { code: "formal_qa_review_source_snapshot_mismatch" });
  }
}

function parseManifest(raw: string, review: typeof formalQaReviews.$inferSelect): FormalQaSourceManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw conflict("Formal-QA source manifest is invalid", { code: "formal_qa_review_source_snapshot_mismatch" }); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || canonicalJson(parsed) !== raw) {
    throw conflict("Formal-QA source manifest is not canonical", { code: "formal_qa_review_source_snapshot_mismatch" });
  }
  const manifest = parsed as FormalQaSourceManifest;
  if (manifest.schema !== "paperclip.formal-qa-source-manifest/v1" || manifest.headSha !== review.headSha ||
    manifest.treeSha !== review.treeSha || !Array.isArray(manifest.entries) || manifest.entries.length > SOURCE_MANIFEST_MAX_ENTRIES ||
    sha256(raw) !== review.sourceManifestSha256) {
    throw conflict("Formal-QA source manifest does not bind the review", { code: "formal_qa_review_source_snapshot_mismatch" });
  }
  let previous = "";
  let total = 0;
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.path !== "string" || !entry.path || entry.path.startsWith("/") || entry.path.split("/").some((part: string) => part === "" || part === "." || part === "..") ||
      (entry.mode !== "100644" && entry.mode !== "100755") || !GIT_BLOB_RE.test(entry.blobSha) || !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > SOURCE_MANIFEST_MAX_BYTES || entry.path <= previous) {
      throw conflict("Formal-QA source manifest entry is invalid", { code: "formal_qa_review_source_snapshot_mismatch" });
    }
    previous = entry.path;
    total += entry.size;
    if (total > SOURCE_MANIFEST_MAX_BYTES) throw conflict("Formal-QA source manifest exceeds its bound", { code: "formal_qa_review_source_snapshot_mismatch" });
  }
  return manifest;
}

async function buildSourceManifest(authority: Awaited<ReturnType<ReturnType<typeof formalQaCheckoutService>["verifyForDispatch"]>>): Promise<{ json: string; sha256: string }> {
  const listing = (await gitBuffer(["ls-tree", "-r", "-l", "-z", authority.preparation.headSha], authority.checkout.repoRoot)).toString("utf8");
  const entries: FormalQaSourceEntry[] = [];
  let total = 0;
  for (const item of listing.split("\0")) {
    if (!item) continue;
    const match = item.match(/^(100644|100755) blob ([0-9a-f]{40,64})\s+(\d+)\t(.+)$/);
    if (!match) throw conflict("Formal-QA source tree contains an unsupported entry", { code: "formal_qa_review_source_snapshot_mismatch" });
    const size = Number(match[3]);
    const content = await gitBuffer(["cat-file", "blob", match[2]!], authority.checkout.repoRoot);
    if (content.length !== size) throw conflict("Formal-QA source blob size differs from its tree", { code: "formal_qa_review_source_snapshot_mismatch" });
    total += size;
    if (entries.length + 1 > SOURCE_MANIFEST_MAX_ENTRIES || total > SOURCE_MANIFEST_MAX_BYTES) {
      throw conflict("Formal-QA source tree exceeds its review bound", { code: "formal_qa_review_source_snapshot_mismatch" });
    }
    entries.push({ path: match[4]!, mode: match[1] as "100644" | "100755", blobSha: match[2]!, sha256: createHash("sha256").update(content).digest("hex"), size });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const json = canonicalJson({ schema: "paperclip.formal-qa-source-manifest/v1", headSha: authority.preparation.headSha, treeSha: authority.preparation.treeSha, entries });
  return { json, sha256: sha256(json) };
}

async function assertSourceManifest(review: typeof formalQaReviews.$inferSelect, authority: Awaited<ReturnType<ReturnType<typeof formalQaCheckoutService>["verifyForDispatch"]>>): Promise<FormalQaSourceManifest> {
  const manifest = parseManifest(review.sourceManifestJson, review);
  for (const entry of manifest.entries) {
    const content = await gitBuffer(["cat-file", "blob", entry.blobSha], authority.checkout.repoRoot);
    if (content.length !== entry.size || createHash("sha256").update(content).digest("hex") !== entry.sha256) {
      throw conflict("Formal-QA source blob changed before execution", { code: "formal_qa_review_source_snapshot_mismatch" });
    }
  }
  return manifest;
}

function redactReviewFinding(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactReviewFinding);
  if (value && typeof value === "object") {
    const record = redactEventPayload(value as Record<string, unknown>) ?? {};
    return Object.fromEntries(Object.entries(record).map(([key, nested]) => [key, redactReviewFinding(nested)]));
  }
  return value;
}

function buildReviewPrompt(input: {
  reviewId: string;
  heartbeatRunId: string;
  repository: string;
  prNumber: number;
  headSha: string;
  treeSha: string;
  contractSha256: string;
}): string {
  const outputExample = {
    schema: "paperclip.formal-qa-review-decision/v1",
    reviewId: input.reviewId,
    runId: input.heartbeatRunId,
    headSha: input.headSha,
    treeSha: input.treeSha,
    contractSha256: input.contractSha256,
    decision: "approved",
    summary: "Bounded review summary",
    findings: [],
  };
  return [
    "Perform the server-authorized Formal-QA review described below.",
    `Review ID: ${input.reviewId}`,
    `Run ID: ${input.heartbeatRunId}`,
    `Repository: ${input.repository}`,
    `Pull request: #${input.prNumber}`,
    `Exact head: ${input.headSha}`,
    `Exact tree: ${input.treeSha}`,
    `Contract SHA-256: ${input.contractSha256}`,
    "The exact source is available only through the server-provided Formal-QA source tools. Do not use a filesystem checkout.",
    "Do not review any other source. Do not modify source. Do not push, merge, publish a status, or call Paperclip APIs.",
    `Return only one JSON object with these exact keys (decision may be approved or rejected): ${canonicalJson(outputExample)}`,
  ].join("\n");
}

export function formalQaReviewService(db: Db, options?: {
  checkoutInstanceRoot?: string;
  checkoutTestOnlyRemoteUrl?: string;
  checkoutTestOnlyAllowFileProtocol?: boolean;
}) {
  const instanceRoot = path.resolve(options?.checkoutInstanceRoot ?? resolvePaperclipInstanceRoot());
  const checkouts = formalQaCheckoutService(db, {
    instanceRoot: options?.checkoutInstanceRoot,
    testOnlyRemoteUrl: options?.checkoutTestOnlyRemoteUrl,
    testOnlyAllowFileProtocol: options?.checkoutTestOnlyAllowFileProtocol,
  });

  const queue = async ({ preparationId }: { preparationId: string }) => {
    const authority = await checkouts.verifyForDispatch({ preparationId });
    const reviewId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const wakeupRequestId = randomUUID();
    const heartbeatRunId = randomUUID();
    const sourceManifest = await buildSourceManifest(authority);
    try {
      const queued = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`formal_qa_review:${authority.checkout.id}`}, 0))`);
      const existing = await tx.select().from(formalQaReviews)
        .where(eq(formalQaReviews.checkoutId, authority.checkout.id)).limit(1)
        .then((rows) => rows[0] ?? null);
      if (existing) return { review: existing, replayed: true };

      const [preparation] = await tx.select().from(formalQaPreparations)
        .where(eq(formalQaPreparations.id, preparationId)).for("update").limit(1);
      const [issuance] = await tx.select().from(formalQaIssuances)
        .where(eq(formalQaIssuances.id, authority.issuance.id)).limit(1);
      const [checkout] = await tx.select().from(formalQaCheckouts)
        .where(eq(formalQaCheckouts.id, authority.checkout.id)).limit(1);
      const [policy] = await tx.select().from(formalQaPolicies)
        .where(eq(formalQaPolicies.id, authority.policy.id)).limit(1);
      const [reviewer] = await tx.select({
        id: agents.id,
        companyId: agents.companyId,
        adapterType: agents.adapterType,
        configSha256: sql<string>`encode(sha256(convert_to(jsonb_build_object(
          'adapterType', ${agents.adapterType},
          'adapterConfig', ${agents.adapterConfig},
          'runtimeConfig', ${agents.runtimeConfig}
        )::text, 'UTF8')), 'hex')`,
      }).from(agents)
        .where(eq(agents.id, authority.policy.reviewerAgentId)).for("share").limit(1);
      if (!preparation || preparation.status !== "issued" || preparation.expiresAt.getTime() <= Date.now() ||
        !issuance || !checkout || checkout.status !== "verified" || !policy || !policy.enabled ||
        !reviewer || reviewer.companyId !== preparation.companyId || reviewer.adapterType !== "codex_local" ||
        policy.version !== issuance.policyVersion || policy.reviewerAgentId !== authority.policy.reviewerAgentId ||
        issuance.preparationId !== preparation.id || checkout.preparationId !== preparation.id) {
        throw conflict("Formal-QA review authority changed before queue publication", {
          code: "formal_qa_review_authority_changed",
        });
      }
      const sealedReviewerConfigSha256 = reviewer.configSha256;
      const sourceSnapshot = buildSourceSnapshot({
        authority,
        contractSha256: FORMAL_QA_REVIEW_CONTRACT_SHA256,
        reviewerConfigSha256: sealedReviewerConfigSha256,
        sourceManifestSha256: sourceManifest.sha256,
      });
      const sourceSnapshotJson = canonicalJson(sourceSnapshot);
      const sourceSnapshotSha256 = sha256(sourceSnapshotJson);
      const prompt = buildReviewPrompt({
        reviewId,
        heartbeatRunId,
        repository: preparation.repository,
        prNumber: preparation.prNumber,
        headSha: preparation.headSha,
        treeSha: preparation.treeSha,
        contractSha256: FORMAL_QA_REVIEW_CONTRACT_SHA256,
      });
      const sealedPromptSha256 = sha256(prompt);

      await tx.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId: preparation.companyId,
        projectId: preparation.projectId,
        projectWorkspaceId: preparation.projectWorkspaceId,
        mode: "formal_qa_checkout",
        strategyType: "formal_qa_checkout",
        name: `Formal-QA PR #${preparation.prNumber} @ ${preparation.headSha.slice(0, 12)}`,
        status: "active",
        cwd: path.resolve(instanceRoot, "formal-qa-review-scratch", preparation.companyId, reviewId),
        repoUrl: `https://github.com/${preparation.repository}.git`,
        baseRef: preparation.headSha,
        branchName: null,
        providerType: "local_fs",
        providerRef: path.resolve(instanceRoot, "formal-qa-review-scratch", preparation.companyId, reviewId),
        metadata: {
          schema: "paperclip.formal-qa-execution-workspace/v1",
          reviewId,
          preparationId,
          issuanceId: issuance.id,
          checkoutId: checkout.id,
          checkoutSha256: checkout.checkoutSha256,
          contractSha256: FORMAL_QA_REVIEW_CONTRACT_SHA256,
          reviewerConfigSha256: sealedReviewerConfigSha256,
          promptSha256: sealedPromptSha256,
          sourceSnapshotSha256,
          sourceManifestSha256: sourceManifest.sha256,
        },
      });
      await tx.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId: preparation.companyId,
        agentId: policy.reviewerAgentId,
        source: "automation",
        triggerDetail: "system",
        reason: "formal_qa_review",
        payload: { schema: FORMAL_QA_REVIEW_CONTEXT_SCHEMA, formalQaReviewId: reviewId },
        status: "queued",
        requestedByActorType: "system",
        requestedByActorId: "formal_qa_review_controller",
        idempotencyKey: `formal-qa-review:${checkout.id}`,
        runId: heartbeatRunId,
      });
      await tx.insert(heartbeatRuns).values({
        id: heartbeatRunId,
        companyId: preparation.companyId,
        agentId: policy.reviewerAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        responsibleUserId: preparation.issuedByUserId,
        wakeupRequestId,
        runtimeMode: "legacy",
        runtimeModeResolverVersion: "formal-qa/v1",
        runtimeModeReason: "formal_qa_review",
        runtimeModeResolvedAt: new Date(),
        contextSnapshot: { schema: FORMAL_QA_REVIEW_CONTEXT_SCHEMA, formalQaReviewId: reviewId },
      });
      const [review] = await tx.insert(formalQaReviews).values({
        id: reviewId,
        companyId: preparation.companyId,
        projectId: preparation.projectId,
        projectWorkspaceId: preparation.projectWorkspaceId,
        preparationId,
        issuanceId: issuance.id,
        checkoutId: checkout.id,
        policyId: policy.id,
        policyVersion: policy.version,
        reviewerAgentId: policy.reviewerAgentId,
        executionWorkspaceId,
        wakeupRequestId,
        heartbeatRunId,
        repository: preparation.repository,
        prNumber: preparation.prNumber,
        headSha: preparation.headSha,
        treeSha: preparation.treeSha,
        issuanceSha256: issuance.snapshotSha256,
        checkoutSha256: checkout.checkoutSha256,
        contractSha256: FORMAL_QA_REVIEW_CONTRACT_SHA256,
        reviewerConfigSha256: sealedReviewerConfigSha256,
        promptSha256: sealedPromptSha256,
        sourceSnapshotJson,
        sourceSnapshotSha256,
        sourceManifestJson: sourceManifest.json,
        sourceManifestSha256: sourceManifest.sha256,
        status: "queued",
        expiresAt: preparation.expiresAt,
      }).returning();
      return { review: review!, replayed: false };
      });
      return queued;
    } catch (error) { throw error; }
  };

  const loadRunBinding = async (input: { reviewId: string; runId: string; companyId: string; agentId: string }) => {
    const review = await db.select().from(formalQaReviews)
      .where(and(
        eq(formalQaReviews.id, input.reviewId),
        eq(formalQaReviews.heartbeatRunId, input.runId),
        eq(formalQaReviews.companyId, input.companyId),
        eq(formalQaReviews.reviewerAgentId, input.agentId),
      )).limit(1).then((rows) => rows[0] ?? null);
    if (!review) throw conflict("Heartbeat run is not bound to this Formal-QA review", { code: "formal_qa_review_run_mismatch" });
    return review;
  };

  const claimRun = async (input: { reviewId: string; runId: string; companyId: string; agentId: string }) => {
    const current = await loadRunBinding(input);
    const authority = await checkouts.verifyForDispatch({ preparationId: current.preparationId });
    assertSourceSnapshot({ review: current, authority });
    await assertSourceManifest(current, authority);
    const prompt = buildReviewPrompt({
      reviewId: current.id,
      heartbeatRunId: current.heartbeatRunId,
      repository: current.repository,
      prNumber: current.prNumber,
      headSha: current.headSha,
      treeSha: current.treeSha,
      contractSha256: current.contractSha256,
    });
    if (current.promptSha256 !== sha256(prompt)) {
      throw conflict("Formal-QA review prompt binding changed before claim", { code: "formal_qa_review_authority_changed" });
    }
    const scratchRoot = path.resolve(instanceRoot, "formal-qa-review-scratch", current.companyId);
    const scratchPath = path.resolve(scratchRoot, current.id);
    if (!scratchPath.startsWith(`${scratchRoot}${path.sep}`)) throw new Error("Formal-QA scratch path escaped its root");
    let review: typeof formalQaReviews.$inferSelect;
    try {
      await fs.mkdir(scratchPath, { recursive: true, mode: 0o700 });
      const stats = await fs.lstat(scratchPath);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw conflict("Formal-QA scratch path is not a trusted directory", { code: "formal_qa_review_scratch_untrusted" });
      review = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`formal_qa_review_run:${input.reviewId}`}, 0))`);
        const locked = await tx.select().from(formalQaReviews)
          .where(and(
            eq(formalQaReviews.id, input.reviewId),
            eq(formalQaReviews.heartbeatRunId, input.runId),
            eq(formalQaReviews.companyId, input.companyId),
            eq(formalQaReviews.reviewerAgentId, input.agentId),
          )).for("update").limit(1).then((rows) => rows[0] ?? null);
        const liveReviewer = await tx.select({
          companyId: agents.companyId,
          adapterType: agents.adapterType,
          configSha256: sql<string>`encode(sha256(convert_to(jsonb_build_object(
            'adapterType', ${agents.adapterType},
            'adapterConfig', ${agents.adapterConfig},
            'runtimeConfig', ${agents.runtimeConfig}
          )::text, 'UTF8')), 'hex')`,
        }).from(agents).where(eq(agents.id, current.reviewerAgentId)).for("share").limit(1)
          .then((rows) => rows[0] ?? null);
        if (!locked || (locked.status !== "queued" && locked.status !== "running")) {
          throw conflict("Formal-QA review is not claimable", { code: "formal_qa_review_not_claimable" });
        }
        if (locked.expiresAt.getTime() <= Date.now() || locked.checkoutId !== authority.checkout.id ||
          locked.issuanceId !== authority.issuance.id || locked.policyId !== authority.policy.id ||
          locked.policyVersion !== authority.policy.version || locked.headSha !== authority.preparation.headSha ||
          locked.treeSha !== authority.preparation.treeSha || locked.checkoutSha256 !== authority.checkout.checkoutSha256 ||
          locked.issuanceSha256 !== authority.issuance.snapshotSha256 || locked.contractSha256 !== FORMAL_QA_REVIEW_CONTRACT_SHA256 ||
          !liveReviewer || liveReviewer.companyId !== locked.companyId || liveReviewer.adapterType !== "codex_local" ||
          locked.reviewerConfigSha256 !== liveReviewer.configSha256) {
          throw conflict("Formal-QA review authority changed before claim", { code: "formal_qa_review_authority_changed" });
        }
        if (locked.status === "running") return locked;
        const [claimed] = await tx.update(formalQaReviews).set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(formalQaReviews.id, locked.id), eq(formalQaReviews.status, "queued"))).returning();
        if (!claimed) throw conflict("Formal-QA review claim was lost", { code: "formal_qa_review_not_claimable" });
        return claimed;
      });
    } catch (error) {
      await fs.rm(scratchPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return { review, authority, scratchPath, prompt };
  };

  const failQueuedRun = async (input: {
    reviewId: string;
    runId: string;
    companyId: string;
    agentId: string;
    reason: string;
  }) => db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`formal_qa_review_run:${input.reviewId}`}, 0))`);
    const review = await tx.select().from(formalQaReviews).where(and(
      eq(formalQaReviews.id, input.reviewId),
      eq(formalQaReviews.heartbeatRunId, input.runId),
      eq(formalQaReviews.companyId, input.companyId),
      eq(formalQaReviews.reviewerAgentId, input.agentId),
    )).for("update").limit(1).then((rows) => rows[0] ?? null);
    if (!review) throw conflict("Heartbeat run is not bound to this Formal-QA review", { code: "formal_qa_review_run_mismatch" });
    if (review.status !== "queued") return review;
    const [failed] = await tx.update(formalQaReviews).set({
      status: "failed",
      terminalReason: input.reason.slice(0, 2_000) || "Formal-QA review failed before claim",
      finishedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(formalQaReviews.id, review.id), eq(formalQaReviews.status, "queued"))).returning();
    return failed ?? review;
  });

  function isFormalQaFinding(finding: unknown): finding is Record<string, unknown> {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) return false;
    const record = finding as Record<string, unknown>;
    if (Object.keys(record).length !== 5 || Object.keys(record).some((key) => !["severity", "title", "body", "path", "line"].includes(key))) return false;
    return ["info", "low", "medium", "high", "critical"].includes(record.severity as string)
      && typeof record.title === "string" && record.title.length > 0 && record.title.length <= 500
      && typeof record.body === "string" && record.body.length > 0 && record.body.length <= 10_000
      && typeof record.path === "string" && record.path.length > 0 && record.path.length <= 1024
      && Number.isSafeInteger(record.line) && (record.line as number) >= 1 && (record.line as number) <= 10_000_000;
  }

  function parseDecisionArtifact(input: { text: string; review: typeof formalQaReviews.$inferSelect }) {
    let value: unknown;
    try { value = JSON.parse(input.text.trim()); } catch { throw conflict("Formal-QA reviewer did not return exact JSON", { code: "formal_qa_review_artifact_invalid" }); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw conflict("Formal-QA reviewer artifact is invalid", { code: "formal_qa_review_artifact_invalid" });
    const artifact = value as Record<string, unknown>;
    const findings = artifact.findings;
    if (artifact.schema !== "paperclip.formal-qa-review-decision/v1" || artifact.reviewId !== input.review.id ||
      artifact.runId !== input.review.heartbeatRunId || artifact.headSha !== input.review.headSha ||
      artifact.treeSha !== input.review.treeSha || artifact.contractSha256 !== input.review.contractSha256 ||
      (artifact.decision !== "approved" && artifact.decision !== "rejected") ||
      typeof artifact.summary !== "string" || artifact.summary.length > 10_000 ||
      !Array.isArray(findings) || findings.length > 100 || findings.some((finding) => !isFormalQaFinding(finding))) {
      throw conflict("Formal-QA reviewer artifact does not match its sealed contract", { code: "formal_qa_review_artifact_invalid" });
    }
    const storedArtifact = {
      ...artifact,
      // Binding fields above are checked before redaction. Only reviewer
      // controlled prose and findings are sanitized before durable storage.
      summary: redactSensitiveText(artifact.summary as string),
      findings: redactReviewFinding(findings),
    } as Record<string, unknown>;
    const canonical = canonicalJson(storedArtifact);
    if (canonical.length > 256 * 1024) throw conflict("Formal-QA reviewer artifact is too large", { code: "formal_qa_review_artifact_invalid" });
    return { artifact: storedArtifact, canonical, decision: artifact.decision as "approved" | "rejected" };
  }

  const finishRun = async (input: {
    reviewId: string;
    runId: string;
    companyId: string;
    agentId: string;
    succeeded: boolean;
    output: string | null;
    failureReason?: string | null;
  }) => {
    const review = await loadRunBinding(input);
    let terminal: "approved" | "rejected" | "failed" | "tainted" = "failed";
    let artifact: Record<string, unknown> | null = null;
    let decisionCanonical: string | null = null;
    let reason: string | null = input.failureReason?.slice(0, 2_000) ?? "Formal-QA reviewer did not produce an accepted terminal artifact";
    if (input.succeeded && input.output) {
      try {
        const authority = await checkouts.verifyForDispatch({ preparationId: review.preparationId });
        assertSourceSnapshot({ review, authority });
        await assertSourceManifest(review, authority);
        const parsed = parseDecisionArtifact({ text: input.output, review });
        terminal = parsed.decision;
        artifact = parsed.artifact;
        decisionCanonical = parsed.canonical;
        reason = null;
      } catch (error) {
        terminal = error && typeof error === "object" && "details" in error &&
          (error as { details?: { code?: string } }).details?.code === "formal_qa_checkout_verification_failed"
          ? "tainted"
          : "failed";
        reason = error instanceof Error ? error.message.slice(0, 2_000) : "Formal-QA terminal verification failed";
      }
    }
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`formal_qa_review_run:${review.id}`}, 0))`);
      const locked = await tx.select().from(formalQaReviews).where(eq(formalQaReviews.id, review.id)).for("update").limit(1).then((rows) => rows[0] ?? null);
      if (!locked) throw conflict("Formal-QA review disappeared", { code: "formal_qa_review_run_mismatch" });
      if (["approved", "rejected", "failed", "cancelled", "expired", "tainted"].includes(locked.status)) return locked;
      if (locked.status !== "running") throw conflict("Formal-QA review is not running", { code: "formal_qa_review_not_running" });
      const [finished] = await tx.update(formalQaReviews).set({
        status: terminal,
        decision: terminal === "approved" || terminal === "rejected" ? terminal : null,
        decisionArtifact: artifact,
        decisionSha256: decisionCanonical
          ? sql<string>`encode(sha256(convert_to(${decisionCanonical}::jsonb::text, 'UTF8')), 'hex')`
          : null,
        terminalReason: reason,
        finishedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(eq(formalQaReviews.id, locked.id), eq(formalQaReviews.status, "running"))).returning();
      if (!finished) throw conflict("Formal-QA review terminal claim was lost", { code: "formal_qa_review_not_running" });
      return finished;
    });
  };

  const reconcileVerified = async (input: { companyId?: string; limit?: number } = {}) => {
    const candidates = await db.select({ preparationId: formalQaPreparations.id })
      .from(formalQaCheckouts)
      .innerJoin(formalQaPreparations, eq(formalQaPreparations.id, formalQaCheckouts.preparationId))
      .leftJoin(formalQaReviews, eq(formalQaReviews.checkoutId, formalQaCheckouts.id))
      .where(and(
        eq(formalQaCheckouts.status, "verified"),
        eq(formalQaPreparations.status, "issued"),
        isNull(formalQaReviews.id),
        input.companyId ? eq(formalQaPreparations.companyId, input.companyId) : undefined,
      ))
      .orderBy(asc(formalQaCheckouts.createdAt))
      .limit(Math.max(1, Math.min(input.limit ?? 25, 100)));
    let queued = 0;
    let deferred = 0;
    for (const candidate of candidates) {
      try {
        await queue({ preparationId: candidate.preparationId });
        queued += 1;
      } catch {
        deferred += 1;
      }
    }
    return { scanned: candidates.length, queued, deferred };
  };

  const list = async (companyId: string, input: { preparationId?: string; limit?: number } = {}) => db
    .select()
    .from(formalQaReviews)
    .where(and(
      eq(formalQaReviews.companyId, companyId),
      input.preparationId ? eq(formalQaReviews.preparationId, input.preparationId) : undefined,
    ))
    .orderBy(asc(formalQaReviews.createdAt))
    .limit(Math.max(1, Math.min(input.limit ?? 100, 100)));

  const getById = async (id: string) => db.select().from(formalQaReviews)
    .where(eq(formalQaReviews.id, id)).limit(1)
    .then((rows) => rows[0] ?? null);

  /**
   * The process-loss reconciler may requeue one already-bound heartbeat run.
   * It must ask this gate first: a retry never extends an expired authority or
   * survives policy revocation/source drift.  The heartbeat layer retains the
   * durable retry counter and enforces the one-successor bound.
   */
  const verifyRetryAuthority = async (input: { reviewId: string; runId: string; companyId: string; agentId: string }) => {
    const review = await loadRunBinding(input);
    if (review.status !== "running") {
      throw conflict("Formal-QA review is not eligible for transient retry", { code: "formal_qa_review_not_running" });
    }
    const authority = await checkouts.verifyForDispatch({ preparationId: review.preparationId });
    assertSourceSnapshot({ review, authority });
    await assertSourceManifest(review, authority);
    return review;
  };

  const loadExactSource = async (input: { reviewId: string; runId: string; companyId: string; agentId: string }) => {
    const review = await loadRunBinding(input);
    if (review.status !== "running") {
      throw conflict("Formal-QA source is available only to the active sealed review", { code: "formal_qa_review_not_running" });
    }
    const authority = await checkouts.verifyForDispatch({ preparationId: review.preparationId });
    assertSourceSnapshot({ review, authority });
    return { review, authority, manifest: await assertSourceManifest(review, authority) };
  };

  /** Fixed source surface for the closed Formal-QA driver. It intentionally
   * returns only metadata from the sealed manifest, never a checkout path. */
  const listSourceFiles = async (input: { reviewId: string; runId: string; companyId: string; agentId: string }) => {
    const { manifest } = await loadExactSource(input);
    return manifest.entries.map(({ path: sourcePath, mode, sha256: contentSha256, size }) => ({
      path: sourcePath, mode, sha256: contentSha256, size,
    }));
  };

  /** Reads one manifest-authorized Git blob and verifies its exact byte digest
   * immediately before returning it to the closed Formal-QA driver. */
  const readSourceFile = async (input: { reviewId: string; runId: string; companyId: string; agentId: string; path: string }) => {
    const { authority, manifest } = await loadExactSource(input);
    const entry = manifest.entries.find((candidate) => candidate.path === input.path);
    if (!entry) throw conflict("Formal-QA source path is not in the sealed manifest", { code: "formal_qa_review_source_path_denied" });
    const content = await gitBuffer(["cat-file", "blob", entry.blobSha], authority.checkout.repoRoot);
    if (content.length !== entry.size || createHash("sha256").update(content).digest("hex") !== entry.sha256) {
      throw conflict("Formal-QA source blob changed while being read", { code: "formal_qa_review_source_snapshot_mismatch" });
    }
    return { path: entry.path, mode: entry.mode, sha256: entry.sha256, size: entry.size, content };
  };

  return { queue, reconcileVerified, loadRunBinding, claimRun, failQueuedRun, finishRun, verifyRetryAuthority, listSourceFiles, readSourceFile, list, getById };
}

export const formalQaReviewTestOnly = {
  canonicalJson,
  contract: REVIEW_CONTRACT,
  buildReviewPrompt,
  buildSourceSnapshot,
};
