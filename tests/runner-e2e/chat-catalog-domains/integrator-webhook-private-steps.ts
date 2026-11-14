/** Closed failure steps the private webhook child may report. */
export const WEBHOOK_PRIVATE_STEPS = ["request", "launch", "open-triggers", "reveal-key", "finish-setup", "invalid-delivery", "valid-delivery"] as const;
export type WebhookPrivateStep = typeof WEBHOOK_PRIVATE_STEPS[number];
