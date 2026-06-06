import { useState } from "react";
import { Download, ExternalLink, Paperclip, Play } from "lucide-react";
import type { CompanyArtifact } from "@/api/artifacts";
import { Link } from "@/lib/router";
import { cn, formatDate } from "@/lib/utils";

interface ArtifactCardProps {
  artifact: CompanyArtifact;
}

/**
 * Stable, fixed-height preview region shared by every card variant. The fixed
 * aspect ratio is what keeps image / video / text / placeholder cards from
 * shifting layout as previews load (or fail to load).
 */
function PreviewFrame({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("relative aspect-video w-full overflow-hidden bg-accent/20", className)}>
      {children}
    </div>
  );
}

function PlaceholderPreview({ label }: { label?: string }) {
  return (
    <PreviewFrame className="flex items-center justify-center">
      <div className="flex flex-col items-center gap-1.5 text-muted-foreground/50">
        <Paperclip className="h-7 w-7" aria-hidden="true" />
        {label ? <span className="text-[11px] font-medium uppercase tracking-wide">{label}</span> : null}
      </div>
    </PreviewFrame>
  );
}

function ImagePreview({ artifact }: { artifact: CompanyArtifact }) {
  const [errored, setErrored] = useState(false);
  if (errored || !artifact.contentPath) {
    return <PlaceholderPreview label="Image" />;
  }
  return (
    <PreviewFrame>
      <img
        src={artifact.contentPath}
        alt={artifact.title}
        loading="lazy"
        className="h-full w-full object-cover"
        onError={() => setErrored(true)}
      />
    </PreviewFrame>
  );
}

function VideoPreview({ artifact }: { artifact: CompanyArtifact }) {
  const [errored, setErrored] = useState(false);
  if (errored || !artifact.contentPath) {
    return (
      <PreviewFrame className="flex items-center justify-center bg-black/80">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white/15">
          <Play className="h-5 w-5 translate-x-0.5 text-white" aria-hidden="true" />
        </div>
      </PreviewFrame>
    );
  }
  return (
    <PreviewFrame className="bg-black">
      <video
        src={artifact.contentPath}
        preload="metadata"
        muted
        playsInline
        className="h-full w-full object-contain"
        onError={() => setErrored(true)}
      />
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-black/55">
          <Play className="h-5 w-5 translate-x-0.5 text-white" aria-hidden="true" />
        </div>
      </div>
    </PreviewFrame>
  );
}

function TextPreview({ artifact }: { artifact: CompanyArtifact }) {
  const preview = artifact.previewText?.trim();
  if (!preview) {
    return <PlaceholderPreview label={artifact.source === "document" ? "Document" : "Text"} />;
  }
  return (
    <PreviewFrame className="bg-card">
      <div className="absolute inset-0 overflow-hidden p-3">
        <p className="max-h-full overflow-hidden whitespace-pre-wrap break-words text-base leading-6 text-muted-foreground/75">
          {preview}
        </p>
      </div>
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-card to-transparent" />
    </PreviewFrame>
  );
}

function ArtifactPreview({ artifact }: { artifact: CompanyArtifact }) {
  switch (artifact.mediaKind) {
    case "image":
      return <ImagePreview artifact={artifact} />;
    case "video":
      return <VideoPreview artifact={artifact} />;
    case "text":
    case "document":
      return <TextPreview artifact={artifact} />;
    case "file":
      return <PlaceholderPreview label="File" />;
    case "empty":
    default:
      return <PlaceholderPreview />;
  }
}

function SecondaryAction({
  href,
  download,
  title,
  children,
}: {
  href: string;
  download?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      {...(download ? { download: "" } : { target: "_blank", rel: "noreferrer" })}
      title={title}
      aria-label={title}
      onClick={(event) => event.stopPropagation()}
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </a>
  );
}

export function ArtifactCard({ artifact }: ArtifactCardProps) {
  return (
    <Link
      to={artifact.href}
      disableIssueQuicklook
      data-testid="artifact-card"
      data-media-kind={artifact.mediaKind}
      className="group flex flex-col overflow-hidden rounded-[8px] border border-border bg-card transition-colors hover:border-foreground/20"
    >
      <ArtifactPreview artifact={artifact} />

      <div className="flex flex-1 flex-col gap-1 p-3">
        <div className="flex h-7 items-start justify-between gap-2">
          <h3
            className="min-w-0 flex-1 truncate text-sm font-medium leading-7 text-foreground/85"
            title={artifact.title}
          >
            {artifact.title}
          </h3>
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            {artifact.openPath ? (
              <SecondaryAction href={artifact.openPath} title="Open file in new tab">
                <ExternalLink className="h-3.5 w-3.5" />
              </SecondaryAction>
            ) : null}
            {artifact.downloadPath ? (
              <SecondaryAction href={artifact.downloadPath} download title="Download file">
                <Download className="h-3.5 w-3.5" />
              </SecondaryAction>
            ) : null}
          </div>
        </div>

        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground/65">
          <span>Last edited {formatDate(artifact.updatedAt)}</span>
          {artifact.createdByAgent ? (
            <>
              <span className="text-muted-foreground/50">·</span>
              <span className="truncate">{artifact.createdByAgent.name}</span>
            </>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
