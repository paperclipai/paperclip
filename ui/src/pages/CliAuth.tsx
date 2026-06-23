import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";

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
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        {t("pages.cliAuth.invalidUrl", { defaultValue: "Invalid CLI auth URL." })}
      </div>
    );
  }

  if (sessionQuery.isLoading || challengeQuery.isLoading) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">
        {t("pages.cliAuth.loading", { defaultValue: "Loading CLI auth challenge..." })}
      </div>
    );
  }

  if (challengeQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">
            {t("pages.cliAuth.challengeUnavailableHeading", { defaultValue: "CLI auth challenge unavailable" })}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {challengeQuery.error instanceof Error
              ? challengeQuery.error.message
              : t("pages.cliAuth.challengeInvalidOrExpired", { defaultValue: "Challenge is invalid or expired." })}
          </p>
        </div>
      </div>
    );
  }

  const challenge = challengeQuery.data;
  if (!challenge) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        {t("pages.cliAuth.challengeUnavailable", { defaultValue: "CLI auth challenge unavailable." })}
      </div>
    );
  }

  if (challenge.status === "approved") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold">
            {t("pages.cliAuth.approvedHeading", { defaultValue: "CLI access approved" })}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("pages.cliAuth.approvedDescription", {
              defaultValue: "The Paperclip CLI can now finish authentication on the requesting machine.",
            })}
          </p>
          <p className="mt-4 text-sm text-muted-foreground">
            {t("pages.cliAuth.commandLabelInline", { defaultValue: "Command:" })}{" "}
            <span className="font-mono text-foreground">{challenge.command}</span>
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
              ? t("pages.cliAuth.challengeExpiredHeading", { defaultValue: "CLI auth challenge expired" })
              : t("pages.cliAuth.challengeCancelledHeading", { defaultValue: "CLI auth challenge cancelled" })}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("pages.cliAuth.restartFlow", {
              defaultValue: "Start the CLI auth flow again from your terminal to generate a new approval request.",
            })}
          </p>
        </div>
      </div>
    );
  }

  if (challenge.requiresSignIn || !sessionQuery.data) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold">
            {t("pages.cliAuth.signInRequiredHeading", { defaultValue: "Sign in required" })}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("pages.cliAuth.signInRequiredDescription", {
              defaultValue: "Sign in or create an account, then return to this page to approve the CLI access request.",
            })}
          </p>
          <Button asChild className="mt-4">
            <Link to={`/auth?next=${encodeURIComponent(currentPath)}`}>
              {t("pages.cliAuth.signInOrCreateAccount", { defaultValue: "Sign in / Create account" })}
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">
          {t("pages.cliAuth.approveHeading", { defaultValue: "Approve Paperclip CLI access" })}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("pages.cliAuth.approveDescription", {
            defaultValue: "A local Paperclip CLI process is requesting board access to this instance.",
          })}
        </p>

        <div className="mt-5 space-y-3 text-sm">
          <div>
            <div className="text-muted-foreground">{t("pages.cliAuth.commandLabel", { defaultValue: "Command" })}</div>
            <div className="font-mono text-foreground">{challenge.command}</div>
          </div>
          <div>
            <div className="text-muted-foreground">{t("pages.cliAuth.clientLabel", { defaultValue: "Client" })}</div>
            <div className="text-foreground">{challenge.clientName ?? "paperclipai cli"}</div>
          </div>
          <div>
            <div className="text-muted-foreground">
              {t("pages.cliAuth.requestedAccessLabel", { defaultValue: "Requested access" })}
            </div>
            <div className="text-foreground">
              {challenge.requestedAccess === "instance_admin_required"
                ? t("pages.cliAuth.accessInstanceAdmin", { defaultValue: "Instance admin" })
                : t("pages.cliAuth.accessBoard", { defaultValue: "Board" })}
            </div>
          </div>
          {challenge.requestedCompanyName && (
            <div>
              <div className="text-muted-foreground">
                {t("pages.cliAuth.requestedCompanyLabel", { defaultValue: "Requested company" })}
              </div>
              <div className="text-foreground">{challenge.requestedCompanyName}</div>
            </div>
          )}
        </div>

        {(approveMutation.error || cancelMutation.error) && (
          <p className="mt-4 text-sm text-destructive">
            {(approveMutation.error ?? cancelMutation.error) instanceof Error
              ? ((approveMutation.error ?? cancelMutation.error) as Error).message
              : t("pages.cliAuth.updateFailed", { defaultValue: "Failed to update CLI auth challenge" })}
          </p>
        )}

        {!challenge.canApprove && (
          <p className="mt-4 text-sm text-destructive">
            {t("pages.cliAuth.requiresInstanceAdmin", {
              defaultValue:
                "This challenge requires instance-admin access. Sign in with an instance admin account to approve it.",
            })}
          </p>
        )}

        <div className="mt-5 flex gap-3">
          <Button
            onClick={() => approveMutation.mutate()}
            disabled={!challenge.canApprove || approveMutation.isPending || cancelMutation.isPending}
          >
            {approveMutation.isPending
              ? t("pages.cliAuth.approving", { defaultValue: "Approving..." })
              : t("pages.cliAuth.approveButton", { defaultValue: "Approve CLI access" })}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => cancelMutation.mutate()}
            disabled={approveMutation.isPending || cancelMutation.isPending}
          >
            {cancelMutation.isPending
              ? t("pages.cliAuth.cancelling", { defaultValue: "Cancelling..." })
              : t("pages.cliAuth.cancelButton", { defaultValue: "Cancel" })}
          </Button>
        </div>
      </div>
    </div>
  );
}
