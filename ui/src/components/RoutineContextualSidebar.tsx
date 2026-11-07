import { t, useTranslation } from "@/i18n";
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
import { ContextualSidebarFrame } from "./ContextualSidebarFrame";
import { SidebarNavItem } from "./SidebarNavItem";

export const ROUTINE_DETAIL_VIEWS = [
  "overview",
  "triggers",
  "variables",
  "delivery",
  "secrets",
  "history",
  "runs",
  "activity",
] as const;

export type RoutineDetailView = (typeof ROUTINE_DETAIL_VIEWS)[number];

export type RoutineContextualNavItem = {
  view: Exclude<RoutineDetailView, "history">;
  label: string;
  icon: LucideIcon;
};

export const ROUTINE_CONTEXTUAL_NAV_ITEMS: readonly RoutineContextualNavItem[] = [
  { view: "overview", get label() { return t("task-components:overview_d4b1ea57"); }, icon: LayoutDashboard },
  { view: "triggers", get label() { return t("task-components:triggers_e62f2148"); }, icon: CalendarClock },
  { view: "variables", get label() { return t("task-components:variables_02db55ba"); }, icon: Braces },
  { view: "delivery", get label() { return t("task-components:delivery_52bfe584"); }, icon: Send },
  { view: "secrets", get label() { return t("task-components:secrets_d8707d41"); }, icon: KeyRound },
];

export function isRoutineDetailView(value: string | null | undefined): value is RoutineDetailView {
  return ROUTINE_DETAIL_VIEWS.includes(value as RoutineDetailView);
}

export function routineDetailHref(routineId: string, view: RoutineDetailView = "overview") {
  return `/routines/${routineId}/${view}`;
}

/** Keep routine configuration and operations in the routine detail shell. */
export function resolveRoutineDetailDestination(input: {
  routineId: string;
  section?: string | null;
  legacyTab?: string | null;
}) {
  const requested = input.legacyTab ?? input.section;
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
  useTranslation("task-components");
  const params = useParams<{ routineId?: string }>();
  const routineId = routineIdProp ?? params.routineId ?? "";
  const { data: routine } = useQuery({
    queryKey: queryKeys.routines.detail(routineId),
    queryFn: () => routinesApi.get(routineId),
    enabled: Boolean(routineId && !title),
  });
  const frameTitle = title ?? routine?.title ?? t("final-components-a:routine_0b5baf30");

  return (
    <ContextualSidebarFrame
      surface="routine"
      title={frameTitle}
      icon={Repeat}
      fallbackTo="/routines"
      showHeader={false}
      className="border-r border-border bg-background"
    >
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-2" aria-label={t("task-components:routineNavigation_906a9d16")}>
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

        <p className="px-4 pb-1 pt-5 text-(length:--text-nano) font-mono font-medium uppercase tracking-widest text-muted-foreground/60">{t("task-components:operate_58c3939c")}</p>
        <div className="flex flex-col gap-0.5">
          <SidebarNavItem
            to={routineDetailHref(routineId, "runs")}
            label={t("task-components:runs_848f54e8")}
            icon={Play}
          />
          <SidebarNavItem
            to={routineDetailHref(routineId, "activity")}
            label={t("task-components:activity_38da1505")}
            icon={Activity}
          />
        </div>
      </nav>
    </ContextualSidebarFrame>
  );
}
