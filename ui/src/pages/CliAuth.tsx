import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { useTranslation } from "@/i18n";

export function CliAuthPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
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
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{t("pages.cliAuth.invalidCliAuthUrl", { defaultValue: "Invalid CLI auth URL." })}</div>;
  }

  if (sessionQuery.isLoading || challengeQuery.isLoading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{t("pages.cliAuth.loadingChallenge", { defaultValue: "Loading CLI auth challenge..." })}</div>;
  }

  if (challengeQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <h1 className="text-lg font-semibold">{t("pages.cliAuth.challengeUnavailableHeading", { defaultValue: "CLI auth challenge unavailable" })}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {challengeQuery.error instanceof Error ? challengeQuery.error.message : t("pages.cliAuth.challengeInvalidOrExpired", { defaultValue: "Challenge is invalid or expired." })}
          </p>
        </Card>
      </div>
    );
  }

  const challenge = challengeQuery.data;
  if (!challenge) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{t("pages.cliAuth.challengeUnavailable", { defaultValue: "CLI auth challenge unavailable." })}</div>;
  }

  if (challenge.status === "approved") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <h1 className="text-xl font-semibold">{t("pages.cliAuth.accessApproved", { defaultValue: "CLI access approved" })}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("pages.cliAuth.accessApprovedBody", { defaultValue: "The Paperclip CLI can now finish authentication on the requesting machine." })}
          </p>
          <p className="mt-4 text-sm text-muted-foreground">
            {t("pages.cliAuth.commandLabel", { defaultValue: "Command:" })} <span className="font-mono text-foreground">{challenge.command}</span>
          </p>
        </Card>
      </div>
    );
  }

  if (challenge.status === "cancelled" || challenge.status === "expired") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <h1 className="text-xl font-semibold">
            {challenge.status === "expired"
              ? t("pages.cliAuth.challengeExpired", { defaultValue: "CLI auth challenge expired" })
              : t("pages.cliAuth.challengeCancelled", { defaultValue: "CLI auth challenge cancelled" })}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("pages.cliAuth.restartFlowBody", { defaultValue: "Start the CLI auth flow again from your terminal to generate a new approval request." })}
          </p>
        </Card>
      </div>
    );
  }

  if (challenge.requiresSignIn || !sessionQuery.data) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <h1 className="text-xl font-semibold">{t("pages.cliAuth.signInRequired", { defaultValue: "Sign in required" })}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("pages.cliAuth.signInRequiredBody", { defaultValue: "Sign in or create an account, then return to this page to approve the CLI access request." })}
          </p>
          <Button asChild className="mt-4">
            <Link to={`/auth?next=${encodeURIComponent(currentPath)}`}>{t("pages.cliAuth.signInCreateAccount", { defaultValue: "Sign in / Create account" })}</Link>
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl py-10">
      <Card className="block p-6">
        <h1 className="text-xl font-semibold">{t("pages.cliAuth.approveCliAccess", { defaultValue: "Approve Paperclip CLI access" })}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("pages.cliAuth.approveCliAccessBody", { defaultValue: "A local Paperclip CLI process is requesting board access to this instance." })}
        </p>

        <div className="mt-5 space-y-3 text-sm">
          <div>
            <div className="text-muted-foreground">{t("pages.cliAuth.command", { defaultValue: "Command" })}</div>
            <div className="font-mono text-foreground">{challenge.command}</div>
          </div>
          <div>
            <div className="text-muted-foreground">{t("pages.cliAuth.client", { defaultValue: "Client" })}</div>
            <div className="text-foreground">{challenge.clientName ?? t("pages.cliAuth.defaultClientName", { defaultValue: "paperclipai cli" })}</div>
          </div>
          <div>
            <div className="text-muted-foreground">{t("pages.cliAuth.requestedAccess", { defaultValue: "Requested access" })}</div>
            <div className="text-foreground">
              {challenge.requestedAccess === "instance_admin_required"
                ? t("pages.cliAuth.instanceAdmin", { defaultValue: "Instance admin" })
                : t("pages.cliAuth.board", { defaultValue: "Board" })}
            </div>
          </div>
          {challenge.requestedCompanyName && (
            <div>
              <div className="text-muted-foreground">{t("pages.cliAuth.requestedCompany", { defaultValue: "Requested company" })}</div>
              <div className="text-foreground">{challenge.requestedCompanyName}</div>
            </div>
          )}
        </div>

        {(approveMutation.error || cancelMutation.error) && (
          <p className="mt-4 text-sm text-destructive">
            {(approveMutation.error ?? cancelMutation.error) instanceof Error
              ? ((approveMutation.error ?? cancelMutation.error) as Error).message
              : t("pages.cliAuth.failedToUpdateChallenge", { defaultValue: "Failed to update CLI auth challenge" })}
          </p>
        )}

        {!challenge.canApprove && (
          <p className="mt-4 text-sm text-destructive">
            {t("pages.cliAuth.requiresAdmin", { defaultValue: "This challenge requires instance-admin access. Sign in with an instance admin account to approve it." })}
          </p>
        )}

        <div className="mt-5 flex gap-3">
          <Button
            onClick={() => approveMutation.mutate()}
            disabled={!challenge.canApprove || approveMutation.isPending || cancelMutation.isPending}
          >
            {approveMutation.isPending
              ? t("pages.cliAuth.approving", { defaultValue: "Approving..." })
              : t("pages.cliAuth.approveCliAccessButton", { defaultValue: "Approve CLI access" })}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => cancelMutation.mutate()}
            disabled={approveMutation.isPending || cancelMutation.isPending}
          >
            {cancelMutation.isPending ? t("pages.cliAuth.cancelling", { defaultValue: "Cancelling..." }) : t("pages.cliAuth.cancel", { defaultValue: "Cancel" })}
          </Button>
        </div>
      </Card>
    </div>
  );
}
