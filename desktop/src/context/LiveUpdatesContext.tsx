import { createContext, useContext, useEffect, type ReactNode } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";

interface LiveUpdatesContextValue {
  connected: boolean;
}

const LiveUpdatesContext = createContext<LiveUpdatesContextValue>({ connected: false });

const EVENT_TO_QUERY_MAP: Record<string, string[]> = {
  "agent-updated": ["agents"],
  "agent-run-started": ["agents", "heartbeat-runs", "live-runs"],
  "agent-run-completed": ["agents", "heartbeat-runs", "live-runs", "costs"],
  "agent-run-failed": ["agents", "heartbeat-runs", "live-runs"],
  "issue-created": ["issues"],
  "issue-updated": ["issues"],
  "routine-triggered": ["routines", "routine-runs"],
  "workflow-node-started": ["workflow-runs"],
  "workflow-node-completed": ["workflow-runs"],
  "workflow-run-completed": ["workflow-runs", "workflows"],
  // agent-run-log is handled by TranscriptViewer directly, not cache invalidation
};

export function LiveUpdatesProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];

    for (const [eventName, queryKeys] of Object.entries(EVENT_TO_QUERY_MAP)) {
      listen(eventName, () => {
        for (const key of queryKeys) {
          queryClient.invalidateQueries({ queryKey: [key] });
        }
      }).then((unlisten) => {
        unlisteners.push(unlisten);
      });
    }

    return () => {
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, [queryClient]);

  return (
    <LiveUpdatesContext value={{ connected: true }}>
      {children}
    </LiveUpdatesContext>
  );
}

export function useLiveUpdates() {
  return useContext(LiveUpdatesContext);
}
