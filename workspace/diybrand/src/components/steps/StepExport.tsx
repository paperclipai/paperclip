"use client";

import { useState } from "react";

type Props = {
  questionnaireId: string;
  brandName: string;
};

export function StepExport({ questionnaireId, brandName }: Props) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);

  async function handleDownload() {
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch(`/api/export/brand-kit/${questionnaireId}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Download failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        res.headers.get("Content-Disposition")?.match(/filename="(.+)"/)?.[1] ||
        "brand-kit.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDownloaded(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not download brand kit."
      );
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100">
          <svg
            className="h-8 w-8 text-emerald-600"
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
        <h3 className="mt-4 text-xl font-bold text-gray-900">
          Your brand kit is ready!
        </h3>
        <p className="mt-2 text-sm text-gray-500">
          Download your complete {brandName} brand kit as a ZIP file with logos,
          color palette, and typography guide.
        </p>
      </div>

      {/* What's included */}
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-6">
        <h4 className="text-sm font-semibold text-gray-700">
          What&apos;s in your brand kit
        </h4>
        <ul className="mt-3 space-y-2 text-sm text-gray-600">
          <li className="flex items-start gap-2">
            <span className="mt-0.5 block h-4 w-4 shrink-0 text-violet-600">
              <svg fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
              </svg>
            </span>
            <span><strong>Logos</strong> — Your selected logo concepts as PNG files</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 block h-4 w-4 shrink-0 text-violet-600">
              <svg fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.098 19.902a3.75 3.75 0 005.304 0l6.401-6.402M6.75 21A3.75 3.75 0 013 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 003.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88M6.75 17.25h.008v.008H6.75v-.008z" />
              </svg>
            </span>
            <span><strong>Colors</strong> — Palette as JSON, CSS variables, and visual HTML swatch page</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 block h-4 w-4 shrink-0 text-violet-600">
              <svg fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
              </svg>
            </span>
            <span><strong>Typography</strong> — Font pairings as JSON, CSS, and visual HTML specimen</span>
          </li>
        </ul>
      </div>

      {/* Download button */}
      <div className="flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={handleDownload}
          disabled={downloading}
          className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-8 py-3 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {downloading ? (
            <>
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              Preparing download...
            </>
          ) : downloaded ? (
            <>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              Download again
            </>
          ) : (
            <>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              Download Brand Kit (.zip)
            </>
          )}
        </button>

        {downloaded && (
          <p className="text-sm text-emerald-600">
            Download started! Check your downloads folder.
          </p>
        )}

        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}
      </div>

      {/* Back to home */}
      <div className="text-center">
        <a
          href="/"
          className="text-sm text-gray-500 underline hover:text-gray-700"
        >
          Back to home
        </a>
      </div>
    </div>
  );
}
