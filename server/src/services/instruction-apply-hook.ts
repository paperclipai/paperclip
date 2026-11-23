import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueApprovals, issues, projects } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { instructionPath } from "./agent-instruction-files.js";
import { agentInstructionRevisionService } from "./agent-instruction-revisions.js";
import { agentInstructionsBundleMode, agentInstructionsService, deriveBundleState } from "./agent-instructions.js";
import { issueService } from "./issues.js";

/**
 * Origin kind for board-authenticated apply tasks auto-created when an
 * instruction-generation approval is approved. Dedup key:
 * originId = target agent id, originFingerprint = approved bundle fingerprint.
 */
export const INSTRUCTION_APPLY_ORIGIN_KIND = "instruction_generation_apply";

const APPLY_TASK_TERMINAL_STATUSES = ["done", "cancelled"];

export interface InstructionBundleFile {
  path: string;
  content: string;
  /** contentHash the proposal was reviewed against (null = new file); absent = not recorded. */
  baseHash?: string | null;
}

interface ReviewedInstructionFile extends InstructionBundleFile {
  baseHash: string | null;
}

const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
// Paths are interpolated into the apply task's markdown, so control characters and backticks are rejected
const UNSAFE_PATH_CHARS = /[\u0000-\u001f\u007f`]/;

export interface CreateInstructionApplyTaskInput {
  companyId: string;
  approvalId: string;
  decidedByUserId: string;
  payload: Record<string, unknown>;
}

export interface InstructionApplyTaskResult {
  issueId: string;
  /** false when an open apply task for the same agent + bundle already existed */
  created: boolean;
}

/**
 * Extracts the approved bundle files from an instruction-generation approval payload.
 * Two payload shapes are supported: the canonical `{ bundle: { files: [...] } }` and a
 * flat `{ files: [...] }` fallback for payloads authored without the bundle wrapper.
 */
function parseBundleFiles(payload: Record<string, unknown>): InstructionBundleFile[] | null {
  const bundle = payload.bundle;
  const rawFiles =
    typeof bundle === "object" && bundle !== null && !Array.isArray(bundle)
      ? (bundle as Record<string, unknown>).files
      : payload.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) return null;

  const files: InstructionBundleFile[] = [];
  for (const entry of rawFiles) {
    if (typeof entry !== "object" || entry === null) return null;
    const { path, content, baseHash } = entry as Record<string, unknown>;
    if (typeof path !== "string" || !path.trim() || typeof content !== "string") return null;
    if (UNSAFE_PATH_CHARS.test(path)) return null;
    try {
      instructionPath(path);
    } catch {
      return null;
    }
    if (baseHash === undefined) {
      files.push({ path, content });
    } else if (baseHash === null || (typeof baseHash === "string" && CONTENT_HASH_PATTERN.test(baseHash))) {
      files.push({ path, content, baseHash });
    } else {
      return null;
    }
  }
  return files;
}

/**
 * Current `contentHash` of an instructions-bundle file, read the same way as
 * `GET /agents/:id/instructions-bundle/file`; null when the file does not exist yet.
 */
async function currentContentHash(
  db: Db,
  agent: typeof agents.$inferSelect,
  path: string,
): Promise<string | null> {
  if (agentInstructionsBundleMode(agent) !== "external" && instructionPath(path) === deriveBundleState(agent).entryFile) {
    const snapshot = await agentInstructionRevisionService(db).readCommittedForRuntime({
      companyId: agent.companyId,
      agentId: agent.id,
    });
    if (snapshot) return snapshot.revision.contentHash;
  }
  try {
    return (await agentInstructionsService(db).readFile(agent, path)).contentHash ?? null;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Whether `PUT /agents/:id/instructions-bundle/file` enforces `baseHash` for this path.
 * The entry file commits against a base revision outside external mode; other managed
 * files go through the hashed file store. External bundles, the legacy prompt file and
 * non-entry files outside a managed bundle are written without a base check.
 */
function hasGuardedWritePath(agent: typeof agents.$inferSelect, path: string): boolean {
  const mode = agentInstructionsBundleMode(agent);
  if (mode === "external") return false;
  if (instructionPath(path) === deriveBundleState(agent).entryFile) return true;
  return mode === "managed" && path !== "promptTemplate.legacy.md";
}

type ApplyTaskScope = { parentId: string | null } | { unsupported: true };

/**
 * The approval is readable only by callers who can read every task it claims or links
 * to. A task in a private subtree or project restricts it, so the apply task is created
 * under that task and inherits its privacy. Restricting tasks with different privacy
 * roots cannot be covered by one parent, so no apply task is created for them.
 */
async function resolveApplyTaskScope(
  db: Db,
  input: { companyId: string; approvalId: string; payload: Record<string, unknown> },
): Promise<ApplyTaskScope> {
  const { companyId, approvalId, payload } = input;
  const claimedIssueIds = [payload.issueId, payload.sourceIssueId].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  const linked = sql<boolean>`${issues.id} in (select ${issueApprovals.issueId} from ${issueApprovals}
    where ${issueApprovals.approvalId} = ${approvalId} and ${issueApprovals.companyId} = ${companyId})`;
  const scopeIssues = await db
    .select({
      id: issues.id,
      visibility: issues.visibility,
      privacyRootIssueId: issues.privacyRootIssueId,
      projectVisibility: projects.visibility,
    })
    .from(issues)
    .leftJoin(projects, and(eq(projects.id, issues.projectId), eq(projects.companyId, issues.companyId)))
    .where(
      and(
        eq(issues.companyId, companyId),
        claimedIssueIds.length > 0 ? or(inArray(issues.id, claimedIssueIds), linked) : linked,
      ),
    );
  const restricted = scopeIssues
    .filter((issue) => issue.visibility === "private" || issue.privacyRootIssueId || issue.projectVisibility === "private")
    .sort((a, b) => a.id.localeCompare(b.id));
  if (restricted.length === 0) return { parentId: null };
  const roots = new Set(restricted.map((issue) => issue.privacyRootIssueId ?? issue.id));
  return roots.size === 1 ? { parentId: restricted[0]!.id } : { unsupported: true };
}

/**
 * Stable fingerprint of an approved bundle: same agent + same files + same reviewed
 * bases = same fingerprint. Bases are part of the key so re-approving the same content
 * against a newer base (after a 409) yields a fresh task instead of the stale one.
 */
export function computeInstructionBundleFingerprint(
  agentId: string,
  files: InstructionBundleFile[],
): string {
  const canonical = JSON.stringify({
    agentId,
    files: [...files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => ({ path: file.path, content: file.content, baseHash: file.baseHash ?? null })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Matches the `contentHash` the instructions-bundle file routes return (sha256 of the UTF-8 bytes). */
function contentSha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

function longestBacktickRun(content: string): number {
  return content.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
}

/** Fence longer than any backtick run inside the content, so the content cannot close it early. */
function codeFence(content: string): string {
  return "`".repeat(Math.max(4, longestBacktickRun(content) + 1));
}

function fenced(content: string, info: string): string {
  const fence = codeFence(content);
  return fence + info + "\n" + content + (content.endsWith("\n") ? "" : "\n") + fence;
}

/** Collapses control characters (including newlines) so free text stays on one line. */
function singleLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
}

/**
 * Agent names are free text that the approval does not cover: render them as an inline
 * code span on one line so a name cannot add headings or other task structure.
 */
function inlineCode(text: string): string {
  const flat = singleLine(text);
  const fence = "`".repeat(longestBacktickRun(flat) + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return fence + pad + flat + pad + fence;
}

function buildApplyTaskDescription(input: {
  agentId: string;
  agentName: string;
  approvalId: string;
  fingerprint: string;
  files: ReviewedInstructionFile[];
  note: string | null;
}): string {
  const { agentId, agentName, approvalId, fingerprint, files, note } = input;
  const fileSections = files
    .map(
      (file) =>
        `### \`${file.path}\`\n\n` +
        `Reviewed base: ${file.baseHash === null ? "`null` (new file)" : `\`${file.baseHash}\``}\n\n` +
        `Expected \`contentHash\` after the write: \`${contentSha256(file.content)}\`\n\n` +
        fenced(file.content, "markdown"),
    )
    .join("\n\n");

  return [
    `Board-authenticated apply task auto-created from instruction-generation approval \`${approvalId}\` for agent \`${agentId}\` (name: ${inlineCode(agentName)}). The agent id is authoritative: every write below targets it.`,
    // The note is approval-payload text: fence it so it reads as data, not task instructions
    note ? `Approval note (as submitted):\n\n${fenced(note, "text")}` : null,
    "## How to execute (board-authenticated callers only)",
    [
      `For each approved file below, \`PUT /api/agents/${agentId}/instructions-bundle/file\` with JSON body \`{ "path": "<path>", "content": "<approved content>", "baseHash": <reviewed base listed under that file> }\`.`,
      "",
      "The reviewed base is the file's state when this bundle was approved, so the route rejects the write (409) if the file changed since. On a 409, stop and get the newer edit reviewed. Do not re-read the file and retry with its new hash: that would overwrite the newer edit.",
      "Agent-authenticated callers receive 403 by design; do not work around the gate.",
    ].join("\n"),
    "## Proof of application",
    [
      "Each PUT response carries the written file's `contentHash`. It must equal the expected hash listed under that file below.",
      "Record each file's returned `contentHash` on this issue before closing it.",
    ].join("\n"),
    `## Approved bundle (fingerprint \`${fingerprint}\`)`,
    fileSections,
  ]
    .filter((section): section is string => section !== null)
    .join("\n\n");
}

/**
 * Creates the board-authenticated apply task for an approved instruction-generation
 * approval. Idempotent across approvals: an open apply task for the same agent and
 * the same bundle fingerprint is reused instead of duplicated.
 *
 * Failures are non-fatal for the approval transition (which has already committed):
 * we log and write to activity, never throw.
 */
export async function createInstructionApplyTask(
  db: Db,
  input: CreateInstructionApplyTaskInput,
): Promise<InstructionApplyTaskResult | null> {
  const { companyId, approvalId, decidedByUserId, payload } = input;

  try {
    const agentId = typeof payload.agentId === "string" ? payload.agentId : null;
    const files = agentId ? parseBundleFiles(payload) : null;
    if (!agentId || !files) {
      logger.warn(
        { companyId, approvalId },
        "instruction apply hook: approval payload missing agentId or bundle files, skipping",
      );
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "instruction_apply_hook",
        action: "instruction_apply_hook.invalid_payload",
        entityType: "approval",
        entityId: approvalId,
        details: { hasAgentId: Boolean(agentId) },
      });
      return null;
    }

    const agent = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) {
      logger.warn(
        { companyId, approvalId, agentId },
        "instruction apply hook: target agent not found in company, skipping",
      );
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "instruction_apply_hook",
        action: "instruction_apply_hook.agent_not_found",
        entityType: "approval",
        entityId: approvalId,
        details: { agentId },
      });
      return null;
    }

    // The task promises a 409 on drift, so only generate it when every write is base-checked.
    const unguardedPaths = files.map((file) => file.path).filter((path) => !hasGuardedWritePath(agent, path));
    if (unguardedPaths.length > 0) {
      logger.warn(
        { companyId, approvalId, agentId, unguardedPaths },
        "instruction apply hook: bundle has files without a base-checked write path, skipping",
      );
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "instruction_apply_hook",
        action: "instruction_apply_hook.unsupported_bundle",
        entityType: "approval",
        entityId: approvalId,
        details: { agentId, bundleMode: agentInstructionsBundleMode(agent), unguardedPaths },
      });
      return null;
    }

    const scope = await resolveApplyTaskScope(db, { companyId, approvalId, payload });
    if ("unsupported" in scope) {
      logger.warn(
        { companyId, approvalId, agentId },
        "instruction apply hook: approval links tasks under different privacy roots, skipping",
      );
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "instruction_apply_hook",
        action: "instruction_apply_hook.private_scope_unsupported",
        entityType: "approval",
        entityId: approvalId,
        details: { agentId },
      });
      return null;
    }

    // Files without a recorded review base are pinned to their state at approval time,
    // so a later edit makes the apply write 409 instead of being overwritten.
    const reviewedFiles: ReviewedInstructionFile[] = await Promise.all(
      files.map(async (file) => ({
        ...file,
        baseHash: file.baseHash !== undefined ? file.baseHash : await currentContentHash(db, agent, file.path),
      })),
    );

    const fingerprint = computeInstructionBundleFingerprint(agentId, reviewedFiles);
    const note = typeof payload.note === "string" && payload.note.trim() ? payload.note.trim() : null;

    // Lookup and insert share one lock so concurrent approvals of the same bundle yield one task.
    const result = await db.transaction(async (tx) => {
      const lockKey = `${INSTRUCTION_APPLY_ORIGIN_KIND}:${companyId}:${agentId}:${fingerprint}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const existing = await tx
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, INSTRUCTION_APPLY_ORIGIN_KIND),
            eq(issues.originId, agentId),
            eq(issues.originFingerprint, fingerprint),
            // Reuse only within the same privacy scope, so an approval never links to a task outside it.
            // Match the saved privacy parent: depth flattening can place the task beside a nested source.
            scope.parentId
              ? eq(issues.privacyParentIssueId, scope.parentId)
              : and(isNull(issues.privacyParentIssueId), isNull(issues.privacyRootIssueId)),
            isNull(issues.hiddenAt),
            notInArray(issues.status, APPLY_TASK_TERMINAL_STATUSES),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (existing) return { issueId: existing.id, created: false };

      const issue = await issueService(db).create(
        companyId,
        {
          title: `Apply approved instruction bundle — ${singleLine(agent.name)}`,
          description: buildApplyTaskDescription({
            agentId,
            agentName: agent.name,
            approvalId,
            fingerprint,
            files: reviewedFiles,
            note,
          }),
          status: "todo",
          priority: "high",
          originKind: INSTRUCTION_APPLY_ORIGIN_KIND,
          originId: agentId,
          originFingerprint: fingerprint,
          createdByUserId: decidedByUserId,
          // Inherit the privacy of the task that restricts the approval
          ...(scope.parentId ? { parentId: scope.parentId } : {}),
        },
        tx,
      );
      return { issueId: issue.id, created: true };
    });

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "instruction_apply_hook",
      action: result.created ? "approval.apply_task_created" : "approval.apply_task_deduped",
      entityType: "issue",
      entityId: result.issueId,
      details: { approvalId, agentId, fingerprint },
    });

    return result;
  } catch (err) {
    logger.error(
      { err, companyId, approvalId },
      "instruction apply hook: failed to create apply task",
    );
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "instruction_apply_hook",
      action: "instruction_apply_hook.error",
      entityType: "approval",
      entityId: approvalId,
      details: { error: err instanceof Error ? err.message : String(err) },
    }).catch(() => {});
    return null;
  }
}
