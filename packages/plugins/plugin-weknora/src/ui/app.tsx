import {
  usePluginAction,
  usePluginData,
  usePluginToast,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { useMemo, useState } from "react";

type Overview = {
  configured: boolean;
  baseUrl?: string;
  tenantConfigured?: boolean;
  enableWriteActions?: boolean;
  defaultWikiKnowledgeBaseId?: string | null;
  error?: { message?: string };
};

type KnowledgeBase = { id: string; name: string; knowledgeCount: number; chunkCount: number; processingCount: number };
type SearchData = { results: Array<{ knowledgeId: string; title: string; content: string; chunkIndex: number; truncated: boolean; score?: number }> };
type WikiPages = { pages: Array<{ slug: string; title: string; summary?: string }>; hasMore: boolean };
type WikiPage = { page: { slug: string; title: string; content: string; truncated?: boolean } };
type Health = { status: string; checkedAt: string; warnings: string[]; lintCounts?: Record<string, number>; error?: { kind?: string; message?: string } };

const panelStyle = { border: "1px solid color-mix(in srgb, currentColor 15%, transparent)", borderRadius: 8, padding: 16 };
const mutedStyle = { opacity: 0.72 };

function ErrorState({ message }: { message: string }) {
  return <p role="alert">WeKnora is not available: {message}</p>;
}

export function WeKnoraPage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const [tab, setTab] = useState<"overview" | "browse" | "query" | "health">("overview");
  const [selectedKnowledgeBaseId, setSelectedKnowledgeBaseId] = useState<string | null>(null);
  const [selectedPageSlug, setSelectedPageSlug] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [manualTitle, setManualTitle] = useState("");
  const [manualContent, setManualContent] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");

  const params = useMemo(() => companyId ? { companyId } : undefined, [companyId]);
  const overview = usePluginData<Overview>("overview", params);
  const bases = usePluginData<{ knowledgeBases: KnowledgeBase[] }>("knowledge-bases", params);
  const knowledgeBaseId = selectedKnowledgeBaseId ?? overview.data?.defaultWikiKnowledgeBaseId ?? bases.data?.knowledgeBases[0]?.id ?? null;
  const pages = usePluginData<WikiPages>("wiki-pages", companyId && knowledgeBaseId ? { companyId, knowledgeBaseId, page: 1, pageSize: 20 } : undefined);
  const page = usePluginData<WikiPage>("wiki-page", companyId && knowledgeBaseId && selectedPageSlug ? { companyId, knowledgeBaseId, slug: selectedPageSlug } : undefined);
  const search = usePluginData<SearchData>("search", companyId && submittedQuery ? { companyId, query: submittedQuery, knowledgeBaseIds: knowledgeBaseId ? [knowledgeBaseId] : undefined } : undefined);
  const document = usePluginData<{ document: { title: string; summary?: string }; chunks: Array<{ index: number; content: string; truncated: boolean }> }>("document", companyId && selectedDocumentId ? { companyId, knowledgeId: selectedDocumentId, page: 1, pageSize: 8 } : undefined);
  const health = usePluginData<Health>("health", companyId ? { companyId, knowledgeBaseId: knowledgeBaseId ?? undefined } : undefined);
  const ingestManual = usePluginAction("ingest-manual");
  const ingestUrl = usePluginAction("ingest-url");
  const rebuildWikiLinks = usePluginAction("rebuild-wiki-links");
  const autoFixWiki = usePluginAction("auto-fix-wiki");
  const toast = usePluginToast();

  if (!companyId) return <main><h1>WeKnora</h1><p>Select a company to use the connector.</p></main>;
  if (overview.error) return <main><h1>WeKnora</h1><ErrorState message={overview.error.message} /></main>;

  async function runBoardAction(action: () => Promise<unknown>, label: string) {
    try {
      await action();
      toast({ title: `${label} complete`, tone: "success", dedupeKey: `weknora-${label}` });
      health.refresh();
    } catch (error) {
      toast({ title: `${label} failed`, body: error instanceof Error ? error.message : "The action failed.", tone: "error" });
    }
  }

  return (
    <main style={{ display: "grid", gap: 16, maxWidth: 1100 }}>
      <header>
        <h1>WeKnora</h1>
        <p style={mutedStyle}>Read-only retrieval and wiki browsing with board-controlled maintenance.</p>
        <nav aria-label="WeKnora sections" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(["overview", "browse", "query", "health"] as const).map((item) => <button key={item} type="button" onClick={() => setTab(item)} aria-current={tab === item ? "page" : undefined}>{item}</button>)}
        </nav>
      </header>

      {!overview.data?.configured ? <section style={panelStyle}><h2>Configuration required</h2><ErrorState message={overview.data?.error?.message ?? "Add a WeKnora base URL and Paperclip secret reference."} /></section> : null}

      {tab === "overview" ? <section style={{ display: "grid", gap: 16 }}>
        <section style={panelStyle}><h2>Connection</h2><p>Endpoint: <code>{overview.data?.baseUrl ?? "Not configured"}</code></p><p>Tenant header: {overview.data?.tenantConfigured ? "configured" : "not configured"}</p><p>Board writes: {overview.data?.enableWriteActions ? "enabled" : "disabled by default"}</p></section>
        <section style={panelStyle}><h2>Knowledge bases</h2>{bases.loading ? <p>Loading knowledge bases…</p> : bases.error ? <ErrorState message={bases.error.message} /> : <>{(bases.data as ({ knowledgeBases: KnowledgeBase[]; total?: number; truncated?: boolean } | undefined))?.truncated ? <p style={mutedStyle}>Showing a bounded list of knowledge bases. Use the WeKnora operator for the complete list.</p> : null}{(bases.data?.knowledgeBases ?? []).length === 0 ? <p>No knowledge bases are visible.</p> : <ul>{(bases.data?.knowledgeBases ?? []).map((base) => <li key={base.id}><button type="button" onClick={() => { setSelectedKnowledgeBaseId(base.id); setTab("browse"); }}>{base.name}</button> <span style={mutedStyle}>({base.knowledgeCount} documents, {base.chunkCount} chunks)</span></li>)}</ul>}</>}</section>
        <section style={panelStyle}><h2>Health</h2>{health.loading ? <p>Checking WeKnora…</p> : health.error ? <ErrorState message={health.error.message} /> : <><p>Status: <strong>{health.data?.status}</strong></p>{health.data?.error ? <p role="alert">{health.data.error.kind ?? "error"}: {health.data.error.message ?? "WeKnora health is unavailable."}</p> : null}{health.data?.warnings?.length ? <ul>{health.data.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <p>No warnings.</p>}</>}</section>
      </section> : null}

      {tab === "browse" ? <section style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(220px, 0.7fr) minmax(0, 1.3fr)" }}>
        <section style={panelStyle}><h2>Wiki pages</h2><p>Knowledge base: {knowledgeBaseId ?? "none"}</p>{pages.loading ? <p>Loading pages…</p> : pages.error ? <ErrorState message={pages.error.message} /> : <ul>{(pages.data?.pages ?? []).map((item) => <li key={item.slug}><button type="button" onClick={() => setSelectedPageSlug(item.slug)}>{item.title}</button><small style={mutedStyle}> {item.slug}</small></li>)}</ul>}</section>
        <section style={panelStyle}><h2>{page.data?.page.title ?? "Select a page"}</h2>{page.error ? <ErrorState message={page.error.message} /> : page.data ? <article><p style={mutedStyle}>{page.data.page.slug}{page.data.page.truncated ? " · truncated" : ""}</p><pre style={{ whiteSpace: "pre-wrap" }}>{page.data.page.content}</pre></article> : <p style={mutedStyle}>Choose a wiki page to read it from WeKnora.</p>}</section>
      </section> : null}

      {tab === "query" ? <section style={panelStyle}><h2>Query</h2><form onSubmit={(event) => { event.preventDefault(); setSubmittedQuery(query.trim()); }}><label>Search WeKnora <input value={query} onChange={(event) => setQuery(event.target.value)} /></label> <button type="submit">Search</button></form>{search.loading ? <p>Searching…</p> : search.error ? <ErrorState message={search.error.message} /> : <ul>{(search.data?.results ?? []).map((result, index) => <li key={`${result.knowledgeId}:${result.chunkIndex}:${index}`}><button type="button" onClick={() => setSelectedDocumentId(result.knowledgeId)}>{result.title}</button><p>{result.content}{result.truncated ? " … [truncated]" : ""}</p><small style={mutedStyle}>knowledgeId={result.knowledgeId} · chunk={result.chunkIndex}{result.score == null ? "" : ` · score=${result.score}`}</small></li>)}</ul>}{document.data ? <aside><h3>{document.data.document.title}</h3>{document.data.chunks.map((chunk) => <p key={chunk.index}><small>[chunk {chunk.index}]</small> {chunk.content}{chunk.truncated ? " … [truncated]" : ""}</p>)}</aside> : null}</section> : null}

      {tab === "health" ? <section style={{ display: "grid", gap: 16 }}><section style={panelStyle}><h2>Health</h2>{health.loading ? <p>Checking WeKnora…</p> : health.error ? <ErrorState message={health.error.message} /> : <><p>Status: <strong>{health.data?.status}</strong></p><p>Checked: {health.data?.checkedAt}</p>{health.data?.error ? <p role="alert">{health.data.error.kind ?? "error"}: {health.data.error.message ?? "WeKnora health is unavailable."}</p> : null}{health.data?.warnings?.length ? <ul>{health.data.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <p>No warnings.</p>}</>}</section><section style={panelStyle}><h2>Board actions</h2><p style={mutedStyle}>Manual ingest and wiki maintenance are disabled until the operator enables them. Agents never receive these actions as tools.</p><label>Title <input value={manualTitle} onChange={(event) => setManualTitle(event.target.value)} disabled={!overview.data?.enableWriteActions} /></label> <label>Content <textarea value={manualContent} onChange={(event) => setManualContent(event.target.value)} disabled={!overview.data?.enableWriteActions} /></label> <button type="button" disabled={!overview.data?.enableWriteActions || !knowledgeBaseId || !manualTitle.trim() || !manualContent.trim()} onClick={() => runBoardAction(() => ingestManual({ companyId, knowledgeBaseId, title: manualTitle.trim(), content: manualContent.trim() }), "Manual ingest")}>Manual ingest</button><div><label>Source URL <input type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} disabled={!overview.data?.enableWriteActions} /></label> <button type="button" disabled={!overview.data?.enableWriteActions || !knowledgeBaseId || !sourceUrl.trim()} onClick={() => runBoardAction(() => ingestUrl({ companyId, knowledgeBaseId, url: sourceUrl.trim() }), "URL ingest")}>URL ingest</button></div><button type="button" disabled={!overview.data?.enableWriteActions || !knowledgeBaseId} onClick={() => runBoardAction(() => rebuildWikiLinks({ companyId, knowledgeBaseId }), "Wiki link rebuild")}>Rebuild links</button>{" "}<button type="button" disabled={!overview.data?.enableWriteActions || !knowledgeBaseId} onClick={() => runBoardAction(() => autoFixWiki({ companyId, knowledgeBaseId }), "Wiki auto-fix")}>Auto-fix wiki</button></section></section> : null}
    </main>
  );
}
