import { expect, it } from "vitest";
import { providerSandboxIsOwned, validateDestroyedSandboxReceipt, type DestroySandboxBinding } from "./runtime-daytona-destroy.js";
const binding: DestroySandboxBinding = { companyId: "company", environmentId: "environment", taskId: "website", runId: "run", leaseId: "lease", sandboxId: "sandbox", actionId: "action", attempt: "attempt" };
const attempt = "12345678-1234-1234-1234-123456789012";
const sandbox = { id: "sandbox", name: `paperclip-create-${attempt}`, labels: { "paperclip-provider": "daytona", "paperclip-company-id": "company", "paperclip-environment-id": "environment", "paperclip-run-id": "run", "paperclip-create-attempt": attempt, "paperclip-reuse-lease": "false" } };
it("binds only the actual newly created failed-run provider allocation", () => expect(providerSandboxIsOwned(sandbox, binding)).toBe(true));
it("never adopts an unowned, reused or renamed sandbox", () => { for (const key of Object.keys(sandbox.labels)) expect(providerSandboxIsOwned({ ...sandbox, labels: { ...sandbox.labels, [key]: "foreign" } }, binding)).toBe(false); expect(providerSandboxIsOwned({ ...sandbox, id: "another" }, binding)).toBe(false); expect(providerSandboxIsOwned({ ...sandbox, name: "preexisting-resource" }, binding)).toBe(false); });
it("requires exact destruction and independent actual absence receipts without secret fields", () => {
  const receipt = { ...binding, processIsolation: true, testRunnerAttached: false, apiStepRecorder: false, actualOwnedProviderLabels: true, actualDeleteAccepted: true, independentlyAbsent: true };
  expect(validateDestroyedSandboxReceipt(receipt, binding)).toEqual(receipt);
  for (const mutation of [{ independentlyAbsent: false }, { actualDeleteAccepted: false }, { runId: "other" }, { testRunnerAttached: true }, { token: "synthetic-private-token" }]) expect(() => validateDestroyedSandboxReceipt({ ...receipt, ...mutation }, binding)).toThrow("closed independent receipt");
});
