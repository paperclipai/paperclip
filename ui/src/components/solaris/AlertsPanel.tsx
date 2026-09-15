import { useCallback, useState } from "react";
import { AlertTriangle, Bell, ChevronDown, ChevronRight, Clock, Globe, MapPin, Plus, Timer, User } from "lucide-react";
import { useSolarisAlerts, useCreateSolarisAlert, LOCALE_BADGES, type SolarisAlert } from "../../hooks/useSolarisAlerts";
import type { SolarisOrg } from "../../hooks/useSolarisAlerts";
import { useResponderStatus, RESPONDER_STATUS_LABELS, type ResponderStatusUpdate } from "../../hooks/useResponder";
import { useIncidentWebSocket } from "../../hooks/useIncidentWebSocket";

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-red-500/20 text-red-400 border-red-500/40",
  warning: "bg-amber-500/20 text-amber-400 border-amber-500/40",
  info: "bg-blue-500/20 text-blue-400 border-blue-500/40",
};

const STATUS_COLOR: Record<string, string> = {
  acknowledged: "bg-amber-500",
  en_route: "bg-blue-500",
  on_scene: "bg-orange-500",
  cleared: "bg-green-500",
};

const STATUS_DOT: Record<string, string> = {
  acknowledged: "bg-amber-400",
  en_route: "bg-blue-400",
  on_scene: "bg-orange-400",
  cleared: "bg-green-400",
};

const TIMEOUT_MS = 15 * 60 * 1000;

function isTimedOut(update: ResponderStatusUpdate): boolean {
  return Date.now() - new Date(update.createdAt).getTime() > TIMEOUT_MS;
}

function minutesAgo(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 60_000);
}

function ResponderStatusBadge({ update }: { update: ResponderStatusUpdate | null | undefined }) {
  if (!update) return null;
  const timedOut = isTimedOut(update);
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
        timedOut
          ? "bg-red-500/20 text-red-400 border-red-500/40"
          : `${STATUS_COLOR[update.status]}/20 border-${STATUS_COLOR[update.status].replace("bg-", "")}/40`
      }`}
      title={timedOut ? `No update for ${minutesAgo(update.createdAt)} min — may be offline` : undefined}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${timedOut ? "bg-red-400 animate-pulse" : STATUS_DOT[update.status]}`} />
      {RESPONDER_STATUS_LABELS[update.status as keyof typeof RESPONDER_STATUS_LABELS]}
      {timedOut && <Timer className="h-3 w-3 ml-0.5 text-red-400" />}
    </span>
  );
}

function ResponderDetail({ alertId }: { alertId: string }) {
  const { data } = useResponderStatus(alertId);
  const updates = data?.updates ?? [];
  const latest = updates.length > 0 ? updates[updates.length - 1] : null;

  if (updates.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">No responder updates yet.</p>
    );
  }

  const timedOut = latest && isTimedOut(latest);

  return (
    <div className="space-y-3">
      {/* Latest status summary */}
      {latest && (
        <div className="rounded-lg bg-muted/30 border border-border/60 p-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full text-white ${STATUS_COLOR[latest.status]}`}>
              {RESPONDER_STATUS_LABELS[latest.status as keyof typeof RESPONDER_STATUS_LABELS]}
            </span>
            {latest.responderName && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <User className="h-3 w-3" />
                {latest.responderName}
              </span>
            )}
            <span className="text-xs text-muted-foreground ml-auto">
              {minutesAgo(latest.createdAt)}m ago
            </span>
          </div>

          {timedOut && (
            <div className="flex items-center gap-1.5 text-xs text-red-400 bg-red-500/10 rounded px-2 py-1 border border-red-500/20">
              <Timer className="h-3.5 w-3.5 shrink-0" />
              No update for {minutesAgo(latest.createdAt)} min — responder may be offline
            </div>
          )}

          {latest.eta && (
            <div className="flex items-center gap-1.5 text-xs text-foreground">
              <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">ETA:</span> {latest.eta}
            </div>
          )}

          {latest.lat != null && latest.lng != null && (
            <div className="flex items-center gap-1.5 text-xs text-foreground">
              <MapPin className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">Location:</span>{" "}
              <a
                href={`https://www.openstreetmap.org/?mlat=${latest.lat}&mlon=${latest.lng}#map=15/${latest.lat}/${latest.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline font-mono"
              >
                {latest.lat.toFixed(5)}, {latest.lng.toFixed(5)}
              </a>
            </div>
          )}

          {latest.note && (
            <p className="text-xs text-muted-foreground italic">"{latest.note}"</p>
          )}
        </div>
      )}

      {/* Status timeline */}
      {updates.length > 1 && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Timeline</p>
          <div className="space-y-1.5">
            {updates.map((u, i) => (
              <div key={u.id} className="flex items-start gap-2">
                <div className="flex flex-col items-center mt-0.5 shrink-0">
                  <span className={`h-2 w-2 rounded-full ${STATUS_DOT[u.status]}`} />
                  {i < updates.length - 1 && <div className="w-px h-3 bg-border mt-0.5" />}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium">
                    {RESPONDER_STATUS_LABELS[u.status as keyof typeof RESPONDER_STATUS_LABELS]}
                  </span>
                  {u.responderName && (
                    <span className="text-[11px] text-muted-foreground ml-1.5">— {u.responderName}</span>
                  )}
                  {u.eta && (
                    <span className="text-[11px] text-muted-foreground ml-1.5">· ETA {u.eta}</span>
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {new Date(u.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AlertRow({ alert, liveStatus }: { alert: SolarisAlert; liveStatus?: ResponderStatusUpdate | null }) {
  const [expanded, setExpanded] = useState(false);
  const [showTranslated, setShowTranslated] = useState(false);

  const translatedLocales = alert.translatedBodies ? Object.keys(alert.translatedBodies) : [];
  const hasTranslation = translatedLocales.length > 0;
  const localeBadge = translatedLocales[0] ? LOCALE_BADGES[translatedLocales[0]] : null;
  const displayBody = showTranslated && hasTranslation && translatedLocales[0]
    ? alert.translatedBodies![translatedLocales[0]]
    : alert.body;

  const timedOut = liveStatus && isTimedOut(liveStatus);

  return (
    <div className={`border rounded-lg bg-card/60 overflow-hidden transition-colors ${timedOut ? "border-red-500/40" : "border-border"}`}>
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded border ${SEVERITY_STYLES[alert.severity] ?? SEVERITY_STYLES.info}`}>
          {alert.severity.toUpperCase()}
        </span>
        <span className="text-sm font-medium flex-1 truncate">{alert.title}</span>
        <div className="flex items-center gap-2 shrink-0">
          {liveStatus && <ResponderStatusBadge update={liveStatus} />}
          {localeBadge && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-400 border border-violet-500/30">
              {localeBadge}
            </span>
          )}
          {alert.dispatchStatus === "translating" && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" /> Translating…
            </span>
          )}
          <span className="text-[11px] text-muted-foreground hidden sm:inline">
            {new Date(alert.createdAt).toLocaleString()}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-border/60 pt-3 space-y-4">
          {alert.incidentArea && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <MapPin className="h-3 w-3" /> {alert.incidentArea}
            </p>
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

          {/* Responder status section */}
          <div className="border-t border-border/40 pt-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              Responder Status
            </p>
            <ResponderDetail alertId={alert.id} />
          </div>
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

  // Live responder status per alert, keyed by alertId
  const [liveStatuses, setLiveStatuses] = useState<Record<string, ResponderStatusUpdate>>({});

  const handleResponderStatus = useCallback((update: ResponderStatusUpdate) => {
    setLiveStatuses((prev) => {
      const current = prev[update.alertId];
      // Only keep the most recent update per alert
      if (!current || new Date(update.createdAt) >= new Date(current.createdAt)) {
        return { ...prev, [update.alertId]: update };
      }
      return prev;
    });
  }, []);

  const { status: wsStatus } = useIncidentWebSocket({
    companyId,
    onResponderStatus: handleResponderStatus,
  });

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

  const timedOutCount = Object.values(liveStatuses).filter((u) =>
    filteredAlerts.some((a) => a.id === u.alertId) && isTimedOut(u)
  ).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">CAP Alerts</span>
          {alerts.length > 0 && (
            <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">{alerts.length}</span>
          )}
          {timedOutCount > 0 && (
            <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30 flex items-center gap-1">
              <Timer className="h-3 w-3" />
              {timedOutCount} timeout{timedOutCount !== 1 ? "s" : ""}
            </span>
          )}
          {/* WS live indicator */}
          <span
            className={`h-1.5 w-1.5 rounded-full shrink-0 ${wsStatus === "open" ? "bg-green-400" : "bg-amber-400 animate-pulse"}`}
            title={`Live feed: ${wsStatus}`}
          />
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
            <AlertRow
              key={alert.id}
              alert={alert}
              liveStatus={liveStatuses[alert.id] ?? null}
            />
          ))}
        </div>
      )}
    </div>
  );
}
