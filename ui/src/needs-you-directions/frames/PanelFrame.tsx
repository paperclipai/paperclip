import { surfaceOf, type DirectionKit } from "../kit";
import { PANEL } from "../fixtures";
import { AppShell, SupportButton } from "./AppShell";
import { Slot } from "./Slot";

const SURFACE = surfaceOf("panel");

function TaskBackdrop() {
  return (
    <div aria-hidden className="flex min-w-0 flex-1 flex-col gap-4 p-6 opacity-50">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">NEE-39</span>
        <span className="h-4 w-px bg-border" />
        <span className="text-sm text-muted-foreground">In review</span>
      </div>
      <div className="h-6 w-2/3 rounded-md bg-muted" />
      <div className="flex flex-col gap-2">
        <div className="h-3 w-full rounded bg-muted" />
        <div className="h-3 w-11/12 rounded bg-muted" />
        <div className="h-3 w-3/4 rounded bg-muted" />
      </div>
      <div className="mt-2 h-24 w-full rounded-lg border border-border bg-muted/60" />
      <div className="flex flex-col gap-2">
        <div className="h-3 w-5/6 rounded bg-muted" />
        <div className="h-3 w-2/3 rounded bg-muted" />
      </div>
    </div>
  );
}

export function PanelFrame({ kit }: { kit: DirectionKit }) {
  return (
    <AppShell active={SURFACE.nav} activeLabel="Decisions">
      <div className="relative flex h-(--sz-60px) shrink-0 items-center gap-2 border-b border-border px-4 md:px-6">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">Decisions</span>
        <span className="text-muted-foreground">/</span>
        <span className="min-w-0 truncate text-sm text-muted-foreground">Review panel</span>
        <SupportButton />
      </div>
      <div className="flex min-h-0 flex-1">
        <TaskBackdrop />
        <aside className="shrink-0 border-l border-border bg-background" style={{ width: SURFACE.width }} aria-label="Review panel">
          <Slot kit={kit} className="h-full">
            <kit.PanelBody {...PANEL} />
          </Slot>
        </aside>
      </div>
    </AppShell>
  );
}
