import { i18n, t, useTranslation } from "@/i18n";
import { useQuery } from "@tanstack/react-query";
import { grokBotApi } from "@/api/grokBot";
import { Link } from "@/lib/router";
/** Reports observed Paperclip activity; this is not a provider availability indicator. */
export function GrokBotWorkSummary({ companyId, agentId }: { companyId: string; agentId: string }) {
  useTranslation();
  const state = useQuery({ queryKey: ["grok-binding", companyId, agentId], queryFn: ({ signal }) => grokBotApi.connection(companyId, agentId, signal), retry: false, refetchInterval: 10000 });
  const data = state.data, binding = data?.binding, routine = binding?.routine;
  return <div className="space-y-2 text-sm">
    {state.error && <p role="alert" className="text-destructive">{t("oct19Voice.statusRefreshFailed", { message: state.error.message })}</p>}
    <p>{data?.recoveryNeeded ? t("oct19Voice.recoveryNeeded_r3xtgz") : binding?.assignment?.status === "offered" ? t("oct19Voice.awaitingAcknowledgement_b2lazn") : binding?.assignment ? t("oct19Voice.workingInGrokBot_170g7vv") : routine?.verified ? t("oct19Voice.noActivePaperclipWorkSession_zfcni5") : t("oct19Voice.connectionSetupIncomplete_le0g14")}</p>
    {data?.currentTask && <Link className="underline" to={`/issues/${data.currentTask.id}`}>{data.currentTask.identifier}: {data.currentTask.title}</Link>}
    <p className="text-muted-foreground">{t("oct19Voice.queuedTasks", { value: data?.queuedTaskCount ?? t("oct19Voice.checking_vyewnp") })}</p>
    <p className="text-muted-foreground">{t("oct19Voice.lastContact", { time: routine?.lastContactAt ? new Date(routine.lastContactAt).toLocaleString(i18n.resolvedLanguage) : t("oct19Voice.notObserved_b5c68i") })}</p>
    <p className="text-xs text-muted-foreground">{t("oct19Voice.showsPaperclipReportedActivityOpenThe_8pxf6h")}</p>
  </div>;
}
