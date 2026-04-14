import { memo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { Bug, Moon, Settings, Sun } from "lucide-react";
import { dashboardApi } from "../api/dashboard";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useTheme } from "../context/ThemeContext";
import { queryKeys } from "../lib/queryKeys";

interface StatusBarProps {
  isInstanceAdmin: boolean;
  instanceSettingsTarget: string;
  onBugReport: () => void;
  onChangelog: () => void;
  changelogTrigger: React.ReactNode;
}

export const StatusBar = memo(function StatusBar({
  isInstanceAdmin,
  instanceSettingsTarget,
  onBugReport,
  changelogTrigger,
}: StatusBarProps) {
  const { selectedCompany: company } = useCompany();
  const { theme, toggleTheme } = useTheme();
  const nextTheme = theme === "dark" ? "light" : "dark";

  const { data: summary } = useQuery({
    queryKey: queryKeys.dashboard(company?.id ?? ""),
    queryFn: () => dashboardApi.summary(company!.id),
    enabled: !!company,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(company?.id ?? ""),
    queryFn: () => heartbeatsApi.liveRunsForCompany(company!.id),
    enabled: !!company,
    staleTime: 10_000,
    refetchInterval: 10_000,
  });

  const agentCount = summary
    ? summary.agents.active + summary.agents.running + summary.agents.paused + summary.agents.error
    : null;
  const runningCount = summary?.agents.running ?? 0;
  const activeRuns = liveRuns?.length ?? 0;

  return (
    <footer
      role="contentinfo"
      className="flex items-center gap-3 px-4 py-1 border-t border-border text-[11px] text-muted-foreground shrink-0 print:hidden"
    >
      {/* System metrics - left side */}
      <div className="flex items-center gap-3">
        {agentCount !== null && (
          <Link to="/agents" className="inline-flex items-center gap-1 hover:text-foreground transition-colors no-underline">
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            <span>{agentCount} agents</span>
            {runningCount > 0 && (
              <span className="text-emerald-500">({runningCount} running)</span>
            )}
          </Link>
        )}
        {activeRuns > 0 && (
          <span className="inline-flex items-center gap-1">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-blue-500" />
            </span>
            <span className="text-blue-400">{activeRuns} active runs</span>
          </span>
        )}
      </div>

      {/* Center spacer */}
      <div className="flex-1" />

      {/* Links - right side */}
      <div className="flex items-center gap-3">
        <span className="opacity-60">IronWorks</span>
        <span className="text-border/50">|</span>
        <Link to="/terms" className="hover:text-foreground transition-colors">Terms</Link>
        <Link to="/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
        <Link to="/aup" className="hover:text-foreground transition-colors">AUP</Link>
        <span className="text-border/50">|</span>
        <button type="button" onClick={onBugReport} className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
          <Bug className="h-3 w-3" />Report a Bug
        </button>
        {changelogTrigger}
        {isInstanceAdmin && (
          <>
            <span className="text-border/50">|</span>
            <Link to={instanceSettingsTarget} className="hover:text-foreground transition-colors" title="Settings">Settings</Link>
            <Link to="/manage" className="hover:text-foreground transition-colors" title="Admin">Admin</Link>
          </>
        )}
        <span className="text-border/50">|</span>
        <button type="button" onClick={toggleTheme} className="hover:text-foreground transition-colors" aria-label={`Switch to ${nextTheme} mode`}>
          {theme === "dark" ? <Sun className="h-3 w-3" /> : <Moon className="h-3 w-3" />}
        </button>
      </div>
    </footer>
  );
});
