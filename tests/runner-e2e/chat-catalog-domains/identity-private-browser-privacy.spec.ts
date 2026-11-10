import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { installIdentitySession } from "./identity-auth.js";
import { privateIdentityBrowser } from "./identity-private-browser.js";
// Offline opt-in calibration only: actual human-session recording policy,
// actual failed fill in standalone child, no product/provider/auth server.
test("private identity failed input is absent from human-session reports", async () => {
  test.skip(!process.env.PAPERCLIP_IDENTITY_CANARY_PRIVATE_FILE, "Explicit offline privacy calibration only");
  const credential = `identity-private-${randomUUID()}`;
  await appendFile(process.env.PAPERCLIP_IDENTITY_CANARY_PRIVATE_FILE!, credential + "\n", { mode: 0o600 });
  const receipt = await privateIdentityBrowser({ kind: "canary-failure", origin: "http://127.0.0.1:1", startPath: "/", cookies: [], credential });
  expect(receipt.failedApiCallObserved).toBe(true);
  // A deliberate parent failure makes JUnit/blob/HTML/error-context observable.
  // Its message and recorded call arguments have never received the canary.
  test.fail(); throw new Error("Deliberate safe parent failure after private failed-input canary");
});

for (const failure of [false, true]) test(`private session file transfer ${failure ? "controlled failure" : "success"} retains no cookie`, async ({ browser }) => {
  test.skip(!process.env.PAPERCLIP_IDENTITY_CANARY_PRIVATE_FILE, "Explicit offline privacy calibration only");
  const credential = `identity-cookie-${randomUUID()}`;
  await appendFile(process.env.PAPERCLIP_IDENTITY_CANARY_PRIVATE_FILE!, credential + "\n", { mode: 0o600 });
  const context = await browser.newContext();
  try {
    await installIdentitySession(context, "http://127.0.0.1:1", `identity.synthetic=${credential}`);
    expect((await context.cookies()).some(cookie => cookie.name === "identity.synthetic" && cookie.value === credential)).toBe(true);
    if (failure) { test.fail(); throw new Error("Deliberate safe failure after private session transfer"); }
  } finally { await context.close(); }
});
