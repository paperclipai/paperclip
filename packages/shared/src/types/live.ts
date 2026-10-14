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
