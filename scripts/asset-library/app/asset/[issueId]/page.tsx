import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { titleSlug, type RawIssue } from "@/lib/queue";
import {
  type IssueDocument,
  evaluateIssueApprovalGate,
} from "@/lib/asset-type";
import AssetIssueSummaryView from "@/app/components/AssetIssueSummaryView";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  // Use the detail proxy — list endpoint truncates description at ~1200 chars.
  const detail = await fetchJson<RawIssue>(
    `/api/issues/${encodeURIComponent(issueId)}`,
  );
  if (detail) return detail;
  // Fallback to list (e.g. proxy unreachable) — accept truncation over 404.
  const list = await fetchJson<RawIssue[]>("/api/issues");
  if (!list) return null;
  return (
    list.find((i) => i.id === issueId || i.identifier === issueId) ?? null
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

export default async function AssetIssue({
  params,
}: {
  params: { issueId: string };
}) {
  const [issue, docs, comments] = await Promise.all([
    fetchIssue(params.issueId),
    fetchDocs(params.issueId),
    fetchComments(params.issueId),
  ]);

  // UUID back-compat: 307 redirect to identifier/slug URL
  if (issue && UUID_RE.test(params.issueId)) {
    const slug = titleSlug(issue.title);
    redirect(`/asset/${issue.identifier}${slug ? `/${slug}` : ""}`);
  }

  if (!issue) {
    return (
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-6">
        <p className="text-sm text-neutral-400">
          Issue <code>{params.issueId}</code> not found in the
          [review-and-ship] queue.
        </p>
        <Link href="/" className="text-sm text-sky-400 underline mt-3 inline-block">
          ← Back to queue
        </Link>
      </div>
    );
  }

  const gate = evaluateIssueApprovalGate(docs, comments);
  const paperclipUrl = paperclipIssueUrl(issue.identifier);

  return (
    <AssetIssueSummaryView
      issueId={issue.identifier}
      issue={issue}
      docs={docs}
      gate={gate}
      paperclipUrl={paperclipUrl}
    />
  );
}
