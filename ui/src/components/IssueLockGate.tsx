import { useCallback, useEffect, useState } from "react";
import { Lock, LockOpen, Fingerprint, ShieldAlert, Info } from "lucide-react";
import {
  issueLockWebauthnApi,
  type IssueLockStatus,
} from "@/api/issue-lock-webauthn";

/**
 * MAT-112 — issue-lock WebAuthn / Touch ID gate (variant A, UI-level).
 *
 * Renders the lock controls + unlock flow for a single issue:
 *  - unlocked issue: a small "Zakleni" toggle.
 *  - locked + content redacted (gated): the Touch ID unlock panel, a clear
 *    fallback when the device has no platform authenticator, and an honest note
 *    that this only hides content in the UI (agents still read via the API).
 *  - locked + already unlocked this session: a slim status bar + re-lock.
 */
export interface IssueLockGateProps {
  locked: boolean;
  /** Server marked description/comments as withheld on this browser read. */
  contentRedacted?: boolean;
  /** Toggle the persistent `locked` flag on the issue (PATCH). */
  onToggleLock: (next: boolean) => void;
  lockToggleBusy?: boolean;
  /** Called after a successful unlock so the parent can refetch content. */
  onUnlocked: () => void;
}

const HONESTY_NOTE =
  "Opomba: to je zaklep na ravni vmesnika. Vsebina je skrita samo v brskalniku — " +
  "podatki v bazi ostanejo nešifrirani in agenti issue še vedno berejo prek API-ja. " +
  "To ni polno šifriranje.";

export function IssueLockGate({
  locked,
  contentRedacted,
  onToggleLock,
  lockToggleBusy,
  onUnlocked,
}: IssueLockGateProps) {
  const [status, setStatus] = useState<IssueLockStatus | null>(null);
  const [caps, setCaps] = useState<{ supported: boolean; platformAvailable: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        issueLockWebauthnApi.getStatus(),
        issueLockWebauthnApi.capabilities(),
      ]);
      setStatus(s);
      setCaps(c);
    } catch {
      // Non-fatal: leave status null; the panel still shows the fallback path.
    }
  }, []);

  useEffect(() => {
    if (locked) void refreshStatus();
  }, [locked, contentRedacted, refreshStatus]);

  const runUnlock = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (status && !status.registered) {
        await issueLockWebauthnApi.register();
      } else {
        await issueLockWebauthnApi.unlock();
      }
      await refreshStatus();
      onUnlocked();
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "NotAllowedError") {
        setError("Preverjanje je bilo preklicano ali je poteklo. Poskusi znova.");
      } else {
        setError(err instanceof Error ? err.message : "Odklep ni uspel.");
      }
    } finally {
      setBusy(false);
    }
  }, [status, refreshStatus, onUnlocked]);

  const relock = useCallback(async () => {
    setBusy(true);
    try {
      await issueLockWebauthnApi.relock();
      await refreshStatus();
      onUnlocked();
    } finally {
      setBusy(false);
    }
  }, [refreshStatus, onUnlocked]);

  // --- Unlocked issue: offer a compact "lock it" toggle. --------------------
  if (!locked) {
    return (
      <div className="flex justify-end">
        <button
          type="button"
          disabled={lockToggleBusy}
          onClick={() => onToggleLock(true)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 disabled:opacity-50"
          title="Zakleni ta issue s Touch ID (zaklep na ravni vmesnika)"
        >
          <Lock className="h-3.5 w-3.5" />
          Zakleni
        </button>
      </div>
    );
  }

  // --- Locked + already unlocked this session: slim status bar. -------------
  if (!contentRedacted) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200">
        <span className="inline-flex items-center gap-2">
          <LockOpen className="h-4 w-4 shrink-0" />
          Odklenjeno za to sejo (do {status ? `${Math.round(status.unlockTtlSeconds / 60)} min` : "kratkega časa"} nedejavnosti).
        </span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void relock()}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-600/40 px-2.5 py-1 text-xs hover:bg-emerald-500/15 disabled:opacity-50"
          >
            <Lock className="h-3.5 w-3.5" />
            Zakleni takoj
          </button>
          <button
            type="button"
            disabled={lockToggleBusy}
            onClick={() => onToggleLock(false)}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-600/40 px-2.5 py-1 text-xs hover:bg-emerald-500/15 disabled:opacity-50"
            title="Odstrani zaklep s tega issue-ja"
          >
            <LockOpen className="h-3.5 w-3.5" />
            Odstrani zaklep
          </button>
        </span>
      </div>
    );
  }

  // --- Locked + gated: the Touch ID unlock panel. ---------------------------
  const noPlatform = caps !== null && (!caps.supported || !caps.platformAvailable);

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/40 px-4 py-4">
      <div className="flex items-center gap-2 text-base font-medium">
        <Lock className="h-5 w-5 shrink-0" />
        🔒 Zaklenjeno
      </div>
      <p className="text-sm text-muted-foreground">
        Vsebina tega issue-ja (opis in komentarji) je skrita. Odkleni s Touch ID, da si jo ogledaš.
      </p>

      {noPlatform ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Ta naprava/brskalnik nima platform authenticatorja (npr. Touch ID), zato odklep tukaj ni mogoč.
            Odpri issue v brskalniku na Matejevi napravi s Touch ID (npr. Safari/Chrome na Macu prek <code>http://localhost:3100</code>).
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void runUnlock()}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Fingerprint className="h-4 w-4" />
            {busy
              ? "Čakam na Touch ID…"
              : status && !status.registered
                ? "Registriraj Touch ID in odkleni"
                : "Odkleni s Touch ID"}
          </button>
          <button
            type="button"
            disabled={lockToggleBusy}
            onClick={() => onToggleLock(false)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            title="Odstrani zaklep s tega issue-ja"
          >
            <LockOpen className="h-3.5 w-3.5" />
            Odstrani zaklep
          </button>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-start gap-2 border-t border-border/60 pt-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{HONESTY_NOTE}</span>
      </div>
    </div>
  );
}
