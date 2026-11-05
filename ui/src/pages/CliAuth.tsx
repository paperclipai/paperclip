import { useTranslation } from "react-i18next";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { accessApi } from "../api/access";
import { ApiError } from "../api/client";
import { authApi } from "../api/auth";
import { describeError } from "../api/errors";
import { QueryErrorState, useQueryView } from "../components/QueryView";
import { queryKeys } from "../lib/queryKeys";

function cliAuthRetryDelay(error: unknown): number {
  const body = error instanceof ApiError && error.body && typeof error.body === "object"
    ? error.body as { details?: unknown } : null;
  const details = body?.details && typeof body.details === "object"
    ? body.details as { retryAfterSeconds?: unknown } : null;
  const milliseconds = typeof details?.retryAfterSeconds === "number" ? details.retryAfterSeconds * 1000 : Number.NaN;
  return Number.isFinite(milliseconds) && milliseconds > 0 ? Math.max(1000, milliseconds) : 60_000;
}

function isCliAuthRateLimit(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 429;
}

export function CliAuthPage() {
  const { t } = useTranslation("settings");
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
  });
  const challengeQueryKey = useMemo(() => ["cli-auth-challenge", challengeId, token] as const, [challengeId, token]);
  const retryWindowEndsAt = useMemo(() => Date.now() + 10 * 60_000, [challengeId, token]);
  const challengeQuery = useQuery({
    queryKey: challengeQueryKey,
    queryFn: () => accessApi.getCliAuthChallenge(challengeId, token),
    enabled: challengeId.length > 0 && token.length > 0,
    retry: (failureCount, error) => {
      if (!isCliAuthRateLimit(error) || failureCount >= 3) return false;
      const knownChallenge = queryClient.getQueryData<{ expiresAt: string }>(challengeQueryKey);
      const knownExpiry = Date.parse(knownChallenge?.expiresAt ?? "");
      const deadline = Number.isFinite(knownExpiry) ? Math.min(knownExpiry, retryWindowEndsAt) : retryWindowEndsAt;
      return Date.now() + cliAuthRetryDelay(error) < deadline;
    },
    retryDelay: (_failureCount, error) => cliAuthRetryDelay(error),
  });
  const challengeView = useQueryView(challengeQuery);

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
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{t("cliAuth.invalid_cli_auth_url")}</div>;
  }

  const waitingForRateLimit = isCliAuthRateLimit(challengeQuery.failureReason) && challengeQuery.isFetching;
  if (sessionQuery.isLoading || challengeQuery.isLoading || waitingForRateLimit) {
    return <div role="status" className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">
      {waitingForRateLimit ? t("cliAuth.too_many_cli_approval_requests_retrying_shortly") : t("cliAuth.loading_cli_auth_challenge")}
    </div>;
  }

  if (challengeView.kind === "error" || (challengeQuery.error && isCliAuthRateLimit(challengeQuery.error))) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <QueryErrorState
            size="panel"
            error={challengeQuery.error}
            action={t("cliAuth.load_the_cli_auth_challenge")}
            onRetry={challengeView.retry}
            retrying={challengeView.isFetching}
          />
        </Card>
      </div>
    );
  }

  const challenge = challengeQuery.data;
  if (!challenge) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{t("cliAuth.cli_auth_challenge_unavailable")}</div>;
  }

  if (challenge.status === "approved") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <h1 className="text-xl font-semibold">{t("cliAuth.cli_access_approved")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("cliAuth.the_paperclip_cli_can_now_finish_authentication_on_the")}</p>
          <p className="mt-4 text-sm text-muted-foreground">{t("cliAuth.command")} <span className="font-mono text-foreground">{challenge.command}</span>
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
            {challenge.status === "expired" ? t("cliAuth.cli_auth_challenge_expired") : t("cliAuth.cli_auth_challenge_cancelled")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("cliAuth.start_the_cli_auth_flow_again_from_your_terminal")}</p>
        </Card>
      </div>
    );
  }

  if (challenge.requiresSignIn || !sessionQuery.data) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card className="block p-6">
          <h1 className="text-xl font-semibold">{t("cliAuth.sign_in_required")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("cliAuth.sign_in_or_create_an_account_then_return_to")}</p>
          <Button asChild className="mt-4">
            <Link to={`/auth?next=${encodeURIComponent(currentPath)}`}>{t("cliAuth.sign_in_create_account")}</Link>
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl py-10">
      <Card className="block p-6">
        <h1 className="text-xl font-semibold">{t("cliAuth.approve_paperclip_cli_access")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("cliAuth.a_cli_client_is_requesting_full_board_access_to")}</p>

        <div className="mt-5 space-y-3 text-sm">
          <div>
            <div className="text-muted-foreground">{t("cliAuth.command_169")}</div>
            <div className="font-mono text-foreground">{challenge.command}</div>
          </div>
          <div>
            <div className="text-muted-foreground">{t("cliAuth.client")}</div>
            <div className="text-foreground">{challenge.clientName ?? "paperclipai cli"}</div>
          </div>
          <div>
            <div className="text-muted-foreground">{t("cliAuth.requested_access")}</div>
            <div className="text-foreground">
              {challenge.requestedAccess === "instance_admin_required" ? t("cliAuth.instance_admin") : t("cliAuth.board")}
            </div>
          </div>
          {challenge.requestedCompanyName && (
            <div>
              <div className="text-muted-foreground">{t("cliAuth.organization_for_audit_context")}</div>
              <div className="text-foreground">{challenge.requestedCompanyName}</div>
            </div>
          )}
        </div>

        {(approveMutation.isError || cancelMutation.isError) && ( // query-error-ok: mutation result
          <p className="mt-4 text-sm text-destructive">{describeError((approveMutation.error ?? cancelMutation.error)as unknown).body}</p>
        )}

        {!challenge.canApprove && (
          <p className="mt-4 text-sm text-destructive">
            {challenge.requestedAccess === "instance_admin_required"
              ? t("cliAuth.this_challenge_requires_instance_admin_access_sign_in_with")
              : t("cliAuth.you_do_not_have_access_to_the_requested_organization")}
          </p>
        )}

        <div className="mt-5 flex gap-3">
          <Button
            onClick={() => approveMutation.mutate()}
            disabled={!challenge.canApprove || approveMutation.isPending || cancelMutation.isPending}
          >
            {approveMutation.isPending ? t("cliAuth.approving") : t("cliAuth.approve_cli_access")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => cancelMutation.mutate()}
            disabled={approveMutation.isPending || cancelMutation.isPending}
          >
            {cancelMutation.isPending ? t("cliAuth.cancelling") : t("cliAuth.cancel")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
