import { useQuery } from "@tanstack/react-query";
import { grokBotApi } from "@/api/grokBot";
import { Link } from "@/lib/router";
/** Reports observed Paperclip activity; this is not a provider availability indicator. */
export function GrokBotWorkSummary({ companyId, agentId }: { companyId: string; agentId: string }) {
  const state = useQuery({ queryKey: ["grok-binding", companyId, agentId], queryFn: ({ signal }) => grokBotApi.connection(companyId, agentId, signal), retry: false, refetchInterval: 10000 });
  const data = state.data, binding = data?.binding, routine = binding?.routine;
  return <div className="space-y-2 text-sm">
    {state.error && <p role="alert" className="text-destructive">Connection status could not be refreshed. {state.error.message}</p>}
    <p>{data?.recoveryNeeded ? "Recovery needed" : binding?.assignment?.status === "offered" ? "Awaiting acknowledgement" : binding?.assignment ? "Working in Grok Bot" : routine?.verified ? "No active Paperclip work session" : "Connection setup incomplete"}</p>
    {data?.currentTask && <Link className="underline" to={`/issues/${data.currentTask.id}`}>{data.currentTask.identifier}: {data.currentTask.title}</Link>}
    <p className="text-muted-foreground">Queued tasks: {data?.queuedTaskCount ?? "Checking…"}</p>
    <p className="text-muted-foreground">Last contact: {routine?.lastContactAt ? new Date(routine.lastContactAt).toLocaleString() : "Not observed"}</p>
    <p className="text-xs text-muted-foreground">Shows Paperclip-reported activity. Open the Grok Bot desktop app to inspect the Bot’s complete activity.</p>
  </div>;
}
