import { useState } from "react";
import { APP_DEFINITIONS } from "@paperclipai/shared";
import type { AppDefinition, ConnectionMethodDef } from "@paperclipai/shared";

import { MethodBadges } from "./MethodSelect";
import { ConfigureStep } from "./ConfigureStep";

/**
 * Add-Connection wizard **preview harness** (plan-wizard-ux §6 build notes): the
 * screenshot source. Renders every Wave-1 `AppDefinition` × method Configure
 * step so review can capture each archetype (branded OAuth / multi-method /
 * api-key multi-key / generic OAuth discovery) without a backend.
 *
 * Dev-only surface routed at `/apps/preview`.
 */
export function ConnectPreview() {
  const [activeSlug, setActiveSlug] = useState<string>(APP_DEFINITIONS[0]?.slug ?? "");
  const active = APP_DEFINITIONS.find((d) => d.slug === activeSlug) ?? APP_DEFINITIONS[0];

  return (
    <div className="mx-auto flex max-w-6xl gap-6 p-6">
      <nav className="w-48 shrink-0">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Wave 1 catalog
        </p>
        <ul className="space-y-0.5">
          {APP_DEFINITIONS.map((d) => (
            <li key={d.slug}>
              <button
                type="button"
                onClick={() => setActiveSlug(d.slug)}
                className={
                  "w-full rounded-md px-2 py-1.5 text-left text-sm " +
                  (d.slug === active?.slug
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent/50")
                }
              >
                {d.name}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="min-w-0 flex-1 space-y-8">
        {active && <ProviderPreview def={active} />}
      </div>
    </div>
  );
}

function ProviderPreview({ def }: { def: AppDefinition }) {
  return (
    <section>
      <header className="mb-4 border-b border-border pb-3">
        <h1 className="text-lg font-semibold text-foreground">{def.name}</h1>
        <p className="text-sm text-muted-foreground">{def.description}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {def.categories.join(" · ")} · {def.methods.length} method
          {def.methods.length === 1 ? "" : "s"}
        </p>
      </header>
      <div className="space-y-10">
        {def.methods.map((method: ConnectionMethodDef) => (
          <div key={method.key} data-preview-method={method.key}>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-sm font-semibold text-foreground">Method: {method.key}</h2>
              <MethodBadges method={method} />
              <span className="text-xs text-muted-foreground">risk {method.riskTier}</span>
            </div>
            <div className="rounded-xl border border-border bg-card p-5">
              <ConfigureStep def={def} method={method} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
