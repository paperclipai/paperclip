import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router";
import {
  LayoutDashboard,
  Bot,
  FolderKanban,
  CircleDot,
  GitBranch,
  Target,
  Settings,
  Plus,
  Search,
  DollarSign,
  Package,
  Cpu,
  Zap,
  History,
} from "lucide-react";
import { Command } from "cmdk";

const NAV_COMMANDS = [
  { label: "Dashboard", icon: LayoutDashboard, path: "/dashboard" },
  { label: "Agents", icon: Bot, path: "/agents" },
  { label: "Projects", icon: FolderKanban, path: "/projects" },
  { label: "Issues", icon: CircleDot, path: "/issues" },
  { label: "Workflows", icon: GitBranch, path: "/workflows" },
  { label: "Goals", icon: Target, path: "/goals" },
  { label: "Costs", icon: DollarSign, path: "/costs" },
  { label: "Plugins", icon: Package, path: "/plugins" },
  { label: "Local AI", icon: Cpu, path: "/local-ai" },
  { label: "Automation", icon: Zap, path: "/automation" },
  { label: "Activity", icon: History, path: "/activity" },
  { label: "Settings", icon: Settings, path: "/settings", shortcut: "⌘," },
] as const;

const ACTION_COMMANDS = [
  { label: "New Issue", icon: Plus },
  { label: "New Agent", icon: Plus },
  { label: "New Project", icon: Plus },
] as const;

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const toggle = useCallback(() => setOpen((prev) => !prev), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        toggle();
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, toggle]);

  // Expose toggle for TitleBar
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__archonos_toggle_palette = toggle;
  }, [toggle]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[120px]"
      style={{ background: "oklch(0 0 0 / 0.4)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        className="w-[520px] overflow-hidden rounded-lg border"
        style={{
          background: "var(--card-bg)",
          borderColor: "var(--border)",
          boxShadow: "var(--shadow-3)",
        }}
      >
        <Command>
          <div
            className="flex items-center gap-3 border-b px-4 py-3"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            <Search size={16} style={{ color: "var(--fg-muted)" }} />
            <Command.Input
              placeholder="Search commands..."
              className="flex-1 border-none bg-transparent text-sm outline-none"
              style={{ color: "var(--fg)", fontFamily: "var(--font-body)" }}
              autoFocus
            />
            <kbd
              className="rounded border px-1.5 text-[11px]"
              style={{
                background: "var(--bg-muted)",
                borderColor: "var(--border)",
                color: "var(--fg-muted)",
                fontFamily: "var(--font-mono)",
              }}
            >
              esc
            </kbd>
          </div>

          <Command.List className="max-h-[340px] overflow-y-auto p-2">
            <Command.Empty className="px-3 py-6 text-center text-sm" style={{ color: "var(--fg-muted)" }}>
              No results found.
            </Command.Empty>

            <Command.Group
              heading="Navigation"
              className="text-[11px] font-medium tracking-wide px-3 py-2"
              style={{ color: "var(--fg-muted)" }}
            >
              {NAV_COMMANDS.map(({ label, icon: Icon, path, ...rest }) => (
                <Command.Item
                  key={path}
                  value={label}
                  onSelect={() => {
                    navigate(path);
                    setOpen(false);
                  }}
                  className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-[13px] transition-colors data-[selected=true]:bg-[var(--accent-subtle)] data-[selected=true]:text-[var(--fg)]"
                  style={{ color: "var(--fg-secondary)" }}
                >
                  <Icon size={16} style={{ opacity: 0.6 }} />
                  {label}
                  {"shortcut" in rest && (
                    <span className="ml-auto text-[11px]" style={{ color: "var(--fg-muted)", fontFamily: "var(--font-mono)" }}>
                      {rest.shortcut}
                    </span>
                  )}
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group
              heading="Actions"
              className="text-[11px] font-medium tracking-wide px-3 py-2"
              style={{ color: "var(--fg-muted)" }}
            >
              {ACTION_COMMANDS.map(({ label, icon: Icon }) => (
                <Command.Item
                  key={label}
                  value={label}
                  onSelect={() => setOpen(false)}
                  className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-[13px] transition-colors data-[selected=true]:bg-[var(--accent-subtle)] data-[selected=true]:text-[var(--fg)]"
                  style={{ color: "var(--fg-secondary)" }}
                >
                  <Icon size={16} style={{ opacity: 0.6 }} />
                  {label}
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
