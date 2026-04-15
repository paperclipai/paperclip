import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";

export function CliAuthPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const challengeId = (params.id ?? "").trim();
  const token = (searchParams.get("token") ?? "").trim();
  const isAuthReturn = (searchParams.get("authReturn") ?? "").trim() === "1";
  const basePath = useMemo(
    () => `/cli-auth/${encodeURIComponent(challengeId)}${token ? `?token=${encodeURIComponent(token)}` : ""}`,
    [challengeId, token],
  );
  const authReturnPath = useMemo(
    () => `${basePath}${token ? "&" : "?"}authReturn=1`,
    [basePath, token],
  );
  const [isReturningFromAuth, setIsReturningFromAuth] = useState(isAuthReturn);
  const [returnStartedAt, setReturnStartedAt] = useState<number | null>(
    isAuthReturn ? Date.now() : null,
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
  const { data: session, isFetching: isSessionFetching, refetch: refetchSession } = sessionQuery;
  const { data: challenge, isFetching: isChallengeFetching, refetch: refetchChallenge } = challengeQuery;

  const approveMutation = useMutation({
    mutationFn: () => accessApi.approveCliAuthChallenge(challengeId, token),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await refetchChallenge();
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => accessApi.cancelCliAuthChallenge(challengeId, token),
    onSuccess: async () => {
      await refetchChallenge();
    },
  });

  useEffect(() => {
    if (!isAuthReturn) return;
    setIsReturningFromAuth(true);
    setReturnStartedAt((current) => current ?? Date.now());
  }, [isAuthReturn]);

  useEffect(() => {
    if (!isReturningFromAuth) return;

    void refetchSession();
    void refetchChallenge();

    const interval = window.setInterval(() => {
      void refetchSession();
      void refetchChallenge();
    }, 1000);

    return () => window.clearInterval(interval);
  }, [isReturningFromAuth, refetchSession, refetchChallenge]);

  useEffect(() => {
    if (!isReturningFromAuth || !challenge) return;
    if (!session || challenge.requiresSignIn) return;

    setIsReturningFromAuth(false);
    setReturnStartedAt(null);
    navigate(basePath, { replace: true });
  }, [isReturningFromAuth, challenge, session, navigate, basePath]);

  if (!challengeId || !token) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">Invalid CLI auth URL.</div>;
  }

  const returnElapsedMs = returnStartedAt == null ? 0 : Date.now() - returnStartedAt;
  const showReconnectFallback = returnElapsedMs >= 6_000;
  const isReconnectPending =
    isReturningFromAuth &&
    (isSessionFetching ||
      isChallengeFetching ||
      !session ||
      !challenge ||
      challenge.requiresSignIn);

  if (isReconnectPending) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold">Finishing sign-in...</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Reconnecting your Paperclip session so we can approve the CLI request.
          </p>
          {showReconnectFallback && (
            <>
              <p className="mt-4 text-sm text-muted-foreground">
                Still reconnecting your session. This can take a few seconds after returning from sign-in.
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-4"
                onClick={() => {
                  void refetchSession();
                  void refetchChallenge();
                }}
              >
                Retry
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (sessionQuery.isLoading || challengeQuery.isLoading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading CLI auth challenge...</div>;
  }

  if (challengeQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">CLI auth challenge unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {challengeQuery.error instanceof Error ? challengeQuery.error.message : "Challenge is invalid or expired."}
          </p>
          <Button
            type="button"
            variant="outline"
            className="mt-4"
            onClick={() => {
              void refetchSession();
              void refetchChallenge();
            }}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!challenge) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">CLI auth challenge unavailable.</div>;
  }

  if (challenge.status === "approved") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold">CLI access approved</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The Paperclip CLI can now finish authentication on the requesting machine.
          </p>
          <p className="mt-4 text-sm text-muted-foreground">
            Command: <span className="font-mono text-foreground">{challenge.command}</span>
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
            {challenge.status === "expired" ? "CLI auth challenge expired" : "CLI auth challenge cancelled"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Start the CLI auth flow again from your terminal to generate a new approval request.
          </p>
        </div>
      </div>
    );
  }

  if (challenge.requiresSignIn || !session) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold">Sign in required</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in or create an account, then return to this page to approve the CLI access request.
          </p>
          <Button asChild className="mt-4">
            <Link to={`/auth?next=${encodeURIComponent(authReturnPath)}`}>Sign in / Create account</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">Approve Paperclip CLI access</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          A local Paperclip CLI process is requesting board access to this instance.
        </p>

        <div className="mt-5 space-y-3 text-sm">
          <div>
            <div className="text-muted-foreground">Command</div>
            <div className="font-mono text-foreground">{challenge.command}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Client</div>
            <div className="text-foreground">{challenge.clientName ?? "paperclipai cli"}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Requested access</div>
            <div className="text-foreground">
              {challenge.requestedAccess === "instance_admin_required" ? "Instance admin" : "Board"}
            </div>
          </div>
          {challenge.requestedCompanyName && (
            <div>
              <div className="text-muted-foreground">Requested company</div>
              <div className="text-foreground">{challenge.requestedCompanyName}</div>
            </div>
          )}
        </div>

        {(approveMutation.error || cancelMutation.error) && (
          <p className="mt-4 text-sm text-destructive">
            {(approveMutation.error ?? cancelMutation.error) instanceof Error
              ? ((approveMutation.error ?? cancelMutation.error) as Error).message
              : "Failed to update CLI auth challenge"}
          </p>
        )}

        {!challenge.canApprove && (
          <p className="mt-4 text-sm text-destructive">
            This challenge requires instance-admin access. Sign in with an instance admin account to approve it.
          </p>
        )}

        <div className="mt-5 flex gap-3">
          <Button
            onClick={() => approveMutation.mutate()}
            disabled={!challenge.canApprove || approveMutation.isPending || cancelMutation.isPending}
          >
            {approveMutation.isPending ? "Approving..." : "Approve CLI access"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => cancelMutation.mutate()}
            disabled={approveMutation.isPending || cancelMutation.isPending}
          >
            {cancelMutation.isPending ? "Cancelling..." : "Cancel"}
          </Button>
        </div>
      </div>
    </div>
  );
}
