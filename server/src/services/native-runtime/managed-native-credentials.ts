import type { NativeSession } from "../../vendor/paperclip-runner/index.js";

type CredentialTurn = {
  /** Copy refreshed credentials only into this invocation's private home. */
  copyBack: () => Promise<void>;
  /** Remove launch credentials after the provider owner has stopped. */
  remove: () => Promise<void>;
  detached: boolean;
  closing?: boolean;
  completed: boolean;
  completion?: Promise<void>;
  removed?: boolean;
};

const credentialTurns = new WeakMap<NativeSession, CredentialTurn>();

/** A warm session outlives an invocation's temporary credential destination. */
export function bindManagedNativeCredentialTurn(
  session: NativeSession,
  callbacks: Pick<CredentialTurn, "copyBack" | "remove">,
): NativeSession {
  const previous = credentialTurns.get(session);
  // A successor controller must attach a new handle. Reusing a detached or
  // closing handle would let old references close the successor's provider.
  if (previous?.detached || previous?.closing) {
    throw new Error("managed_native_credential_session_retired");
  }
  if (previous && !previous.completed) {
    throw new Error("managed_native_credential_turn_still_owned");
  }
  const turn: CredentialTurn = { ...callbacks, detached: false, completed: false };
  credentialTurns.set(session, turn);
  if (previous) return session;

  const close = session.close.bind(session);
  const detach = session.detachControllerForRestart?.bind(session);
  if (detach) {
    session.detachControllerForRestart = async () => {
      // Set before yielding: a late close from this controller cannot touch
      // credentials retained by the replacement controller.
      const owner = credentialTurns.get(session);
      if (owner) owner.detached = true;
      await detach();
    };
  }
  session.close = async (input) => {
    const owner = credentialTurns.get(session);
    if (owner?.detached) return;
    if (owner) owner.closing = true;
    await close(input);
    if (!owner || owner.detached || credentialTurns.get(session) !== owner) return;
    try {
      await completeCredentialTurn(owner);
    } finally {
      // Idle expiry removes the provider credential, but never writes back to
      // the already-deleted temporary home of a completed invocation.
      if (!owner.detached && !owner.removed && credentialTurns.get(session) === owner) {
        owner.removed = true;
        await owner.remove();
      }
    }
  };
  return session;
}

async function completeCredentialTurn(turn: CredentialTurn) {
  if (turn.detached || turn.completed) return;
  turn.completion ??= turn.copyBack().finally(() => { turn.completed = true; });
  await turn.completion;
}

/** Flush refreshes after each turn, without closing a healthy warm provider. */
export async function completeManagedNativeCredentialTurn(session: NativeSession | undefined) {
  if (!session) return;
  const turn = credentialTurns.get(session);
  if (turn) await completeCredentialTurn(turn);
}
