import { useEffect, useRef } from "react";
import { Navigate, Outlet, useLocation } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { BootstrapPendingPage } from "@/components/BootstrapPendingPage";
import { Card } from "@/components/ui/card";

// How long to silently retry before surfacing the error to the user.
// 30 s gives the embedded-Postgres startup + server init enough headroom during
// a controlled local-service restart (e.g. pnpm dev:once re-invocation), while
// still surfacing a real failure within half a minute.
const RECONNECT_TIMEOUT_MS = 30_000;
// How often to poll health during the silent-retry window.
const RECONNECT_POLL_MS = 1_000;

/**
 * Returns true for errors that a brief server restart could resolve.
 * Browsers report network-level failures differently:
 *   Chrome/Edge → TypeError: "Failed to fetch"
 *   Safari      → TypeError: "Load failed"
 *   Firefox     → TypeError: "NetworkError when attempting to fetch resource."
 * healthApi also throws plain `Error: Failed to load health (5xx)` for server-side errors.
 */
function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof TypeError) return true;
  const msg = err.message.toLowerCase();
  if (msg.includes("failed to fetch") || msg.includes("load failed") || msg.includes("networkerror")) return true;
  return /\(5\d\d\)/.test(err.message);
}

function NoBoardAccessPage() {
  return (
    <div className="mx-auto max-w-xl py-10">
      <Card className="block p-6">
        <h1 className="text-xl font-semibold">No company access</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This account is signed in, but it does not have an active company membership or instance-admin access on
          this Paperclip instance.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Use a company invite or sign in with an account that already belongs to this org.
        </p>
      </Card>
    </div>
  );
}

/** Bottom-center pill shown while the server is recovering. Auto-dismissed when health returns. */
function ReconnectingBanner() {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm text-muted-foreground shadow-lg">
        <Loader2 className="size-4 shrink-0 motion-safe:animate-spin" />
        Reconnecting…
      </div>
    </div>
  );
}

export function CloudAccessGate() {
  const location = useLocation();
  const queryClient = useQueryClient();

  // Wall-clock when a transient error window started. Set synchronously during render
  // (ref mutation only — no setState) so the reconnect window begins on the same frame
  // the error is first detected, before any effects fire.
  const reconnectStartRef = useRef<number | null>(null);
  // True once <Outlet /> has been rendered at least once (gate fully passed).
  // Used to decide whether to keep page content visible during a mid-session bounce.
  const gatePassedRef = useRef(false);

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
  const isBootstrapPending = isAuthenticatedMode && healthQuery.data?.bootstrapStatus === "bootstrap_pending";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthenticatedMode,
    retry: false,
  });

  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: isAuthenticatedMode && !isBootstrapPending && !!sessionQuery.data,
    retry: false,
  });

  const claimMutation = useMutation({
    mutationFn: () => accessApi.claimBootstrapAdmin(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
    },
  });

  // --- Reconnect logic ---
  // Pin the reconnect window start time synchronously on the first render that sees a
  // transient error. Ref mutations in render are safe here because:
  //   • refs never trigger re-renders
  //   • this is lazy-init (set-once, cleared on recovery), not computed state
  const healthError = healthQuery.error;
  const isTransient = !!healthError && isTransientError(healthError);

  if (isTransient) {
    if (reconnectStartRef.current === null) {
      reconnectStartRef.current = Date.now();
    }
  } else if (reconnectStartRef.current !== null) {
    reconnectStartRef.current = null;
  }

  const reconnectElapsedMs = reconnectStartRef.current !== null
    ? Date.now() - reconnectStartRef.current
    : RECONNECT_TIMEOUT_MS;
  const withinReconnectWindow = isTransient && reconnectElapsedMs < RECONNECT_TIMEOUT_MS;

  // Poll health every RECONNECT_POLL_MS while within the silent-retry window.
  // healthQuery.error changes on each failed attempt, so this effect re-runs on every
  // failure to keep scheduling the next probe until the window expires or health recovers.
  useEffect(() => {
    if (!withinReconnectWindow) return;
    const timer = window.setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.health });
    }, RECONNECT_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [withinReconnectWindow, healthQuery.error, queryClient]);

  // --- Normal gate logic ---

  if (
    healthQuery.isLoading ||
    (isAuthenticatedMode && sessionQuery.isLoading) ||
    (isAuthenticatedMode && !isBootstrapPending && !!sessionQuery.data && boardAccessQuery.isLoading)
  ) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  if (healthQuery.error || boardAccessQuery.error) {
    if (withinReconnectWindow) {
      if (gatePassedRef.current) {
        // Gate was previously open — keep the page content visible and show a
        // non-blocking banner so the user isn't interrupted by a transient blip.
        return (
          <>
            <Outlet />
            <ReconnectingBanner />
          </>
        );
      }
      // Gate never opened (server was already down on first page load) —
      // show a centred reconnecting indicator instead of the error screen.
      return (
        <div className="mx-auto flex max-w-xl items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-4 shrink-0 motion-safe:animate-spin" />
          Reconnecting…
        </div>
      );
    }
    // Reconnect window expired or error is non-transient — show the real error.
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        {healthQuery.error instanceof Error
          ? healthQuery.error.message
          : boardAccessQuery.error instanceof Error
            ? boardAccessQuery.error.message
            : "Failed to load app state"}
      </div>
    );
  }

  if (isBootstrapPending) {
    const health = healthQuery.data;
    if (!health) {
      return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
    }
    const claimError = claimMutation.error instanceof ApiError
      ? { status: claimMutation.error.status, message: claimMutation.error.message }
      : claimMutation.error instanceof Error
        ? { message: claimMutation.error.message }
        : null;
    return (
      <BootstrapPendingPage
        claimAvailable={health.deploymentExposure === "private"}
        hasActiveInvite={health.bootstrapInviteActive}
        session={sessionQuery.data}
        claimState={claimMutation.isSuccess ? "success" : claimMutation.isPending ? "claiming" : "idle"}
        claimError={claimError}
        onClaim={() => claimMutation.mutate()}
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

  // Happy path — gate passed. Mark it so future reconnect renders preserve the page.
  gatePassedRef.current = true;
  return <Outlet />;
}
