import { Play } from "lucide-react";
import type { IssueWorkProduct } from "@paperclipai/shared";
import {
  formatBytes,
  getIssueOutputs,
  isImageContentType,
  isVideoLikeOutput,
  outputFilename,
  type IssueOutputItem,
} from "@/lib/issue-output";
import { OutputPrimaryCard } from "./OutputPrimaryCard";
import { OutputRow } from "./OutputRow";
import { cn, relativeTime } from "@/lib/utils";

interface IssueOutputSectionProps {
  workProducts: IssueWorkProduct[] | null | undefined;
  /** Optional resolver for the artifact creator's display name. */
  resolveCreatorName?: (item: IssueOutputItem) => string | null;
  onMediaClick?: (item: IssueOutputItem) => void;
}

function isMediaOutput(item: IssueOutputItem) {
  const meta = item.metadata;
  return Boolean(meta && (
    isImageContentType(meta.contentType) ||
    isVideoLikeOutput(meta.contentType, meta.originalFilename)
  ));
}

function OutputMediaPreview({
  item,
  creatorName,
  onMediaClick,
}: {
  item: IssueOutputItem;
  creatorName?: string | null;
  onMediaClick?: (item: IssueOutputItem) => void;
}) {
  const meta = item.metadata;
  if (!meta) return null;

  const filename = outputFilename(item);
  const isVideo = isVideoLikeOutput(meta.contentType, meta.originalFilename);
  const metaBits = [meta.contentType, formatBytes(meta.byteSize)];
  if (creatorName) metaBits.push(creatorName);
  metaBits.push(relativeTime(item.createdAt));

  const preview = (
    <>
      {isVideo ? (
        <video
          src={meta.contentPath}
          className="h-full w-full object-cover"
          muted
          playsInline
          preload="metadata"
        />
      ) : (
        <img
          src={meta.contentPath}
          alt={filename}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      )}
      <div className="absolute inset-x-0 bottom-0 bg-black/65 px-2 py-1.5 text-left">
        <p className="truncate text-xs font-medium text-white" title={filename}>{filename}</p>
        <p className="truncate text-[10px] text-white/65">{metaBits.join(" · ")}</p>
      </div>
    </>
  );

  const className = cn(
    "group relative block aspect-square overflow-hidden rounded-md border border-border bg-accent/10",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  );

  if (onMediaClick) {
    return (
      <button
        type="button"
        className={className}
        aria-label={`Browse ${filename} in gallery`}
        onClick={() => onMediaClick(item)}
      >
        {preview}
      </button>
    );
  }

  return (
    <a
      href={meta.openPath}
      target="_blank"
      rel="noreferrer"
      className={className}
      aria-label={`Open ${filename}`}
    >
      {preview}
    </a>
  );
}

/**
 * Issue Output surface (PAP-10162 Phase 3).
 *
 * Renders attachment-backed artifact work products as first-class issue
 * outputs: a full-width primary card (video player / image / generic file) with
 * Open + Download, plus compact rows for any additional outputs. The section is
 * omitted entirely when the issue has produced no outputs — we never show a
 * permanent empty card.
 */
export function IssueOutputSection({ workProducts, resolveCreatorName, onMediaClick }: IssueOutputSectionProps) {
  const { primary, rest, count } = getIssueOutputs(workProducts);

  if (!primary) return null;

  const creatorFor = (item: IssueOutputItem) => resolveCreatorName?.(item) ?? null;
  const mediaRest = rest.filter(isMediaOutput);
  const fileRest = rest.filter((item) => !isMediaOutput(item));

  return (
    <section className="space-y-3" aria-label="Task outputs">
      <div className="flex items-center gap-2">
        <Play className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-medium text-muted-foreground">Output</h3>
        <span className="text-xs text-muted-foreground">{count}</span>
      </div>

      {/* Stable anchor target so company Artifacts cards can deep-link to a
          specific work product inside its issue context (PAP-10359). */}
      <div id={`work-product-${primary.id}`} className="scroll-mt-20">
        <OutputPrimaryCard item={primary} creatorName={creatorFor(primary)} onMediaClick={onMediaClick} />
      </div>

      {rest.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Also produced</p>
          {mediaRest.length > 0 ? (
            <div className="grid grid-cols-4 gap-2">
              {mediaRest.map((item) => (
                <div key={item.id} id={`work-product-${item.id}`} className="scroll-mt-20">
                  <OutputMediaPreview
                    item={item}
                    creatorName={creatorFor(item)}
                    onMediaClick={onMediaClick}
                  />
                </div>
              ))}
            </div>
          ) : null}
          {fileRest.map((item) => (
            <div key={item.id} id={`work-product-${item.id}`} className="scroll-mt-20">
              <OutputRow item={item} creatorName={creatorFor(item)} />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
