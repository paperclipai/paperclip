import { Navigate, Outlet, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { RoboLoading } from "./RoboLoading";
import { RoboError } from "./RoboError";

function BootstrapPendingPage({ hasActiveInvite = false }: { hasActiveInvite?: boolean }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">Instance setup required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {hasActiveInvite
            ? "No instance admin exists yet. A bootstrap invite is already active. Check your ValadrienOs startup logs for the first admin invite URL, or run this command to rotate it:"
            : "No instance admin exists yet. Run this command in your ValadrienOs environment to generate the first admin invite URL:"}
        </p>
        <pre className="mt-4 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
{`pnpm valadrien-os auth bootstrap-ceo`}
        </pre>
      </div>
    </div>
  );
}

function NoBoardAccessPage() {
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">No company access</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This account is signed in, but it does not have an active company membership or instance-admin access on
          this ValadrienOs instance.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Use a company invite or sign in with an account that already belongs to this org.
        </p>
      </div>
    </div>
  );
}

export function CloudAccessGate() {
  const location = useLocation();
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as
        | { deploymentMode?: "local_trusted" | "authenticated"; bootstrapStatus?: "ready" | "bootstrap_pending" }
        | undefined;
      return data?.deploymentMode === "authenticated" && data.bootstrapStatus === "bootstrap_pending"
        ? 2000
        : false;
    },
    refetchIntervalInBackground: true,
  });

  const isAuthenticatedMode = healthQuery.data?.deploymentMode === "authenticated";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthenticatedMode,
    // getSession() returns null on a clean 401 (no thrown error), so a retry only kicks
    // in for transient failures (cold-boot timeout / 5xx) — never for "logged out".
    // Retry a couple times so a cold get-session blip doesn't surface as a forced
    // sign-out (the login/nav lag the cold-boot hang caused).
    retry: 2,
  });

  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: isAuthenticatedMode && !!sessionQuery.data,
    retry: false,
  });

  if (
    healthQuery.isLoading ||
    (isAuthenticatedMode && sessionQuery.isLoading) ||
    (isAuthenticatedMode && !!sessionQuery.data && boardAccessQuery.isLoading)
  ) {
    return <RoboLoading />;
  }

  if (healthQuery.error || boardAccessQuery.error) {
    return (
      <RoboError
        error={healthQuery.error ?? boardAccessQuery.error ?? "Failed to load app state"}
        onRetry={() => {
          void healthQuery.refetch();
          void boardAccessQuery.refetch();
        }}
      />
    );
  }

  if (isAuthenticatedMode && healthQuery.data?.bootstrapStatus === "bootstrap_pending") {
    return <BootstrapPendingPage hasActiveInvite={healthQuery.data.bootstrapInviteActive} />;
  }

  // A get-session that THREW (cold-boot timeout / 5xx / network) is a transient failure,
  // NOT a sign-out — getSession() resolves to null (not an error) for a real 401. Don't
  // bounce the user to /auth on a transient error; keep the shell and offer Retry. This
  // is the most direct fix for "login still lags / drops me to sign-in" under cold boots.
  if (isAuthenticatedMode && sessionQuery.error) {
    return (
      <RoboError
        error={sessionQuery.error}
        onRetry={() => {
          void sessionQuery.refetch();
        }}
      />
    );
  }

  if (isAuthenticatedMode && !sessionQuery.data) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/auth?next=${next}`} replace />;
  }

  if (
    isAuthenticatedMode &&
    sessionQuery.data &&
    !boardAccessQuery.data?.isInstanceAdmin &&
    (boardAccessQuery.data?.companyIds.length ?? 0) === 0
  ) {
    return <NoBoardAccessPage />;
  }

  return <Outlet />;
}
