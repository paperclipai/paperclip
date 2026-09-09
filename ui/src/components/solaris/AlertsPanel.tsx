import { useState } from "react";
import { AlertTriangle, Bell, ChevronDown, ChevronRight, Clock, Globe, Plus } from "lucide-react";
import { useSolarisAlerts, useCreateSolarisAlert, LOCALE_BADGES, type SolarisAlert } from "../../hooks/useSolarisAlerts";
import type { SolarisOrg } from "../../hooks/useSolarisAlerts";

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-red-500/20 text-red-400 border-red-500/40",
  warning: "bg-amber-500/20 text-amber-400 border-amber-500/40",
  info: "bg-blue-500/20 text-blue-400 border-blue-500/40",
};

function AlertRow({ alert }: { alert: SolarisAlert }) {
  const [expanded, setExpanded] = useState(false);
  const [showTranslated, setShowTranslated] = useState(false);

  const translatedLocales = alert.translatedBodies ? Object.keys(alert.translatedBodies) : [];
  const hasTranslation = translatedLocales.length > 0;
  const localeBadge = translatedLocales[0] ? LOCALE_BADGES[translatedLocales[0]] : null;
  const displayBody = showTranslated && hasTranslation && translatedLocales[0]
    ? alert.translatedBodies![translatedLocales[0]]
    : alert.body;

  return (
    <div className="border border-border rounded-lg bg-card/60 overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded border ${SEVERITY_STYLES[alert.severity] ?? SEVERITY_STYLES.info}`}>
          {alert.severity.toUpperCase()}
        </span>
        <span className="text-sm font-medium flex-1 truncate">{alert.title}</span>
        {localeBadge && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-400 border border-violet-500/30 shrink-0">
            {localeBadge}
          </span>
        )}
        {alert.dispatchStatus === "translating" && (
          <span className="text-[10px] text-muted-foreground shrink-0 flex items-center gap-1">
            <Clock className="h-3 w-3" /> Translating…
          </span>
        )}
        <span className="text-[11px] text-muted-foreground shrink-0">
          {new Date(alert.createdAt).toLocaleString()}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-border/60 pt-3 space-y-3">
          {alert.incidentArea && (
            <p className="text-xs text-muted-foreground">Area: {alert.incidentArea}</p>
          )}
          <p className="text-sm text-foreground whitespace-pre-wrap">{displayBody}</p>
          {hasTranslation && (
            <button
              onClick={() => setShowTranslated((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-violet-400 hover:text-violet-300 transition-colors"
            >
              <Globe className="h-3.5 w-3.5" />
              {showTranslated ? "Show original" : `Show translated version (${translatedLocales[0]})`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface AlertsPanelProps {
  companyId: string;
  orgs: SolarisOrg[];
}

export function AlertsPanel({ companyId, orgs }: AlertsPanelProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [selectedOrgId, setSelectedOrgId] = useState<string>("");
  const { data: alerts = [], isLoading } = useSolarisAlerts(companyId);
  const createAlert = useCreateSolarisAlert();

  const [form, setForm] = useState({
    title: "",
    body: "",
    severity: "info" as "critical" | "warning" | "info",
    orgId: "",
    incidentArea: "",
  });

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim() || !form.body.trim()) return;
    await createAlert.mutateAsync({
      companyId,
      title: form.title.trim(),
      body: form.body.trim(),
      severity: form.severity,
      orgId: form.orgId || undefined,
      incidentArea: form.incidentArea || undefined,
    });
    setForm({ title: "", body: "", severity: "info", orgId: "", incidentArea: "" });
    setShowCreate(false);
  }

  const filteredAlerts = selectedOrgId
    ? alerts.filter((a) => a.orgId === selectedOrgId)
    : alerts;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">CAP Alerts</span>
          {alerts.length > 0 && (
            <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">{alerts.length}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {orgs.length > 0 && (
            <select
              className="text-xs bg-card border border-border rounded px-2 py-1 text-foreground"
              value={selectedOrgId}
              onChange={(e) => setSelectedOrgId(e.target.value)}
            >
              <option value="">All orgs</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          )}
          <button
            onClick={() => setShowCreate((v) => !v)}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-border bg-card hover:bg-muted transition-colors"
          >
            <Plus className="h-3 w-3" /> New Alert
          </button>
        </div>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="border border-border rounded-lg bg-card/60 p-4 space-y-3">
          <p className="text-xs font-semibold">New CAP Alert</p>
          <input
            className="w-full text-sm bg-muted/40 border border-border rounded px-3 py-2 placeholder:text-muted-foreground"
            placeholder="Title"
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            required
          />
          <textarea
            className="w-full text-sm bg-muted/40 border border-border rounded px-3 py-2 placeholder:text-muted-foreground min-h-[80px] resize-y"
            placeholder="Alert body text"
            value={form.body}
            onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
            required
          />
          <div className="flex gap-3">
            <select
              className="text-xs bg-card border border-border rounded px-2 py-1"
              value={form.severity}
              onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value as typeof form.severity }))}
            >
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
            {orgs.length > 0 && (
              <select
                className="text-xs bg-card border border-border rounded px-2 py-1 flex-1"
                value={form.orgId}
                onChange={(e) => setForm((f) => ({ ...f, orgId: e.target.value }))}
              >
                <option value="">No specific org</option>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>{o.name} ({o.preferredLanguage})</option>
                ))}
              </select>
            )}
            <input
              className="text-xs bg-muted/40 border border-border rounded px-2 py-1 flex-1"
              placeholder="Incident area (optional)"
              value={form.incidentArea}
              onChange={(e) => setForm((f) => ({ ...f, incidentArea: e.target.value }))}
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createAlert.isPending}
              className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {createAlert.isPending ? "Creating…" : "Create Alert"}
            </button>
          </div>
        </form>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground text-center py-4">Loading alerts…</div>
      ) : filteredAlerts.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground">
          <AlertTriangle className="h-6 w-6" />
          <span className="text-sm">No alerts</span>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredAlerts.map((alert) => (
            <AlertRow key={alert.id} alert={alert} />
          ))}
        </div>
      )}
    </div>
  );
}
