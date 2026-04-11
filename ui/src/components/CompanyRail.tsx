import { useCallback, useEffect, useMemo, useState } from "react";
import { Paperclip, Plus } from "lucide-react";
import { useQueries } from "@tanstack/react-query";
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
import { useLocale } from "../context/LocaleContext";
import { getShellCopy } from "../lib/shell-copy";
import { cn } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { sidebarBadgesApi } from "../api/sidebarBadges";
import { heartbeatsApi } from "../api/heartbeats";
import { useLocation, useNavigate } from "@/lib/router";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Company } from "@paperclipai/shared";
import { CompanyPatternIcon } from "./CompanyPatternIcon";

const ORDER_STORAGE_KEY = "paperclip.companyOrder";

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
  hasUnreadInbox,
  onSelect,
}: {
  company: Company;
  isSelected: boolean;
  hasLiveAgents: boolean;
  hasUnreadInbox: boolean;
  onSelect: () => void;
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
              e.preventDefault();
              onSelect();
            }}
            className="relative flex items-center justify-center group overflow-visible"
          >
            {/* Selection indicator pill */}
            <div
              className={cn(
                "absolute left-[-14px] w-1 rounded-r-full bg-foreground transition-[height] duration-150",
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
              {hasUnreadInbox && (
                <span className="pointer-events-none absolute -bottom-0.5 -right-0.5 z-10 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-background" />
              )}
            </div>
          </a>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          <p>{company.name}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export function CompanyRail() {
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { openOnboarding } = useDialog();
  const { locale } = useLocale();
  const copy = getShellCopy(locale);
  const navigate = useNavigate();
  const location = useLocation();
  const isInstanceRoute = location.pathname.startsWith("/instance/");
  const highlightedCompanyId = isInstanceRoute ? null : selectedCompanyId;
  const sidebarCompanies = useMemo(
    () => companies.filter((company) => company.status !== "archived"),
    [companies],
  );
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
  const hasUnreadInboxByCompanyId = useMemo(() => {
    const result = new Map<string, boolean>();
    companyIds.forEach((companyId, index) => {
      result.set(companyId, (sidebarBadgeQueries[index]?.data?.inbox ?? 0) > 0);
    });
    return result;
  }, [companyIds, sidebarBadgeQueries]);

  // Maintain sorted order in local state, synced from companies + localStorage
  const [orderedIds, setOrderedIds] = useState<string[]>(() =>
    sortByStoredOrder(sidebarCompanies).map((c) => c.id)
  );

  // Re-sync orderedIds from localStorage whenever companies changes.
  // Handles initial data load (companies starts as [] before query resolves)
  // and subsequent refetches triggered by live updates.
  useEffect(() => {
    if (sidebarCompanies.length === 0) {
      setOrderedIds([]);
      return;
    }
    setOrderedIds(sortByStoredOrder(sidebarCompanies).map((c) => c.id));
  }, [sidebarCompanies]);

  // Sync order across tabs via the native storage event
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key !== ORDER_STORAGE_KEY) return;
      try {
        const ids: string[] = e.newValue ? JSON.parse(e.newValue) : [];
        setOrderedIds(ids);
      } catch { /* ignore malformed data */ }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  // Re-derive when companies change (new company added/removed)
  const orderedCompanies = useMemo(() => {
    const byId = new Map(sidebarCompanies.map((c) => [c.id, c]));
    const result: Company[] = [];
    for (const id of orderedIds) {
      const c = byId.get(id);
      if (c) {
        result.push(c);
        byId.delete(id);
      }
    }
    // Append any new companies not yet in our order
    for (const c of byId.values()) {
      result.push(c);
    }
    return result;
  }, [sidebarCompanies, orderedIds]);

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

      const newIds = arrayMove(ids, oldIndex, newIndex);
      setOrderedIds(newIds);
      saveOrder(newIds);
    },
    [orderedCompanies]
  );

  return (
    <div className="flex flex-col items-center w-[72px] shrink-0 h-full bg-background border-r border-border">
      {/* Paperclip icon - aligned with top sections (implied line, no visible border) */}
      <div className="flex items-center justify-center h-12 w-full shrink-0">
        <Paperclip className="h-5 w-5 text-foreground" />
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
                hasUnreadInbox={hasUnreadInboxByCompanyId.get(company.id) ?? false}
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

      {/* Separator before add button */}
      <div className="w-8 h-px bg-border mx-auto shrink-0" />

      {/* Add company button */}
      <div className="flex items-center justify-center py-2 shrink-0">
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <button
              onClick={() => openOnboarding()}
              className="flex items-center justify-center w-11 h-11 rounded-[22px] hover:rounded-[14px] border-2 border-dashed border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground transition-[border-color,color,border-radius] duration-150"
              aria-label={copy.addCompany}
            >
              <Plus className="h-5 w-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            <p>{copy.addCompany}</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
