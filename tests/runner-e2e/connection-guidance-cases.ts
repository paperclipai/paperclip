import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { everydayTasks } from "./everyday-cases.js";

export const CONNECTION_GUIDANCE_SUITE = "native-connection-guidance";
export const CONNECTION_GUIDANCE_BUDGET_CENTS = 1_000;

// The fallback defines the user's deliverable, not the connection procedure.
// No tool names, no-retry rule, provider preference, or completion API hints.
export const connectionGuidanceDeclinePrompts: Readonly<Record<string, string>> = {
  "service-decline": "Use the connected page service to find recent pages and create a short Markdown briefing on this task. Include the titles and verification code returned by the service. If the data is unavailable, a brief explanation is enough instead of the briefing.",
  "connection-decline": "Connect Notion so you can read my recent pages and write a short briefing. If the pages are unavailable, a brief explanation is enough instead of the briefing.",
  "provider-decline": "Connect HubSpot so you can read my recent contacts. If the contacts are unavailable, a brief explanation is enough instead of the contact list.",
};
const cases = ["service-approve", "service-decline", "connection-decline", "provider-decline", "provider-second"];

export const connectionGuidanceTasks = cases.map(id => {
  const original = everydayTasks.find(task => task.id === id);
  if (!original) throw new Error("Missing original connection story: " + id);
  return {
    ...original,
    expectedRunCount: id === "provider-second" ? 3 : original.expectedRunCount,
    automaticRetryPolicy: "single_attempt" as const,
    buildPrompt: (nonce: string) => connectionGuidanceDeclinePrompts[id] ?? original.buildPrompt(nonce),
  };
});

export function connectionGuidanceDefinitionDigest() {
  const files = [
    "connection-guidance-cases.ts", "connection-guidance-evidence.ts", "continuation-screenshot.ts",
    "everyday-cases.ts", "everyday-flow.ts", "everyday-decisions.ts",
    "everyday-observations.ts", "everyday-delivery.ts",
    "connection-routing-evidence.ts", "connection-reviews.ts", "aggregator-fixture.ts",
    "live-fixtures.ts", "runner.spec.ts", "user-actions.ts", "catalog.ts",
  ];
  return createHash("sha256").update(files.map(file =>
    file + "\0" + readFileSync(new URL(file, import.meta.url), "utf8"),
  ).join("\0")).digest("hex");
}
