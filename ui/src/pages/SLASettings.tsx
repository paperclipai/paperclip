import { useEffect, useState } from "react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import {
  Clock,
  Shield,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  TrendingUp,
  Save,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "../lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type Priority = "critical" | "high" | "medium" | "low";

interface SLAPolicy {
  responseTimeMinutes: number;
  resolutionTimeMinutes: number;
}

type SLAPolicies = Record<Priority, SLAPolicy>;

interface SLABreach {
  id: string;
  issueIdentifier: string;
  issueTitle: string;
  priority: Priority;
  breachType: "response" | "resolution";
  breachedAt: string;
}

const STORAGE_KEY = "ironworks.sla-policies";

const DEFAULT_POLICIES: SLAPolicies = {
  critical: { responseTimeMinutes: 60, resolutionTimeMinutes: 240 },
  high: { responseTimeMinutes: 240, resolutionTimeMinutes: 1440 },
  medium: { responseTimeMinutes: 1440, resolutionTimeMinutes: 4320 },
  low: { responseTimeMinutes: 4320, resolutionTimeMinutes: 10080 },
};

const PRIORITY_LABELS: Record<Priority, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const PRIORITY_COLORS: Record<Priority, string> = {
  critical: "text-red-600 dark:text-red-400",
  high: "text-orange-600 dark:text-orange-400",
  medium: "text-yellow-600 dark:text-yellow-400",
  low: "text-blue-600 dark:text-blue-400",
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function loadPolicies(): SLAPolicies {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as SLAPolicies;
  } catch { /* ignore */ }
  return { ...DEFAULT_POLICIES };
}

function savePolicies(policies: SLAPolicies) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(policies));
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remainH = h % 24;
  return remainH > 0 ? `${d}d ${remainH}h` : `${d}d`;
}

function parseTimeInput(value: string): number {
  const num = parseInt(value, 10);
  return isNaN(num) || num < 1 ? 1 : num;
}

function generateMockBreaches(): SLABreach[] {
  const now = Date.now();
  return [
    {
      id: "b1",
      issueIdentifier: "PAP-142",
      issueTitle: "Production API timeout on /agents endpoint",
      priority: "critical",
      breachType: "response",
      breachedAt: new Date(now - 2 * 3600_000).toISOString(),
    },
    {
      id: "b2",
      issueIdentifier: "PAP-138",
      issueTitle: "Dashboard metrics not updating",
      priority: "high",
      breachType: "resolution",
      breachedAt: new Date(now - 18 * 3600_000).toISOString(),
    },
  ];
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function PolicyRow({
  priority,
  policy,
  onChange,
}: {
  priority: Priority;
  policy: SLAPolicy;
  onChange: (updated: SLAPolicy) => void;
}) {
  const [responseH, setResponseH] = useState(String(Math.floor(policy.responseTimeMinutes / 60)));
  const [responseM, setResponseM] = useState(String(policy.responseTimeMinutes % 60));
  const [resolutionH, setResolutionH] = useState(String(Math.floor(policy.resolutionTimeMinutes / 60)));
  const [resolutionM, setResolutionM] = useState(String(policy.resolutionTimeMinutes % 60));

  useEffect(() => {
    setResponseH(String(Math.floor(policy.responseTimeMinutes / 60)));
    setResponseM(String(policy.responseTimeMinutes % 60));
    setResolutionH(String(Math.floor(policy.resolutionTimeMinutes / 60)));
    setResolutionM(String(policy.resolutionTimeMinutes % 60));
  }, [policy]);

  function commitResponse() {
    const h = parseTimeInput(responseH);
    const m = parseInt(responseM, 10) || 0;
    onChange({ ...policy, responseTimeMinutes: h * 60 + m });
  }

  function commitResolution() {
    const h = parseTimeInput(resolutionH);
    const m = parseInt(resolutionM, 10) || 0;
    onChange({ ...policy, resolutionTimeMinutes: h * 60 + m });
  }

  return (
    <div className="grid grid-cols-[120px_1fr_1fr] gap-4 items-center py-3 border-b border-border last:border-0">
      <span className={cn("text-sm font-medium", PRIORITY_COLORS[priority])}>
        {PRIORITY_LABELS[priority]}
      </span>

      <div>
        <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Response</label>
        <div className="flex items-center gap-1 mt-0.5">
          <Input
            value={responseH}
            onChange={(e) => setResponseH(e.target.value)}
            onBlur={commitResponse}
            className="h-7 w-14 text-xs text-center"
            type="number"
            min={0}
          />
          <span className="text-xs text-muted-foreground">h</span>
          <Input
            value={responseM}
            onChange={(e) => setResponseM(e.target.value)}
            onBlur={commitResponse}
            className="h-7 w-14 text-xs text-center"
            type="number"
            min={0}
            max={59}
          />
          <span className="text-xs text-muted-foreground">m</span>
          <span className="text-[10px] text-muted-foreground ml-1">
            ({formatMinutes(policy.responseTimeMinutes)})
          </span>
        </div>
      </div>

      <div>
        <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Resolution</label>
        <div className="flex items-center gap-1 mt-0.5">
          <Input
            value={resolutionH}
            onChange={(e) => setResolutionH(e.target.value)}
            onBlur={commitResolution}
            className="h-7 w-14 text-xs text-center"
            type="number"
            min={0}
          />
          <span className="text-xs text-muted-foreground">h</span>
          <Input
            value={resolutionM}
            onChange={(e) => setResolutionM(e.target.value)}
            onBlur={commitResolution}
            className="h-7 w-14 text-xs text-center"
            type="number"
            min={0}
            max={59}
          />
          <span className="text-xs text-muted-foreground">m</span>
          <span className="text-[10px] text-muted-foreground ml-1">
            ({formatMinutes(policy.resolutionTimeMinutes)})
          </span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export function SLASettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const [policies, setPolicies] = useState<SLAPolicies>(() => loadPolicies());
  const [breaches] = useState<SLABreach[]>(() => generateMockBreaches());

  useEffect(() => {
    setBreadcrumbs([{ label: "SLA Settings" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  function handlePolicyChange(priority: Priority, updated: SLAPolicy) {
    setPolicies((prev) => ({ ...prev, [priority]: updated }));
  }

  function handleSave() {
    savePolicies(policies);
    pushToast({ title: "SLA policies saved", tone: "success" });
  }

  function handleReset() {
    setPolicies({ ...DEFAULT_POLICIES });
    savePolicies(DEFAULT_POLICIES);
    pushToast({ title: "SLA policies reset to defaults", tone: "info" });
  }

  // Mock compliance stats
  const totalIssues = 48;
  const breachedCount = breaches.length;
  const complianceRate = Math.round(((totalIssues - breachedCount) / totalIssues) * 100);
  const avgResponseMinutes = 32;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">SLA Settings</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Configure response and resolution time targets per priority level.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={handleReset}>
            Reset Defaults
          </Button>
          <Button size="sm" onClick={handleSave}>
            <Save className="h-3.5 w-3.5 mr-1.5" />
            Save Policies
          </Button>
        </div>
      </div>

      {/* Compliance dashboard */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-2">
            <TrendingUp className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-wider">Compliance Rate</span>
          </div>
          <p className={cn(
            "text-3xl font-bold",
            complianceRate >= 95 ? "text-green-600 dark:text-green-400" :
            complianceRate >= 80 ? "text-yellow-600 dark:text-yellow-400" :
            "text-red-600 dark:text-red-400",
          )}>
            {complianceRate}%
          </p>
          <p className="text-xs text-muted-foreground mt-1">This period</p>
        </div>

        <div className="rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-2">
            <Clock className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-wider">Avg Response Time</span>
          </div>
          <p className="text-3xl font-bold">{avgResponseMinutes}m</p>
          <p className="text-xs text-muted-foreground mt-1">Across all priorities</p>
        </div>

        <div className="rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-2">
            <AlertTriangle className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-wider">Breaches</span>
          </div>
          <p className={cn(
            "text-3xl font-bold",
            breachedCount === 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400",
          )}>
            {breachedCount}
          </p>
          <p className="text-xs text-muted-foreground mt-1">This period</p>
        </div>
      </div>

      {/* Policy configuration */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center gap-2 mb-4">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">SLA Policies by Priority</h2>
        </div>

        <div className="grid grid-cols-[120px_1fr_1fr] gap-4 mb-2 px-0">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Priority</span>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Response Time Target</span>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Resolution Time Target</span>
        </div>

        {(["critical", "high", "medium", "low"] as Priority[]).map((p) => (
          <PolicyRow
            key={p}
            priority={p}
            policy={policies[p]}
            onChange={(updated) => handlePolicyChange(p, updated)}
          />
        ))}
      </div>

      {/* Recent breaches */}
      {breaches.length > 0 && (
        <div className="rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 mb-3">
            <XCircle className="h-4 w-4 text-red-500" />
            <h2 className="text-sm font-semibold">Recent Breaches</h2>
          </div>
          <div className="space-y-2">
            {breaches.map((b) => (
              <div key={b.id} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
                <span className={cn("text-xs font-medium", PRIORITY_COLORS[b.priority])}>
                  {PRIORITY_LABELS[b.priority]}
                </span>
                <span className="text-xs font-mono text-muted-foreground">{b.issueIdentifier}</span>
                <span className="text-sm flex-1 truncate">{b.issueTitle}</span>
                <span className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                  b.breachType === "response"
                    ? "bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300"
                    : "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
                )}>
                  {b.breachType} SLA
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {breaches.length === 0 && (
        <div className="rounded-lg border border-border p-6 text-center">
          <CheckCircle2 className="h-8 w-8 text-green-500 mx-auto mb-2" />
          <p className="text-sm font-medium">No SLA Breaches</p>
          <p className="text-xs text-muted-foreground mt-1">All missions are within their SLA targets.</p>
        </div>
      )}
    </div>
  );
}
