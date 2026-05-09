"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ApprovalGate } from "@/lib/asset-type";

const TONE_CLASS: Record<ApprovalGate["bannerTone"], string> = {
  ok: "border-emerald-700/60 bg-emerald-950/30 text-emerald-200",
  warn: "border-amber-700/60 bg-amber-950/30 text-amber-200",
  block: "border-rose-700/60 bg-rose-950/30 text-rose-200",
};

type Props = {
  issueId: string;
  identifier: string;
  docKey: string;
  gate: ApprovalGate;
  paperclipUrl: string | null;
};

export default function ApproveRejectBar({
  issueId,
  identifier,
  docKey,
  gate,
  paperclipUrl,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"approved" | "rejected" | null>(null);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [note, setNote] = useState("");

  async function approve() {
    setBusy("approve");
    setError(null);
    try {
      const res = await fetch(`/api/issues/${encodeURIComponent(issueId)}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docKey }),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setError(typeof json.error === "string" ? json.error : `HTTP ${res.status}`);
        return;
      }
      setDone("approved");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    if (!note.trim()) {
      setError("Note is required");
      return;
    }
    setBusy("reject");
    setError(null);
    try {
      const res = await fetch(`/api/issues/${encodeURIComponent(issueId)}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docKey, note: note.trim() }),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setError(typeof json.error === "string" ? json.error : `HTTP ${res.status}`);
        return;
      }
      setDone("rejected");
      setShowRejectModal(false);
      setNote("");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border-t border-neutral-800 pt-4 mt-4">
      {gate.banner ? (
        <div
          data-testid="approval-banner"
          className={`mb-3 rounded-md border px-3 py-2 text-xs ${TONE_CLASS[gate.bannerTone]}`}
        >
          {gate.banner}
        </div>
      ) : null}

      {done === "approved" ? (
        <div className="mb-3 rounded-md border border-emerald-700/60 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-200">
          ✅ Approval comment posted. Issue is now <code>todo</code>.
        </div>
      ) : null}
      {done === "rejected" ? (
        <div className="mb-3 rounded-md border border-rose-700/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
          ❌ Rejection note posted. Issue is now <code>in_progress</code>.
        </div>
      ) : null}
      {error ? (
        <div className="mb-3 rounded-md border border-rose-700/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
          Error: {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="approve-button"
          onClick={approve}
          disabled={!gate.allowed || busy !== null || done !== null}
          title={gate.allowed ? "Approve and mark issue todo" : (gate.banner ?? "Approval blocked")}
          className={`px-3 py-1.5 rounded-md border text-xs font-medium transition-colors ${
            !gate.allowed || done !== null
              ? "bg-emerald-700/20 text-emerald-300/40 border-emerald-800/40 cursor-not-allowed"
              : "bg-emerald-700/40 text-emerald-100 border-emerald-700/70 hover:bg-emerald-700/60"
          }`}
        >
          {busy === "approve" ? "Approving…" : "APPROVE"}
        </button>
        <button
          type="button"
          data-testid="reject-button"
          onClick={() => setShowRejectModal(true)}
          disabled={busy !== null || done !== null}
          className="px-3 py-1.5 rounded-md bg-rose-900/40 text-rose-100 border border-rose-700/70 text-xs font-medium hover:bg-rose-900/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          REJECT WITH NOTE
        </button>
        {paperclipUrl ? (
          <a
            href={paperclipUrl}
            className="text-xs text-sky-400 hover:text-sky-300 underline"
            target="_blank"
            rel="noreferrer"
          >
            Open in Paperclip ↗
          </a>
        ) : null}
        <span className="text-[11px] text-neutral-600 ml-auto font-mono">{identifier}</span>
      </div>

      {showRejectModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-950 p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-white mb-2">Reject with note</h3>
            <p className="text-xs text-neutral-400 mb-3">
              Note posts as a comment on <code>{identifier}</code> and moves the
              issue back to <code>in_progress</code>.
            </p>
            <textarea
              data-testid="reject-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What needs to change?"
              rows={6}
              className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-neutral-500"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowRejectModal(false);
                  setNote("");
                  setError(null);
                }}
                className="px-3 py-1.5 rounded-md border border-neutral-700 bg-neutral-900 text-neutral-300 text-xs hover:bg-neutral-800"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="reject-confirm"
                onClick={reject}
                disabled={!note.trim() || busy === "reject"}
                className="px-3 py-1.5 rounded-md border border-rose-700/70 bg-rose-900/60 text-rose-100 text-xs hover:bg-rose-900/80 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {busy === "reject" ? "Sending…" : "Send rejection"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
