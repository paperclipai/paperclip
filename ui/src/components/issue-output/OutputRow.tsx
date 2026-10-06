import { useTranslation } from "@/i18n";
import { Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, relativeTime } from "@/lib/utils";
import { formatBytes, outputFilename, type IssueOutputItem } from "@/lib/issue-output";
import { OutputFileTile } from "./OutputFileTile";
import { Card } from "@/components/ui/card";

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
    <Card className="flex-row items-center gap-2.5 p-2">
      <OutputFileTile contentType={meta?.contentType} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground" title={filename}>
          {filename}
        </p>
        <p
          className={cn(
            "truncate text-(length:--text-micro)",
            item.degraded ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {item.degraded ? t("localizationCommonTail.fileDetailsUnavailable") : metaBits.join(" · ")}
        </p>
      </div>
      {meta ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button asChild variant="ghost" size="icon-sm" title={t("localizationCommonTail.openNewTab")}>
            <a href={meta.openPath} target="_blank" rel="noreferrer" aria-label={t("localizationCommonTail.openFile", { filename })}>
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
          <Button asChild variant="ghost" size="icon-sm" title={t("localizationCommonTail.download")}>
            <a href={meta.downloadPath} aria-label={t("localizationCommonTail.downloadFileNamed", { filename })}>
              <Download className="h-4 w-4" />
            </a>
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
