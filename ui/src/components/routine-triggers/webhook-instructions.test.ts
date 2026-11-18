import { expect, it } from "vitest";
import { webhookAgentInstructions, webhookInstructionSigningMode } from "./webhook-instructions";

it("explains both supported app authentication methods", () => {
  const instructions = webhookAgentInstructions("custom", "Meetings", "https://paperclip.example/webhook", "signing-secret");
  expect(instructions).toContain("Secret key: signing-secret");
  expect(instructions).toContain("X-Hub-Signature");
  expect(instructions).toContain("Authorization: Bearer signing-secret");
  expect(instructions).toContain("They do not start the routine");
  expect(instructions).not.toContain("Fireflies");
});

it("keeps legacy bearer setup instructions accurate", () => {
  const instructions = webhookAgentInstructions("custom", "Meetings", "https://paperclip.example/webhook", "secret", true, "bearer");
  expect(instructions).toContain("Authorization: Bearer secret");
  expect(instructions).not.toContain("HMAC-SHA256");
});

it("tells GitHub users to paste the secret instead of using a bearer header", () => {
  const instructions = webhookAgentInstructions("github", "Deploys", "https://paperclip.example/webhook", "gh-secret", false);
  expect(instructions).toContain("Secret: gh-secret");
  expect(instructions).toContain("X-Hub-Signature-256");
  expect(instructions).toContain("Deliveries can start the routine");
});

it("explains timestamp signing for hmac_sha256 webhooks instead of bearer or X-Hub-Signature", () => {
  const instructions = webhookAgentInstructions("custom", "Deploys", "https://paperclip.example/webhook", "hmac-secret", false, webhookInstructionSigningMode("hmac_sha256"));
  expect(instructions).toContain("X-Paperclip-Timestamp");
  expect(instructions).toContain("X-Paperclip-Signature");
  expect(instructions).not.toContain("Authorization: Bearer");
  expect(instructions).not.toContain("X-Hub-Signature");
});

it("gives no key instructions for a webhook without a key", () => {
  const instructions = webhookAgentInstructions("custom", "Deploys", "https://paperclip.example/webhook", "", false, webhookInstructionSigningMode("none"));
  expect(instructions).toContain("Its URL is the shared secret");
  expect(instructions).not.toContain("Secret key:");
  expect(instructions).toContain("Store the URL securely");
  expect(instructions).not.toContain("Store the key securely");
  expect(webhookInstructionSigningMode("something-new")).toBe("app_webhook");
});
