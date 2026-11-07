import { useTranslation } from "react-i18next";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { describeError } from "../api/errors";
import { QueryErrorState, useQueryView } from "../components/QueryView";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function BoardClaimPage() {
  const { t } = useTranslation("settings");
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
  });
  const statusQuery = useQuery({
    queryKey: ["board-claim", token, code],
    queryFn: () => accessApi.getBoardClaimStatus(token, code),
    enabled: token.length > 0 && code.length > 0,
  });
  const statusView = useQueryView(statusQuery);

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
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{t("boardClaim.invalid_board_claim_url")}</div>;
  }

  if (statusQuery.isLoading || sessionQuery.isLoading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{t("boardClaim.loading_claim_challenge")}</div>;
  }

  if (statusView.kind === "error") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <QueryErrorState
            size="panel"
            error={statusView.error}
            action={t("boardClaim.load_the_board_claim_challenge")}
            onRetry={statusView.retry}
            retrying={statusView.isFetching}
          />
        </Card>
      </div>
    );
  }

  const status = statusQuery.data;
  if (!status) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{t("boardClaim.claim_challenge_unavailable")}</div>;
  }

  if (status.status === "claimed") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <h1 className="text-lg font-semibold">{t("boardClaim.board_ownership_claimed")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("boardClaim.this_instance_is_now_linked_to_your_authenticated_user")}</p>
          <Button asChild className="mt-4">
            <Link to="/">{t("boardClaim.open_board")}</Link>
          </Button>
        </Card>
      </div>
    );
  }

  if (!sessionQuery.data) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <h1 className="text-lg font-semibold">{t("boardClaim.sign_in_required")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("boardClaim.sign_in_or_create_an_account_then_return_to")}</p>
          <Button asChild className="mt-4">
            <Link to={`/auth?next=${encodeURIComponent(currentPath)}`}>{t("boardClaim.sign_in_create_account")}</Link>
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl py-10">
      <Card className="block p-6">
        <h1 className="text-xl font-semibold">{t("boardClaim.claim_board_ownership")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("boardClaim.this_will_promote_your_user_to_instance_admin_and")}</p>

        {claimMutation.isError && ( // query-error-ok: mutation result
          <p className="mt-3 text-sm text-destructive">{describeError(claimMutation.error).body}</p>
        )}

        <Button
          className="mt-5"
          onClick={() => claimMutation.mutate()}
          disabled={claimMutation.isPending}
        >
          {claimMutation.isPending ? t("boardClaim.claiming") : t("boardClaim.claim_ownership")}
        </Button>
      </Card>
    </div>
  );
}
