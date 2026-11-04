import { surfaceOf, type DirectionKit } from "../kit";
import { LANDING } from "../fixtures";
import { AppShell, SupportButton } from "./AppShell";
import { Slot } from "./Slot";

const SURFACE = surfaceOf("landing");

export function LandingFrame({ kit }: { kit: DirectionKit }) {
  return (
    <AppShell active={SURFACE.nav} activeLabel="Needs You">
      <div className="relative flex h-(--sz-60px) shrink-0 items-center gap-2 border-b border-border px-4 md:px-6">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">Needs You</span>
        <SupportButton />
      </div>
      <main className="flex-1 p-4 md:p-6">
        <div className="mx-auto w-full" style={{ maxWidth: SURFACE.width }}>
          <Slot kit={kit}>
            <kit.LandingBody {...LANDING} />
          </Slot>
        </div>
      </main>
    </AppShell>
  );
}
