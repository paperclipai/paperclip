import { Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { cn, relativeTime } from "@/lib/utils";
import { formatBytes, outputFilename, type IssueOutputItem } from "@/lib/issue-output";
import { OutputFileTile } from "./OutputFileTile";

interface OutputRowProps {
  item: IssueOutputItem;
  creatorName?: string | null;
}

/** Compact row for a non-primary output ("ALSO PRODUCED"). */
export function OutputRow({ item, creatorName }: OutputRowProps) {
  const { t } = useTranslation();
  const filename = outputFilename(item);
  const meta = item.metadata;

  const metaBits: string[] = [];
  if (meta) {
    metaBits.push(meta.contentType);
    metaBits.push(formatBytes(meta.byteSize));
  }
  if (creatorName) metaBits.push(creatorName);
  metaBits.push(relativeTime(item.createdAt));

  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border bg-card p-2">
      <OutputFileTile contentType={meta?.contentType} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground" title={filename}>
          {filename}
        </p>
        <p
          className={cn(
            "truncate text-[11px]",
            item.degraded ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {item.degraded
            ? t("components.outputRow.fileDetailsUnavailable", {
                defaultValue: "File details unavailable",
              })
            : metaBits.join(" · ")}
        </p>
      </div>
      {meta ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            title={t("components.outputRow.openInNewTab", { defaultValue: "Open in new tab" })}
          >
            <a
              href={meta.openPath}
              target="_blank"
              rel="noreferrer"
              aria-label={t("components.outputRow.openFile", {
                filename,
                defaultValue: "Open {{filename}}",
              })}
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            title={t("components.outputRow.download", { defaultValue: "Download" })}
          >
            <a
              href={meta.downloadPath}
              aria-label={t("components.outputRow.downloadFile", {
                filename,
                defaultValue: "Download {{filename}}",
              })}
            >
              <Download className="h-4 w-4" />
            </a>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
