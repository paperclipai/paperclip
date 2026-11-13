import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerDeadlineWork } from "./deadline-work.js";
import type { heartbeatService } from "./heartbeat.js";
import type { createToolGatewayService } from "./tool-gateway.js";

/**
 * Background polling for provider tasks (MCP Tasks) that outlived the call
 * that started them, including across restarts and deploys.
 *
 * Trigger: a task row written or released by a live call notifies this queue;
 * startup runs once and reconstructs from the rows. Deadline: the earliest
 * `next_poll_at` (never earlier than a live call's lease). Quiet: no row has a
 * next poll, which is true once every task is delivered, expired, or woken.
 */
export function registerMcpTaskWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  gateway: Pick<ReturnType<typeof createToolGatewayService>, "pollDueMcpTasks" | "nextMcpTaskPollAt">,
  heartbeat: Pick<ReturnType<typeof heartbeatService>, "wakeup"> | null,
  canRun: () => boolean,
) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.mcpTasks, {
    retryMs: 30_000,
    continuationMs: 1_000,
    canRun,
    run: (signal) => gateway.pollDueMcpTasks({
      signal,
      wake: heartbeat ? async (task) => {
        // The agent's repeated call collects the result; nothing is replayed.
        await heartbeat.wakeup(task.agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: { issueId: task.issueId, mutation: "tool_task" },
          // Distinct per reason: an input wake must never stand in for the completion wake.
          idempotencyKey: task.wakeKey,
          requestedByActorType: "system",
          requestedByActorId: "tool_gateway",
          contextSnapshot: {
            issueId: task.issueId,
            taskId: task.issueId,
            mutation: "tool_task",
            wakeReason: "issue_commented",
            source: "mcp_task.settled",
            toolTask: { tool: task.toolName, status: task.status },
          },
          issueStateGuard: { statuses: ["todo", "in_progress", "in_review", "blocked"], assigneeAgentId: task.agentId },
        });
      } : undefined,
    }),
    next: () => gateway.nextMcpTaskPollAt(),
  });
}
