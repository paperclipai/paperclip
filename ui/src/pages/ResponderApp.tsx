import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle, Flame, MapPin, Radio, Truck, WifiOff, X } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { fetchSolarisAlerts, type SolarisAlert } from "../api/solaris-alerts";
import {
  usePostResponderStatus,
  useResponderStatus,
  useVapidPublicKey,
  useSavePushSubscription,
  RESPONDER_STATUS_LABELS,
  RESPONDER_STATUS_ORDER,
  type ResponderStatus,
  type ResponderStatusUpdate,
} from "../hooks/useResponder";
import { useIncidentWebSocket } from "../hooks/useIncidentWebSocket";
import { useToast } from "../context/ToastContext";

// ── IndexedDB offline cache ───────────────────────────────────────────────────

const IDB_DB = "responder-pwa";
const IDB_STORE = "incidents";
const IDB_VERSION = 1;

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheIncidents(alerts: SolarisAlert[]): Promise<void> {
  try {
    const db = await openIdb();
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    for (const a of alerts) store.put(a);
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch {
    // IndexedDB not available (privacy mode, etc.) — degrade gracefully
  }
}

async function loadCachedIncidents(): Promise<SolarisAlert[]> {
  try {
    const db = await openIdb();
    const tx = db.transaction(IDB_STORE, "readonly");
    const store = tx.objectStore(IDB_STORE);
    return new Promise<SolarisAlert[]>((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => { db.close(); resolve(req.result as SolarisAlert[]); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch {
    return [];
  }
}

// ── Severity styles ───────────────────────────────────────────────────────────

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-red-500/20 text-red-400 border-red-500/40",
  warning: "bg-amber-500/20 text-amber-400 border-amber-500/40",
  info: "bg-blue-500/20 text-blue-400 border-blue-500/40",
};

const SEVERITY_ICON: Record<string, React.ReactNode> = {
  critical: <Flame className="h-4 w-4 text-red-400" />,
  warning: <AlertTriangle className="h-4 w-4 text-amber-400" />,
  info: <Radio className="h-4 w-4 text-blue-400" />,
};

const STATUS_NEXT: Record<ResponderStatus, ResponderStatus | null> = {
  acknowledged: "en_route",
  en_route: "on_scene",
  on_scene: "cleared",
  cleared: null,
};

const STATUS_COLOR: Record<ResponderStatus, string> = {
  acknowledged: "bg-amber-500",
  en_route: "bg-blue-500",
  on_scene: "bg-orange-500",
  cleared: "bg-green-500",
};

// ── Responder status pill ─────────────────────────────────────────────────────

function StatusPill({ status }: { status: ResponderStatus | null }) {
  if (!status) return <span className="text-xs text-muted-foreground">No status</span>;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full text-white ${STATUS_COLOR[status]}`}>
      {RESPONDER_STATUS_LABELS[status]}
    </span>
  );
}

// ── Progress stepper ─────────────────────────────────────────────────────────

function StatusStepper({ current }: { current: ResponderStatus | null }) {
  return (
    <div className="flex items-center gap-1 mt-3">
      {RESPONDER_STATUS_ORDER.map((s, i) => {
        const isDone = current !== null && RESPONDER_STATUS_ORDER.indexOf(current) >= i;
        return (
          <div key={s} className="flex items-center gap-1 flex-1">
            <div className={`h-2 flex-1 rounded-full transition-colors ${isDone ? STATUS_COLOR[s] : "bg-muted"}`} />
            {i < RESPONDER_STATUS_ORDER.length - 1 && (
              <div className="w-1 h-1 rounded-full bg-muted-foreground/30" />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Incident card ─────────────────────────────────────────────────────────────

function IncidentCard({
  alert,
  responderId,
  onSelect,
}: {
  alert: SolarisAlert;
  responderId: string;
  onSelect: (alert: SolarisAlert) => void;
}) {
  const { data } = useResponderStatus(alert.id, responderId);
  const latestStatus = data?.latestStatus ?? null;

  return (
    <button
      onClick={() => onSelect(alert)}
      className="w-full text-left rounded-xl border border-border bg-card/70 p-4 active:scale-[0.98] transition-transform"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">{SEVERITY_ICON[alert.severity] ?? SEVERITY_ICON.info}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded border ${SEVERITY_STYLES[alert.severity] ?? SEVERITY_STYLES.info}`}>
              {alert.severity.toUpperCase()}
            </span>
            <StatusPill status={latestStatus} />
          </div>
          <p className="mt-1.5 text-sm font-semibold leading-snug line-clamp-2">{alert.title}</p>
          {alert.incidentArea && (
            <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
              <MapPin className="h-3 w-3" /> {alert.incidentArea}
            </p>
          )}
          <StatusStepper current={latestStatus} />
        </div>
      </div>
    </button>
  );
}

// ── Incident detail panel ─────────────────────────────────────────────────────

function IncidentDetail({
  alert,
  responderId,
  responderName,
  onClose,
}: {
  alert: SolarisAlert;
  responderId: string;
  responderName: string;
  onClose: () => void;
}) {
  const { data, refetch } = useResponderStatus(alert.id, responderId);
  const latestStatus = data?.latestStatus ?? null;
  const nextStatus = latestStatus ? STATUS_NEXT[latestStatus] : "acknowledged";
  const postStatus = usePostResponderStatus(alert.id);
  const { pushToast } = useToast();

  async function advance() {
    const status = nextStatus;
    if (!status) return;
    try {
      await postStatus.mutateAsync({ status, responderId, responderName });
      refetch();
      pushToast({ title: `Status updated: ${RESPONDER_STATUS_LABELS[status]}`, tone: "success" });
    } catch {
      pushToast({ title: "Failed to update status", tone: "error" });
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background safe-area-insets">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-safe-top pb-3 pt-3 border-b border-border bg-card/80 backdrop-blur-sm">
        <button
          onClick={onClose}
          className="p-2 rounded-lg hover:bg-muted/40 transition-colors"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground font-mono">
            {alert.incidentId ?? alert.id.slice(0, 8).toUpperCase()}
          </p>
          <p className="text-sm font-semibold truncate">{alert.title}</p>
        </div>
        <StatusPill status={latestStatus} />
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-5 space-y-6">
        {/* Metadata */}
        <div className="rounded-xl border border-border bg-card/60 p-4 space-y-2">
          {alert.incidentArea && (
            <div className="flex items-center gap-2 text-sm">
              <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
              <span>{alert.incidentArea}</span>
            </div>
          )}
          {alert.incidentType && (
            <div className="flex items-center gap-2 text-sm">
              <Flame className="h-4 w-4 text-muted-foreground shrink-0" />
              <span>{alert.incidentType}</span>
            </div>
          )}
          <div className="flex items-center gap-2 text-sm">
            <Radio className="h-4 w-4 text-muted-foreground shrink-0" />
            <span>{alert.source}</span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Reported: {new Date(alert.reportedAt ?? alert.createdAt).toLocaleString()}
          </p>
        </div>

        {/* Incident body */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Details</p>
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{alert.body}</p>
        </div>

        {/* Status stepper */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wide">Progress</p>
          <div className="flex gap-2">
            {RESPONDER_STATUS_ORDER.map((s) => {
              const idx = latestStatus ? RESPONDER_STATUS_ORDER.indexOf(latestStatus) : -1;
              const sIdx = RESPONDER_STATUS_ORDER.indexOf(s);
              const isDone = idx >= sIdx;
              return (
                <div key={s} className="flex-1 text-center">
                  <div className={`h-2 rounded-full mb-1 ${isDone ? STATUS_COLOR[s] : "bg-muted"}`} />
                  <p className={`text-[10px] font-medium ${isDone ? "text-foreground" : "text-muted-foreground"}`}>
                    {RESPONDER_STATUS_LABELS[s]}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {/* History */}
        {(data?.updates?.length ?? 0) > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">History</p>
            <div className="space-y-2">
              {data!.updates.map((u) => (
                <div key={u.id} className="flex items-center gap-3 text-sm">
                  <CheckCircle className={`h-4 w-4 shrink-0 ${STATUS_COLOR[u.status]} rounded-full text-white`} style={{ padding: "1px" }} />
                  <span className="font-medium">{RESPONDER_STATUS_LABELS[u.status]}</span>
                  {u.responderName && <span className="text-muted-foreground">— {u.responderName}</span>}
                  <span className="text-muted-foreground text-xs ml-auto">{new Date(u.createdAt).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* CTA */}
      {nextStatus && (
        <div className="px-4 pb-safe-bottom pb-6 pt-4 border-t border-border bg-card/80 backdrop-blur-sm">
          <button
            onClick={advance}
            disabled={postStatus.isPending}
            className="w-full py-4 rounded-xl font-semibold text-white text-base transition-all active:scale-[0.97] disabled:opacity-50 flex items-center justify-center gap-2"
            style={{ background: `var(--${STATUS_COLOR[nextStatus].replace("bg-", "").replace("-500", "")}-500, #3b82f6)` }}
          >
            <Truck className="h-5 w-5" />
            {postStatus.isPending ? "Updating…" : `Mark ${RESPONDER_STATUS_LABELS[nextStatus]}`}
          </button>
        </div>
      )}
      {!nextStatus && (
        <div className="px-4 pb-safe-bottom pb-6 pt-4 border-t border-border bg-card/80 backdrop-blur-sm">
          <div className="w-full py-4 rounded-xl font-semibold text-center text-sm text-green-400 bg-green-500/10 border border-green-500/20 flex items-center justify-center gap-2">
            <CheckCircle className="h-5 w-5" />
            Incident Cleared
          </div>
        </div>
      )}
    </div>
  );
}

// ── Push notification setup ───────────────────────────────────────────────────

function usePushSetup(companyId: string | null | undefined, responderId: string) {
  const { data: vapidKey } = useVapidPublicKey();
  const saveSub = useSavePushSubscription(companyId);
  const attempted = useRef(false);

  useEffect(() => {
    if (!vapidKey || !companyId || !responderId || attempted.current) return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    attempted.current = true;

    async function subscribe() {
      try {
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        const sub = existing ?? await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKey!,
        });
        const json = sub.toJSON();
        if (!json.endpoint || !json.keys?.["p256dh"] || !json.keys?.["auth"]) return;
        await saveSub.mutateAsync({
          responderId,
          endpoint: json.endpoint,
          p256dh: json.keys["p256dh"],
          auth: json.keys["auth"],
        });
      } catch {
        // Push permission denied or VAPID key invalid — silent fail
      }
    }

    void subscribe();
  }, [vapidKey, companyId, responderId, saveSub]);
}

// ── Main page ─────────────────────────────────────────────────────────────────

const DEFAULT_RESPONDER_ID = "field-responder";
const DEFAULT_RESPONDER_NAME = "Field Responder";

export function ResponderApp() {
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id ?? null;
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  useEffect(() => {
    setBreadcrumbs([{ label: "Responder" }]);
  }, [setBreadcrumbs]);

  const [selectedAlert, setSelectedAlert] = useState<SolarisAlert | null>(null);
  const [offlineAlerts, setOfflineAlerts] = useState<SolarisAlert[]>([]);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  // Responder identity (in production, derive from auth session)
  const responderId = DEFAULT_RESPONDER_ID;
  const responderName = DEFAULT_RESPONDER_NAME;

  // Live incident query
  const alertsQuery = useQuery({
    queryKey: ["solaris-alerts-responder", companyId],
    queryFn: () => fetchSolarisAlerts(companyId!),
    enabled: !!companyId,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  // Cache to IndexedDB when we get fresh data
  useEffect(() => {
    if (alertsQuery.data && alertsQuery.data.length > 0) {
      void cacheIncidents(alertsQuery.data);
    }
  }, [alertsQuery.data]);

  // Load IndexedDB cache when offline
  useEffect(() => {
    function goOffline() {
      setIsOffline(true);
      loadCachedIncidents().then(setOfflineAlerts);
    }
    function goOnline() {
      setIsOffline(false);
      queryClient.invalidateQueries({ queryKey: ["solaris-alerts-responder"] });
    }
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    if (!navigator.onLine) {
      loadCachedIncidents().then(setOfflineAlerts);
    }
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, [queryClient]);

  // WebSocket for live updates
  const { status: wsStatus } = useIncidentWebSocket({
    companyId,
    onAlertUpdated: (updated) => {
      queryClient.setQueryData<SolarisAlert[]>(
        ["solaris-alerts-responder", companyId],
        (prev) => {
          if (!prev) return [updated];
          const idx = prev.findIndex((a) => a.id === updated.id);
          if (idx === -1) return [updated, ...prev];
          const next = [...prev];
          next[idx] = updated;
          return next;
        },
      );
    },
    onResponderStatus: (update: ResponderStatusUpdate) => {
      queryClient.invalidateQueries({ queryKey: ["responder-status", update.alertId] });
      pushToast({ title: `Incident status: ${RESPONDER_STATUS_LABELS[update.status as ResponderStatus]}`, tone: "info" });
    },
  });

  // Web Push setup
  usePushSetup(companyId, responderId);

  const alerts = isOffline ? offlineAlerts : (alertsQuery.data ?? []);
  const activeAlerts = alerts.filter((a) => a.dispatchStatus === "ready" || a.source === "cad" || a.incidentId);

  const handleSelect = useCallback((alert: SolarisAlert) => {
    setSelectedAlert(alert);
  }, []);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Offline banner */}
      {isOffline && (
        <div className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-400 text-xs font-medium">
          <WifiOff className="h-3.5 w-3.5" />
          Offline — showing last-known incidents
        </div>
      )}

      {/* WS status */}
      {!isOffline && wsStatus !== "open" && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-muted/40 border-b border-border text-muted-foreground text-xs">
          <div className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
          {wsStatus === "connecting" ? "Connecting to live feed…" : "Reconnecting…"}
        </div>
      )}

      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-border bg-card/60 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-red-500/20 flex items-center justify-center shrink-0">
            <Radio className="h-4 w-4 text-red-400" />
          </div>
          <div>
            <h1 className="text-base font-bold">Field Responder</h1>
            <p className="text-xs text-muted-foreground">
              {activeAlerts.length} active incident{activeAlerts.length !== 1 ? "s" : ""}
              {!isOffline && wsStatus === "open" && (
                <span className="ml-2 text-green-400 font-medium">● Live</span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Incident list */}
      <div className="flex-1 px-3 py-4 space-y-3 overflow-y-auto">
        {alertsQuery.isLoading && !isOffline && (
          <div className="flex flex-col gap-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 rounded-xl bg-muted/40 animate-pulse" />
            ))}
          </div>
        )}

        {!alertsQuery.isLoading && activeAlerts.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <CheckCircle className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm font-medium text-muted-foreground">No active incidents</p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              {isOffline ? "No cached incidents available" : "All clear in your area"}
            </p>
          </div>
        )}

        {activeAlerts.map((alert) => (
          <IncidentCard
            key={alert.id}
            alert={alert}
            responderId={responderId}
            onSelect={handleSelect}
          />
        ))}
      </div>

      {/* Incident detail panel */}
      {selectedAlert && (
        <IncidentDetail
          alert={selectedAlert}
          responderId={responderId}
          responderName={responderName}
          onClose={() => setSelectedAlert(null)}
        />
      )}
    </div>
  );
}
