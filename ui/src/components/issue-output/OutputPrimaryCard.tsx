import { Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn, relativeTime } from "@/lib/utils";
import {
  formatBytes,
  isImageContentType,
  isVideoContentType,
  outputFilename,
  type IssueOutputItem,
} from "@/lib/issue-output";
import { OutputVideoPlayer } from "./OutputVideoPlayer";
import { OutputFileTile } from "./OutputFileTile";

interface OutputPrimaryCardProps {
  item: IssueOutputItem;
  creatorName?: string | null;
}

/**
 * Full-width primary output card: media region (video / image / generic file)
 * over a metadata strip with Open + Download actions. The layout stacks on
 * mobile and uses a single horizontal meta row on desktop.
 */
export function OutputPrimaryCard({ item, creatorName }: OutputPrimaryCardProps) {
  const meta = item.metadata;
  const filename = outputFilename(item);
  const contentType = meta?.contentType;

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      {/* Media region */}
      {meta && isVideoContentType(contentType) ? (
        <OutputVideoPlayer src={meta.contentPath} title={filename} />
      ) : meta && isImageContentType(contentType) ? (
        <a
          href={meta.openPath}
          target="_blank"
          rel="noreferrer"
          className="block aspect-video w-full overflow-hidden bg-black"
          aria-label={`Open ${filename}`}
        >
          <img src={meta.contentPath} alt={filename} className="h-full w-full object-contain" />
        </a>
      ) : (
        <div className="flex aspect-video w-full items-center justify-center bg-muted/30">
          <OutputFileTile contentType={contentType} sizeClassName="h-16 w-16 text-base" />
        </div>
      )}

      {/* Metadata strip */}
      <div className="flex flex-col gap-2 p-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-semibold text-foreground">{filename}</p>
          {item.degraded ? (
            <p className="mt-0.5 text-[11px] text-destructive">
              Output metadata is unavailable — this file can’t be played or downloaded here.
            </p>
          ) : (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
              {item.isPrimary && (
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                  Primary
                </Badge>
              )}
              {meta && <span>{meta.contentType}</span>}
              {meta && <span aria-hidden="true">·</span>}
              {meta && <span>{formatBytes(meta.byteSize)}</span>}
              {creatorName && <span aria-hidden="true">·</span>}
              {creatorName && <span>{creatorName}</span>}
              <span aria-hidden="true">·</span>
              <span>{relativeTime(item.createdAt)}</span>
            </div>
          )}
        </div>

        {meta ? (
          <div className={cn("flex shrink-0 items-center gap-2", "max-md:w-full")}>
            <Button asChild variant="outline" size="sm" className="max-md:flex-1">
              <a href={meta.openPath} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" />
                Open
              </a>
            </Button>
            <Button asChild size="sm" className="max-md:flex-1">
              <a href={meta.downloadPath} aria-label={`Download ${filename}`}>
                <Download className="h-4 w-4" />
                Download
              </a>
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
