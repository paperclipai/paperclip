import { useCallback, useMemo } from "react";
import {
  bridgeDenyFlashPayloadSchema,
  bridgeSessionPayloadSchema,
  type BridgeDenyFlashPayload,
  type BridgeSessionPayload,
} from "@paperclipai/shared";
import { useLiveEventSubscription } from "../context/LiveUpdatesProvider";

export type { BridgeDenyFlashPayload, BridgeSessionPayload };

export interface BridgeLiveEvents {
  onSessionState: (handler: (p: BridgeSessionPayload) => void) => () => void;
  onDenyFlash: (handler: (p: BridgeDenyFlashPayload) => void) => () => void;
}

export function useBridgeLiveEvents(): BridgeLiveEvents {
  const subscribe = useLiveEventSubscription();

  const onSessionState = useCallback<BridgeLiveEvents["onSessionState"]>(
    (handler) =>
      subscribe((event) => {
        if (event.type !== "bridge.session_state") return;
        const parsed = bridgeSessionPayloadSchema.safeParse(event.payload ?? null);
        if (!parsed.success) return;
        handler(parsed.data);
      }),
    [subscribe],
  );

  const onDenyFlash = useCallback<BridgeLiveEvents["onDenyFlash"]>(
    (handler) =>
      subscribe((event) => {
        if (event.type !== "bridge.deny_flash") return;
        const parsed = bridgeDenyFlashPayloadSchema.safeParse(event.payload ?? null);
        if (!parsed.success) return;
        handler(parsed.data);
      }),
    [subscribe],
  );

  return useMemo(
    () => ({
      onSessionState,
      onDenyFlash,
    }),
    [onDenyFlash, onSessionState],
  );
}
