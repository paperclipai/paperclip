import { t, useTranslation } from "@/i18n";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { chatEndpointsApi, type ChatProvider } from "@/api/chatEndpoints";
import { healthApi } from "@/api/health";
import { authApi } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { Navigate, useSearchParams } from "@/lib/router";

const providerNames: Record<ChatProvider, string> = {
  slack: "Slack",
  github: "GitHub",
  discord: "Discord",
  "microsoft-teams": "Microsoft Teams",
  telegram: "Telegram",
  agentmail: "AgentMail",
  "imessage-photon": "iMessage Photon",
};

export function ChatIdentityConfirm() {
  useTranslation();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [confirmed, setConfirmed] = useState(false);
  const health = useQuery({ queryKey: queryKeys.health, queryFn: healthApi.get, retry: false });
  const local = health.data?.deploymentMode === "local_trusted";
  const session = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const preview = useQuery({
    queryKey: ["chat-identity-link-preview", token],
    queryFn: () => chatEndpointsApi.previewIdentityLink(token),
    enabled: token.length >= 32 && (local || Boolean(session.data)),
    refetchInterval: confirmed ? false : 3_000,
    retry: false,
  });
  const confirm = useMutation({
    mutationFn: () => chatEndpointsApi.confirmIdentityLink(token),
    onSuccess: () => setConfirmed(true),
  });

  const requestAccess = useMutation({
    mutationFn: () => chatEndpointsApi.requestIdentityAccess(token),
  });
  if (health.isError || (!local && session.isError)) return <main className="mx-auto max-w-lg px-6 py-12 text-sm text-destructive">{t("sep28Apps.accountLoadFailed")}</main>;
  if (health.isSuccess && !local && session.isSuccess && !session.data) {
    return <Navigate to={`/auth?next=${encodeURIComponent(`/chat-identity/confirm?token=${token}`)}`} replace />;
  }
  if (token.length < 32 || (!confirmed && preview.isError)) {
    return (
      <main className="mx-auto max-w-lg space-y-4 px-6 py-12">
        <h1 className="text-xl font-bold">{t("chatUi.chatIdentityConfirm.thisIdentityLinkIsUnavailable")}</h1>
        <p className="text-sm text-muted-foreground">{t("chatUi.chatIdentityConfirm.theLinkIsInvalidExpiredAlreadyUsedOrBelongsTo")}</p>
      </main>
    );
  }
  if (health.isPending || preview.isLoading || (!local && session.isLoading) || !preview.data) {
    return (
      <main className="flex items-center justify-center gap-2 px-6 py-12 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />{t("chatUi.chatIdentityConfirm.checkingIdentityLink")}</main>
    );
  }
  const identity = preview.data;
  const paperclipAccount = local ? t("sep28Apps.localBoard") :
    session.data?.user.name?.trim() ||
    session.data?.user.email?.trim() ||
    session.data?.user.id ||
    t("sep28Apps.signedInAccount");
  if (confirmed) {
    return (
      <main className="mx-auto max-w-lg space-y-5 px-6 py-12">
        <CheckCircle2 className="h-8 w-8" />
        <div>
          <h1 className="text-xl font-bold">{t("chatUi.chatIdentityConfirm.identityLinked")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("chatUi.chatIdentityConfirm.futureMessagesFromUseYourCurrentPaperclipPermissionsIn", { value0: identity.externalLabel, value1: identity.companyName })}</p>
        </div>
        {identity.provider === "slack" && <Button asChild><a href="https://app.slack.com/" target="_blank" rel="noopener noreferrer">{t("sep28Apps.returnSlack")}</a></Button>}
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-lg space-y-6 px-6 py-12">
      <div>
        <p className="text-sm text-muted-foreground">{identity.companyName}</p>
        <h1 className="mt-1 text-xl font-bold">{t("chatUi.chatIdentityConfirm.linkYourExternalIdentity")}</h1>
      </div>
      <dl className="divide-y divide-border border-y border-border">
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted-foreground">{t("localizationInspector.ui_Provider")}</dt>
          <dd className="text-sm font-medium">
            {providerNames[identity.provider]}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted-foreground">{t("chatUi.chatIdentityConfirm.externalIdentity")}</dt>
          <dd className="text-right text-sm font-medium">
            {identity.externalLabel}
            {identity.externalDetail ? ` · ${identity.externalDetail}` : ""}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted-foreground">{t("chatUi.chatIdentityConfirm.paperclipAccount")}</dt>
          <dd className="text-right text-sm font-medium">{paperclipAccount}</dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted-foreground">{t("localizationActivityTail.agent")}</dt>
          <dd className="text-sm font-medium">
            {identity.botLabel ?? t("chatUi.chatIdentityConfirm.paperclipAgent")}
          </dd>
        </div>
      </dl>
      <p className="text-sm text-muted-foreground">{t("chatUi.chatIdentityConfirm.confirmOnlyIfThisIsYourIdentityPaperclipWillCheck", { value0: providerNames[identity.provider] })}</p>
      {confirm.isError && (
        <p className="text-sm text-destructive">{t("chatUi.chatIdentityConfirm.thisLinkCouldNotBeConfirmedItMayHaveExpired")}</p>
      )}
      {identity.canConfirm === false ? (
        <div className="space-y-3">
          <p className="text-sm">{t("sep28Apps.membershipRequired", { organization: identity.companyName })}</p>
          {requestAccess.isSuccess ? <p role="status" className="text-sm">{t("sep28Apps.accessRequested")}</p>
            : <Button disabled={requestAccess.isPending || !identity.selfService} onClick={() => requestAccess.mutate()}>{t("sep28Apps.copy287")}</Button>}
          {requestAccess.isError && <p role="alert" className="text-sm text-destructive">{t("sep28Apps.accessRequestFailed")}</p>}
        </div>
      ) : <Button disabled={confirm.isPending} onClick={() => confirm.mutate()}>
        {confirm.isPending && <Loader2 className="h-4 w-4 animate-spin" />}{t("chatUi.chatIdentityConfirm.confirmIdentity")}</Button>}
    </main>
  );
}
