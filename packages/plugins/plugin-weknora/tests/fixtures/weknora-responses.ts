export const envelope = (data: unknown) => ({ success: true, data });

export const knowledgeBases = envelope({ knowledge_bases: [{ id: "kb-1", name: "Engineering", type: "wiki", knowledge_count: 2, chunk_count: 4, processing_count: 0 }] });

export const search = envelope({ results: [{ knowledge_base_id: "kb-1", knowledge_id: "doc-1", title: "Runbook", filename: "runbook.md", source: "handle:doc-1", chunk_index: 0, score: 0.91, content: "A trusted passage from WeKnora." }] });

export const knowledge = envelope({ document: { id: "doc-1", title: "Runbook", summary: "Operations runbook", status: "ready" }, chunks: [{ index: 0, content: "First chunk." }, { index: 1, content: "Second chunk." }], total: 2 });

export const chunks = envelope({ chunks: [{ index: 2, content: "Third chunk." }], total: 3 });

export const wikiPages = envelope({ pages: [{ slug: "operations/runbook", title: "Runbook", summary: "Wiki summary", page_type: "concept", status: "published" }], total: 1 });

export const wikiPage = envelope({ page: { slug: "operations/runbook", title: "Runbook", content: "# Runbook\n\nUntrusted wiki content.", source_refs: ["doc-1"], in_links: [], out_links: [] } });

export const wikiSearch = envelope({ results: [{ slug: "operations/runbook", title: "Runbook", excerpt: "A matching excerpt", score: 0.88 }] });

export const wikiStats = envelope({ stats: { pages: 1, published: 1 } });
export const wikiLint = envelope({ lint_counts: { broken_links: 1, missing_summary: 0 } });
export const wikiIssues = envelope({ issues: [{ slug: "operations/runbook", code: "broken_link", message: "A safe warning" }] });

export const ingest = envelope({ id: "task-1", task_id: "task-1", status: "queued" });
