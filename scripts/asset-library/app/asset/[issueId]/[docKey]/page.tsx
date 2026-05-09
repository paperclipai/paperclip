import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import AssetRenderer from "@/app/components/AssetRenderer";
import ProvenancePanel from "@/app/components/ProvenancePanel";
import ApproveRejectBar from "./ApproveRejectBar";
import AssetIssueSummaryView from "@/app/components/AssetIssueSummaryView";
import {
  evaluateApprovalGate,
  evaluateIssueApprovalGate,
  parseProvenance,
  type ExceptionRef,
  type IssueDocument,
} from "@/lib/asset-type";
import { toCard, titleSlug, type RawIssue } from "@/lib/queue";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function fetchJson<T>(path: string): Promise<T | null> {
  const h = headers();
  const host = h.get("host") ?? "127.0.0.1:7700";
  const proto = h.get("x-forwarded-proto") ?? "http";
  const url = `${proto}://${host}${path}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchIssue(issueId: string): Promise<RawIssue | null> {
  // Use the detail proxy — list endpoint truncates description at ~1200 chars,
  // which clips the right-hand description fallback when no docs are attached.
  const detail = await fetchJson<RawIssue>(
    `/api/issues/${encodeURIComponent(issueId)}`,
  );
  if (detail) return detail;
  const list = await fetchJson<RawIssue[]>("/api/issues");
  if (!list) return null;
  return (
    list.find((i) => i.id === issueId || i.identifier === issueId) ?? null
  );
}

async function fetchDoc(
  issueId: string,
  docKey: string,
): Promise<IssueDocument | null> {
  return fetchJson<IssueDocument>(
    `/api/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(docKey)}`,
  );
}

async function fetchDocs(issueId: string): Promise<IssueDocument[]> {
  return (
    (await fetchJson<IssueDocument[]>(
      `/api/issues/${encodeURIComponent(issueId)}/documents`,
    )) ?? []
  );
}

async function fetchComments(issueId: string): Promise<{ body?: string | null }[]> {
  const apiUrl = process.env.PAPERCLIP_API_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  if (!apiUrl || !apiKey) return [];
  try {
    const res = await fetch(
      `${apiUrl.replace(/\/$/, "")}/api/issues/${encodeURIComponent(issueId)}/comments`,
      { headers: { Authorization: `Bearer ${apiKey}` }, cache: "no-store" },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as { body?: string | null }[]) : [];
  } catch {
    return [];
  }
}

function paperclipIssueUrl(identifier: string): string {
  const base = process.env.PAPERCLIP_WEB_URL ?? "http://127.0.0.1:5173";
  return `${base.replace(/\/$/, "")}/issues/${identifier}`;
}

export default async function AssetDocDetail({
  params,
}: {
  params: { issueId: string; docKey: string };
}) {
  const [doc, issue] = await Promise.all([
    fetchDoc(params.issueId, params.docKey),
    fetchIssue(params.issueId),
  ]);

  if (!doc) {
    if (!issue) {
      return (
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-6">
          <Link
            href={`/asset/${params.issueId}`}
            className="text-xs text-neutral-500 hover:text-neutral-300 inline-block mb-3"
          >
            ← Back to issue
          </Link>
          <p className="text-sm text-neutral-300">
            Document <code className="text-neutral-100">{params.docKey}</code>{" "}
            not found on issue <code>{params.issueId}</code>.
          </p>
        </div>
      );
    }

    // No doc found but issue exists → treat second segment as title slug.
    const canonicalSlug = titleSlug(issue.title);
    if (params.docKey !== canonicalSlug) {
      // Wrong or stale slug → 307 to canonical.
      redirect(`/asset/${issue.identifier}${canonicalSlug ? `/${canonicalSlug}` : ""}`);
    }
    // Canonical slug matches — render issue summary.
    const [docs, comments] = await Promise.all([
      fetchDocs(params.issueId),
      fetchComments(params.issueId),
    ]);
    const issueGate = evaluateIssueApprovalGate(docs, comments);
    return (
      <AssetIssueSummaryView
        issueId={issue.identifier}
        issue={issue}
        docs={docs}
        gate={issueGate}
        paperclipUrl={paperclipIssueUrl(issue.identifier)}
      />
    );
  }

  const card = issue ? toCard(issue) : null;
  const prov = parseProvenance(doc);

  const exceptionId = prov.raw["exception_issue_id"] ?? prov.raw["exception"] ?? null;
  let exception: ExceptionRef | null = null;
  if (exceptionId) {
    exception = await fetchJson<ExceptionRef>(
      `/api/exception-check?id=${encodeURIComponent(exceptionId)}`,
    );
  }
  const gate = evaluateApprovalGate(prov, params.docKey, exception);
  const paperclipUrl = issue ? paperclipIssueUrl(issue.identifier) : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem] gap-6">
      <div>
        <Link
          href={card ? `/asset/${issue?.identifier ?? params.issueId}` : "/"}
          className="text-xs text-neutral-500 hover:text-neutral-300 inline-block mb-4"
        >
          ← Back {card ? "to issue" : "to queue"}
        </Link>

        <header className="mb-4">
          <div className="flex flex-wrap items-baseline gap-3 mb-2">
            <h2 className="text-lg font-semibold text-white">
              {doc.title || doc.key}
            </h2>
            <span className="font-mono text-xs text-neutral-500">
              {doc.key}
            </span>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px]">
            {card ? <Pill label={card.platform} /> : null}
            {card?.postDate ? <Pill label={`Post: ${card.postDate}`} /> : null}
            {card ? <Pill label={`Author: ${card.author}`} /> : null}
            <Pill label={`Format: ${doc.format ?? "—"}`} />
            {doc.latestRevisionNumber ? (
              <Pill label={`Rev ${doc.latestRevisionNumber}`} />
            ) : null}
          </div>
        </header>

        <section className="mb-6">
          <AssetRenderer doc={doc} />
        </section>

        <ApproveRejectBar
          issueId={params.issueId}
          identifier={card?.identifier ?? params.issueId}
          docKey={params.docKey}
          gate={gate}
          paperclipUrl={paperclipUrl}
        />
      </div>

      <ProvenancePanel prov={prov} />
    </div>
  );
}

function Pill({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded border border-neutral-700 bg-neutral-900 text-neutral-300">
      {label}
    </span>
  );
}
