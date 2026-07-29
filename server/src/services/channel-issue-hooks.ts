import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Fire-and-forget channel sync from issue/interaction mutations.
 *
 * Uses dynamic import of `channelService` so this module does not create a
 * static cycle with `channels.ts` → `issues.ts`.
 *
 * Failures never fail the calling mutation — channels are additive.
 */
export async function syncChannelAfterIssueCreated(
  db: Db,
  issue: {
    id: string;
    companyId: string;
    projectId: string | null;
    title: string;
    parentId?: string | null;
    assigneeAgentId?: string | null;
    identifier?: string | null;
  },
  options: { skipRoot?: boolean } = {},
): Promise<void> {
  try {
    const { channelService } = await import("./channels.js");
    const channels = channelService(db);
    if (!(await channels.channelsEnabled(issue.companyId))) return;

    if (!options.skipRoot && issue.projectId) {
      await channels.ensureTaskRootMessage(issue.companyId, {
        id: issue.id,
        projectId: issue.projectId,
        title: issue.title,
        assigneeAgentId: issue.assigneeAgentId ?? null,
      });
      if (issue.assigneeAgentId) {
        await channels.ensureAgentMembershipForIssue(issue.companyId, issue.projectId, issue.assigneeAgentId);
      }
    }

    if (issue.parentId) {
      await channels.linkChildIssueInParentThread({
        companyId: issue.companyId,
        parentIssueId: issue.parentId,
        child: {
          id: issue.id,
          title: issue.title,
          identifier: issue.identifier ?? null,
          projectId: issue.projectId,
        },
      });
    }
  } catch (error) {
    logger.warn({ err: error, issueId: issue.id }, "channel sync after issue create failed");
  }
}

export async function syncChannelAfterIssueUpdated(
  db: Db,
  before: {
    id: string;
    companyId: string;
    projectId: string | null;
    title: string;
    assigneeAgentId?: string | null;
    identifier?: string | null;
  },
  after: {
    id: string;
    companyId: string;
    projectId: string | null;
    title: string;
    assigneeAgentId?: string | null;
    identifier?: string | null;
  },
): Promise<void> {
  try {
    const { channelService } = await import("./channels.js");
    const channels = channelService(db);
    if (!(await channels.channelsEnabled(after.companyId))) return;

    const projectChanged = before.projectId !== after.projectId;
    if (projectChanged) {
      await channels.moveIssueToProject({
        companyId: after.companyId,
        issueId: after.id,
        title: after.title,
        identifier: after.identifier ?? null,
        fromProjectId: before.projectId,
        toProjectId: after.projectId,
      });
    } else if (after.projectId) {
      await channels.ensureTaskRootMessage(after.companyId, {
        id: after.id,
        projectId: after.projectId,
        title: after.title,
        assigneeAgentId: after.assigneeAgentId ?? null,
      });
    }

    if (
      after.projectId
      && after.assigneeAgentId
      && after.assigneeAgentId !== before.assigneeAgentId
    ) {
      await channels.ensureAgentMembershipForIssue(
        after.companyId,
        after.projectId,
        after.assigneeAgentId,
      );
    }
  } catch (error) {
    logger.warn({ err: error, issueId: after.id }, "channel sync after issue update failed");
  }
}

export async function syncChannelAfterInteractionCreated(
  db: Db,
  interaction: {
    id: string;
    companyId: string;
    issueId: string;
    kind: string;
    title?: string | null;
    summary?: string | null;
  },
): Promise<void> {
  try {
    const { channelService } = await import("./channels.js");
    const channels = channelService(db);
    if (!(await channels.channelsEnabled(interaction.companyId))) return;
    await channels.postInteractionCard({
      companyId: interaction.companyId,
      issueId: interaction.issueId,
      interactionId: interaction.id,
      kind: interaction.kind,
      title: interaction.title ?? null,
      summary: interaction.summary ?? null,
    });
  } catch (error) {
    logger.warn(
      { err: error, interactionId: interaction.id },
      "channel sync after interaction create failed",
    );
  }
}
