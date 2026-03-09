import { Puzzle, Settings } from "lucide-react";
import { Link, useLocation, Outlet } from "@/lib/router";
import { useSidebar } from "@/context/SidebarContext";
import { cn } from "@/lib/utils";

/**
 * InstanceSettings layout component.
 * 
 * Provides a unified sidebar navigation for instance-wide settings that are not specific 
 * to a single project or operational context. This currently includes plugin management,
 * and is designed to house future instance-level configurations like User Management,
 * Authentication providers, and System Health.
 * 
 * This component acts as a layout, rendering child routes in an <Outlet />.
 * Breadcrumbs are managed by the individual child pages to ensure specific context.
 * On mobile, the nav sidebar is collapsed so content uses full width.
 */
export function InstanceSettings() {
  const location = useLocation();
  const path = location.pathname;
  const { isMobile } = useSidebar();

  // Check if we are in the plugins section
  const isPlugins = path.includes("/settings/plugins");

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 mb-6 shrink-0">
        <Settings className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Settings</h1>
      </div>

      <div className="flex flex-1 min-h-0 gap-8">
        {/* Left Nav — hidden on mobile so content has full width */}
        {!isMobile && (
          <aside className="w-48 shrink-0 flex flex-col gap-1">
            <SettingsNavLink 
              to="/settings/plugins" 
              label="Plugins" 
              icon={Puzzle} 
              active={isPlugins} 
            />
            {/* Add more settings here in the future: Users, Auth, General, etc. */}
          </aside>
        )}

        {/* Content */}
        <main className={cn("flex-1 min-w-0 overflow-y-auto pr-4", isMobile && "pr-0")}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

interface SettingsNavLinkProps {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
}

/**
 * Navigation link for the settings sidebar.
 */
function SettingsNavLink({ 
  to, 
  label, 
  icon: Icon, 
  active 
}: SettingsNavLinkProps) {
  return (
    <Link
      to={to}
      className={cn(
        "flex items-center gap-2.5 px-3 py-2 text-sm font-medium transition-colors no-underline",
        active 
          ? "bg-accent text-foreground" 
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span>{label}</span>
    </Link>
  );
}
