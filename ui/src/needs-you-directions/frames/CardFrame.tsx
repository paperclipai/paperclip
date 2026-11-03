import { surfaceOf, type DirectionKit } from "../kit";
import { CARD_ITEMS } from "../fixtures";
import { AppShell, SupportButton } from "./AppShell";
import { Slot } from "./Slot";

const SURFACE = surfaceOf("card");

export function CardFrame({ kit }: { kit: DirectionKit }) {
  return (
    <AppShell active={SURFACE.nav} activeLabel="Decisions">
      <div className="relative flex h-(--sz-60px) shrink-0 items-center gap-2 border-b border-border px-4 md:px-6">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">Decisions</span>
        <span className="text-muted-foreground">/</span>
        <span className="min-w-0 truncate text-sm text-muted-foreground">Card structure</span>
        <SupportButton />
      </div>
      <main className="flex-1 bg-muted/30 p-4 md:p-8">
        <div className="mx-auto w-full" style={{ maxWidth: SURFACE.width }}>
          <Slot kit={kit}>
            <kit.CardBody items={CARD_ITEMS} />
          </Slot>
        </div>
      </main>
    </AppShell>
  );
}
