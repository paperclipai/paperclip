import { Search } from "lucide-react";

interface TitleBarProps {
  onSearchClick?: () => void;
}

export function TitleBar({ onSearchClick }: TitleBarProps) {
  return (
    <div
      data-tauri-drag-region
      className="flex h-[var(--titlebar-h)] items-center border-b px-4"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg)" }}
    >
      {/* Traffic light space (macOS positions them here automatically) */}
      <div className="w-[72px] shrink-0" />

      {/* Center title */}
      <div className="flex flex-1 items-center justify-center">
        <span
          className="text-xs font-medium tracking-wide"
          style={{ color: "var(--fg-muted)" }}
        >
          ArchonOS
        </span>
      </div>

      {/* Actions */}
      <div className="flex w-[72px] shrink-0 justify-end">
        <button
          onClick={onSearchClick}
          className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
          style={{ color: "var(--fg-muted)" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-muted)";
            e.currentTarget.style.color = "var(--fg)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--fg-muted)";
          }}
          title="Search (⌘K)"
          aria-label="Open command palette"
        >
          <Search size={14} />
        </button>
      </div>
    </div>
  );
}
