import { getWorktreeUiBranding } from "../lib/worktree-branding";

export function WorktreeBanner() {
  const branding = getWorktreeUiBranding();
  if (!branding) return null;

  return (
    <div
      className="relative overflow-hidden border-b px-3 py-1.5 text-[11px] font-medium tracking-[0.2em] uppercase"
      style={{
        backgroundColor: branding.color,
        color: branding.textColor,
        borderColor: `${branding.textColor}22`,
        boxShadow: `inset 0 -1px 0 ${branding.textColor}18`,
        backgroundImage: `linear-gradient(90deg, ${branding.textColor}14, transparent 28%, transparent 72%, ${branding.textColor}12), repeating-linear-gradient(135deg, transparent 0 10px, ${branding.textColor}08 10px 20px)`,
      }}
    >
      <div className="flex items-center gap-2 overflow-hidden whitespace-nowrap">
        <span className="shrink-0 opacity-70">Worktree</span>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" aria-hidden="true" />
        <span className="truncate font-semibold tracking-[0.12em]">{branding.name}</span>
      </div>
    </div>
  );
}
