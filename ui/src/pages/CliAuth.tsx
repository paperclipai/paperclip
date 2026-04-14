import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/runtime";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";

export function CliAuthPage() {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const challengeId = (params.id ?? "").trim();
  const token = (searchParams.get("token") ?? "").trim();
  const currentPath = useMemo(
    () => `/cli-auth/${encodeURIComponent(challengeId)}${token ? `?token=${encodeURIComponent(token)}` : ""}`,
    [challengeId, token],
  );

  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const challengeQuery = useQuery({
    queryKey: ["cli-auth-challenge", challengeId, token],
    queryFn: () => accessApi.getCliAuthChallenge(challengeId, token),
    enabled: challengeId.length > 0 && token.length > 0,
    retry: false,
  });

  const approveMutation = useMutation({
    mutationFn: () => accessApi.approveCliAuthChallenge(challengeId, token),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await challengeQuery.refetch();
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => accessApi.cancelCliAuthChallenge(challengeId, token),
    onSuccess: async () => {
      await challengeQuery.refetch();
    },
  });

  if (!challengeId || !token) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{t("cliAuth.invalidUrl", "Invalid CLI auth URL.")}</div>;
  }

  if (sessionQuery.isLoading || challengeQuery.isLoading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{t("cliAuth.loading", "Loading CLI auth challenge...")}</div>;
  }

  if (challengeQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">{t("cliAuth.unavailable.title", "CLI auth challenge unavailable")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {challengeQuery.error instanceof Error ? challengeQuery.error.message : t("cliAuth.unavailable.detail", "Challenge is invalid or expired.")}
          </p>
        </div>
      </div>
    );
  }

  const challenge = challengeQuery.data;
  if (!challenge) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{t("cliAuth.unavailable.title", "CLI auth challenge unavailable")}</div>;
  }

  if (challenge.status === "approved") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold">{t("cliAuth.approved.title", "CLI access approved")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("cliAuth.approved.detail", "The Paperclip CLI can now finish authentication on the requesting machine.")}
          </p>
          <p className="mt-4 text-sm text-muted-foreground">
            {t("cliAuth.fields.command", "Command")}: <span className="font-mono text-foreground">{challenge.command}</span>
          </p>
        </div>
      </div>
    );
  }

  if (challenge.status === "cancelled" || challenge.status === "expired") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold">
            {challenge.status === "expired"
              ? t("cliAuth.status.expired", "CLI auth challenge expired")
              : t("cliAuth.status.cancelled", "CLI auth challenge cancelled")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("cliAuth.status.retry", "Start the CLI auth flow again from your terminal to generate a new approval request.")}
          </p>
        </div>
      </div>
    );
  }

  if (challenge.requiresSignIn || !sessionQuery.data) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold">{t("cliAuth.signInRequired.title", "Sign in required")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("cliAuth.signInRequired.detail", "Sign in or create an account, then return to this page to approve the CLI access request.")}
          </p>
          <Button asChild className="mt-4">
            <Link to={`/auth?next=${encodeURIComponent(currentPath)}`}>{t("cliAuth.actions.signIn", "Sign in / Create account")}</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">{t("cliAuth.title", "Approve Paperclip CLI access")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("cliAuth.description", "A local Paperclip CLI process is requesting board access to this instance.")}
        </p>

        <div className="mt-5 space-y-3 text-sm">
          <div>
            <div className="text-muted-foreground">{t("cliAuth.fields.command", "Command")}</div>
            <div className="font-mono text-foreground">{challenge.command}</div>
          </div>
          <div>
            <div className="text-muted-foreground">{t("cliAuth.fields.client", "Client")}</div>
            <div className="text-foreground">{challenge.clientName ?? t("cliAuth.values.defaultClient", "paperclipai cli")}</div>
          </div>
          <div>
            <div className="text-muted-foreground">{t("cliAuth.fields.requestedAccess", "Requested access")}</div>
            <div className="text-foreground">
              {challenge.requestedAccess === "instance_admin_required"
                ? t("cliAuth.values.instanceAdmin", "Instance admin")
                : t("cliAuth.values.board", "Board")}
            </div>
          </div>
          {challenge.requestedCompanyName && (
            <div>
              <div className="text-muted-foreground">{t("cliAuth.fields.requestedCompany", "Requested company")}</div>
              <div className="text-foreground">{challenge.requestedCompanyName}</div>
            </div>
          )}
        </div>

        {(approveMutation.error || cancelMutation.error) && (
          <p className="mt-4 text-sm text-destructive">
            {(approveMutation.error ?? cancelMutation.error) instanceof Error
              ? ((approveMutation.error ?? cancelMutation.error) as Error).message
              : t("cliAuth.error.update", "Failed to update CLI auth challenge")}
          </p>
        )}

        {!challenge.canApprove && (
          <p className="mt-4 text-sm text-destructive">
            {t("cliAuth.warning.instanceAdminRequired", "This challenge requires instance-admin access. Sign in with an instance admin account to approve it.")}
          </p>
        )}

        <div className="mt-5 flex gap-3">
          <Button
            onClick={() => approveMutation.mutate()}
            disabled={!challenge.canApprove || approveMutation.isPending || cancelMutation.isPending}
          >
            {approveMutation.isPending
              ? t("cliAuth.actions.approving", "Approving...")
              : t("cliAuth.actions.approve", "Approve CLI access")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => cancelMutation.mutate()}
            disabled={approveMutation.isPending || cancelMutation.isPending}
          >
            {cancelMutation.isPending
              ? t("cliAuth.actions.cancelling", "Cancelling...")
              : t("cliAuth.actions.cancel", "Cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
