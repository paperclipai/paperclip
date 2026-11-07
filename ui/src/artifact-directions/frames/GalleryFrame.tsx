import { ArrowLeft, Layers, Search } from "lucide-react";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { DirectionKit, LabGroup } from "../kit";
import { SupportButton } from "./AppShell";
import { Slot } from "./Slot";

/**
 * Static mock of the company Artifacts page (pages/Artifacts.tsx): the 60px top
 * bar, the toolbar and, when a stack is open, its header row. The kit supplies
 * the grid below.
 */

// pages/Artifacts.tsx:32-39
const KIND_TABS = ["All", "Images", "Videos", "Documents", "Text", "Files"];

/** BreadcrumbBar.tsx:193-214 (single crumb) and :128-189 (trail); crumbs from Artifacts.tsx:218-227. */
function TopBar({ open }: { open: LabGroup | null }) {
  return (
    <div className="relative h-(--sz-60px) shrink-0 flex items-center border-b border-border px-4 md:px-6">
      <div className="min-w-0 overflow-hidden flex-1">
        {open ? (
          <Breadcrumb className="min-w-0 overflow-hidden">
            <BreadcrumbList className="flex-nowrap">
              <BreadcrumbItem className="shrink-0">
                <span className="min-w-0 truncate font-semibold uppercase tracking-wider text-muted-foreground">Artifacts</span>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="truncate">
                  {open.taskIdentifier} · {open.title}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        ) : (
          <h1 className="text-sm font-semibold uppercase tracking-wider truncate">Artifacts</h1>
        )}
      </div>
      <SupportButton />
    </div>
  );
}

/** pages/Artifacts.tsx:250-325. Grouping is on (Task, the default) and "All" is selected, as in the screenshots. */
function Toolbar() {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="relative w-full sm:max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input readOnly className="h-9 pl-9 pr-9 text-sm" placeholder="Search artifacts..." aria-label="Search artifacts" />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="outline" size="icon" className="h-8 w-8 shrink-0 bg-accent" title="Group artifacts" aria-label="Group artifacts (currently Task)">
          <Layers className="h-3.5 w-3.5" />
        </Button>
        <div role="tablist" aria-label="Filter artifacts by type" className="flex flex-wrap items-center gap-1.5">
          {KIND_TABS.map((label, index) => (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={index === 0}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                index === 0 ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** pages/Artifacts.tsx:327-344. */
function StackHeader({ group }: { group: LabGroup }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" />
        All stacks
      </span>
      <span className="truncate text-muted-foreground">
        <span className="text-foreground/80">{group.taskIdentifier}</span> {group.title}
      </span>
    </div>
  );
}

export function GalleryFrame({ kit, groups, open }: { kit: DirectionKit; groups: LabGroup[]; open: LabGroup | null }) {
  return (
    <>
      <TopBar open={open} />
      {/* Layout.tsx:749-765 */}
      <main className="flex-1 p-4 outline-none md:p-6">
        {/* pages/Artifacts.tsx:249 */}
        <div className="w-full max-w-6xl space-y-5">
          {kit.GalleryView ? (
            <Slot kit={kit}>
              <kit.GalleryView groups={groups} open={open} />
            </Slot>
          ) : (
            <>
              <Toolbar />
              {open ? <StackHeader group={open} /> : null}
              <Slot kit={kit}>{open ? <kit.GalleryStack group={open} /> : <kit.GalleryStacks groups={groups} />}</Slot>
            </>
          )}
        </div>
      </main>
    </>
  );
}
