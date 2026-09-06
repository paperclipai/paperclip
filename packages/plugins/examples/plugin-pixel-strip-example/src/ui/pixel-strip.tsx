import {
  type PluginDetailTabProps,
  type PluginProjectSidebarItemProps,
} from "@paperclipai/plugin-sdk/ui";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PixelSpriteState } from "../pixel-state.js";
import { spriteStateLabel } from "../pixel-state.js";

const PLUGIN_KEY = "paperclip.pixel-strip-example";
const TAB_SLOT_ID = "pixel-strip-tab";

interface Sprite {
  agentId: string;
  state: PixelSpriteState;
}

interface PluginConfig {
  showSidebarLink?: boolean;
}

function tokenClass(token: "verified" | "working" | "waiting" | "blocked" | "owner-gate"): string {
  // The plugin honours the live Paperclip token-only rule: every
  // colour comes from a semantic token. We map the archived
  // Pixel-Company authority onto the same five tokens the live
  // DESIGN.md uses for verified / working / waiting / blocked /
  // owner-gate. The exact Tailwind utility values follow the live
  // `ui/src/index.css`; this layer does not introduce a per-plugin
  // theme.
  switch (token) {
    case "verified":
      return "bg-emerald-100 text-emerald-900 border-emerald-300";
    case "working":
      return "bg-blue-100 text-blue-900 border-blue-300";
    case "waiting":
      return "bg-amber-100 text-amber-900 border-amber-300";
    case "blocked":
      return "bg-red-100 text-red-900 border-red-300";
    case "owner-gate":
      return "bg-violet-100 text-violet-900 border-violet-300";
  }
}

function SpriteChip({ sprite, agentLabel }: { sprite: Sprite; agentLabel: string }) {
  const { label, token } = spriteStateLabel(sprite.state);
  return (
    <span
      title={`${agentLabel} \u2014 ${label}`}
      aria-label={`${agentLabel} \u2014 ${label}`}
      data-sprite-state={sprite.state}
      className={`inline-flex items-center gap-2 rounded-md border px-2 py-1 text-[11px] font-medium ${tokenClass(token)}`}
    >
      <span aria-hidden="true" className="inline-block h-3 w-3 rounded-sm bg-current opacity-70" />
      <span className="font-mono uppercase tracking-wide">{label}</span>
      <span className="truncate text-foreground/80">{agentLabel}</span>
    </span>
  );
}

/**
 * Per-project detail tab. Shows the read-only pixel strip.
 */
export function PixelStripTab({ context }: PluginDetailTabProps) {
  const companyId = context.companyId;
  const projectId = context.entityId;
  const { data, loading, error } = usePluginData<{ sprites: Sprite[] }>("pixel-strip", {
    projectId,
    companyId,
  });

  const sprites = data?.sprites ?? [];

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-foreground">Pixel Strip</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Read-only mirror of persisted Paperclip runtime state. No animation implies work.
          State is mapped only from the same persisted fields the Board and Active Runs use.
        </p>
      </div>

      <div
        className="rounded-lg border border-border bg-card p-4"
        data-testid="pixel-strip-container"
      >
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading pixel strip\u2026</p>
        ) : error ? (
          <p className="text-sm text-destructive">Failed to load pixel strip: {error.message}</p>
        ) : sprites.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No agents currently have an active heartbeat run assigned to this project.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2" role="list" aria-label="Project pixel strip">
            {sprites.map((sprite) => (
              <div role="listitem" key={sprite.agentId}>
                <SpriteChip sprite={sprite} agentLabel={sprite.agentId} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Optional per-project sidebar link. Honours the
 * `showSidebarLink` operator config; hidden by default.
 */
export function PixelStripLink({ context }: PluginProjectSidebarItemProps) {
  const companyId = context.companyId;
  const { data } = usePluginData<PluginConfig>("plugin-config", { companyId });
  const showSidebarLink = data?.showSidebarLink === true;
  if (!showSidebarLink) return null;

  const projectId = context.entityId;
  const projectRef =
    "projectRef" in context && typeof (context as { projectRef?: unknown }).projectRef === "string"
      ? ((context as { projectRef: string }).projectRef)
      : projectId;
  const prefix = context.companyPrefix ? `/${context.companyPrefix}` : "";
  const tabValue = `plugin:${PLUGIN_KEY}:${TAB_SLOT_ID}`;
  const href = `${prefix}/projects/${projectRef}?tab=${encodeURIComponent(tabValue)}`;

  return (
    <a
      href={href}
      className="block px-3 py-1 text-[12px] truncate text-muted-foreground hover:text-foreground hover:bg-accent/50"
    >
      Pixel Strip
    </a>
  );
}
