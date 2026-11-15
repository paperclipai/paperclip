/** Closed failure steps the private browser child may report: each operation
 * mode, plus finer steps for device approval and secure key entry. */
export const PRIVATE_BROWSER_STEPS = ["request", "launch",
  "secure-key", "canary", "gateway-token-rotation", "company-secret-create", "personal-secret-create", "grok-routine-configure", "slack-identity-confirm",
  "slack-endpoint-configure", "slack-wizard-confirm", "slack-wizard-resume", "slack-endpoint-reconnect", "device-approve", "device-expired",
  "device-session", "device-describe", "device-expired-page", "device-consent-page",
  "secure-key-address", "secure-key-field", "secure-key-connect", "secure-key-ready"] as const;
export type PrivateBrowserStep = typeof PRIVATE_BROWSER_STEPS[number];
