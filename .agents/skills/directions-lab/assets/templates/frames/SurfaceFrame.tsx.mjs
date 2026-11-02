export default (ctx, surface) => `import { surfaceOf, type DirectionKit } from "../kit";
import { ${surface.fixture} } from "../fixtures";
import { AppShell, SupportButton } from "./AppShell";
import { Slot } from "./Slot";

const SURFACE = surfaceOf("${surface.id}");

export function ${surface.frame}({ kit }: { kit: DirectionKit }) {
  return (
    <AppShell active={SURFACE.nav}>
      <div className="relative flex h-(--sz-60px) shrink-0 items-center border-b border-border px-4 md:px-6">
        <span className="min-w-0 truncate font-semibold uppercase tracking-wider text-muted-foreground">{SURFACE.label}</span>
        <SupportButton />
      </div>
      <main className="flex-1 p-4 md:p-6">
        <div
          data-lab-stub="frame-${surface.id}"
          className="mx-auto flex w-full flex-col gap-3 rounded-md border border-dashed border-border p-4"
          style={{ maxWidth: SURFACE.width }}
        >
          <p className="font-mono text-(length:--text-micro) uppercase tracking-(--tracking-label) text-muted-foreground">
            Frame · {SURFACE.label} · {SURFACE.width}px · draw the product chrome here
          </p>
          <Slot kit={kit}>
            <kit.${surface.body} items={${surface.fixture}} />
          </Slot>
        </div>
      </main>
    </AppShell>
  );
}
`;
