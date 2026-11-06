import { expect, it } from "vitest";
import { privateKeyBrowser, validatePrivateKeyReceipt } from "./runtime-private-key.js";
const valid = () => ({ privateBrowserProcessIsolated: true, privateBrowserTestRunnerAttached: false, privateBrowserApiStepRecorder: false });
it("accepts the finite standalone-process receipt", () => expect(validatePrivateKeyReceipt(valid())).toEqual(valid()));
it("rejects attached Playwright Test despite disabled tracing", () => expect(() => validatePrivateKeyReceipt({ ...valid(), privateBrowserTestRunnerAttached: true })).toThrow());
it("rejects API-step recording despite a fresh context", () => expect(() => validatePrivateKeyReceipt({ ...valid(), privateBrowserApiStepRecorder: true })).toThrow());
it("rejects a credential field without reflecting its value", () => {
  const synthetic = "pcp_SYNTHETIC_PRIVATE_RECEIPT_CANARY";
  try { validatePrivateKeyReceipt({ ...valid(), token: synthetic }); throw new Error("Unexpected valid receipt"); }
  catch (error) { expect(String(error)).not.toContain(synthetic); expect(String(error)).toContain("closed boundary"); }
});
it("rejects credential text hidden inside safe-looking key metadata", () => expect(() => validatePrivateKeyReceipt({ ...valid(), createdKey: { id: "pcp_SYNTHETIC_PRIVATE_CANARY", name: "local integration", revokedAt: null } })).toThrow());
it.skipIf(process.env.PAPERCLIP_CHAT_EVAL_PRIVATE_BROWSER_CANARY !== "1")("contains a synthetic one-time UI token entirely inside the standalone browser child", async () => {
  const synthetic = "pcp_SYNTHETIC_PRIVATE_BROWSER_CANARY_a5bb4e";
  const receipt = await privateKeyBrowser({ mode: "canary", baseURL: "http://127.0.0.1:1", cookies: [], canary: synthetic });
  expect(receipt).toEqual({ ...valid(), canaryContained: true }); expect(JSON.stringify(receipt)).not.toContain(synthetic);
}, 30_000);
