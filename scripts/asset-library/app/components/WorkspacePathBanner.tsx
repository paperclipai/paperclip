"use client";

import { useState } from "react";

type ResolveResult = {
  resolved?: Array<{ path: string; key: string }>;
  failed?: Array<{ path: string; reason: string }>;
  error?: string;
};

export default function WorkspacePathBanner({
  issueId,
}: {
  issueId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState<ResolveResult | null>(null);

  async function onResolve() {
    setBusy(true);
    setError(null);
    setPartial(null);
    try {
      const res = await fetch(
        `/api/issues/${encodeURIComponent(issueId)}/auto-resolve-paths`,
        { method: "POST" },
      );
      const data = (await res.json()) as ResolveResult;
      if (!res.ok) {
        setError(data.error ?? `auto_resolve_failed_${res.status}`);
        if (data.failed && data.failed.length) setPartial(data);
        setBusy(false);
        return;
      }
      const failed = data.failed ?? [];
      const resolved = data.resolved ?? [];
      if (resolved.length === 0 && failed.length > 0) {
        setError("No paths resolved.");
        setPartial(data);
        setBusy(false);
        return;
      }
      // Reload — banner disappears once docs exist.
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 rounded-md border border-red-500 bg-red-100 px-4 py-3 text-red-900">
      <div className="flex items-start gap-3">
        <span className="font-mono text-lg leading-none">[!]</span>
        <div className="flex-1">
          <div className="font-semibold text-sm">
            Issue references workspace files but none are attached.
          </div>
          <div className="text-xs mt-1">
            Asset Library cannot render these assets.
          </div>
          {error ? (
            <div className="mt-2 text-xs font-mono text-red-800">
              {error}
            </div>
          ) : null}
          {partial?.failed?.length ? (
            <ul className="mt-2 text-xs font-mono text-red-800 space-y-0.5">
              {partial.failed.map((f) => (
                <li key={f.path}>
                  Could not resolve path: <code>{f.path}</code> — {f.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <button
          onClick={onResolve}
          disabled={busy}
          className="shrink-0 rounded bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
        >
          {busy ? "Resolving…" : "Auto-resolve"}
        </button>
      </div>
    </div>
  );
}
