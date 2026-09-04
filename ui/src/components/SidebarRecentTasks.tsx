import { useQuery } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { useRecentTasks } from "@/hooks/useRecentTasks";
import { useSidebar } from "@/context/SidebarContext";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";

export function SidebarRecentTasks({
  companyId,
  liveIssueIds,
}: {
  companyId: string | null | undefined;
  liveIssueIds: ReadonlySet<string>;
}) {
  const { collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const { data: session, isPending } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  if (!companyId || isPending) return null;

  const userId = session?.user?.id ?? session?.session?.userId ?? null;
  return (
    <RecentTasksList
      key={`${companyId}:${userId ?? "__local_board__"}`}
      companyId={companyId}
      userId={userId}
      liveIssueIds={liveIssueIds}
      rail={rail}
    />
  );
}

function RecentTasksList({
  companyId,
  userId,
  liveIssueIds,
  rail,
}: {
  companyId: string;
  userId: string | null;
  liveIssueIds: ReadonlySet<string>;
  rail: boolean;
}) {
  const { entries } = useRecentTasks({ companyId, userId });

  if (rail && entries.length === 0) return null;

  return (
    <SidebarSection label="Recent Tasks">
      {entries.length === 0 ? (
        <p className="mx-3 px-2 py-1 text-(length:--text-micro) leading-snug text-muted-foreground/70">
          Open or create a task to keep it close at hand.
        </p>
      ) : entries.map((entry) => (
        <SidebarNavItem
          key={entry.id}
          to={`/issues/${entry.id}`}
          label={entry.title}
          liveCount={liveIssueIds.has(entry.id) ? 1 : undefined}
        />
      ))}
    </SidebarSection>
  );
}
