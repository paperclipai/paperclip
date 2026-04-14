import { useCallback, useState } from "react";
import { useLocale } from "../context/LocaleContext";
import { getWorktreeUiBranding } from "../lib/worktree-branding";

export function WorktreeBanner() {
  const { t } = useLocale();
  const branding = getWorktreeUiBranding();
  const [copied, setCopied] = useState(false);

  const handleCopyName = useCallback(() => {
    if (!branding) return;
    navigator.clipboard.writeText(branding.name).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [branding]);

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
        <span className="shrink-0 opacity-70">{t("worktreeBanner.title")}</span>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" aria-hidden="true" />
        <button
          type="button"
          onClick={handleCopyName}
          title={t("worktreeBanner.copyName")}
          className="truncate font-semibold tracking-[0.12em] cursor-pointer hover:opacity-80 transition-opacity bg-transparent border-none p-0 text-current uppercase text-[11px]"
        >
          {copied ? t("common.copied") : branding.name}
        </button>
      </div>
    </div>
  );
}
