import { getEventRouter } from "./event-router.js";
import { KnowledgeService } from "@paperclip-ui/knowledge-service";
import { issueService } from "./issues.js";
import type { Db } from "@paperclipai/db";
import { issueComments, agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

const KNOWLEDGE_STALE_REGEX = /\[KNOWLEDGE-STALE\]\s*topic=([a-z0-9-]+)/gi;

export function extractTopicSlugFromComment(text: string): string | null {
  const match = KNOWLEDGE_STALE_REGEX.exec(text);
  if (match) {
    return match[1].toLowerCase();
  }
  return null;
}

export async function startKnowledgeRefreshHandler(db: Db): Promise<void> {
  const knowledgeService = new KnowledgeService();
  
  try {
    await knowledgeService.initialize();
    logger.info("Knowledge service initialized for stale refresh handler");
  } catch (err) {
    logger.error({ err }, "Failed to initialize knowledge service, stale refresh handler not started");
    return;
  }

  const router = getEventRouter();

  router.onEvent("issue_comment", async (event) => {
    const commentId = event.payload.entity_id;

    try {
      const commentRows = await db
        .select({
          body: issueComments.body,
          issueId: issueComments.issueId,
          authorAgentId: issueComments.authorAgentId,
          companyId: issueComments.companyId,
        })
        .from(issueComments)
        .where(eq(issueComments.id, commentId))
        .limit(1);

      if (commentRows.length === 0) {
        logger.debug({ commentId }, "Comment not found for stale check");
        return;
      }

      const comment = commentRows[0];

      if (!comment.authorAgentId) {
        logger.debug({ commentId }, "Comment has no author agent, skipping stale check");
        return;
      }

      const topicSlug = extractTopicSlugFromComment(comment.body);
      if (!topicSlug) {
        return;
      }

      const agentRows = await db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, comment.authorAgentId))
        .limit(1);

      const agentName = agentRows[0]?.name ?? "Unknown Agent";

      logger.info(
        { commentId, topicSlug, agentId: comment.authorAgentId },
        "Detected [KNOWLEDGE-STALE] trigger, initiating refresh"
      );

      const result = await knowledgeService.triggerStaleRefresh({
        topicSlug,
        agentId: comment.authorAgentId,
        agentName,
        issueLink: `issue/${comment.issueId}`,
        companyId: comment.companyId,
        priority: "medium",
      });

      const issuesSvc = issueService(db);
      const confirmationBody = result.success
        ? `[KNOWLEDGE-STALE] refresh completed for topic \`${topicSlug}\`. The knowledge base has been updated with fresh content.`
        : `[KNOWLEDGE-STALE] refresh failed for topic \`${topicSlug}\`: ${result.error}`;

      try {
        await issuesSvc.addComment(
          comment.issueId,
          confirmationBody,
          { agentId: undefined }
        );
        logger.info(
          { commentId, topicSlug, success: result.success },
          "Posted confirmation comment for stale refresh"
        );
      } catch (commentErr) {
        logger.error(
          { err: commentErr, commentId, topicSlug },
          "Failed to post confirmation comment"
        );
      }
    } catch (err) {
      logger.error({ err, commentId }, "Error processing stale refresh event");
    }
  });

  logger.info("Knowledge stale refresh handler registered for issue_comment events");
}