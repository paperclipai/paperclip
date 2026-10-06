import { Trans } from "react-i18next";
import { t, useTranslation } from "@/i18n";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Copy, ExternalLink, Loader2 } from "lucide-react";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/clipboard";
import { queryKeys } from "@/lib/queryKeys";

export function SlackIdentityStep({ endpointId, command, testStartedAt, onConnected, onSaveExit }: {
  endpointId: string;
  command: string;
  testStartedAt?: string | null;
  onConnected: () => void;
  onSaveExit: () => void;
}) {
  useTranslation();
  const client = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: authApi.getSession, retry: false });
  const health = useQuery({ queryKey: queryKeys.health, queryFn: healthApi.get });
  const identities = useQuery({
    queryKey: queryKeys.chatEndpoints.principals(endpointId),
    queryFn: () => chatEndpointsApi.listPrincipals(endpointId),
    refetchInterval: 1_500,
  });
  const local = health.data?.deploymentMode === "local_trusted";
  const userId = local ? "local-board" : session.data?.user.id;
  const userLabel = local ? t("sep28Apps.localBoard") : session.data?.user.name || session.data?.user.email;
  const candidates = (identities.data ?? []).filter((identity) => identity.lastConnectAt &&
    (!testStartedAt || Date.parse(identity.lastConnectAt) >= Date.parse(testStartedAt)));
  const linkedToMe = candidates.some((identity) => identity.status === "linked" && identity.paperclipUserId === userId);
  const connectCommand = `${command} connect`;
  const link = useMutation({
    mutationFn: async (principalId: string) => {
      const { confirmationUrl } = await chatEndpointsApi.createLinkIntent(endpointId, principalId);
      const token = new URL(confirmationUrl, window.location.origin).searchParams.get("token");
      if (!token) throw new Error(t("sep28Apps.copy197"));
      await chatEndpointsApi.confirmIdentityLink(token);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.chatEndpoints.principals(endpointId) }),
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">{t("sep28Apps.copy198")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("sep28Apps.copy199")}</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
        <code className="text-sm">{connectCommand}</code>
        <Button variant="ghost" size="sm" onClick={() => {
          void copyTextToClipboard(connectCommand).then(() => { setCopied(true); setCopyError(false); }, () => setCopyError(true));
        }}><Copy className="size-4" />{copied ? t("pages.agentDetail.copied") : t("sep28Apps.copy200")}</Button>
      </div>
      {copyError && <p role="alert" className="text-sm text-destructive">{t("sep28Apps.copy201")}</p>}
      <p className="text-sm">
        <Trans i18nKey="sep28Apps.openSlackCommand" components={{ slack: <a href="https://app.slack.com/" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4" /> }} />
      </p>
      {identities.isError ? (
        <p role="alert" className="text-sm text-destructive">{t("sep28Apps.copy203")}</p>
      ) : candidates.length === 0 ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("sep28Apps.copy204")}</p>
      ) : (
        <div className={`space-y-3 rounded-lg border p-4 ${linkedToMe
          ? "border-(--status-task-done)/30 bg-(--status-task-done)/10"
          : "border-(--status-task-todo)/30 bg-(--status-task-todo)/10"}`}>
          <p className="text-sm"><Trans i18nKey="sep28Apps.slackAccountLink" values={{ user: userLabel ?? t("sep28Apps.paperclipAccount") }} components={{ user: <strong /> }} /></p>
          {candidates.map((identity) => {
            const mine = identity.status === "linked" && identity.paperclipUserId === userId;
            return (
              <div key={identity.principalId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{identity.externalLabel}</p>
                  <p className="text-xs text-muted-foreground">{identity.externalDetail}</p>
                </div>
                {mine ? <p role="status" className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4 text-(--status-task-done)" />{t("sep28Apps.copy205")}</p>
                  : identity.status === "linked" ? <p className="text-sm text-muted-foreground">{t("sep28Apps.linkedOther", { user: identity.paperclipUserLabel ?? t("sep28Apps.anotherAccount") })}</p>
                  : <Button variant="outline" disabled={!userId || link.isPending} onClick={() => link.mutate(identity.principalId)} aria-label={t("sep28Apps.linkSlackAria", { identity: identity.externalLabel })}>
                    {link.isPending && link.variables === identity.principalId && <Loader2 className="size-4 animate-spin" />}{t("sep28Apps.copy206")}</Button>}
              </div>
            );
          })}
        </div>
      )}
      {!userId && !session.isPending && !health.isPending && <p role="alert" className="text-sm text-destructive">{t("sep28Apps.copy207")}</p>}
      {link.isError && <p role="alert" className="text-sm text-destructive">{t("sep28Apps.copy208")}</p>}
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" className="text-muted-foreground" onClick={onSaveExit}>{t("chatUi.chatEndpointSetup.saveExit")}</Button>
        {linkedToMe && <Button onClick={onConnected}>{t("sep28Apps.copy209")}</Button>}
      </div>
    </div>
  );
}
