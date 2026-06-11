import { createHash } from "node:crypto";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
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
}

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
    const { path, content } = entry as Record<string, unknown>;
    if (typeof path !== "string" || !path.trim() || typeof content !== "string") return null;
    files.push({ path, content });
  }
  return files;
}

/** Stable fingerprint of an approved bundle: same agent + same file set = same fingerprint. */
export function computeInstructionBundleFingerprint(
  agentId: string,
  files: InstructionBundleFile[],
): string {
  const canonical = JSON.stringify({
    agentId,
    files: [...files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => ({ path: file.path, content: file.content })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function buildApplyTaskDescription(input: {
  agentId: string;
  agentName: string;
  approvalId: string;
  fingerprint: string;
  files: InstructionBundleFile[];
  note: string | null;
}): string {
  const { agentId, agentName, approvalId, fingerprint, files, note } = input;
  const fileSections = files
    .map(
      (file) =>
        `### \`${file.path}\`\n\n` +
        // 4-backtick fence so bundle content containing ``` renders intact
        "````markdown\n" +
        file.content +
        (file.content.endsWith("\n") ? "" : "\n") +
        "````",
    )
    .join("\n\n");

  return [
    `Board-authenticated apply task auto-created from instruction-generation approval \`${approvalId}\` for agent **${agentName}** (\`${agentId}\`).`,
    note ? `> ${note}` : null,
    "## How to execute (board-authenticated callers only)",
    [
      "For each approved file below, write it through the gated route:",
      "",
      `\`PUT /api/agents/${agentId}/instructions-bundle/file\` with JSON body \`{ "path": "<path>", "content": "<approved content>" }\``,
      "",
      "Agent-authenticated callers receive 403 by design; do not work around the gate.",
    ].join("\n"),
    "## Proof of application",
    [
      `After the write(s), \`GET /api/agents/${agentId}/config-revisions\` must show a new revision with \`source: "instructions_bundle_file_put"\`.`,
      "Record the resulting config-revision id on this issue before closing it.",
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

    const fingerprint = computeInstructionBundleFingerprint(agentId, files);

    const existing = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, INSTRUCTION_APPLY_ORIGIN_KIND),
          eq(issues.originId, agentId),
          eq(issues.originFingerprint, fingerprint),
          isNull(issues.hiddenAt),
          notInArray(issues.status, APPLY_TASK_TERMINAL_STATUSES),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (existing) {
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "instruction_apply_hook",
        action: "approval.apply_task_deduped",
        entityType: "issue",
        entityId: existing.id,
        details: { approvalId, agentId, fingerprint },
      });
      return { issueId: existing.id, created: false };
    }

    const note = typeof payload.note === "string" && payload.note.trim() ? payload.note.trim() : null;
    const issue = await issueService(db).create(companyId, {
      title: `Apply approved instruction bundle — ${agent.name}`,
      description: buildApplyTaskDescription({
        agentId,
        agentName: agent.name,
        approvalId,
        fingerprint,
        files,
        note,
      }),
      status: "todo",
      priority: "high",
      originKind: INSTRUCTION_APPLY_ORIGIN_KIND,
      originId: agentId,
      originFingerprint: fingerprint,
      createdByUserId: decidedByUserId,
    });

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "instruction_apply_hook",
      action: "approval.apply_task_created",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId, agentId, fingerprint },
    });

    return { issueId: issue.id, created: true };
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
