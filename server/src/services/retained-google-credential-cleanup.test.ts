import { expect, it, vi } from "vitest";
import {
  assertGoogleCredentialCleanupSettled, bindRetainedGoogleCredentialHome, reconcileRetainedGoogleCleanup,
  reconcileRetainedGoogleCleanupForHome, retainGoogleCredentialCleanup,
  retainGoogleCredentialCleanupForHome,
} from "./retained-google-credential-cleanup.js";
import { RetiredCredentialRecoveryError } from "./quota-credential-recovery.js";

let sequence = 0;
const scope = () => ({ companyId: "company", accountKey: `retained-${++sequence}` });

it("retries only on the next same-company account action and coalesces concurrent cleanup", async () => {
  const owner = scope();
  let finish!: () => void;
  const cleanup = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  retainGoogleCredentialCleanup({ scope: owner, cleanup });
  await reconcileRetainedGoogleCleanup({ ...owner, companyId: "other-company" });
  await reconcileRetainedGoogleCleanup({ ...owner, accountKey: "another-account" });
  expect(cleanup).not.toHaveBeenCalled();
  const first = reconcileRetainedGoogleCleanup(owner);
  const second = reconcileRetainedGoogleCleanup(owner);
  await Promise.resolve();
  expect(cleanup).toHaveBeenCalledOnce();
  finish();
  await Promise.all([first, second]);
  await reconcileRetainedGoogleCleanup(owner);
  expect(cleanup).toHaveBeenCalledOnce();
});

it("preserves failed cleanup for an event-driven retry without launching a provider", async () => {
  const owner = scope();
  const cleanup = vi.fn().mockRejectedValueOnce(new Error("private-token journal unavailable")).mockResolvedValue(undefined);
  const provider = vi.fn();
  retainGoogleCredentialCleanup({ scope: owner, cleanup });
  const useAccount = async () => { await reconcileRetainedGoogleCleanup(owner); provider(); };
  await expect(useAccount()).rejects.toMatchObject({ details: { code: "ai_connection_busy" } });
  expect(provider).not.toHaveBeenCalled();
  await useAccount();
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(provider).toHaveBeenCalledOnce();
});

it("requires confirmed physical retirement before retrying the retained callback", async () => {
  const owner = scope();
  let finish!: () => void;
  const retired = new Promise<void>(resolve => { finish = resolve; });
  const cleanup = vi.fn(async () => {});
  retainGoogleCredentialCleanup({ scope: owner, cleanup, retired });
  await expect(reconcileRetainedGoogleCleanup(owner)).rejects.toMatchObject({ details: { code: "ai_connection_busy" } });
  expect(cleanup).not.toHaveBeenCalled();
  finish();
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  await reconcileRetainedGoogleCleanup(owner);
  expect(cleanup).toHaveBeenCalledOnce();
});

it("lets a durable encrypted journal take over without replaying the retired callback", async () => {
  const owner = scope();
  const cleanup = vi.fn(async () => { throw new RetiredCredentialRecoveryError(new Error("private token")); });
  retainGoogleCredentialCleanup({ scope: owner, cleanup });
  await reconcileRetainedGoogleCleanup(owner);
  await reconcileRetainedGoogleCleanup(owner);
  expect(cleanup).toHaveBeenCalledOnce();
});

it("retries a rejected physical proof only on the next account action and coalesces proof ownership", async () => {
  const owner = scope();
  const retired = Promise.reject(new Error("fixture initial retirement proof unavailable"));
  let confirm!: () => void;
  const retryRetirement = vi.fn().mockRejectedValueOnce(new RetiredCredentialRecoveryError(new Error("fixture owner still present")))
    .mockImplementationOnce(() => new Promise<void>(resolve => { confirm = resolve; }));
  const cleanup = vi.fn(async () => {});
  retainGoogleCredentialCleanup({ scope: owner, cleanup, retired, retryRetirement });
  await retired.catch(() => {});
  await expect(reconcileRetainedGoogleCleanup(owner)).rejects.toMatchObject({ details: { code: "ai_connection_busy" } });
  expect(retryRetirement).toHaveBeenCalledOnce(); expect(cleanup).not.toHaveBeenCalled();
  const first = reconcileRetainedGoogleCleanup(owner), second = reconcileRetainedGoogleCleanup(owner);
  await vi.waitFor(() => expect(retryRetirement).toHaveBeenCalledTimes(2));
  expect(cleanup).not.toHaveBeenCalled();
  confirm(); await Promise.all([first, second]);
  expect(cleanup).toHaveBeenCalledOnce();
  await reconcileRetainedGoogleCleanup(owner);
  expect(retryRetirement).toHaveBeenCalledTimes(2);
});

it("does not recurse through cleanup wrappers and settles peers once", async () => {
  const owner = scope();
  const first = vi.fn(async () => { assertGoogleCredentialCleanupSettled(owner); await reconcileRetainedGoogleCleanup(owner); });
  const second = vi.fn(async () => { await reconcileRetainedGoogleCleanup(owner); });
  retainGoogleCredentialCleanup({ scope: owner, cleanup: first });
  retainGoogleCredentialCleanup({ scope: owner, cleanup: second });
  expect(() => assertGoogleCredentialCleanupSettled(owner)).toThrow("still completing credential cleanup");
  await reconcileRetainedGoogleCleanup(owner);
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
});

it("keeps admission closed when a new obligation arrives during bounded cleanup", async () => {
  const owner = scope();
  const second = vi.fn(async () => {});
  retainGoogleCredentialCleanup({ scope: owner, cleanup: async () => {
    retainGoogleCredentialCleanup({ scope: owner, cleanup: second });
  } });
  await expect(reconcileRetainedGoogleCleanup(owner)).rejects.toMatchObject({ details: { code: "ai_connection_busy" } });
  expect(second).not.toHaveBeenCalled();
  await reconcileRetainedGoogleCleanup(owner);
  expect(second).toHaveBeenCalledOnce();
});

it("retains the original home's cleanup scope until its owner releases it", async () => {
  const owner = scope(), home = `/fixture/private-${owner.accountKey}`;
  const release = bindRetainedGoogleCredentialHome(home, owner);
  const cleanup = vi.fn(async () => {});
  retainGoogleCredentialCleanupForHome(home, { cleanup });
  await reconcileRetainedGoogleCleanupForHome(home);
  expect(cleanup).toHaveBeenCalledOnce();
  release();
  retainGoogleCredentialCleanupForHome(home, { cleanup });
  await reconcileRetainedGoogleCleanup(owner);
  expect(cleanup).toHaveBeenCalledOnce();
});
