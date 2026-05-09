"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { IssueApprovalGate } from "@/lib/asset-type";

const TONE_CLASS: Record<IssueApprovalGate["bannerTone"], string> = {
  ok: "border-emerald-700/60 bg-emerald-950/30 text-emerald-200",
  warn: "border-amber-700/60 bg-amber-950/30 text-amber-200",
  block: "border-rose-700/60 bg-rose-950/30 text-rose-200",
};

type Props = {
  issueId: string;
  identifier: string;
  gate: IssueApprovalGate;
  paperclipUrl: string | null;
};

export default function IssueApproveBar({
  issueId,
  identifier,
  gate,
  paperclipUrl,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/issues/${encodeURIComponent(issueId)}/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const json = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!res.ok) {
        setError(
          typeof json.error === "string" ? json.error : `HTTP ${res.status}`,
        );
        return;
      }
      setDone(true);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-neutral-800 pt-4 mt-6">
      <h3 className="text-xs uppercase tracking-wide text-neutral-500 mb-3">
        Brief approval gate
      </h3>

      {gate.banner ? (
        <div
          data-testid="issue-approval-banner"
          className={`mb-3 rounded-md border px-3 py-2 text-xs ${TONE_CLASS[gate.bannerTone]}`}
        >
          {gate.banner}
        </div>
      ) : null}

      {done ? (
        <div className="mb-3 rounded-md border border-emerald-700/60 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-200">
          ✅ Brief approved. Issue is now <code>todo</code> — ready to ship.
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
          data-testid="issue-approve-button"
          onClick={approve}
          disabled={!gate.allowed || busy || done}
          title={
            gate.allowed
              ? "Approve brief and mark issue todo"
              : (gate.banner ?? "Approval blocked — visual asset required")
          }
          className={`px-3 py-1.5 rounded-md border text-xs font-medium transition-colors ${
            !gate.allowed || done
              ? "bg-emerald-700/20 text-emerald-300/40 border-emerald-800/40 cursor-not-allowed"
              : "bg-emerald-700/40 text-emerald-100 border-emerald-700/70 hover:bg-emerald-700/60"
          }`}
        >
          {busy ? "Approving…" : "APPROVE BRIEF"}
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
        <span className="text-[11px] text-neutral-600 ml-auto font-mono">
          {identifier}
        </span>
      </div>
    </div>
  );
}
