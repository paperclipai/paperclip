import { FileText, Image, Link as LinkIcon, Package, Trash2, ExternalLink, ChevronRight } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import type { Artifact } from "../api/artifacts";

const kindIcons: Record<string, typeof FileText> = {
  attachment: FileText,
  image: Image,
  link: LinkIcon,
  package: Package,
};

const KIND_COLORS: Record<string, string> = {
  attachment: "bg-[var(--primary)]/15 text-[var(--primary)]",
  image: "bg-[var(--primary)]/15 text-[var(--primary)]",
  link: "bg-[var(--status-active)]/15 text-[var(--status-active)]",
  package: "bg-[var(--status-warning)]/15 text-[var(--status-warning)]",
};

function formatBytes(bytes: number | null): string {
  if (bytes == null || bytes === 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface ArtifactCardProps {
  artifact: Artifact;
  onDelete?: (id: string) => void;
}

export function ArtifactCard({ artifact, onDelete }: ArtifactCardProps) {
  const Icon = kindIcons[artifact.kind] ?? FileText;
  const sizeLabel = formatBytes(artifact.sizeBytes);

  return (
    <Link
      to={`/artifacts/${artifact.id}`}
      className={cn(
        "group flex items-start gap-3 rounded-[2px] border border-border bg-card p-4",
        "transition-all duration-200 hover:border-primary/30 hover:shadow-md hover:shadow-primary/5 hover:-translate-y-[1px]",
      )}
    >
      <div className={cn("rounded-[2px] p-2 shrink-0", KIND_COLORS[artifact.kind] ?? KIND_COLORS.attachment)}>
        <Icon className="h-5 w-5" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-[var(--font-display)] uppercase tracking-[0.06em] truncate group-hover:text-primary transition-colors">{artifact.title}</h3>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
          <span
            className={cn(
              "inline-flex items-center rounded-[2px] px-2 py-0.5 text-[9px] font-[var(--font-mono)] font-medium uppercase shrink-0",
              artifact.status === "active"
                ? "bg-[var(--status-active)]/15 text-[var(--status-active)]"
                : "bg-muted text-muted-foreground",
            )}
          >
            {artifact.status}
          </span>
        </div>

        {artifact.description && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
            {artifact.description}
          </p>
        )}

        <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
          <span className="capitalize">{artifact.kind}</span>
          {artifact.mimeType && <span>{artifact.mimeType}</span>}
          {sizeLabel && <span>{sizeLabel}</span>}
          {artifact.filePath && <span className="truncate max-w-[150px]">{artifact.filePath}</span>}
          <span>{new Date(artifact.createdAt).toLocaleDateString()}</span>
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.preventDefault()}>
        {artifact.url && (
          <Button
            variant="ghost"
            size="icon-sm"
            asChild
          >
            <a href={artifact.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        )}
        {onDelete && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); onDelete(artifact.id); }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </Link>
  );
}
