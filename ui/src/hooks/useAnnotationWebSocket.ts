import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Annotation } from "../api/annotations";

export interface AnnotationBBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export type WsStatus = "connecting" | "open" | "closed" | "error";

interface WsAnnotationEvent {
  type: "annotation.created" | "annotation.updated" | "annotation.deleted";
  annotation?: Annotation;
  annotationId?: string;
}

function bboxToParam(bbox: AnnotationBBox): string {
  return `${bbox.minLng},${bbox.minLat},${bbox.maxLng},${bbox.maxLat}`;
}

function buildWsUrl(companyId: string, bbox: AnnotationBBox): string {
  const url = new URL("/ws/annotations", window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("companyId", companyId);
  url.searchParams.set("bbox", bboxToParam(bbox));
  return url.toString();
}

/**
 * Connects to the annotation WebSocket and resubscribes with updated bbox on
 * map pan/zoom. bbox prop is the current viewport bounding box; changing it
 * closes the existing connection and opens a new one with the updated bbox
 * parameter so the server streams annotations for the new viewport.
 *
 * FIX(IUN-2268): Previous implementation connected once with the initial bbox
 * and never updated it. Now we reconnect whenever bbox changes (debounced
 * 500ms at the call-site via Solaris.tsx).
 */
export function useAnnotationWebSocket(
  companyId: string | null | undefined,
  bbox: AnnotationBBox | null,
) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<WsStatus>("closed");
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef<number>(1_000);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // Stable bbox string — used as effect dependency so we reconnect on bbox change.
  const bboxKey = bbox ? bboxToParam(bbox) : null;

  const connect = useCallback(() => {
    if (!companyId || !bbox) return;

    // Close any existing connection before opening a new one.
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close(1000, "bbox_update");
      wsRef.current = null;
    }

    setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(buildWsUrl(companyId, bbox));
    } catch {
      setStatus("error");
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      backoffRef.current = 1_000;
      setStatus("open");
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(event.data as string) as WsAnnotationEvent;
        if (msg.type === "annotation.created" || msg.type === "annotation.updated") {
          queryClient.invalidateQueries({ queryKey: ["annotations", companyId] });
        } else if (msg.type === "annotation.deleted" && msg.annotationId) {
          queryClient.invalidateQueries({ queryKey: ["annotations", companyId] });
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      setStatus("error");
    };

    ws.onclose = (event) => {
      if (!mountedRef.current) return;
      setStatus("closed");
      // Intentional close (bbox update or unmount) — don't reconnect.
      if (event.code === 1000) return;
      // Exponential backoff reconnect for unexpected disconnects.
      const delay = Math.min(backoffRef.current, 30_000);
      backoffRef.current = Math.min(backoffRef.current * 2, 30_000);
      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) connect();
      }, delay);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, bboxKey, queryClient]);

  // Reconnect whenever companyId or bbox changes.
  useEffect(() => {
    mountedRef.current = true;
    if (companyId && bbox) {
      connect();
    }
    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close(1000, "unmount");
        wsRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, bboxKey]);

  return { status };
}
