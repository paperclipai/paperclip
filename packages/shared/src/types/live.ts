import type { LiveEventType } from "../constants.js";

export interface LiveEvent {
  id: number;
  companyId: string;
  type: LiveEventType;
  createdAt: string;
  /** Viewer-specific WebSocket projection; absent/false means no task toast. */
  toastEligible?: boolean;
  payload: Record<string, unknown>;
}

export type LiveDeliveryClientMessage = { type: "live.hello"; version: 1; capabilities: string[] } | {
  type: "live.interests"; version: 1; revision: number; runIds: string[];
};
export type LiveDeliveryServerMessage =
  | { type: "live.capabilities"; version: 1; capabilities: string[] }
  | { type: "live.subscribed"; version: 1; revision: number }
  | { type: "live.resync"; version: 1; revision: number; reason: "delivery_overflow" | "controller_change" };
