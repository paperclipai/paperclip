import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { chatEndpointsApi, type ChatProvider } from "@/api/chatEndpoints";
import { healthApi } from "@/api/health";
import { authApi } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { queryKeys } from "@/lib/queryKeys";
import { useTranslation } from "@/i18n";
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
  const { t } = useTranslation();
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
        <QueryErrorState size="page" error={accountFailure.error} action={t("apps.ChatIdentityConfirm.loadAccount")} onRetry={accountFailure.retry} retrying={accountFailure.isFetching} />
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
        <h1 className="text-xl font-bold">{t("apps.ChatIdentityConfirm.unavailableTitle")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("apps.ChatIdentityConfirm.unavailableBody")}
        </p>
      </main>
    );
  }
  if (!confirmed && previewView.kind === "error") {
    return (
      <main className="mx-auto max-w-lg px-6 py-12">
        <QueryErrorState size="page" error={preview.error} action={t("apps.ChatIdentityConfirm.loadLink")} onRetry={previewView.retry} retrying={previewView.isFetching} />
      </main>
    );
  }
  if (health.isPending || healthView.kind === "reconnecting" || preview.isLoading || previewView.kind === "reconnecting"
    || (!local && (session.isLoading || sessionView.kind === "reconnecting")) || !preview.data) {
    return (
      <main className="flex items-center justify-center gap-2 px-6 py-12 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("apps.ChatIdentityConfirm.checking")}
      </main>
    );
  }
  const identity = preview.data;
  const paperclipAccount = local ? "Local Board" :
    session.data?.user.name?.trim() ||
    session.data?.user.email?.trim() ||
    session.data?.user.id ||
    t("apps.ChatIdentityConfirm.signedInAccount");
  if (confirmed) {
    return (
      <main className="mx-auto max-w-lg space-y-5 px-6 py-12">
        <CheckCircle2 className="h-8 w-8" />
        <div>
          <h1 className="text-xl font-bold">{t("apps.ChatIdentityConfirm.linkedTitle")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("apps.ChatIdentityConfirm.linkedBody", { label: identity.externalLabel, company: identity.companyName })}
          </p>
        </div>
        {identity.provider === "slack" && <Button asChild><a href="https://app.slack.com/" target="_blank" rel="noopener noreferrer">{t("apps.ChatIdentityConfirm.returnSlack")}</a></Button>}
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-lg space-y-6 px-6 py-12">
      <div>
        <p className="text-sm text-muted-foreground">{identity.companyName}</p>
        <h1 className="mt-1 text-xl font-bold">{t("apps.ChatIdentityConfirm.title")}</h1>
      </div>
      <dl className="divide-y divide-border border-y border-border">
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted-foreground">{t("apps.ChatIdentityConfirm.provider")}</dt>
          <dd className="text-sm font-medium">
            {providerNames[identity.provider]}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted-foreground">{t("apps.ChatIdentityConfirm.externalIdentity")}</dt>
          <dd className="text-right text-sm font-medium">
            {identity.externalLabel}
            {identity.externalDetail ? ` · ${identity.externalDetail}` : ""}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted-foreground">{t("apps.ChatIdentityConfirm.paperclipAccount")}</dt>
          <dd className="text-right text-sm font-medium">{paperclipAccount}</dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted-foreground">{t("apps.ChatIdentityConfirm.agent")}</dt>
          <dd className="text-sm font-medium">
            {identity.botLabel ?? t("apps.ChatIdentityConfirm.defaultAgent")}
          </dd>
        </div>
      </dl>
      <p className="text-sm text-muted-foreground">
        {t("apps.ChatIdentityConfirm.confirmHelp", { provider: providerNames[identity.provider] })}
      </p>
      {confirm.error ? (
        <p className="text-sm text-destructive">
          {t("apps.ChatIdentityConfirm.confirmError")}
        </p>
      ) : null}
      {identity.canConfirm === false ? (
        <div className="space-y-3">
          <p className="text-sm">{t("apps.ChatIdentityConfirm.membershipNeeded", { company: identity.companyName })}</p>
          {requestAccess.isSuccess ? <p role="status" className="text-sm">{t("apps.ChatIdentityConfirm.accessRequested")}</p>
            : <Button disabled={requestAccess.isPending || !identity.selfService} onClick={() => requestAccess.mutate()}>{t("apps.ChatIdentityConfirm.requestAccess")}</Button>}
          {requestAccess.error ? <p role="alert" className="text-sm text-destructive">{t("apps.ChatIdentityConfirm.requestError")}</p> : null}
        </div>
      ) : <Button disabled={confirm.isPending} onClick={() => confirm.mutate()}>
        {confirm.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
        {t("apps.ChatIdentityConfirm.confirm")}
      </Button>}
    </main>
  );
}
