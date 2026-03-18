"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FeedbackForm } from "@/components/FeedbackForm";

export default function SuccessPage() {
  return (
    <Suspense
      fallback={
        <main id="main-content" className="relative flex min-h-screen items-center justify-center overflow-hidden" style={{ background: "var(--bg-void)" }}>
          <div className="aurora-bg pointer-events-none fixed inset-0 opacity-60" />
          <div className="relative z-10 text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-white/10 border-t-[var(--accent-cyan)]" />
            <p className="mt-4 text-sm" style={{ color: "var(--text-muted)" }}>Loading...</p>
          </div>
        </main>
      }
    >
      <SuccessContent />
    </Suspense>
  );
}

function SuccessContent() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session_id");
  const [state, setState] = useState<
    "loading" | "paid" | "error"
  >("loading");
  const [data, setData] = useState<{
    tier: string;
    questionnaireId: string;
  } | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setState("error");
      return;
    }

    fetch(`/api/checkout/verify?session_id=${sessionId}`)
      .then((res) => res.json())
      .then((json) => {
        if (json.paid) {
          setData({ tier: json.tier, questionnaireId: json.questionnaireId });
          setState("paid");
        } else {
          setState("error");
        }
      })
      .catch(() => setState("error"));
  }, [sessionId]);

  async function handleDownload() {
    if (!data || !sessionId) return;
    setDownloading(true);
    try {
      const res = await fetch(
        `/api/export/brand-kit/${data.questionnaireId}?session_id=${sessionId}`
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Download failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        res.headers
          .get("Content-Disposition")
          ?.match(/filename="(.+)"/)?.[1] || "brand-kit.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Error handled silently — user can retry
    } finally {
      setDownloading(false);
    }
  }

  if (state === "loading") {
    return (
      <main id="main-content" className="relative flex min-h-screen items-center justify-center overflow-hidden" style={{ background: "var(--bg-void)" }}>
        <div className="aurora-bg pointer-events-none fixed inset-0 opacity-60" />
        <div className="relative z-10 text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-white/10 border-t-[var(--accent-cyan)]" />
          <p className="mt-4 text-sm" style={{ color: "var(--text-muted)" }}>
            Verifying your payment...
          </p>
        </div>
      </main>
    );
  }

  if (state === "error") {
    return (
      <main id="main-content" className="relative flex min-h-screen items-center justify-center overflow-hidden px-4" style={{ background: "var(--bg-void)" }}>
        <div className="aurora-bg pointer-events-none fixed inset-0 opacity-60" />
        <div className="relative z-10 max-w-sm text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full" style={{ background: "rgba(247, 37, 133, 0.15)", boxShadow: "0 0 30px rgba(247, 37, 133, 0.2)" }}>
            <svg
              className="h-8 w-8"
              style={{ color: "var(--accent-pink)" }}
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </div>
          <h1 className="mt-4 text-xl font-bold text-[var(--text-primary)]">
            Payment not confirmed
          </h1>
          <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
            We couldn&apos;t verify your payment. If you were charged, please
            contact support.
          </p>
          <a
            href="/"
            className="mt-6 inline-block text-sm underline transition-colors hover:text-[var(--text-primary)]"
            style={{ color: "var(--primary)" }}
          >
            Back to home
          </a>
        </div>
      </main>
    );
  }

  return (
    <main id="main-content" className="relative flex min-h-screen items-center justify-center overflow-hidden px-4" style={{ background: "var(--bg-void)" }}>
      <div className="aurora-bg pointer-events-none fixed inset-0 opacity-60" />
      <div className="relative z-10 max-w-md text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full" style={{ background: "rgba(0, 245, 255, 0.1)", boxShadow: "0 0 30px rgba(0, 245, 255, 0.25)" }}>
          <svg
            className="h-8 w-8"
            style={{ color: "var(--accent-cyan)" }}
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4.5 12.75l6 6 9-13.5"
            />
          </svg>
        </div>
        <h1 className="mt-4 text-xl font-bold text-[var(--text-primary)]">
          Payment successful!
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
          Your {data?.tier === "premium" ? "Premium" : "Basic"} Brand Kit is
          ready to download.
        </p>

        <button
          type="button"
          onClick={handleDownload}
          disabled={downloading}
          className="cta-glow mt-6 inline-flex items-center gap-2 rounded-lg bg-[var(--primary)] px-8 py-3 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50 transition-all"
        >
          {downloading ? (
            <>
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              Preparing...
            </>
          ) : (
            <>
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
                />
              </svg>
              Download Brand Kit
            </>
          )}
        </button>

        <div className="mt-6">
          <a
            href="/"
            className="text-sm underline transition-colors hover:text-[var(--text-primary)]"
            style={{ color: "var(--text-muted)" }}
          >
            Back to home
          </a>
        </div>
      </div>
      <FeedbackForm />
    </main>
  );
}
