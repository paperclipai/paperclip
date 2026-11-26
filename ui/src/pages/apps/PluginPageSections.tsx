import type { ReactNode } from "react";
import { ArrowUpRight, Check, Plug, TriangleAlert } from "lucide-react";
import type { ConnectionMethodDef } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AppLogo } from "./AppLogo";
import type { PluginTileState } from "./PluginMarketplace";

const AUTH_LABEL: Record<ConnectionMethodDef["auth"], string> = { oauth: "OAuth", api_key: "API key", none: "No sign-in" };

/** The host a connector talks to, when its definition names one. */
export function pluginHost(methods: readonly ConnectionMethodDef[] | undefined): string | null {
  for (const method of methods ?? []) {
    const url = method.defaults?.serverUrl;
    if (!url) continue;
    try {
      return new URL(url).host;
    } catch {
      continue;
    }
  }
  return null;
}

/** Sign-in kinds a connector offers, in the order its definition lists them. */
export function pluginSignIn(methods: readonly ConnectionMethodDef[] | undefined): string | null {
  const labels = [...new Set((methods ?? []).map((method) => AUTH_LABEL[method.auth]))];
  return labels.length > 0 ? labels.join(" or ") : null;
}

/** A labelled block on the plugin page: a quiet heading with an optional count over one grouped surface. */
export function PluginGroup({ id, label, count, children }: { id: string; label: string; count?: number; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="flex items-baseline gap-2 px-4 text-sm text-muted-foreground">
        {label}
        {count === undefined ? null : <span className="tabular-nums">{count}</span>}
      </h2>
      <div className="overflow-hidden rounded-2xl bg-muted/50">{children}</div>
    </section>
  );
}

function StatusMark({ state, name }: { state: Exclude<PluginTileState, "available">; name: string }) {
  const attention = state === "attention";
  const Icon = attention ? TriangleAlert : Check;
  return (
    <span
      role="img"
      aria-label={attention ? `${name} needs attention` : `${name} connected`}
      title={attention ? "Needs attention" : "Connected"}
      className={cn("grid size-7 shrink-0 place-items-center rounded-lg", attention ? "bg-(--status-task-todo)/15 text-(--status-task-icon-todo)" : "bg-(--status-task-done)/15 text-(--status-task-icon-done)")}
    >
      <Icon className="size-4" aria-hidden />
    </span>
  );
}

export type PluginConnectAction = { disabled?: boolean; title?: string; onSelect: () => void };

/** Plugin page header: logo, name with its status, what it is, and the one primary action. */
export function PluginPageHeader({
  name,
  kind,
  description,
  brandKey,
  logoUrl,
  darkLogoUrl,
  state,
  docsUrl,
  connect,
}: {
  name: string;
  kind: string;
  description: string;
  brandKey: string;
  logoUrl?: string | null;
  darkLogoUrl?: string | null;
  state: PluginTileState;
  docsUrl?: string;
  connect: PluginConnectAction | null;
}) {
  return (
    <header className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <span className="grid size-16 shrink-0 place-items-center rounded-2xl bg-foreground/5">
          <AppLogo name={name} brandKey={brandKey} logoUrl={logoUrl} darkLogoUrl={darkLogoUrl} size={40} className="bg-transparent" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-3">
            <p className="truncate text-2xl leading-8 font-semibold tracking-tight text-foreground">{name}</p>
            {state === "available" ? null : <StatusMark state={state} name={name} />}
          </div>
          <p className="text-sm text-muted-foreground">{kind}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state !== "available" && docsUrl ? (
            <Button asChild variant="ghost">
              <a href={docsUrl} target="_blank" rel="noopener noreferrer">
                Docs
                <ArrowUpRight aria-hidden />
              </a>
            </Button>
          ) : null}
          {state === "available" && connect ? (
            <Button type="button" disabled={connect.disabled} title={connect.title} aria-label={`Connect ${name}`} onClick={connect.onSelect}>
              Connect
            </Button>
          ) : null}
        </div>
      </div>
      <p className="max-w-prose text-base leading-6 text-pretty text-foreground">{description}</p>
    </header>
  );
}

/** The connector a plugin installs: what it is, where it runs and how it signs in. */
export function PluginConnector({ name, host, signIn }: { name: string; host: string | null; signIn: string | null }) {
  return (
    <PluginGroup id="plugin-connector-title" label="Connector">
      <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-foreground/5 text-foreground">
          <Plug className="size-4" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="truncate text-sm font-semibold text-foreground">{name}</p>
          <p className="truncate text-sm text-muted-foreground">
            Connector{host ? <> · <span className="font-mono text-xs">{host}</span></> : null}
          </p>
        </div>
        {signIn ? <span className="shrink-0 text-sm text-muted-foreground">{signIn}</span> : null}
      </div>
    </PluginGroup>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 px-4 py-2">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 justify-end text-right text-sm text-foreground">{children}</dd>
    </div>
  );
}

/** Reference facts about a plugin, drawn from its catalog definition. */
export function PluginInformation({ category, signIn, host, docsUrl }: { category: string; signIn: string | null; host: string | null; docsUrl?: string }) {
  return (
    <PluginGroup id="plugin-information-title" label="Information">
      <dl className="flex flex-col divide-y divide-border">
        <Fact label="Category">{category}</Fact>
        {signIn ? <Fact label="Sign-in">{signIn}</Fact> : null}
        {host ? (
          <Fact label="Server">
            <span className="truncate font-mono text-xs">{host}</span>
          </Fact>
        ) : null}
        {docsUrl ? (
          <Fact label="Docs">
            <a href={docsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 underline underline-offset-2">
              <span className="truncate">{docsUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>
              <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
            </a>
          </Fact>
        ) : null}
      </dl>
    </PluginGroup>
  );
}
