import { CircleDot, ExternalLink, FolderGit2, GitBranch } from "lucide-react";
import { Link } from "@/lib/router";
import type { WorkReference } from "../lib/pipeline-references";

/**
 * Renders a case's typed work references — workspace folders, external URLs,
 * linked issues — as real links/chips on the case detail panel.
 */
export function PipelineWorkReferences({ references }: { references: WorkReference[] }) {
  if (references.length === 0) {
    return <p className="py-3 text-sm text-muted-foreground">No linked work yet.</p>;
  }
  return (
    <ul className="space-y-2">
      {references.map((reference) => (
        <li key={`${reference.kind}-${reference.id}`}>
          <WorkReferenceRow reference={reference} />
        </li>
      ))}
    </ul>
  );
}

function WorkReferenceRow({ reference }: { reference: WorkReference }) {
  if (reference.kind === "url") {
    return (
      <a
        href={reference.url}
        target="_blank"
        rel="noreferrer"
        className="group flex items-start gap-2 text-sm text-foreground"
      >
        <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          <span className="font-medium underline-offset-2 group-hover:underline">{reference.label}</span>
          <span className="block truncate text-xs text-muted-foreground">{reference.url}</span>
        </span>
      </a>
    );
  }

  if (reference.kind === "issue") {
    const inner = (
      <>
        <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          <span className="font-medium underline-offset-2 group-hover:underline">{reference.label}</span>
          {reference.identifier ? (
            <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
              {reference.identifier}
            </span>
          ) : null}
        </span>
      </>
    );
    return reference.issueId ? (
      <Link to={`/issues/${reference.issueId}`} className="group flex items-start gap-2 text-sm text-foreground">
        {inner}
      </Link>
    ) : (
      <span className="flex items-start gap-2 text-sm text-foreground">{inner}</span>
    );
  }

  // workspace
  return (
    <div className="flex items-start gap-2 text-sm text-foreground">
      <FolderGit2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0">
        <span className="block text-xs text-muted-foreground">Folder</span>
        <span className="font-normal">{reference.label}</span>
        {reference.path ? (
          <span className="block truncate font-mono text-xs text-muted-foreground">{reference.path}</span>
        ) : null}
        {reference.branch ? (
          <span className="mt-0.5 inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            <GitBranch className="h-3 w-3" />
            {reference.branch}
          </span>
        ) : null}
      </span>
    </div>
  );
}
