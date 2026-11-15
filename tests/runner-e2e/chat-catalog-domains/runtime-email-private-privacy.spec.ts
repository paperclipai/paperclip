/** Explicit opt-in synthetic child/reporting calibration. Invalid owned scope
 * rejects before HTTP/provider access; no real credential, inbox or DB. */
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { privateEmailOperation } from "./runtime-email-private.js";
for (const branch of ["child-failure", "parent-failure"] as const) test(`private email operation reporting ${branch}`, async () => {
 test.skip(!process.env.PAPERCLIP_EMAIL_PRIVATE_CANARY_FILE, "Explicit synthetic-only private email reporting canary");
 const credential = `synthetic-email-key-${randomUUID()}`, senderCredential = `synthetic-reviewer-key-${randomUUID()}`, cookie = `synthetic-email-session-${randomUUID()}`;
 await appendFile(process.env.PAPERCLIP_EMAIL_PRIVATE_CANARY_FILE!, `${credential}\n${senderCredential}\n${cookie}\n`, { mode: 0o600 });
 const secrets: string[] = [];
 await expect(privateEmailOperation({ operation: "seed-review", scenarioId: "chat-channels.reply-to-email", companyId: "intentionally-invalid-owned-scope", agentId: "invalid", baseURL: "http://127.0.0.1:1", inboxId: "synthetic@example.test", recipient: "synthetic@example.test", dedicatedDisposableInbox: true, credential, reviewer: { address: "reviewer@example.test", credential: senderCredential, authorization: "reply-to-selected-synthetic-only", nonce: randomUUID() }, cookies: [{ name: "session", value: cookie, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }] }, secrets)).rejects.toThrow("credential-bearing request and provider diagnostics withheld");
 expect(secrets.length).toBe(3);
 if (branch === "parent-failure") { test.fail(); throw new Error("Deliberate safe parent failure after private synthetic email child rejection"); }
});
