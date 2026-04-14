import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/runtime";

export function BoardClaimPage() {
  const queryClient = useQueryClient();
  const { t } = useI18n();
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
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{t("boardClaim.invalidUrl", "Invalid board claim URL.")}</div>;
  }

  if (statusQuery.isLoading || sessionQuery.isLoading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{t("boardClaim.loading", "Loading claim challenge...")}</div>;
  }

  if (statusQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">{t("boardClaim.unavailable.title", "Claim challenge unavailable")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("boardClaim.unavailable.detail", "Challenge is invalid or expired.")}
          </p>
        </div>
      </div>
    );
  }

  const status = statusQuery.data;
  if (!status) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{t("boardClaim.unavailable.title", "Claim challenge unavailable")}</div>;
  }

  if (status.status === "claimed") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">{t("boardClaim.claimed.title", "Board ownership claimed")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("boardClaim.claimed.detail", "This instance is now linked to your authenticated user.")}
          </p>
          <Button asChild className="mt-4">
            <Link to="/">{t("boardClaim.actions.openBoard", "Open board")}</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (!sessionQuery.data) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">{t("boardClaim.signInRequired.title", "Sign in required")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("boardClaim.signInRequired.detail", "Sign in or create an account, then return to this page to claim Board ownership.")}
          </p>
          <Button asChild className="mt-4">
            <Link to={`/auth?next=${encodeURIComponent(currentPath)}`}>{t("boardClaim.actions.signIn", "Sign in / Create account")}</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">{t("boardClaim.claim.title", "Claim Board ownership")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("boardClaim.claim.detail", "This will promote your user to instance admin and migrate company ownership access from local trusted mode.")}
        </p>

        {claimMutation.error && (
          <p className="mt-3 text-sm text-destructive">
            {t("boardClaim.claim.error", "Failed to claim board ownership")}
          </p>
        )}

        <Button
          className="mt-5"
          onClick={() => claimMutation.mutate()}
          disabled={claimMutation.isPending}
        >
          {claimMutation.isPending
            ? t("boardClaim.actions.claiming", "Claiming…")
            : t("boardClaim.actions.claim", "Claim ownership")}
        </Button>
      </div>
    </div>
  );
}
