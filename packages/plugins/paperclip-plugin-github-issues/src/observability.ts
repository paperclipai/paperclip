export type Outcome = "created" | "updated" | "closed" | "duplicate" | "filtered" | "error";

export interface DeliveryLog {
  deliveryId: string;
  event: string;
  action?: string;
  repo?: string;
  outcome: Outcome;
  durationMs: number;
  error?: string;
}

export function logDelivery(entry: DeliveryLog): void {
  // Write to stderr — stdout is reserved for the plugin IPC channel.
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ...entry, ts: new Date().toISOString(), plugin: "paperclip-plugin-github-issues" }));
}
