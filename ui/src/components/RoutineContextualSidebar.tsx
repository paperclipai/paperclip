import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Braces,
  CalendarClock,
  KeyRound,
  LayoutDashboard,
  Play,
  Repeat,
  Send,
  type LucideIcon,
} from "lucide-react";
import { routinesApi } from "@/api/routines";
import { queryKeys } from "@/lib/queryKeys";
import { useParams } from "@/lib/router";
import {
  auditSectionHref,
  routineAuditHref,
} from "@/pages/audit/audit-navigation";
import { ContextualSidebarFrame } from "./ContextualSidebarFrame";
import { SidebarNavItem } from "./SidebarNavItem";

export const ROUTINE_DETAIL_VIEWS = [
  "overview",
  "triggers",
  "variables",
  "delivery",
  "secrets",
  "history",
] as const;

export type RoutineDetailView = (typeof ROUTINE_DETAIL_VIEWS)[number];

export type RoutineContextualNavItem = {
  view: Exclude<RoutineDetailView, "history">;
  label: string;
  icon: LucideIcon;
};

export const ROUTINE_CONTEXTUAL_NAV_ITEMS: readonly RoutineContextualNavItem[] = [
  { view: "overview", label: "Overview", icon: LayoutDashboard },
  { view: "triggers", label: "Schedule", icon: CalendarClock },
  { view: "variables", label: "Variables", icon: Braces },
  { view: "delivery", label: "Delivery", icon: Send },
  { view: "secrets", label: "Secrets", icon: KeyRound },
];

export function isRoutineDetailView(value: string | null | undefined): value is RoutineDetailView {
  return ROUTINE_DETAIL_VIEWS.includes(value as RoutineDetailView);
}

export function routineDetailHref(routineId: string, view: RoutineDetailView = "overview") {
  return `/routines/${routineId}/${view}`;
}

export function routineRunsAuditHref(routineId: string) {
  return auditSectionHref("runs", {
    entityType: "routine",
    entityId: routineId,
  });
}

export function routineActivityAuditHref(routineId: string) {
  return routineAuditHref(routineId);
}

/**
 * Canonical landing/legacy resolver used by the page and available to the
 * shell. Detail configuration stays local; immutable operational history
 * lives in scoped Audit.
 */
export function resolveRoutineDetailDestination(input: {
  routineId: string;
  section?: string | null;
  legacyTab?: string | null;
}) {
  const requested = input.legacyTab ?? input.section;
  if (requested === "runs") return routineRunsAuditHref(input.routineId);
  if (requested === "activity") return routineActivityAuditHref(input.routineId);
  if (isRoutineDetailView(requested)) return routineDetailHref(input.routineId, requested);
  return routineDetailHref(input.routineId, "overview");
}

export function RoutineContextualSidebar({
  routineId: routineIdProp,
  title,
}: {
  routineId?: string;
  title?: string;
} = {}) {
  const params = useParams<{ routineId?: string }>();
  const routineId = routineIdProp ?? params.routineId ?? "";
  const { data: routine } = useQuery({
    queryKey: queryKeys.routines.detail(routineId),
    queryFn: () => routinesApi.get(routineId),
    enabled: Boolean(routineId && !title),
  });
  const frameTitle = title ?? routine?.title ?? "Routine";

  return (
    <ContextualSidebarFrame
      surface="routine"
      title={frameTitle}
      icon={Repeat}
      fallbackTo="/routines"
      showHeader={false}
      className="border-r border-border bg-background"
    >
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-2" aria-label="Routine navigation">
        <div className="flex flex-col gap-0.5">
          {ROUTINE_CONTEXTUAL_NAV_ITEMS.map((item) => (
            <SidebarNavItem
              key={item.view}
              to={routineDetailHref(routineId, item.view)}
              label={item.label}
              icon={item.icon}
              end
            />
          ))}
        </div>

        <p className="px-4 pb-1 pt-5 text-(length:--text-nano) font-mono font-medium uppercase tracking-widest text-muted-foreground/60">
          Audit
        </p>
        <div className="flex flex-col gap-0.5">
          <SidebarNavItem
            to={routineRunsAuditHref(routineId)}
            label="Runs"
            icon={Play}
          />
          <SidebarNavItem
            to={routineActivityAuditHref(routineId)}
            label="Activity"
            icon={Activity}
          />
        </div>
      </nav>
    </ContextualSidebarFrame>
  );
}
