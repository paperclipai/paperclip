// In-process per-identity provisioning mutex. The nearby `withAgentStartLock`
// is agent-keyed and so does NOT serialize two DIFFERENT agents provisioning the
// same issue (the observed cross-agent-handoff dup source). This lock is keyed on
// the shared_workspace logical identity
// (`companyId:projectId:sourceIssueId:branchName`) and serializes the
// re-lookup -> reuse-or-create decision so two near-simultaneous wakes for the
// same identity cannot both insert a second active execution_workspace row.
//
// It is held only across the fast persist (the idempotent `realizeExecutionWorkspace`
// runs outside it) and released from a `finally`, so a throw can never leak it.
// There is deliberately NO stale/"proceed anyway" timeout: a waiter blocks until
// its predecessor's persist completes, which is what preserves the dup-prevention
// guarantee even when provisioning is slow. Single-process scope (matches this
// deployment); a multi-process server would additionally need a Postgres advisory
// lock keyed on the same identity hash.
const tailByIdentity = new Map<string, Promise<void>>();

// FIFO async mutex: each caller chains onto the synchronously-captured previous
// tail and awaits it before entering. Returns an idempotent release fn; the caller
// MUST invoke it (from a `finally`) once the critical section completes.
export async function acquireExecutionWorkspaceIdentityLock(
  identityKey: string,
): Promise<() => void> {
  const previous = tailByIdentity.get(identityKey) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Publish synchronously so the next caller chains onto THIS holder, not onto
  // our already-settling predecessor.
  const tail = previous.then(() => held);
  tailByIdentity.set(identityKey, tail);
  void tail.finally(() => {
    if (tailByIdentity.get(identityKey) === tail) {
      tailByIdentity.delete(identityKey);
    }
  });

  await previous;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}
