import { useLocation, useNavigate } from "react-router";
import {
  LayoutDashboard,
  Bot,
  FolderKanban,
  CircleDot,
  GitBranch,
  Target,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { icon: LayoutDashboard, path: "/dashboard", label: "Dashboard" },
  { icon: Bot, path: "/agents", label: "Agents" },
  { icon: FolderKanban, path: "/projects", label: "Projects" },
  { icon: CircleDot, path: "/issues", label: "Issues" },
  { icon: GitBranch, path: "/workflows", label: "Workflows" },
  { icon: Target, path: "/goals", label: "Goals" },
] as const;

export function NavigationRail() {
  const location = useLocation();
  const navigate = useNavigate();

  const isActive = (path: string) => location.pathname.startsWith(path);

  return (
    <nav
      className="flex w-[var(--rail-w)] shrink-0 flex-col items-center border-r py-3"
      style={{ background: "var(--rail-bg)", borderColor: "var(--border-subtle)" }}
    >
      {/* Primary navigation */}
      <div className="flex flex-1 flex-col items-center gap-1">
        {NAV_ITEMS.map(({ icon: Icon, path, label }) => (
          <button
            key={path}
            onClick={() => navigate(path)}
            className={cn(
              "relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors",
              isActive(path)
                ? "text-[var(--accent)]"
                : "text-[var(--fg-muted)] hover:bg-[var(--bg-muted)] hover:text-[var(--fg-secondary)]",
            )}
            title={label}
            aria-label={label}
            aria-current={isActive(path) ? "page" : undefined}
          >
            {isActive(path) && (
              <span
                className="absolute -left-2 h-5 w-[3px] rounded-r-full"
                style={{
                  background: "var(--accent)",
                  animation: "pill-in var(--duration-normal) var(--ease-spring)",
                }}
              />
            )}
            <Icon size={20} />
          </button>
        ))}
      </div>

      {/* Bottom section */}
      <div className="flex flex-col items-center gap-1">
        <div className="my-2 h-px w-6" style={{ background: "var(--border)" }} />
        <button
          onClick={() => navigate("/settings")}
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-lg transition-colors",
            isActive("/settings")
              ? "text-[var(--accent)]"
              : "text-[var(--fg-muted)] hover:bg-[var(--bg-muted)] hover:text-[var(--fg-secondary)]",
          )}
          title="Settings"
          aria-label="Settings"
        >
          {isActive("/settings") && (
            <span
              className="absolute -left-2 h-5 w-[3px] rounded-r-full"
              style={{ background: "var(--accent)" }}
            />
          )}
          <Settings size={20} />
        </button>
        <div
          className="flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-full text-[11px] font-semibold transition-transform hover:scale-110"
          style={{
            background: "var(--accent-subtle)",
            border: "2px solid var(--accent)",
            color: "var(--accent)",
          }}
          title="User"
        >
          U
        </div>
      </div>

      <style>{`
        @keyframes pill-in {
          from { height: 0; opacity: 0; }
          to { height: 20px; opacity: 1; }
        }
      `}</style>
    </nav>
  );
}
