import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";

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
    return (
      <div className="paperclip-edge-shell items-center justify-center p-6">
        <div className="paperclip-edge-card w-full max-w-xl px-6 py-8">
          <p className="paperclip-edge-kicker">Board Claim</p>
          <p className="mt-4 text-sm text-destructive">Invalid board claim URL.</p>
        </div>
      </div>
    );
  }

  if (statusQuery.isLoading || sessionQuery.isLoading) {
    return (
      <div className="paperclip-edge-shell items-center justify-center p-6">
        <div className="paperclip-edge-card w-full max-w-xl px-6 py-8">
          <p className="paperclip-edge-kicker">Board Claim</p>
          <p className="mt-4 text-sm text-muted-foreground">Loading claim challenge…</p>
        </div>
      </div>
    );
  }

  if (statusQuery.error) {
    return (
      <div className="paperclip-edge-shell items-center justify-center p-6">
        <div className="paperclip-edge-card w-full max-w-xl px-6 py-8">
          <p className="paperclip-edge-kicker">Board Claim</p>
          <h1 className="mt-3 text-2xl font-semibold">Claim challenge unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {statusQuery.error instanceof Error ? statusQuery.error.message : "Challenge is invalid or expired."}
          </p>
        </div>
      </div>
    );
  }

  const status = statusQuery.data;
  if (!status) {
    return (
      <div className="paperclip-edge-shell items-center justify-center p-6">
        <div className="paperclip-edge-card w-full max-w-xl px-6 py-8">
          <p className="paperclip-edge-kicker">Board Claim</p>
          <p className="mt-4 text-sm text-destructive">Claim challenge unavailable.</p>
        </div>
      </div>
    );
  }

  if (status.status === "claimed") {
    return (
      <div className="paperclip-edge-shell items-center justify-center p-6">
        <div className="paperclip-edge-card w-full max-w-xl px-6 py-8">
          <p className="paperclip-edge-kicker">Board Claim</p>
          <h1 className="mt-3 text-2xl font-semibold">Board ownership claimed</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This instance is now linked to your authenticated user.
          </p>
          <Button asChild className="mt-4">
            <Link to="/">Open board</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (!sessionQuery.data) {
    return (
      <div className="paperclip-edge-shell items-center justify-center p-6">
        <div className="paperclip-edge-card w-full max-w-xl px-6 py-8">
          <p className="paperclip-edge-kicker">Board Claim</p>
          <h1 className="mt-3 text-2xl font-semibold">Sign in required</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in or create an account, then return to this page to claim Board ownership.
          </p>
          <Button asChild className="mt-4">
            <Link to={`/auth?next=${encodeURIComponent(currentPath)}`}>Sign in / Create account</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="paperclip-edge-shell items-center justify-center p-6">
      <div className="paperclip-edge-card w-full max-w-xl px-6 py-8">
        <p className="paperclip-edge-kicker">Board Claim</p>
        <h1 className="mt-3 text-3xl font-semibold">Claim board ownership</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This will promote your user to instance admin and migrate company ownership access from local trusted mode.
        </p>

        {claimMutation.error && (
          <p className="mt-3 text-sm text-destructive">
            {claimMutation.error instanceof Error ? claimMutation.error.message : "Failed to claim board ownership"}
          </p>
        )}

        <Button
          className="mt-5"
          onClick={() => claimMutation.mutate()}
          disabled={claimMutation.isPending}
        >
          {claimMutation.isPending ? "Claiming…" : "Claim ownership"}
        </Button>
      </div>
    </div>
  );
}
