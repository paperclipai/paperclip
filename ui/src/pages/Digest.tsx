import { useEffect, useState } from "react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { generateDigest, type DigestResult } from "../api/assistant";
import { MarkdownBody } from "../components/MarkdownBody";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { FileText, RefreshCw } from "lucide-react";

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Daily operating digest — generated on demand from live company state and rendered
// through the shared GLASSHOUSE Markdown renderer. Advisory only.
export function Digest() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [digest, setDigest] = useState<DigestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Digest" }]);
  }, [setBreadcrumbs]);

  async function run() {
    if (!selectedCompanyId || loading) return;
    setLoading(true);
    setError(null);
    try {
      setDigest(await generateDigest(selectedCompanyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate the digest.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-4 sm:px-6 sm:py-6">
      <header className="mb-5 flex items-end justify-between gap-3">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground/60">Company</div>
          <h1 className="font-serif text-2xl tracking-tight text-foreground">Digest</h1>
          {digest && (
            <p className="mt-0.5 text-[12px] text-muted-foreground">Generated {fmtDateTime(digest.generatedAt)}</p>
          )}
        </div>
        <Button onClick={() => void run()} disabled={loading || !selectedCompanyId} size="sm" variant="outline">
          <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          {digest ? "Regenerate" : "Generate"}
        </Button>
      </header>

      {error && (
        <div className="mb-4 rounded-[3px] border border-status-error/40 bg-status-error/10 px-3 py-2 text-[12px] text-status-error">
          {error}
        </div>
      )}

      {digest ? (
        <article className="rounded-[3px] border border-border bg-card/40 px-4 py-4 sm:px-6 sm:py-5">
          <MarkdownBody>{digest.markdown}</MarkdownBody>
        </article>
      ) : (
        !error && (
          <EmptyState
            icon={FileText}
            message="Generate today's operating digest — spend, agent health, and issue flow, summarized from live state."
            action={loading ? undefined : "Generate digest"}
            onAction={loading ? undefined : () => void run()}
          />
        )
      )}
    </div>
  );
}
