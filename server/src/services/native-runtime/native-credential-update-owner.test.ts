import { expect, it, vi } from "vitest";
import type { NativeSession, PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { createNativeCredentialUpdateOwner } from "./native-credential-updates.js";

const event = { eventType: "auth.credentials.updated" } as PrpEvent;
it("handles bootstrap, idle refreshes, and successive warm invocation exporters", async () => {
  const first = vi.fn(async () => {}), next = vi.fn(async () => {});
  const owner = createNativeCredentialUpdateOwner(first);
  await owner.onCredentialsUpdated(event);
  const session = { close: vi.fn(async () => {}) } as unknown as NativeSession;
  owner.bindSession(session);
  // Completing a turn and deleting its invocation home does not retire this owner.
  await owner.onCredentialsUpdated(event);
  createNativeCredentialUpdateOwner(next).bindSession(session);
  await owner.onCredentialsUpdated(event);
  expect(first).toHaveBeenCalledTimes(2);
  expect(next).toHaveBeenCalledExactlyOnceWith(event);
});

it("keeps the handler available for trailing close events and rejects closing-handle rebind", async () => {
  const handle = vi.fn(async () => {}), owner = createNativeCredentialUpdateOwner(handle);
  const session = { close: async () => { await owner.onCredentialsUpdated(event); } } as unknown as NativeSession;
  owner.bindSession(session);
  await session.close({ reason: "retirement" });
  expect(handle).toHaveBeenCalledExactlyOnceWith(event);
  expect(() => createNativeCredentialUpdateOwner(handle).bindSession(session)).toThrow("owner_retired");
});

it("fences detached controllers and gives recovered handles independent ownership", async () => {
  const handle = vi.fn(async () => {}), owner = createNativeCredentialUpdateOwner(handle);
  const session = { close: async () => {}, detachControllerForRestart: async () => {} } as unknown as NativeSession;
  owner.bindSession(session);
  await session.detachControllerForRestart!();
  await expect(owner.onCredentialsUpdated(event)).rejects.toThrow("owner_detached");
  expect(() => createNativeCredentialUpdateOwner(handle).bindSession(session)).toThrow("owner_retired");
  expect(handle).not.toHaveBeenCalled();
  const recovered = createNativeCredentialUpdateOwner(handle);
  recovered.bindSession({ close: async () => {} } as unknown as NativeSession);
  await recovered.onCredentialsUpdated(event);
  expect(handle).toHaveBeenCalledOnce();
});
