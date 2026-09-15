import { useCallback, useEffect, useRef, useState } from "react";
import type { SolarisAlert } from "../api/solaris-alerts";
import type { ResponderStatusUpdate } from "../api/responder";

export type WsStatus = "connecting" | "open" | "closed" | "error";

export interface IncidentWsEvent {
  type: "solaris.alert.updated" | "solaris.alert.responder_status" | "solaris.alert.chat";
  payload: Record<string, unknown>;
}

interface UseIncidentWebSocketOptions {
  companyId: string | null | undefined;
  onAlertUpdated?: (alert: SolarisAlert) => void;
  onResponderStatus?: (update: ResponderStatusUpdate) => void;
}

function buildWsUrl(companyId: string): string {
  const url = new URL(`/api/companies/${encodeURIComponent(companyId)}/events/ws`, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function useIncidentWebSocket({ companyId, onAlertUpdated, onResponderStatus }: UseIncidentWebSocketOptions) {
  const [status, setStatus] = useState<WsStatus>("closed");
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef<number>(1_000);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const onAlertUpdatedRef = useRef(onAlertUpdated);
  const onResponderStatusRef = useRef(onResponderStatus);
  onAlertUpdatedRef.current = onAlertUpdated;
  onResponderStatusRef.current = onResponderStatus;

  const connect = useCallback(() => {
    if (!companyId) return;

    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    setStatus("connecting");
    const ws = new WebSocket(buildWsUrl(companyId));
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      backoffRef.current = 1_000;
      setStatus("open");
    };

    ws.onmessage = (evt) => {
      let parsed: IncidentWsEvent;
      try {
        parsed = JSON.parse(evt.data as string) as IncidentWsEvent;
      } catch {
        return;
      }

      if (parsed.type === "solaris.alert.updated" && onAlertUpdatedRef.current) {
        const alert = parsed.payload["alert"] as SolarisAlert | undefined;
        if (alert) onAlertUpdatedRef.current(alert);
      }

      if (parsed.type === "solaris.alert.responder_status" && onResponderStatusRef.current) {
        const update = parsed.payload["update"] as ResponderStatusUpdate | undefined;
        if (update) onResponderStatusRef.current(update);
      }
    };

    ws.onerror = () => {
      setStatus("error");
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setStatus("closed");
      const delay = backoffRef.current;
      backoffRef.current = Math.min(backoffRef.current * 2, 30_000);
      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) connect();
      }, delay);
    };
  }, [companyId]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return { status };
}
