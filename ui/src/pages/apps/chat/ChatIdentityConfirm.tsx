import { useTranslation } from "@/i18n";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { chatEndpointsApi, type ChatProvider } from "@/api/chatEndpoints";
import { healthApi } from "@/api/health";
import { authApi } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { queryKeys } from "@/lib/queryKeys";
import { Navigate, useSearchParams } from "@/lib/router";

const providerNames: Record<ChatProvider, string> = {
  speko: "Speko",
  slack: "Slack",
  github: "GitHub",
  discord: "Discord",
  "microsoft-teams": "Microsoft Teams",
  telegram: "Telegram",
  agentmail: "AgentMail",
  "imessage-photon": "iMessage Photon",
};

export function ChatIdentityConfirm() {
  const { t } = useTranslation("connections");
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [confirmed, setConfirmed] = useState(false);
  const health = useQuery({ queryKey: queryKeys.health, queryFn: healthApi.get });
  const healthView = useQueryView(health);
  const local = health.data?.deploymentMode === "local_trusted";
  const session = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const sessionView = useQueryView(session);
  const preview = useQuery({
    queryKey: ["chat-identity-link-preview", token],
    queryFn: () => chatEndpointsApi.previewIdentityLink(token),
    enabled: token.length >= 32 && (local || Boolean(session.data)),
    refetchInterval: confirmed ? false : 3_000,
  });
  const previewView = useQueryView(preview);
  const confirm = useMutation({
    mutationFn: () => chatEndpointsApi.confirmIdentityLink(token),
    onSuccess: () => setConfirmed(true),
  });

  const requestAccess = useMutation({
    mutationFn: () => chatEndpointsApi.requestIdentityAccess(token),
  });
  const accountFailure = healthView.kind === "error" ? healthView : !local && sessionView.kind === "error" ? sessionView : null;
  if (accountFailure) {
    return (
      <main className="mx-auto max-w-lg px-6 py-12">
        <QueryErrorState size="page" error={accountFailure.error} action="load your account" onRetry={accountFailure.retry} retrying={accountFailure.isFetching} />
      </main>
    );
  }
  if (health.isSuccess && !local && session.isSuccess && !session.data) {
    return <Navigate to={`/auth?next=${encodeURIComponent(`/chat-identity/confirm?token=${token}`)}`} replace />;
  }
  // The server rejects a bad, expired, used, or foreign link with a client
  // error; an outage or server fault is not a verdict on the link.
  const previewRejected = !confirmed && previewView.kind === "error"
    && previewView.errorKind !== "transient" && previewView.errorKind !== "unknown";
  if (token.length < 32 || previewRejected) {
    return (
      <main className="mx-auto max-w-lg space-y-4 px-6 py-12">
        <h1 className="text-xl font-bold">{t("this_identity_link_is_unavailable_8ac34cb")}</h1>
        <p className="text-sm text-muted-foreground">{t("the_link_is_invalid_expired_already_used_fa88df2")}</p>
      </main>
    );
  }
  if (!confirmed && previewView.kind === "error") {
    return (
      <main className="mx-auto max-w-lg px-6 py-12">
        <QueryErrorState size="page" error={preview.error} action="load the identity link" onRetry={previewView.retry} retrying={previewView.isFetching} />
      </main>
    );
  }
  if (health.isPending || healthView.kind === "reconnecting" || preview.isLoading || previewView.kind === "reconnecting"
    || (!local && (session.isLoading || sessionView.kind === "reconnecting")) || !preview.data) {
    return (
      <main className="flex items-center justify-center gap-2 px-6 py-12 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />{t("checking_identity_link_b2e67f6")}</main>
    );
  }
  const identity = preview.data;
  const paperclipAccount = local ? t("local_board_12547fc") :
    session.data?.user.name?.trim() ||
    session.data?.user.email?.trim() ||
    session.data?.user.id ||
    t("the_signed_in_account_870cfb3");
  if (confirmed) {
    return (
      <main className="mx-auto max-w-lg space-y-5 px-6 py-12">
        <CheckCircle2 className="h-8 w-8" />
        <div>
          <h1 className="text-xl font-bold">{t("identity_linked_360aea5")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("future_messages_from_use_your_current_paperclip_0899076", { externalLabel: identity.externalLabel, companyName: identity.companyName })}</p>
        </div>
        {identity.provider === "slack" && <Button asChild><a href="https://app.slack.com/" target="_blank" rel="noopener noreferrer">{t("return_to_slack_d2ac729")}</a></Button>}
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-lg space-y-6 px-6 py-12">
      <div>
        <p className="text-sm text-muted-foreground">{identity.companyName}</p>
        <h1 className="mt-1 text-xl font-bold">{t("link_your_external_identity_8253324")}</h1>
      </div>
      <dl className="divide-y divide-border border-y border-border">
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted-foreground">{t("provider_7ceee3f")}</dt>
          <dd className="text-sm font-medium">
            {providerNames[identity.provider]}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted-foreground">{t("external_identity_5b5ea6f")}</dt>
          <dd className="text-right text-sm font-medium">
            {identity.externalLabel}
            {identity.externalDetail ? ` · ${identity.externalDetail}` : ""}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted-foreground">{t("paperclip_account_6d4034f")}</dt>
          <dd className="text-right text-sm font-medium">{paperclipAccount}</dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted-foreground">{t("agent_5ce2e6f")}</dt>
          <dd className="text-sm font-medium">
            {identity.botLabel ?? t("paperclip_agent_6e4c737")}
          </dd>
        </div>
      </dl>
      <p className="text-sm text-muted-foreground">{t("confirm_only_if_this_is_your_identity_b414e84", { value: providerNames[identity.provider] })}</p>
      {confirm.error ? (
        <p className="text-sm text-destructive">{t("this_link_could_not_be_confirmed_it_542e1c3")}</p>
      ) : null}
      {identity.canConfirm === false ? (
        <div className="space-y-3">
          <p className="text-sm">{t("you_need_membership_in_before_linking_this_4a79f70", { companyName: identity.companyName })}</p>
          {requestAccess.isSuccess ? <p role="status" className="text-sm">{t("access_requested_an_admin_can_approve_it_d698bc1")}</p>
            : <Button disabled={requestAccess.isPending || !identity.selfService} onClick={() => requestAccess.mutate()}>{t("request_access_859ca6c")}</Button>}
          {requestAccess.error ? <p role="alert" className="text-sm text-destructive">{t("couldn_t_request_access_the_link_may_d72a231")}</p> : null}
        </div>
      ) : <Button disabled={confirm.isPending} onClick={() => confirm.mutate()}>
        {confirm.isPending && <Loader2 className="h-4 w-4 animate-spin" />}{t("confirm_identity_e8cb47a")}</Button>}
    </main>
  );
}
