import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { t } from "@/i18n";

export function BoardClaimPage() {
  const queryClient = useQueryClient();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const token = (params.token ?? "").trim();
  const code = (searchParams.get("code") ?? "").trim();
  const currentPath = useMemo(
    () => `/board-claim/${encodeURIComponent(token)}${code ? `?code=${encodeURIComponent(code)}` : ""}`,
    [token, code],
  );

  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const statusQuery = useQuery({
    queryKey: ["board-claim", token, code],
    queryFn: () => accessApi.getBoardClaimStatus(token, code),
    enabled: token.length > 0 && code.length > 0,
    retry: false,
  });

  const claimMutation = useMutation({
    mutationFn: () => accessApi.claimBoard(token, code),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
      await statusQuery.refetch();
    },
  });

  if (!token || !code) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{t("app.boardClaim.invalidBoardClaimUrl", { defaultValue: "Invalid board claim URL." })}</div>;
  }

  if (statusQuery.isLoading || sessionQuery.isLoading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{t("app.boardClaim.loadingClaimChallenge", { defaultValue: "Loading claim challenge..." })}</div>;
  }

  if (statusQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <h1 className="text-lg font-semibold">{t("app.boardClaim.claimChallengeUnavailable", { defaultValue: "Claim challenge unavailable" })}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {statusQuery.error instanceof Error ? statusQuery.error.message : t("app.boardClaim.challengeIsInvalidOrExpired", { defaultValue: "Challenge is invalid or expired." })}
          </p>
        </Card>
      </div>
    );
  }

  const status = statusQuery.data;
  if (!status) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{t("app.boardClaim.claimChallengeUnavailable2", { defaultValue: "Claim challenge unavailable." })}</div>;
  }

  if (status.status === "claimed") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <h1 className="text-lg font-semibold">{t("app.boardClaim.boardOwnershipClaimed", { defaultValue: "Board ownership claimed" })}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("app.boardClaim.thisInstanceIsNowLinkedToYourAuthenticatedUser", { defaultValue: "This instance is now linked to your authenticated user." })}
          </p>
          <Button asChild className="mt-4">
            <Link to="/">{t("app.boardClaim.openBoard", { defaultValue: "Open board" })}</Link>
          </Button>
        </Card>
      </div>
    );
  }

  if (!sessionQuery.data) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <h1 className="text-lg font-semibold">{t("app.boardClaim.signInRequired", { defaultValue: "Sign in required" })}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("app.boardClaim.signInOrCreateAnAccountThenReturnToThisPageToClaimBoardOwnership", { defaultValue: "Sign in or create an account, then return to this page to claim Board ownership." })}
          </p>
          <Button asChild className="mt-4">
            <Link to={`/auth?next=${encodeURIComponent(currentPath)}`}>{t("app.boardClaim.signInCreateAccount", { defaultValue: "Sign in / Create account" })}</Link>
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl py-10">
      <Card className="block p-6">
        <h1 className="text-xl font-semibold">{t("app.boardClaim.claimBoardOwnership", { defaultValue: "Claim Board ownership" })}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("app.boardClaim.thisWillPromoteYourUserToInstanceAdminAndMigrateCompanyOwnershipAccessFromLocalTrustedMode", { defaultValue: "This will promote your user to instance admin and migrate company ownership access from local trusted mode." })}
        </p>

        {claimMutation.error && (
          <p className="mt-3 text-sm text-destructive">
            {claimMutation.error instanceof Error ? claimMutation.error.message : t("app.boardClaim.failedToClaimBoardOwnership", { defaultValue: "Failed to claim board ownership" })}
          </p>
        )}

        <Button
          className="mt-5"
          onClick={() => claimMutation.mutate()}
          disabled={claimMutation.isPending}
        >
          {claimMutation.isPending ? t("app.boardClaim.claiming", { defaultValue: "Claiming…" }) : t("app.boardClaim.claimOwnership", { defaultValue: "Claim ownership" })}
        </Button>
      </Card>
    </div>
  );
}
