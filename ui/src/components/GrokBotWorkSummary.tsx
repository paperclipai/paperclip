import { useTranslation } from "@/i18n";
import { describeError } from "@/api/errors";
import { useQuery } from "@tanstack/react-query";
import { grokBotApi } from "@/api/grokBot";
import { Link } from "@/lib/router";
/** Reports observed Paperclip activity; this is not a provider availability indicator. */
export function GrokBotWorkSummary({ companyId, agentId }: { companyId: string; agentId: string }) {
  const { t, i18n } = useTranslation("connections");
  const state = useQuery({ queryKey: ["grok-binding", companyId, agentId], queryFn: ({ signal }) => grokBotApi.connection(companyId, agentId, signal), refetchInterval: 10000 });
  const data = state.data, binding = data?.binding, routine = binding?.routine;
  return <div className="space-y-2 text-sm">
    {state.error && <p role="alert" className="text-destructive">{t("connection_status_could_not_be_refreshed_09a5d7a", { body: describeError(state.error).body })}</p>}
    <p>{data?.recoveryNeeded ? t("recovery_needed_7bdda42") : binding?.assignment?.status === "offered" ? t("awaiting_acknowledgement_c351a0f") : binding?.assignment ? t("working_in_grok_bot_7bcc2c4") : routine?.verified ? t("no_active_paperclip_work_session_456c0a6") : t("connection_setup_incomplete_e158852")}</p>
    {data?.currentTask && <Link className="underline" to={`/issues/${data.currentTask.id}`}>{data.currentTask.identifier}: {data.currentTask.title}</Link>}
    <p className="text-muted-foreground">{t("queued_tasks_a9ddd38", { taskCount: data?.queuedTaskCount ?? t("reviewBChecking") })}</p>
    <p className="text-muted-foreground">{t("last_contact_1809874", { contactTime: routine?.lastContactAt ? new Date(routine.lastContactAt).toLocaleString(i18n.resolvedLanguage) : t("reviewBNotObserved") })}</p>
    <p className="text-xs text-muted-foreground">{t("shows_paperclip_reported_activity_open_the_grok_1254807")}</p>
  </div>;
}
