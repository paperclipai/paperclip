import { useTranslation } from "@/i18n";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Copy, ExternalLink, Loader2 } from "lucide-react";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import { useQueryView } from "@/components/QueryView";
import { copyTextToClipboard } from "@/lib/clipboard";
import { queryKeys } from "@/lib/queryKeys";

export function SlackIdentityStep({ endpointId, command, testStartedAt, onConnected, onSaveExit }: {
  endpointId: string;
  command: string;
  testStartedAt?: string | null;
  onConnected: () => void;
  onSaveExit: () => void;
}) {
  const { t } = useTranslation("connections");
  const client = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: authApi.getSession });
  const sessionView = useQueryView(session);
  const health = useQuery({ queryKey: queryKeys.health, queryFn: healthApi.get });
  const healthView = useQueryView(health);
  const identities = useQuery({
    queryKey: queryKeys.chatEndpoints.principals(endpointId),
    queryFn: () => chatEndpointsApi.listPrincipals(endpointId),
    refetchInterval: 1_500,
  });
  const identitiesView = useQueryView(identities);
  const local = health.data?.deploymentMode === "local_trusted";
  const userId = local ? "local-board" : session.data?.user.id;
  const userLabel = local ? t("local_board_12547fc") : session.data?.user.name || session.data?.user.email;
  const candidates = (identities.data ?? []).filter((identity) => identity.lastConnectAt &&
    (!testStartedAt || Date.parse(identity.lastConnectAt) >= Date.parse(testStartedAt)));
  const linkedToMe = candidates.some((identity) => identity.status === "linked" && identity.paperclipUserId === userId);
  const connectCommand = `${command} connect`;
  const link = useMutation({
    mutationFn: async (principalId: string) => {
      const { confirmationUrl } = await chatEndpointsApi.createLinkIntent(endpointId, principalId);
      const token = new URL(confirmationUrl, window.location.origin).searchParams.get("token");
      if (!token) throw new Error(t("could_not_create_the_account_confirmation_try_7cc4106"));
      await chatEndpointsApi.confirmIdentityLink(token);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.chatEndpoints.principals(endpointId) }),
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">{t("connect_your_slack_account_6406348")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("send_this_command_in_slack_so_we_efcb6a4")}</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
        <code className="text-sm">{connectCommand}</code>
        <Button variant="ghost" size="sm" onClick={() => {
          void copyTextToClipboard(connectCommand).then(() => { setCopied(true); setCopyError(false); }, () => setCopyError(true));
        }}><Copy className="size-4" />{copied ? t("copied_8e3df45") : t("copy_command_a8e1047")}</Button>
      </div>
      {copyError && <p role="alert" className="text-sm text-destructive">{t("couldn_t_copy_the_command_select_and_2f9f9fd")}</p>}
      <p className="text-sm">
        <a href="https://app.slack.com/" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">{t("open_slack_8245d1b")}<ExternalLink className="inline size-3" /></a>{t("send_the_command_in_your_workspace_then_5f82c17")}</p>
      {identitiesView.kind === "error" ? (
        <p role="alert" className="text-sm text-destructive">{t("couldn_t_check_for_your_slack_account_e7df823")}</p>
      ) : candidates.length === 0 ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("waiting_for_your_connect_command_b58907f")}</p>
      ) : (
        <div className={`space-y-3 rounded-lg border p-4 ${linkedToMe
          ? "border-(--status-task-done)/30 bg-(--status-task-done)/10"
          : "border-(--status-task-todo)/30 bg-(--status-task-todo)/10"}`}>
          <p className="text-sm">{t("choose_your_slack_account_below_to_link_621ac8b")}<strong>{userLabel ?? t("your_paperclip_account_456506f")}</strong>{t("only_confirm_an_account_that_belongs_to_c139509")}</p>
          {candidates.map((identity) => {
            const mine = identity.status === "linked" && identity.paperclipUserId === userId;
            return (
              <div key={identity.principalId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{identity.externalLabel}</p>
                  <p className="text-xs text-muted-foreground">{identity.externalDetail}</p>
                </div>
                {mine ? <p role="status" className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4 text-(--status-task-done)" />{t("linked_to_you_572a13d")}</p>
                  : identity.status === "linked" ? <p className="text-sm text-muted-foreground">{t("linked_to_a6630a2", { accountName: identity.paperclipUserLabel ?? t("reviewBAnotherAccount") })}</p>
                  : <Button variant="outline" disabled={!userId || link.isPending} onClick={() => link.mutate(identity.principalId)} aria-label={t("link_to_my_paperclip_account_f7b675b", { externalLabel: identity.externalLabel })}>
                    {link.isPending && link.variables === identity.principalId && <Loader2 className="size-4 animate-spin" />}{t("this_is_my_slack_account_d9e292a")}</Button>}
              </div>
            );
          })}
        </div>
      )}
      {!userId && !session.isPending && !health.isPending && sessionView.kind !== "reconnecting" && healthView.kind !== "reconnecting" && <p role="alert" className="text-sm text-destructive">{t("sign_in_to_paperclip_to_link_your_b24c917")}</p>}
      {link.error ? <p role="alert" className="text-sm text-destructive">{t("couldn_t_link_your_account_check_that_1fc4d33")}</p> : null}
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" className="text-muted-foreground" onClick={onSaveExit}>{t("save_exit_fc5599f")}</Button>
        {linkedToMe && <Button onClick={onConnected}>{t("continue_to_message_test_3115171")}</Button>}
      </div>
    </div>
  );
}
