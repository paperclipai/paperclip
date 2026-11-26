import { Layers } from "lucide-react";
import type { To } from "react-router-dom";
import type { CompanyArtifactGroup } from "@/api/artifacts";
import { Link } from "@/lib/router";
import { ArtifactPreview } from "@/components/artifacts/ArtifactCard";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

interface ArtifactGroupCardProps {
  group: CompanyArtifactGroup;
  /** Destination for opening this stack (preserves active filters/search). */
  to: To;
}

/**
 * A stack card rendered in grouped mode. It mirrors the dimensions and preview
 * of {@link ArtifactCard} so grouped and flat grids share the same rhythm, and
 * layers a subtle "stack" effect behind the card only when it represents more
 * than one artifact.
 */
export function ArtifactGroupCard({ group, to }: ArtifactGroupCardProps) {
  const stacked = group.count > 1;
  const preview = group.previewArtifacts[0];
  const countLabel = `${group.count} artifact${group.count === 1 ? "" : "s"}`;

  return (
    <div className="relative">
      {stacked ? (
        <>
          <div
            aria-hidden="true"
            data-testid="artifact-stack-layer"
            className="pointer-events-none absolute inset-0 translate-x-(--sz-8px) translate-y-(--sz-8px) rounded-lg border border-border bg-muted/70"
          />
          <div
            aria-hidden="true"
            data-testid="artifact-stack-layer"
            className="pointer-events-none absolute inset-0 translate-x-(--sz-4px) translate-y-(--sz-4px) rounded-lg border border-border bg-muted/40"
          />
        </>
      ) : null}

      {/* design-allow(card-pattern): navigation <Link> card; Card renders a div and would break anchor semantics (C5a Run 3) */}
      <Link
        to={to}
        title={countLabel}
        data-testid="artifact-group-card"
        data-group-id={group.id}
        data-count={group.count}
        data-stacked={stacked ? "true" : "false"}
        className="group relative flex flex-col overflow-hidden rounded-lg border border-border bg-card cursor-pointer transition-colors hover:border-foreground/20 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="relative">
          {preview ? (
            <ArtifactPreview artifact={preview} />
          ) : (
            <div className="flex aspect-video w-full items-center justify-center bg-accent/20 text-muted-foreground/50">
              <Layers className="h-7 w-7" aria-hidden="true" />
            </div>
          )}
          <Badge variant="ghost" className="absolute right-2 top-2 bg-background/85 text-(length:--text-micro) text-foreground/90 shadow-sm backdrop-blur">
            <Layers className="h-3 w-3" aria-hidden="true" />
            {group.count}
          </Badge>
        </div>

        <div className="flex flex-1 flex-col gap-1 p-3">
          <div className="flex h-7 items-center gap-2">
            <span className="shrink-0 font-mono text-(length:--text-micro) text-muted-foreground">
              {group.issue.identifier}
            </span>
            <h3
              className="min-w-0 flex-1 truncate text-sm font-medium leading-7 text-foreground/85"
              title={group.title}
            >
              {group.title}
            </h3>
          </div>

          <div className="mt-0.5 flex items-center gap-1.5 text-(length:--text-micro) text-muted-foreground/65">
            <span>{countLabel}</span>
            <span className="text-muted-foreground/50">·</span>
            <span>Updated {formatDate(group.updatedAt)}</span>
          </div>
        </div>
      </Link>
    </div>
  );
}
