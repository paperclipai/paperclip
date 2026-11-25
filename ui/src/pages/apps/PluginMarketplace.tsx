import type { ReactNode } from "react";
import {
  BarChart3,
  Bot,
  Check,
  Code,
  Database,
  FileText,
  LayoutGrid,
  MessageCircle,
  ShoppingBag,
  SquareCheck,
  TriangleAlert,
  Plus,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AppLogo } from "./AppLogo";

export type PluginTileState = "available" | "connected" | "attention";

export type PluginTileAction = {
  label: string;
  disabled?: boolean;
  title?: string;
  onSelect: () => void;
};

const CORNER = "relative z-10 grid size-8 shrink-0 place-items-center rounded-lg";

function StatusMark({ state, label }: { state: Exclude<PluginTileState, "available">; label: string }) {
  const attention = state === "attention";
  const Icon = attention ? TriangleAlert : Check;
  return (
    <span
      title={label}
      className={cn(CORNER, attention ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400")}
    >
      <Icon className="size-4" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** One catalog entry in the Plugins marketplace: logo, name, a corner status or connect control, and a short description. */
export function PluginTile({
  slug,
  name,
  description,
  brandKey,
  logoUrl,
  darkLogoUrl,
  state,
  statusLabel,
  action,
  onOpen,
}: {
  slug: string;
  name: string;
  description: string;
  brandKey: string;
  logoUrl?: string | null;
  darkLogoUrl?: string | null;
  state: PluginTileState;
  statusLabel: string;
  action: PluginTileAction | null;
  onOpen: () => void;
}) {
  const installed = state !== "available";
  return (
    <div
      role="listitem"
      data-app-slug={slug}
      data-connected={installed ? "true" : "false"}
      className="group relative flex min-w-0 flex-col gap-3 rounded-2xl bg-muted/50 p-5 transition-colors hover:bg-muted"
    >
      <div className="flex min-h-8 items-center gap-3">
        <AppLogo name={name} brandKey={brandKey} logoUrl={logoUrl} darkLogoUrl={darkLogoUrl} size={32} compact className="bg-transparent" />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          <button
            type="button"
            title={name}
            className="block max-w-full truncate text-left outline-none after:absolute after:inset-0 after:rounded-2xl focus-visible:after:ring-2 focus-visible:after:ring-ring"
            onClick={onOpen}
          >
            {name}
          </button>
        </h3>
        {action ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              CORNER,
              "bg-foreground/5 hover:bg-foreground/10",
              installed && "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
            )}
            disabled={action.disabled}
            title={action.title ?? `${action.label} ${name}`}
            aria-label={`${action.label} ${name}`}
            onClick={action.onSelect}
          >
            <Plus aria-hidden />
          </Button>
        ) : null}
        {installed ? <StatusMark state={state} label={statusLabel} /> : null}
      </div>
      <p className="line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">{description}</p>
    </div>
  );
}

export const PLUGIN_GRID = "grid gap-3 sm:grid-cols-2 xl:grid-cols-3";

export function PluginShelf({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-6 flex-col gap-3">
      <h2 id={`${id}-title`} className="text-base font-semibold text-foreground">
        {title}
      </h2>
      <div className={PLUGIN_GRID}>{children}</div>
    </section>
  );
}

export const PLUGIN_CATEGORY_ORDER = ["productivity", "developer", "communication", "ai", "data", "analytics", "content", "commerce", "other"] as const;
export type PluginCategoryId = (typeof PLUGIN_CATEGORY_ORDER)[number];

export const PLUGIN_CATEGORIES: Record<PluginCategoryId, { label: string; icon: LucideIcon }> = {
  productivity: { label: "Productivity", icon: SquareCheck },
  developer: { label: "Developer tools", icon: Code },
  communication: { label: "Communication", icon: MessageCircle },
  ai: { label: "AI models & agents", icon: Bot },
  data: { label: "Data", icon: Database },
  analytics: { label: "Analytics", icon: BarChart3 },
  content: { label: "Content", icon: FileText },
  commerce: { label: "Commerce", icon: ShoppingBag },
  other: { label: "Other", icon: LayoutGrid },
};

export const pluginCategoryId = (categories: readonly string[] | undefined): PluginCategoryId => {
  const first = categories?.[0];
  return first && first in PLUGIN_CATEGORIES ? (first as PluginCategoryId) : "other";
};

export const pluginCategorySectionId = (id: PluginCategoryId) => `plugins-category-${id}`;

/** Jump list of the categories that have plugins on the page. */
export function PluginCategories({ categories }: { categories: { id: PluginCategoryId; count: number }[] }) {
  if (categories.length === 0) return null;
  return (
    <nav aria-labelledby="plugins-categories-title" className="flex flex-col gap-3">
      <h2 id="plugins-categories-title" className="text-base font-semibold text-foreground">
        Categories
      </h2>
      <ul className="-mx-2 grid gap-x-6 sm:grid-cols-2 lg:grid-cols-4">
        {categories.map(({ id, count }) => {
          const { label, icon: Icon } = PLUGIN_CATEGORIES[id];
          return (
            <li key={id} className="min-w-0">
              <button
                type="button"
                className="flex h-10 w-full min-w-0 items-center gap-3 rounded-lg px-2 text-left text-sm text-foreground outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => document.getElementById(pluginCategorySectionId(id))?.scrollIntoView({ block: "start", behavior: "smooth" })}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{count}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
