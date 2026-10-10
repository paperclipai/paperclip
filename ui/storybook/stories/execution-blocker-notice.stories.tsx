import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExecutionBlockerNotice } from "@/components/ExecutionBlockerNotice";
import { queryKeys } from "@/lib/queryKeys";

const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
client.setQueryData(queryKeys.issues.runs("storybook-recovery"), [
  { runId: "stopped-run", agentId: "agent", status: "failed" },
]);
const meta = {
  title: "Task chat/Recovery notice",
  component: ExecutionBlockerNotice,
  decorators: [Story => <QueryClientProvider client={client}><div className="max-w-2xl"><Story /></div></QueryClientProvider>],
  args: {
    companyId: "storybook-company", issueId: "storybook-recovery", onRetried: () => {},
    blocker: {
      recoveryActionId: "recovery", runId: "stopped-run", agentId: "agent",
      cause: "legacy_execution_requires_reconciliation",
      nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
    },
  },
} satisfies Meta<typeof ExecutionBlockerNotice>;
export default meta;
export const Stopped: StoryObj<typeof meta> = {};
