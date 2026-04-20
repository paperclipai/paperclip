import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Plus,
} from "lucide-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  DndContext,
  closestCenter,
  MouseSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar, type SidebarSide } from "../context/SidebarContext";
import { cn } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { sidebarBadgesApi } from "../api/sidebarBadges";
import { heartbeatsApi } from "../api/heartbeats";
import { authApi } from "../api/auth";
import { useCompanyOrder } from "../hooks/useCompanyOrder";
import { useLocation, useNavigate } from "@/lib/router";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Company } from "@paperclipai/shared";
import { CompanyPatternIcon } from "./CompanyPatternIcon";
import { InstanceAgentPauseControl } from "./InstanceAgentPauseControl";

const ORDER_STORAGE_KEY = "paperclip.companyOrder";
const MISSION_CONTROL_URL = "https://robert-dawson-mini-s-1.tail3dddf6.ts.net/";

function getStoredOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function saveOrder(ids: string[]) {
  localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(ids));
}

/** Sort companies by stored order, appending any new ones at the end. */
function sortByStoredOrder(companies: Company[]): Company[] {
  const order = getStoredOrder();
  if (order.length === 0) return companies;

  const byId = new Map(companies.map((c) => [c.id, c]));
  const sorted: Company[] = [];

  for (const id of order) {
    const c = byId.get(id);
    if (c) {
      sorted.push(c);
      byId.delete(id);
    }
  }
  // Append any companies not in stored order
  for (const c of byId.values()) {
    sorted.push(c);
  }
  return sorted;
}

function SortableCompanyItem({
  company,
  isSelected,
  hasLiveAgents,
  hasBlockers,
  onSelect,
  railSide,
}: {
  company: Company;
  isSelected: boolean;
  hasLiveAgents: boolean;
  hasBlockers: boolean;
  onSelect: () => void;
  railSide: SidebarSide;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: company.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.8 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className="overflow-visible">
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <a
            href={`/${company.issuePrefix}/dashboard`}
            onClick={(e) => {
              if (isDragging) {
                e.preventDefault();
                return;
              }
              e.preventDefault();
              onSelect();
            }}
            className="relative flex items-center justify-center group overflow-visible"
          >
            {/* Selection indicator pill */}
            <div
              className={cn(
                "absolute w-1 bg-foreground transition-[height] duration-150",
                railSide === "right" ? "right-[-14px] rounded-l-full" : "left-[-14px] rounded-r-full",
                isSelected
                  ? "h-5"
                  : "h-0 group-hover:h-2"
              )}
            />
            <div
              className={cn("relative overflow-visible transition-transform duration-150", isDragging && "scale-105")}
            >
              <CompanyPatternIcon
                companyName={company.name}
                logoUrl={company.logoUrl}
                brandColor={company.brandColor}
                className={cn(
                  isSelected
                    ? "rounded-[14px]"
                    : "rounded-[22px] group-hover:rounded-[14px]",
                  isDragging && "shadow-lg",
                )}
              />
              {hasLiveAgents && (
                <span className="pointer-events-none absolute -right-0.5 -top-0.5 z-10">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-80" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500 ring-2 ring-background" />
                  </span>
                </span>
              )}
              {hasBlockers && (
                <span className="pointer-events-none absolute -bottom-0.5 -right-0.5 z-10 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-background" />
              )}
            </div>
          </a>
        </TooltipTrigger>
        <TooltipContent side={railSide === "right" ? "left" : "right"} sideOffset={8}>
          <p>{company.name}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export function CompanyRail() {
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { openOnboarding } = useDialog();
  const { isMobile, sidebarOpen, sidebarSide, toggleSidebar, toggleSidebarSide } = useSidebar();
  const navigate = useNavigate();
  const location = useLocation();
  const isInstanceRoute = location.pathname.startsWith("/instance/");
  const highlightedCompanyId = isInstanceRoute ? null : selectedCompanyId;
  const railSide: SidebarSide = isMobile ? "left" : sidebarSide;
  const tooltipSide = railSide === "right" ? "left" : "right";
  const ToggleIcon = sidebarOpen
    ? railSide === "right"
      ? PanelRightClose
      : PanelLeftClose
    : railSide === "right"
      ? PanelRightOpen
      : PanelLeftOpen;
  const MoveIcon = sidebarSide === "left" ? PanelRight : PanelLeft;
  const toggleLabel = sidebarOpen ? "Collapse sidebar" : "Expand sidebar";
  const moveLabel = sidebarSide === "left" ? "Move sidebar right" : "Move sidebar left";
  const sidebarCompanies = useMemo(
    () => companies.filter((company) => company.status !== "archived"),
    [companies],
  );
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const companyIds = useMemo(() => sidebarCompanies.map((company) => company.id), [sidebarCompanies]);

  const liveRunsQueries = useQueries({
    queries: companyIds.map((companyId) => ({
      queryKey: queryKeys.liveRuns(companyId),
      queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
      refetchInterval: 10_000,
    })),
  });
  const sidebarBadgeQueries = useQueries({
    queries: companyIds.map((companyId) => ({
      queryKey: queryKeys.sidebarBadges(companyId),
      queryFn: () => sidebarBadgesApi.get(companyId),
      refetchInterval: 15_000,
    })),
  });
  const hasLiveAgentsByCompanyId = useMemo(() => {
    const result = new Map<string, boolean>();
    companyIds.forEach((companyId, index) => {
      result.set(companyId, (liveRunsQueries[index]?.data?.length ?? 0) > 0);
    });
    return result;
  }, [companyIds, liveRunsQueries]);
  const hasBlockersByCompanyId = useMemo(() => {
    const result = new Map<string, boolean>();
    companyIds.forEach((companyId, index) => {
      result.set(companyId, (sidebarBadgeQueries[index]?.data?.blockers ?? 0) > 0);
    });
    return result;
  }, [companyIds, sidebarBadgeQueries]);

  const { orderedCompanies, persistOrder } = useCompanyOrder({
    companies: sidebarCompanies,
    userId: currentUserId,
  });

  // Require 8px of movement before starting a drag to avoid interfering with clicks
  const sensors = useSensors(
    // Keep sidebar reordering mouse-only so touch input can scroll/tap without drag affordances.
    useSensor(MouseSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const ids = orderedCompanies.map((c) => c.id);
      const oldIndex = ids.indexOf(active.id as string);
      const newIndex = ids.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      persistOrder(arrayMove(ids, oldIndex, newIndex));
    },
    [orderedCompanies, persistOrder]
  );

  return (
    <div
      className={cn(
        "flex flex-col items-center w-[72px] shrink-0 h-full bg-background border-border",
        railSide === "right" ? "border-l" : "border-r",
      )}
    >
      {/* Mission Control shortcut - aligned with top sections (implied line, no visible border) */}
      <div className="flex items-center justify-center h-12 w-full shrink-0">
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <a
              href={MISSION_CONTROL_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-[background-color,color] duration-150 hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Open Mission Control"
              title="Open Mission Control"
            >
              <Paperclip className="h-5 w-5" aria-hidden="true" />
              <span
                data-testid="mission-control-external-badge"
                className="pointer-events-none absolute bottom-0.5 right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground ring-2 ring-background"
                aria-hidden="true"
              >
                <ExternalLink className="h-2.5 w-2.5" />
              </span>
            </a>
          </TooltipTrigger>
          <TooltipContent side={tooltipSide} sideOffset={8}>
            <p>Mission Control</p>
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex items-center justify-center w-full shrink-0 pb-2">
        <InstanceAgentPauseControl side={tooltipSide} />
      </div>

      {/* Company list */}
      <div className="flex-1 flex flex-col items-center gap-2 py-3 w-full overflow-y-auto overflow-x-hidden scrollbar-none">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={orderedCompanies.map((c) => c.id)}
            strategy={verticalListSortingStrategy}
          >
            {orderedCompanies.map((company) => (
              <SortableCompanyItem
                key={company.id}
                company={company}
                isSelected={company.id === highlightedCompanyId}
                hasLiveAgents={hasLiveAgentsByCompanyId.get(company.id) ?? false}
                hasBlockers={hasBlockersByCompanyId.get(company.id) ?? false}
                railSide={railSide}
                onSelect={() => {
                  setSelectedCompanyId(company.id);
                  if (isInstanceRoute) {
                    navigate(`/${company.issuePrefix}/dashboard`);
                  }
                }}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      <div className="flex shrink-0 flex-col items-center gap-1 py-2">
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleSidebar}
              className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-[background-color,color] duration-150 hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={toggleLabel}
              title={toggleLabel}
            >
              <ToggleIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side={tooltipSide} sideOffset={8}>
            <p>{toggleLabel}</p>
          </TooltipContent>
        </Tooltip>
        {!isMobile && (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={toggleSidebarSide}
                className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-[background-color,color] duration-150 hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={moveLabel}
                title={moveLabel}
              >
                <MoveIcon className="h-4 w-4" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side={tooltipSide} sideOffset={8}>
              <p>{moveLabel}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Separator before add button */}
      <div className="w-8 h-px bg-border mx-auto shrink-0" />

      {/* Add company button */}
      <div className="flex items-center justify-center py-2 shrink-0">
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => openOnboarding()}
              className="flex items-center justify-center w-11 h-11 rounded-[22px] hover:rounded-[14px] border-2 border-dashed border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground transition-[border-color,color,border-radius] duration-150"
              aria-label="Add company"
            >
              <Plus className="h-5 w-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side={tooltipSide} sideOffset={8}>
            <p>Add company</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
