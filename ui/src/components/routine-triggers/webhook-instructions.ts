export type WebhookInstructionSender = "custom" | "github";
export type WebhookInstructionSigningMode = "app_webhook" | "bearer" | "fireflies_hmac" | "hmac_sha256" | "none";

const SIGNING_MODES: readonly WebhookInstructionSigningMode[] = ["app_webhook", "bearer", "fireflies_hmac", "hmac_sha256", "none"];

/** The instruction set for a saved webhook's signing mode; unknown modes read as the shared app flow. */
export function webhookInstructionSigningMode(mode: string | null | undefined): WebhookInstructionSigningMode {
  return SIGNING_MODES.includes(mode as WebhookInstructionSigningMode) ? mode as WebhookInstructionSigningMode : "app_webhook";
}

/** Copyable setup instructions for whoever (or whichever agent) connects the sending app. */
export function webhookAgentInstructions(
  sender: WebhookInstructionSender,
  routineTitle: string,
  webhookUrl: string,
  webhookSecret: string,
  setupPending = true,
  signingMode: WebhookInstructionSigningMode = "app_webhook",
) {
  const common = [
    `Connect the sending app to the Paperclip routine ${JSON.stringify(routineTitle)}.`,
    `Webhook URL: ${webhookUrl}`,
    "Send an HTTP POST request with a JSON object as the body (not an array or string).",
    "Content-Type: application/json",
  ];
  const auth =
    sender === "github"
      ? [
          "In GitHub, open your repository → Settings → Webhooks → Add webhook.",
          "Use the webhook URL above as Payload URL and select application/json as Content type.",
          `Secret: ${webhookSecret}`,
          "Paste this value into GitHub’s Secret field. GitHub signs requests with X-Hub-Signature-256; do not use Bearer authentication.",
          "Select the events that should start this routine, enable the webhook, and save.",
          "To check the connection, open Recent Deliveries and redeliver an event.",
        ]
      : signingMode === "none"
        ? [
            "This webhook has no key. Its URL is the shared secret, so keep it private.",
            "In the sending app, add a webhook using this URL, POST method and JSON body, then save it.",
            "Send a unique Idempotency-Key header for each event and reuse it on retries.",
          ]
      : signingMode === "hmac_sha256"
        ? [
            `Secret key: ${webhookSecret}`,
            "Sign each request with HMAC-SHA256 using the secret key. The signed message is the Unix timestamp in seconds, a period, and the exact JSON body.",
            "Send the timestamp in X-Paperclip-Timestamp and the signature in X-Paperclip-Signature, formatted sha256=<hex digest>.",
            "Requests with an old timestamp are rejected, so sign each request when you send it. Do not use Bearer authentication.",
            "Send a unique Idempotency-Key header for each event and reuse it on retries.",
          ]
      : [
          `Secret key: ${webhookSecret}`,
          ...(signingMode === "bearer" ? [] : [
            `If the app asks for a signing secret, paste the secret key above. Paperclip accepts HMAC-SHA256 over the exact request body in ${signingMode === "fireflies_hmac" ? "X-Hub-Signature" : "X-Hub-Signature or X-Hub-Signature-256"}, formatted sha256=<hex digest>.`,
          ]),
          ...(signingMode === "fireflies_hmac" ? [] : [
            `For apps with custom headers, use Authorization: Bearer ${webhookSecret}`,
          ]),
          "Subscribe only to the events that should start this routine. Public services need a publicly reachable HTTPS URL.",
          "In the sending app, add a webhook using this URL, POST method, JSON body, and headers, then save it.",
          "Send a unique Idempotency-Key header for each event and reuse it on retries, so retrying a setup test after activation cannot start the routine.",
          'Example JSON body: {"event":"deployment.completed","environment":"production"}',
          "To check the connection, send a test event from the app or perform the action that triggers a delivery.",
        ];
  return [
    ...common,
    ...auth,
    "The webhook in Paperclip shows whether the event arrived and authentication passed.",
    ...(setupPending
      ? [
          "During setup, deliveries only test the connection. They do not start the routine or create a task.",
          "Finish in Paperclip to enable this webhook for future events. Test events are not replayed.",
        ]
      : [
          "This webhook is enabled. Deliveries can start the routine and create tasks.",
        ]),
    signingMode === "none"
      ? "Store the URL securely; do not put it in source control or logs."
      : "Store the key securely; do not put it in source control or logs.",
  ].join("\n");
}
