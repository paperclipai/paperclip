import type { Meta, StoryObj } from "@storybook/react-vite";
import { IssueScheduledRetryCard } from "@/components/IssueScheduledRetryCard";

const meta = {
  parameters: { paperclip: {
      "capabilities": [
        "recovery/bounded-continuation"
      ],
      "implementation": "production",
      "boundary": "fixtures"
    } },
  id: "tasks-model-capacity-retry",
  title: "Projects and execution/Recovery/Tasks/Model capacity retry",
  component: IssueScheduledRetryCard,
  decorators: [Story => <div className="max-w-2xl"><Story /></div>],
  args: {
    issueId: "capacity-task",
    scheduledRetry: {
      runId: "capacity-retry", status: "scheduled_retry", agentId: "capacity-agent", agentName: "Codex",
      retryOfRunId: "failed-capacity-run", scheduledRetryAt: new Date(Date.now() + 60_000).toISOString(),
      scheduledRetryAttempt: 1, scheduledRetryReason: "native_provider_overloaded", retryExhaustedReason: null,
      error: "Selected model is at capacity. Please try a different model.", errorCode: "native_provider_overloaded",
    },
  },
} satisfies Meta<typeof IssueScheduledRetryCard>;
export default meta;
export const Waiting: StoryObj<typeof meta> = {};
