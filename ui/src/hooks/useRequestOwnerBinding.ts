import { useCallback, useEffect, useRef, type RefObject } from "react";
import { loadDraftSubmission, saveDraftSubmission, type ComposerDraftSubmission } from "@/lib/composer-draft";

interface InFlightSend {
  draftKey: string;
  attemptId: string;
  requestOwner?: string;
}

/**
 * A comment sent before the session is known records no owner, so
 * `replayableRequest` would never resend it. Once the account is known, bind
 * it to the sends this composer made in the meantime: they went out with this
 * session. A stored record without an owner may belong to another account in
 * this browser and stays unreplayable.
 *
 * Returns `markUnbound`, to call with each attempt sent while the owner is unknown.
 */
export function useRequestOwnerBinding({
  draftKey,
  owner,
  uncertainSubmission,
  setUncertainSubmission,
  pendingDraftRef,
}: {
  draftKey: string | undefined;
  owner: string | undefined;
  uncertainSubmission: ComposerDraftSubmission | null;
  setUncertainSubmission: (next: ComposerDraftSubmission) => void;
  pendingDraftRef: RefObject<InFlightSend | null>;
}): (attemptId: string) => void {
  const unbound = useRef(new Set<string>());
  const markUnbound = useCallback((attemptId: string) => {
    unbound.current.add(attemptId);
  }, []);

  useEffect(() => {
    if (owner === undefined || unbound.current.size === 0) return;
    const bindStored = (key: string, attemptId: string) => {
      const stored = loadDraftSubmission(key);
      if (stored?.attemptId === attemptId && stored.requestOwner === undefined) {
        saveDraftSubmission(key, { ...stored, requestOwner: owner });
      }
    };
    // Still in flight: later draft backups and a failure keep the owner.
    const inFlight = pendingDraftRef.current;
    if (inFlight && inFlight.requestOwner === undefined && unbound.current.has(inFlight.attemptId)) {
      inFlight.requestOwner = owner;
      bindStored(inFlight.draftKey, inFlight.attemptId);
    }
    const waiting = uncertainSubmission;
    if (waiting?.request && waiting.requestOwner === undefined && unbound.current.has(waiting.attemptId)) {
      unbound.current.delete(waiting.attemptId);
      if (draftKey) bindStored(draftKey, waiting.attemptId);
      setUncertainSubmission({ ...waiting, requestOwner: owner });
    }
  }, [draftKey, owner, pendingDraftRef, setUncertainSubmission, uncertainSubmission]);

  return markUnbound;
}
