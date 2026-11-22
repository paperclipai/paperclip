import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * A demo tool that takes a while and reports MCP progress as it goes, so a
 * client can show it. Each step waits `stepMs`, then sends
 * `notifications/progress` for the caller's `progressToken` (when it sent
 * one). `withTotal: false` leaves `total` out, for an indeterminate display.
 */
export const SLOW_WITH_PROGRESS_TOOL = "slow_with_progress";

const schema = z.object({
  steps: z.number().int().min(1).max(100).default(5),
  stepMs: z.number().int().min(0).max(10_000).default(1_000),
  withTotal: z.boolean().default(true),
});

export function registerSlowWithProgressTool(server: McpServer): void {
  server.registerTool(
    SLOW_WITH_PROGRESS_TOOL,
    {
      description: "Wait for a few steps, reporting progress after each one. For progress demos.",
      inputSchema: schema.shape,
      annotations: { title: "Slow task with progress", readOnlyHint: true, openWorldHint: false },
    },
    async (input, extra) => {
      const { steps, stepMs, withTotal } = schema.parse(input);
      const progressToken = extra._meta?.progressToken;
      for (let step = 1; step <= steps; step++) {
        await new Promise((resolve) => setTimeout(resolve, stepMs));
        if (extra.signal.aborted) break;
        if (progressToken !== undefined) {
          await extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: step,
              ...(withTotal ? { total: steps } : {}),
              message: `Finished step ${step} of ${steps}`,
            },
          });
        }
      }
      return { content: [{ type: "text", text: JSON.stringify({ steps, completed: true }) }] };
    },
  );
}
