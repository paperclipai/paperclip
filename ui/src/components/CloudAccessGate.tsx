import { Navigate, Outlet, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";

function BootstrapPendingPage({ hasActiveInvite = false }: { hasActiveInvite?: boolean }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">RealTycoon2 초기 설정이 필요합니다</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {hasActiveInvite
            ? "아직 인스턴스 관리자가 없습니다. 첫 관리자 초대가 이미 생성되어 있으니 RealTycoon2 시작 로그에서 초대 URL을 확인하거나 아래 명령으로 다시 발급하세요:"
            : "아직 인스턴스 관리자가 없습니다. RealTycoon2 환경에서 아래 명령으로 첫 관리자 초대 URL을 생성하세요:"}
        </p>
        <pre className="mt-4 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
{`pnpm realtycoon2 auth bootstrap-ceo`}
        </pre>
      </div>
    </div>
  );
}

function NoBoardAccessPage() {
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">회사 접근 권한이 없습니다</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          로그인은 되었지만 이 계정에는 활성 회사 멤버십이나 RealTycoon2 인스턴스 관리자 권한이 없습니다.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          회사 초대를 사용하거나 이미 이 조직에 속한 계정으로 다시 로그인하세요.
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
    retry: false,
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
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">RealTycoon2를 불러오는 중입니다...</div>;
  }

  if (healthQuery.error || boardAccessQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        {healthQuery.error instanceof Error
          ? healthQuery.error.message
          : boardAccessQuery.error instanceof Error
            ? boardAccessQuery.error.message
            : "RealTycoon2 상태를 불러오지 못했습니다"}
      </div>
    );
  }

  if (isAuthenticatedMode && healthQuery.data?.bootstrapStatus === "bootstrap_pending") {
    return <BootstrapPendingPage hasActiveInvite={healthQuery.data.bootstrapInviteActive} />;
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
