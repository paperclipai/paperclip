import { describeError } from "@/api/errors";
import { useQuery } from "@tanstack/react-query";
import { grokBotApi } from "@/api/grokBot";
import { Link } from "@/lib/router";
import { useTranslation } from "@/i18n";
/** Reports observed Paperclip activity; this is not a provider availability indicator. */
export function GrokBotWorkSummary({ companyId, agentId }: { companyId: string; agentId: string }) {
  const { t } = useTranslation();
  const state = useQuery({ queryKey: ["grok-binding", companyId, agentId], queryFn: ({ signal }) => grokBotApi.connection(companyId, agentId, signal), refetchInterval: 10000 });
  const data = state.data, binding = data?.binding, routine = binding?.routine;
  return <div className="space-y-2 text-sm">
    {state.error && <p role="alert" className="text-destructive">{t("apps.GrokBotWorkSummary.connectionStatusCouldNot")} {describeError(state.error).body}</p>}
    <p>{data?.recoveryNeeded ? t("apps.GrokBotWorkSummary.recoveryNeeded") : binding?.assignment?.status === "offered" ? t("apps.GrokBotWorkSummary.awaitingAcknowledgement") : binding?.assignment ? t("apps.GrokBotWorkSummary.workingInGrokBot") : routine?.verified ? t("apps.GrokBotWorkSummary.noActivePaperclipWork") : t("apps.GrokBotWorkSummary.connectionSetupIncomplete")}</p>
    {data?.currentTask && <Link className="underline" to={`/issues/${data.currentTask.id}`}>{data.currentTask.identifier}: {data.currentTask.title}</Link>}
    <p className="text-muted-foreground">{t("apps.GrokBotWorkSummary.queuedTasks")} {data?.queuedTaskCount ?? t("apps.GrokBotWorkSummary.checking")}</p>
    <p className="text-muted-foreground">{t("apps.GrokBotWorkSummary.lastContact")} {routine?.lastContactAt ? new Date(routine.lastContactAt).toLocaleString() : t("apps.GrokBotWorkSummary.notObserved")}</p>
    <p className="text-xs text-muted-foreground">{t("apps.GrokBotWorkSummary.showsPaperclipReportedActivity")}</p>
  </div>;
}
