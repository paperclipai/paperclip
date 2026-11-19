import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  acquireAiCredentialTeardownHold, completeRetainedAiCredentialCleanup,
  reconcileRetainedAiCleanup, retainedAiCredentialCleanupHomeInside, retainAiCredentialCleanup,
} from "./retained-ai-credential-cleanup.js";

it("completes only the exact confirmed owner, preserving peer obligations and holds", async () => {
  const scope = { companyId: "fixture", accountKey: randomUUID() };
  const other = { ...scope, companyId: "other-company" };
  const home = `/fixture/${scope.accountKey}`;
  const own = vi.fn(async () => {}), peer = vi.fn(async () => {});
  retainAiCredentialCleanup({ scope, home, cleanup: own });
  retainAiCredentialCleanup({ scope, home, cleanup: peer });
  retainAiCredentialCleanup({ scope: other, home, cleanup: own });
  const release = acquireAiCredentialTeardownHold(home);
  try {
    completeRetainedAiCredentialCleanup(scope, own);
    await reconcileRetainedAiCleanup(scope);
    expect(own).not.toHaveBeenCalled();
    expect(peer).toHaveBeenCalledOnce();
    expect(await retainedAiCredentialCleanupHomeInside(home)).toBe(true);
    await reconcileRetainedAiCleanup(other);
    expect(own).toHaveBeenCalledOnce();
    expect(await retainedAiCredentialCleanupHomeInside(home)).toBe(true);
  } finally { release(); }
  expect(await retainedAiCredentialCleanupHomeInside(home)).toBe(false);
});

it.each(["pending", "failed"])("keeps %s physical retirement fenced when the callback reports completion", async state => {
  const scope = { companyId: "fixture", accountKey: randomUUID() };
  const home = `/fixture/${scope.accountKey}`;
  let confirm!: () => void;
  const retired = state === "pending" ? new Promise<void>(resolve => { confirm = resolve; })
    : Promise.reject(new Error("retirement unconfirmed"));
  const cleanup = vi.fn(async () => {});
  retainAiCredentialCleanup({ scope, home, cleanup, retired, retryRetirement: async () => {} });
  await Promise.resolve();
  completeRetainedAiCredentialCleanup(scope, cleanup);
  expect(await retainedAiCredentialCleanupHomeInside(home)).toBe(true);
  if (state === "pending") {
    await expect(reconcileRetainedAiCleanup(scope)).rejects.toMatchObject({ details: { code: "ai_credential_cleanup_pending" } });
    expect(cleanup).not.toHaveBeenCalled();
    confirm(); await retired;
  }
  await reconcileRetainedAiCleanup(scope);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(await retainedAiCredentialCleanupHomeInside(home)).toBe(false);
});
