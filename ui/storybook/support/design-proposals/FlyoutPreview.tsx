import { useState, type CSSProperties } from "react";
import { Check } from "lucide-react";
import { SidebarAccountMenu } from "@/components/SidebarAccountMenu";
import { TruncatedTextMarqueeProvider } from "@/components/TruncatedText";
import { DesignProposalAccess } from "./DesignProposalAccess";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Flyout, FlyoutAppearanceProvider, FlyoutContent, FlyoutHeader, FlyoutOptions, FlyoutTrigger } from "@/components/ui/flyout";
import { allTaskListColumns, defaultTaskListColumns, taskListColumns, type TaskListColumnId } from "@/lib/task-list";
import { taskListViews, type TaskListView } from "@/lib/task-list-views";

export type FlyoutPreviewProps = { mode: "columns" | "views" | "account-menu"; shadow?: string };

/** Isolated reference for the same composition used by the page's flyouts.
 * Shadow overrides stay local to this preview; the saved default is a token. */
export function FlyoutPreview({ mode, shadow }: FlyoutPreviewProps) {
  const [columns, setColumns] = useState<readonly TaskListColumnId[]>(defaultTaskListColumns);
  const [view, setView] = useState<TaskListView>("all");
  const [accountOpen, setAccountOpen] = useState(true);
  return (
    <main className="task-row-design-preview min-h-screen p-12 text-foreground" data-testid="flyout-design-preview">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <h1 className="text-2xl font-semibold">Popover</h1>
        <p className="text-sm text-muted-foreground">Shared title block, options, selection marks and shadow. Hover or focus an option to inspect its highlight.</p>
        <p className="text-sm text-muted-foreground">The Shadow control previews a CSS box-shadow. Clear it to inherit the shared --shadow-flyout token.</p>
        <div className="mt-6 flex justify-center">
          {mode === "account-menu" ? (
            <DesignProposalAccess><FlyoutAppearanceProvider><TruncatedTextMarqueeProvider>
              <div className="flex min-h-96 w-(--profile-popover-width) items-end">
                <div className="design-sidebar-account w-full">
                  <SidebarAccountMenu forceExpanded open={accountOpen} onOpenChange={setAccountOpen} shadow={shadow} />
                </div>
              </div>
            </TruncatedTextMarqueeProvider></FlyoutAppearanceProvider></DesignProposalAccess>
          ) : mode === "views" ? (
            <FlyoutAppearanceProvider><DropdownMenu defaultOpen>
              <DropdownMenuTrigger asChild><Button variant="outline">Views</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-(--flyout-width)" style={shadow ? { "--shadow-flyout": shadow } as CSSProperties : undefined}>
                <DropdownMenuLabel asChild><FlyoutHeader>Views</FlyoutHeader></DropdownMenuLabel>
                <DropdownMenuRadioGroup asChild value={view} onValueChange={value => setView(value as TaskListView)}><FlyoutOptions>
                  {taskListViews.map(({ value, label }) => <DropdownMenuRadioItem key={value} value={value}>{label}</DropdownMenuRadioItem>)}
                </FlyoutOptions></DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu></FlyoutAppearanceProvider>
          ) : (
            <Flyout defaultOpen>
              <FlyoutTrigger asChild><Button variant="outline">Columns</Button></FlyoutTrigger>
              <FlyoutContent align="start" aria-label="Columns" shadow={shadow}>
                <FlyoutHeader>Columns</FlyoutHeader>
                <FlyoutOptions>
                  <>
                    {allTaskListColumns.map(id => <Button key={id} variant="ghost" className="justify-start" aria-pressed={columns.includes(id)} onClick={() => setColumns(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])}>{taskListColumns.find(column => column.id === id)!.label}{columns.includes(id) ? <Check className="ml-auto size-3.5" aria-hidden /> : null}</Button>)}
                    <Button variant="ghost" className="task-list-options-reset" onClick={() => setColumns(defaultTaskListColumns)}>Reset defaults</Button>
                  </>
                </FlyoutOptions>
              </FlyoutContent>
            </Flyout>
          )}
        </div>
      </div>
    </main>
  );
}
