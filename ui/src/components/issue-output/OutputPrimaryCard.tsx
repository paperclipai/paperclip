import { Download, ExternalLink, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn, relativeTime } from "@/lib/utils";
import {
  formatBytes,
  isImageContentType,
  isVideoLikeOutput,
  outputFilename,
  type IssueOutputItem,
} from "@/lib/issue-output";
import { OutputVideoPlayer } from "./OutputVideoPlayer";
import { OutputFileTile } from "./OutputFileTile";
import { Card } from "@/components/ui/card";

interface OutputPrimaryCardProps {
  item: IssueOutputItem;
  creatorName?: string | null;
  onMediaClick?: (item: IssueOutputItem) => void;
}

/**
 * Full-width primary output card: media region (video / image / generic file)
 * over a metadata strip with Open + Download actions. The layout stacks on
 * mobile and uses a single horizontal meta row on desktop.
 */
export function OutputPrimaryCard({ item, creatorName, onMediaClick }: OutputPrimaryCardProps) {
  const meta = item.metadata;
  const filename = outputFilename(item);
  const contentType = meta?.contentType;
  const isMedia = Boolean(meta && (
    isImageContentType(contentType) ||
    isVideoLikeOutput(contentType, meta.originalFilename)
  ));
  const isVideo = Boolean(meta && isVideoLikeOutput(contentType, meta.originalFilename));

  return (
    <Card className="block overflow-hidden py-0">
      {/* Media region */}
      {isVideo && meta ? (
        <OutputVideoPlayer src={meta.contentPath} title={filename} />
      ) : meta && isImageContentType(contentType) ? (
        onMediaClick ? (
          <button
            type="button"
            className="block aspect-video w-full overflow-hidden bg-black"
            aria-label={`Browse ${filename} in gallery`}
            onClick={() => onMediaClick(item)}
          >
            <img src={meta.contentPath} alt={filename} className="h-full w-full object-contain" />
          </button>
        ) : (
          <a
            href={meta.openPath}
            target="_blank"
            rel="noreferrer"
            className="block aspect-video w-full overflow-hidden bg-black"
            aria-label={`Open ${filename}`}
          >
            <img src={meta.contentPath} alt={filename} className="h-full w-full object-contain" />
          </a>
        )
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
            <p className="mt-0.5 text-(length:--text-micro) text-destructive">
              Output metadata is unavailable — this file can’t be played or downloaded here.
            </p>
          ) : (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-(length:--text-micro) text-muted-foreground">
              {item.isPrimary && (
                <Badge variant="secondary" className="px-1.5 py-0 text-(length:--text-nano)">
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
            {isMedia && onMediaClick ? (
              <Button
                variant="outline"
                size="sm"
                className="max-md:flex-1"
                onClick={() => onMediaClick(item)}
              >
                <Maximize2 className="h-4 w-4" />
                Browse
              </Button>
            ) : null}
            {!isMedia || !onMediaClick || isVideo ? (
              <Button asChild variant="outline" size="sm" className="max-md:flex-1">
                <a href={meta.openPath} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  Open
                </a>
              </Button>
            ) : null}
            <Button asChild size="sm" className="max-md:flex-1">
              <a href={meta.downloadPath} aria-label={`Download ${filename}`}>
                <Download className="h-4 w-4" />
                Download
              </a>
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
