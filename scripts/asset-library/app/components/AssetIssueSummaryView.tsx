import Link from "next/link";
import MarkdownView from "@/app/components/MarkdownView";
import WorkspacePathBanner from "@/app/components/WorkspacePathBanner";
import IssueApproveBar from "@/app/components/IssueApproveBar";
import { toCard, type RawIssue } from "@/lib/queue";
import { detectKind, type IssueDocument, type IssueApprovalGate } from "@/lib/asset-type";
import { hasWorkspacePaths } from "@/lib/workspace-paths";

const KIND_ICON: Record<string, string> = {
  video: "▶",
  image: "🖼",
  pdf: "📄",
  html: "🌐",
  markdown: "📝",
  text: "📃",
  unknown: "•",
};

function Pill({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded border border-neutral-700 bg-neutral-900 text-neutral-300">
      {label}
    </span>
  );
}

export default function AssetIssueSummaryView({
  issueId,
  issue,
  docs,
  gate,
  paperclipUrl,
}: {
  issueId: string;
  issue: RawIssue;
  docs: IssueDocument[];
  gate: IssueApprovalGate;
  paperclipUrl: string | null;
}) {
  const card = toCard(issue);
  const showWorkspaceBanner = docs.length === 0 && hasWorkspacePaths(issue.description);
  return (
    <div>
      <Link
        href="/"
        className="text-xs text-neutral-500 hover:text-neutral-300 inline-block mb-4"
      >
        ← Back to queue
      </Link>
      {showWorkspaceBanner ? (
        <WorkspacePathBanner issueId={issueId} />
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
                    href={`/asset/${issueId}/${encodeURIComponent(d.key)}`}
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

      <IssueApproveBar
        issueId={issueId}
        identifier={card.identifier}
        gate={gate}
        paperclipUrl={paperclipUrl}
      />
    </div>
  );
}
