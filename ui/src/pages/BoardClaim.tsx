import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";

export function BoardClaimPage() {
  const { t } = useTranslation();
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
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{t("boardClaim.invalidUrl", { defaultValue: "Invalid board claim URL." })}</div>;
  }

  if (statusQuery.isLoading || sessionQuery.isLoading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{t("boardClaim.loading", { defaultValue: "Loading claim challenge..." })}</div>;
  }

  if (statusQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">{t("boardClaim.unavailable", { defaultValue: "Claim challenge unavailable" })}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {statusQuery.error instanceof Error ? statusQuery.error.message : t("boardClaim.invalidOrExpired", { defaultValue: "Challenge is invalid or expired." })}
          </p>
        </div>
      </div>
    );
  }

  const status = statusQuery.data;
  if (!status) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{t("boardClaim.challengeUnavailable", { defaultValue: "Claim challenge unavailable." })}</div>;
  }

  if (status.status === "claimed") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">{t("boardClaim.ownershipClaimed", { defaultValue: "Board ownership claimed" })}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("boardClaim.instanceLinked", { defaultValue: "This instance is now linked to your authenticated user." })}
          </p>
          <Button asChild className="mt-4">
            <Link to="/">{t("boardClaim.openBoard", { defaultValue: "Open board" })}</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (!sessionQuery.data) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">{t("boardClaim.signInRequired", { defaultValue: "Sign in required" })}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("boardClaim.signInPrompt", { defaultValue: "Sign in or create an account, then return to this page to claim Board ownership." })}
          </p>
          <Button asChild className="mt-4">
            <Link to={`/auth?next=${encodeURIComponent(currentPath)}`}>{t("boardClaim.signInCreate", { defaultValue: "Sign in / Create account" })}</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">{t("boardClaim.claimOwnership", { defaultValue: "Claim Board ownership" })}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("boardClaim.claimDescription", { defaultValue: "This will promote your user to instance admin and migrate company ownership access from local trusted mode." })}
        </p>

        {claimMutation.error && (
          <p className="mt-3 text-sm text-destructive">
            {claimMutation.error instanceof Error ? claimMutation.error.message : t("boardClaim.claimFailed", { defaultValue: "Failed to claim board ownership" })}
          </p>
        )}

        <Button
          className="mt-5"
          onClick={() => claimMutation.mutate()}
          disabled={claimMutation.isPending}
        >
          {claimMutation.isPending ? t("boardClaim.claiming", { defaultValue: "Claiming…" }) : t("boardClaim.claimOwnershipBtn", { defaultValue: "Claim ownership" })}
        </Button>
      </div>
    </div>
  );
}
