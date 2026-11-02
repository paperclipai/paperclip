import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Browse } from "@/pages/apps/Browse";
import { Button } from "@/components/ui/button";

/** Production Apps UI and API; only upstream providers are simulated by the disposable fixture server. */
export function ManagedAggregatorAccounts() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const previous = window.fetch;
    let mounted = true;
    void previous("http://localhost:4310/fixture").then(response => response.json()).then(({ companyId }) => {
      if (!mounted) return;
      window.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
        if (/^\/api\/(companies\/[^/]+\/tools|tool-connections\/)/.test(url.pathname)) {
          url.pathname = url.pathname.replace("company-storybook", companyId);
          return previous(`http://localhost:4310${url.pathname}${url.search}`, { ...init, credentials: "omit", headers: { "Content-Type": "application/json" } });
        }
        return previous(input, init);
      };
      setReady(true);
    }).catch(() => { if (mounted) setError("Start tests/aggregator-accounts/test-drive.ts to use this full-stack fixture."); });
    return () => { mounted = false; window.fetch = previous; client.clear(); };
  }, [client]);
  async function change(upstream: Record<string, unknown>) {
    await fetch("http://localhost:4310/fixture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(upstream) });
  }
  return <QueryClientProvider client={client}><main className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
    <aside aria-label="Simulated upstream controls" className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border p-3">
      <span className="text-xs text-muted-foreground">Simulated upstream</span>
      <Button size="sm" variant="outline" onClick={() => change({ arcadeAccounts: ["Work", "Personal", "Added upstream"], failed: false, partial: false })}>Add Arcade account</Button>
      <Button size="sm" variant="outline" onClick={() => change({ arcadeAccounts: ["Work"], failed: false, partial: false })}>Disconnect Arcade Personal</Button>
      <Button size="sm" variant="outline" onClick={() => change({ failed: true })}>Expire authorization</Button>
      <Button size="sm" variant="outline" onClick={() => change({ failed: false, partial: true })}>Fail a page</Button>
      <Button size="sm" variant="outline" onClick={() => change({ unsupported: true })}>Disable Executor inventory</Button>
      <Button size="sm" variant="outline" onClick={() => change({ arcadeAccounts: ["Work", "Personal"], failed: false, partial: false, unsupported: false })}>Restore upstream</Button>
    </aside>
    {error ? <p role="alert">{error}</p> : ready ? <Browse /> : <p role="status">Connecting to the fixture API…</p>}
  </main></QueryClientProvider>;
}
