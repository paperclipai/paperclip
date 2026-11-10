/** Opt-in synthetic retention calibration only. Invalid ownership stops before
 * HTTP/provider access; no real key, resource, DB or canonical admission. */
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { destroyOwnedFailedSandbox } from "./runtime-daytona-destroy.js";
for (const branch of ["child-failure", "parent-failure"] as const) test(`private owned sandbox fault reporting ${branch}`, async () => {
  test.skip(!process.env.PAPERCLIP_DAYTONA_FAULT_CANARY_PRIVATE_FILE, "Explicit synthetic-only private provider child calibration");
  const credential = `synthetic-provider-key-${randomUUID()}`, cookie = `synthetic-session-${randomUUID()}`;
  await appendFile(process.env.PAPERCLIP_DAYTONA_FAULT_CANARY_PRIVATE_FILE!, `${credential}\n${cookie}\n`, { mode: 0o600 });
  const secrets: string[] = [];
  const result = destroyOwnedFailedSandbox({ scenarioId: "workspaces.recover-lost-sandbox", executionId: "chat-features.runner-codex-subscription.local.workspaces.recover-lost-sandbox", binding: { companyId: "intentionally-invalid-owned-context", environmentId: "invalid", taskId: "invalid", runId: "invalid", leaseId: "invalid", sandboxId: "invalid", actionId: "invalid", attempt: "synthetic" }, baseURL: "http://127.0.0.1:1", credential, cookies: [{ name: "session", value: cookie, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }] }, secrets);
  await expect(result).rejects.toThrow("private provider request/diagnostics withheld");
  expect(secrets.length).toBe(2);
  if (branch === "parent-failure") { test.fail(); throw new Error("Deliberate safe parent failure after isolated synthetic provider child rejection"); }
});
