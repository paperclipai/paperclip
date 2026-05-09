import Link from "next/link";
import { headers } from "next/headers";
import MarkdownView from "@/app/components/MarkdownView";
import WorkspacePathBanner from "@/app/components/WorkspacePathBanner";
import { toCard, type RawIssue } from "@/lib/queue";
import { detectKind, type IssueDocument } from "@/lib/asset-type";
import { hasWorkspacePaths } from "@/lib/workspace-paths";

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

const KIND_ICON: Record<string, string> = {
  video: "▶",
  image: "🖼",
  pdf: "📄",
  html: "🌐",
  markdown: "📝",
  text: "📃",
  unknown: "•",
};

export default async function AssetIssue({
  params,
}: {
  params: { issueId: string };
}) {
  const [issue, docs] = await Promise.all([
    fetchIssue(params.issueId),
    fetchDocs(params.issueId),
  ]);
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
  const card = toCard(issue);
  const showWorkspaceBanner =
    docs.length === 0 && hasWorkspacePaths(issue.description);
  return (
    <div>
      <Link
        href="/"
        className="text-xs text-neutral-500 hover:text-neutral-300 inline-block mb-4"
      >
        ← Back to queue
      </Link>
      {showWorkspaceBanner ? (
        <WorkspacePathBanner issueId={params.issueId} />
      ) : null}
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h2 className="text-lg font-semibold text-white">{card.cleanTitle}</h2>
        <span className="text-xs font-mono text-neutral-500">{card.identifier}</span>
      </div>
      <div className="mb-6 flex flex-wrap gap-2 text-[11px]">
        <Pill label={card.platform} />
        <Pill label={card.statusLabel} />
        {card.postDate ? <Pill label={`Post: ${card.postDate}`} /> : null}
        <Pill label={`Author: ${card.author}`} />
      </div>

      {docs.length > 0 ? (
        <section className="mb-6">
          <h3 className="text-xs uppercase tracking-wide text-neutral-500 mb-2">
            Documents ({docs.length})
          </h3>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {docs.map((d) => {
              const kind = detectKind(d);
              const icon = KIND_ICON[kind] ?? "•";
              return (
                <li key={d.id}>
                  <Link
                    href={`/asset/${params.issueId}/${encodeURIComponent(d.key)}`}
                    className="flex items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/40 hover:bg-neutral-900 hover:border-neutral-700 px-3 py-2"
                  >
                    <span className="text-lg leading-none w-6 text-center text-neutral-400">
                      {icon}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-neutral-100 truncate">
                        {d.title || d.key}
                      </span>
                      <span className="block text-[11px] font-mono text-neutral-500 truncate">
                        {d.key} · {kind}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <p className="text-xs text-neutral-500 mb-6">
          No IssueDocuments attached. Falling back to issue description.
        </p>
      )}

      <section>
        <h3 className="text-xs uppercase tracking-wide text-neutral-500 mb-2">
          Issue description
        </h3>
        <MarkdownView source={issue.description ?? "*(no description)*"} />
      </section>
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
