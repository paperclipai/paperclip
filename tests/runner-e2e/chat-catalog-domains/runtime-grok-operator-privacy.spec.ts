/** Opt-in synthetic failure-only reporter boundary, no browser/provider launch. */
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { runPrivateGrokOperator } from "./runtime-grok-operator.js";
import type { GrokOperatorInput } from "./runtime-grok-operator-contract.js";
for (const branch of ["child-rejection", "parent-failure"] as const) test(`private Grok operator reporting ${branch}`, async () => {
 test.skip(!process.env.PAPERCLIP_GROK_OPERATOR_CANARY_FILE, "Explicit synthetic-only private Grok operator calibration");
 const key = `synthetic-grok-key-${randomUUID()}`, cookie = `synthetic-public-cookie-${randomUUID()}`; await appendFile(process.env.PAPERCLIP_GROK_OPERATOR_CANARY_FILE!, `${key}\n${cookie}\n`, { mode: 0o600 }); const secrets: string[] = [];
 const i = { operation: "setup", executionId: "chat-features.runner-codex-subscription.local.agents.existing-grok-bot", attemptId: "a".repeat(32), receiptPath: "/never-read", backendOrigin: "http://127.0.0.1:1", publicOrigin: "https://owned.example.test", companyId: randomUUID(), companyName: "Synthetic", prefix: "ACORN", personId: "synthetic-person", personName: "Synthetic Person", leadId: randomUUID(), botName: "Synthetic Bot", operatorRef: "synthetic-operator", botAuthorizationRef: "synthetic-bot", operatorMode: "interactive-private-ui", publicSession: { cookies: [{ name: "session", value: cookie, domain: "owned.example.test", path: "/", secure: true, httpOnly: true, expires: -1, sameSite: "Lax" }], origins: [] }, webhookUrl: "https://routine.example.test", webhookKey: key } as GrokOperatorInput;
 await expect(runPrivateGrokOperator(i, secrets)).rejects.toThrow("Actual Grok human handoff failed"); expect(secrets).toHaveLength(3);
 if (branch === "parent-failure") { test.fail(); throw new Error("Deliberate safe parent failure after synthetic Grok private rejection"); }
});
