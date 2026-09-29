// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AgentInstructions } from "./routineWebhookFields";
import { webhookAgentInstructions, demoWebhookUrl } from "./routineTriggerWizard";

const container = document.createElement("div");
document.body.append(container);
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it.each(["custom", "github"] as const)("copies complete %s instructions from the agent instructions card", async (sender) => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const value = webhookAgentInstructions(sender);
  root = createRoot(container);
  await act(async () => root.render(<AgentInstructions value={value} />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(writeText).toHaveBeenCalledExactlyOnceWith(value);
  expect(value).toContain(demoWebhookUrl);
  expect(value).toContain("HTTP POST");
  expect(value).toContain("JSON object");
  expect(value).toContain("Content-Type: application/json");
  expect(value).toContain("demo_webhook_key_for_storybook_only");
  expect(value).toContain("They do not start the routine or create a task.");
  expect(value).toContain("Test events are not replayed.");
  if (sender === "custom") expect(value).toContain("Authorization: Bearer demo_webhook_key_for_storybook_only");
  else {
    expect(value).toContain("X-Hub-Signature-256");
    expect(value).not.toContain("Authorization: Bearer");
  }
  expect(container.querySelector("button")!.textContent).toContain("Copied");
});
