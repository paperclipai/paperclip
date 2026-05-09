"use client";

import { useEffect, useState } from "react";

export default function ChunkErrorBanner() {
  const [show, setShow] = useState(false);
  const [countdown, setCountdown] = useState(10);

  useEffect(() => {
    function handleError(event: ErrorEvent) {
      const isChunk =
        event.error?.name === "ChunkLoadError" ||
        String(event.message).includes("Loading chunk") ||
        String(event.message).includes("Failed to fetch dynamically imported") ||
        String(event.message).includes("ChunkLoadError");
      if (isChunk) setShow(true);
    }
    window.addEventListener("error", handleError);
    return () => window.removeEventListener("error", handleError);
  }, []);

  useEffect(() => {
    if (!show) return;
    if (countdown <= 0) {
      window.location.reload();
      return;
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [show, countdown]);

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/90 backdrop-blur-sm">
      <div className="max-w-sm w-full mx-4 rounded-xl border border-amber-700/60 bg-amber-950/40 p-8 text-center">
        <div className="text-3xl mb-4 animate-spin inline-block">⟳</div>
        <h2 className="text-lg font-semibold text-amber-200 mb-2">
          Library is rebuilding
        </h2>
        <p className="text-sm text-amber-300/80 mb-4">
          A code update is being applied. Refreshing in{" "}
          <span className="font-bold text-amber-200">{countdown}s</span>.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="text-xs text-amber-400 underline hover:text-amber-200"
        >
          Refresh now
        </button>
      </div>
    </div>
  );
}
