import { describe, expect, it, vi } from "vitest";
import type { NativeSession } from "../../vendor/paperclip-runner/index.js";
import { bindManagedNativeCredentialTurn, completeManagedNativeCredentialTurn } from "./managed-native-credentials.js";

function fixture() {
  const close = vi.fn(async () => {});
  const detach = vi.fn(async () => {});
  const session = { close, detachControllerForRestart: detach } as unknown as NativeSession;
  const first = { copyBack: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
  bindManagedNativeCredentialTurn(session, first);
  return { session, close, detach, first };
}

describe("managed native credential turns", () => {
  it("flushes each warm turn into its own home without stopping the provider", async () => {
    const { session, close, first } = fixture();
    await completeManagedNativeCredentialTurn(session);
    expect(first.copyBack).toHaveBeenCalledOnce();
    expect(first.remove).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    const next = { copyBack: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
    bindManagedNativeCredentialTurn(session, next);
    await completeManagedNativeCredentialTurn(session);
    await session.close({ reason: "idle timeout" });
    await session.close({ reason: "repeated cleanup" });
    expect(first.copyBack).toHaveBeenCalledOnce();
    expect(first.remove).not.toHaveBeenCalled();
    expect(next.copyBack).toHaveBeenCalledOnce();
    expect(next.remove).toHaveBeenCalledOnce();
  });

  it("flushes and removes credentials when a per-turn session closes", async () => {
    const { session, first } = fixture();
    await session.close({ reason: "turn complete" });
    await completeManagedNativeCredentialTurn(session);
    expect(first.copyBack).toHaveBeenCalledOnce();
    expect(first.remove).toHaveBeenCalledOnce();
  });

  it("keeps the current invocation exclusive until copy-back settles", async () => {
    const { session } = fixture();
    expect(() => bindManagedNativeCredentialTurn(session, { copyBack: vi.fn(), remove: vi.fn() }))
      .toThrow("managed_native_credential_turn_still_owned");
    await completeManagedNativeCredentialTurn(session);
    let finish!: () => void;
    const next = { copyBack: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })), remove: vi.fn(async () => {}) };
    bindManagedNativeCredentialTurn(session, next);
    const one = completeManagedNativeCredentialTurn(session);
    const two = completeManagedNativeCredentialTurn(session);
    expect(() => bindManagedNativeCredentialTurn(session, { copyBack: vi.fn(), remove: vi.fn() }))
      .toThrow("managed_native_credential_turn_still_owned");
    finish();
    await Promise.all([one, two]);
    expect(next.copyBack).toHaveBeenCalledOnce();
  });

  it("leaves retained credentials alone after controller detach", async () => {
    const { session, close, first } = fixture();
    await session.detachControllerForRestart!();
    await completeManagedNativeCredentialTurn(session);
    await session.close({ reason: "late old-owner cleanup" });
    expect(first.copyBack).not.toHaveBeenCalled();
    expect(first.remove).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(() => bindManagedNativeCredentialTurn(session, { copyBack: vi.fn(), remove: vi.fn() }))
      .toThrow("managed_native_credential_session_retired");
  });

  it("does not delete a successor's credentials when an old close finishes late", async () => {
    let finish!: () => void;
    const session = { close: () => new Promise<void>(resolve => { finish = resolve; }), detachControllerForRestart: async () => {} } as unknown as NativeSession;
    const first = { copyBack: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
    bindManagedNativeCredentialTurn(session, first);
    const closing = session.close({ reason: "old owner" });
    await session.detachControllerForRestart!();
    const next = { copyBack: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
    expect(() => bindManagedNativeCredentialTurn(session, next))
      .toThrow("managed_native_credential_session_retired");
    const successorClose = vi.fn(async () => {});
    const successor = { close: successorClose } as unknown as NativeSession;
    bindManagedNativeCredentialTurn(successor, next);
    finish();
    await closing;
    await session.close({ reason: "old reference after successor attached" });
    expect(first.remove).not.toHaveBeenCalled();
    expect(next.remove).not.toHaveBeenCalled();
    expect(next.copyBack).not.toHaveBeenCalled();
    expect(successorClose).not.toHaveBeenCalled();
  });

  it("never rebinds a handle whose close is in progress", async () => {
    let finish!: () => void;
    const session = { close: () => new Promise<void>(resolve => { finish = resolve; }) } as unknown as NativeSession;
    bindManagedNativeCredentialTurn(session, { copyBack: vi.fn(async () => {}), remove: vi.fn(async () => {}) });
    await completeManagedNativeCredentialTurn(session);
    const closing = session.close({ reason: "idle timeout" });
    expect(() => bindManagedNativeCredentialTurn(session, { copyBack: vi.fn(), remove: vi.fn() }))
      .toThrow("managed_native_credential_session_retired");
    finish();
    await closing;
  });

  it("removes stopped-provider credentials even when refresh copy-back fails", async () => {
    const session = { close: async () => {} } as unknown as NativeSession;
    const remove = vi.fn(async () => {});
    bindManagedNativeCredentialTurn(session, { copyBack: async () => { throw new Error("copy-back failed"); }, remove });
    await expect(session.close({ reason: "completed" })).rejects.toThrow("copy-back failed");
    expect(remove).toHaveBeenCalledOnce();
  });
});
