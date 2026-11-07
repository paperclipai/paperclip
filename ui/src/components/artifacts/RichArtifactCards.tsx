import { t, useTranslation, Trans } from "@/i18n";
import { isPatchFile } from "@/lib/patch";
import { PatchLines } from "@/components/PatchLines";
import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import {
  ArrowRight,
  CircleCheck,
  CircleHelp,
  Clock,
  ExternalLink,
  File,
  FileText,
  Film,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Globe,
  Image as ImageIcon,
  Table2,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { artifactPreviewUrl, artifactUrl } from "@/lib/artifact-card-data";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

// Renderers contain UI labels only. All artifact-specific content is passed in.
// Example values live exclusively in the individual stories' args.
export interface ArtifactIdentity {
  title: string;
  summary: string;
  author: string;
  updatedAt: string;
  statusBadge?: ReactNode;
}

function Identity({
  title,
  summary,
}: Pick<ArtifactIdentity, "title" | "summary">) {
  useTranslation("task-components");
  return (
    <div className="flex flex-col gap-2">
      <h2 className="break-words text-lg font-semibold leading-snug">
        {title}
      </h2>
      {summary && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
          {summary}
        </p>
      )}
    </div>
  );
}

function Footer({
  author,
  updatedAt,
  action,
  statusBadge,
}: Pick<ArtifactIdentity, "author" | "updatedAt" | "statusBadge"> & {
  action: ReactNode;
}) {
  useTranslation("task-components");
  return (
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
      <span className="text-xs text-muted-foreground">
        {[author, updatedAt].filter(Boolean).join(" · ")}
      </span>
      {statusBadge}
      {action}
    </footer>
  );
}

function Card({ children }: { children: ReactNode }) {
  useTranslation("task-components");
  return (
    <article className="w-full min-w-0 overflow-hidden rounded-lg border border-border bg-card text-card-foreground">
      {children}
    </article>
  );
}

function SourceLink({ url, children }: { url: string; children: ReactNode }) {
  useTranslation("task-components");
  return url ? (
    <Button variant="outline" size="sm" asChild>
      <a href={url} target="_blank" rel="noreferrer">
        {children}
        <ExternalLink className="size-3" />
      </a>
    </Button>
  ) : (
    <Button variant="outline" size="sm" disabled>
      {children}
    </Button>
  );
}

function Viewer({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action: string;
  children: ReactNode;
}) {
  useTranslation("task-components");
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          {action}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-dvh overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="pr-6">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

interface DiffProps {
  additions?: number | null;
  deletions?: number | null;
  filesChanged?: number | null;
}
function Diff({ additions, deletions, filesChanged }: DiffProps) {
  useTranslation("task-components");
  return (
    <div className="flex flex-wrap gap-2 font-mono text-xs">
      {additions != null && (
        <span className="text-(--status-task-icon-done)">
          +{additions.toLocaleString("en-US")}
        </span>
      )}
      {deletions != null && (
        <span className="text-(--status-task-icon-blocked)">
          −{deletions.toLocaleString("en-US")}
        </span>
      )}
      {filesChanged != null && (
        <span className="text-muted-foreground">
          {filesChanged} {filesChanged === 1 ? t("task-components:file_3b9c358f") : t("task-components:files_3d7db37d")}
        </span>
      )}
    </div>
  );
}

export interface PullRequestCardProps extends ArtifactIdentity, DiffProps {
  number?: number | null;
  repository: string;
  sourceBranch: string;
  targetBranch: string;
  state: "open" | "draft" | "merged" | "closed" | "unknown";
  checks: "passed" | "pending" | "failed" | "unknown";
  evidenceSource: string;
  reviewSummary: string;
  url: string;
}

const checksLabel = {
  get passed() { return t("final-components-a:checksPassed_b63c39d9"); },
  get pending() { return t("final-components-a:checksPending_88c45075"); },
  get failed() { return t("final-components-a:checksFailed_69ea579f"); },
  get unknown() { return t("final-components-a:checksNotAvailable_f335a89f"); },
};
const stateLabel = {
  get open() { return t("final-components-a:open_ed077f3d"); },
  get draft() { return t("final-components-a:draft_ebf12ef4"); },
  get merged() { return t("final-components-a:merged_bd0a0620"); },
  get closed() { return t("final-components-a:closed_c21ead06"); },
  get unknown() { return t("final-components-a:stateUnknown_5fcbf73a"); },
};

export function PullRequestCard(props: PullRequestCardProps) {
  useTranslation("task-components");
  const {
    number,
    repository,
    sourceBranch,
    targetBranch,
    state,
    checks,
    evidenceSource,
    reviewSummary,
    url,
  } = props;
  const CheckIcon = {
    passed: CircleCheck,
    pending: Clock,
    failed: TriangleAlert,
    unknown: CircleHelp,
  }[checks];
  const checkTone = {
    passed: "text-(--status-task-icon-done)",
    pending: "text-muted-foreground",
    failed: "text-(--status-task-icon-blocked)",
    unknown: "text-muted-foreground",
  }[checks];
  return (
    <Card>
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <GitPullRequest className="size-4" />{t("task-components:pullRequest_f3dba662")}{" "}
            {number != null && <span className="font-mono">#{number}</span>}
          </span>
          <Badge
            variant="outline"
            className={
              state === "merged"
                ? "text-(--status-task-icon-done)"
                : "text-muted-foreground"
            }
          >
            {state === "merged" && <GitMerge className="size-3" />}
            {stateLabel[state]}
          </Badge>
        </div>
        <Identity {...props} />
        <div className="flex flex-col gap-2 text-xs text-muted-foreground">
          <span>{repository}</span>
          {(sourceBranch || targetBranch) && (
            <div className="flex min-w-0 items-center gap-2">
              <GitBranch className="size-3.5 shrink-0" />
              <code className="min-w-0 truncate" title={sourceBranch}>
                {sourceBranch}
              </code>
              {sourceBranch && targetBranch && (
                <ArrowRight className="size-3.5 shrink-0" />
              )}
              <code className="min-w-0 truncate" title={targetBranch}>
                {targetBranch}
              </code>
            </div>
          )}
        </div>
        <Diff {...props} />
      </div>
      <div className="flex flex-col gap-2 border-t border-border px-5 py-4">
        <span className="flex items-center gap-2 text-xs">
          <CheckIcon className={`size-4 ${checkTone}`} />
          {checksLabel[checks]}
        </span>
        {reviewSummary && (
          <p className="text-xs leading-relaxed">{reviewSummary}</p>
        )}
        {evidenceSource && (
          <p className="text-xs text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_ec566e42334d" components={{ part1: <>{evidenceSource}</> }} /></p>
        )}
      </div>
      <Footer
        {...props}
        action={<SourceLink url={url}>{t("task-components:openPullRequest_43999652")}</SourceLink>}
      />
    </Card>
  );
}

export interface CommitCardProps extends ArtifactIdentity, DiffProps {
  sha: string;
  repository: string;
  branch: string;
  url: string;
}
export function CommitCard(props: CommitCardProps) {
  useTranslation("task-components");
  return (
    <Card>
      <div className="flex flex-col gap-4 p-5">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <GitCommitHorizontal className="size-4" />{" "}{t("task-components:commit_82a9c46f")}{" "}
          <code title={props.sha}>{props.sha.slice(0, 8)}</code>
        </span>
        <Identity {...props} />
        <span className="break-words text-xs text-muted-foreground">
          {props.repository}
        </span>
        {props.branch && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <GitBranch className="size-3.5" />
            <code className="min-w-0 truncate">{props.branch}</code>
          </span>
        )}
        <Diff {...props} />
      </div>
      <Footer
        {...props}
        action={<SourceLink url={props.url}>{t("task-components:viewCommit_83b2eddb")}</SourceLink>}
      />
    </Card>
  );
}

function Markdown({ body, preview = false }: { body: string; preview?: boolean }) {
  useTranslation("task-components");
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed">
      <ReactMarkdown
        components={{
          pre: ({ children }) => <pre className={preview
            ? "paperclip-patch-preview min-w-0 max-w-full overflow-hidden whitespace-pre font-mono text-xs"
            : "min-w-0 max-w-full overflow-x-auto whitespace-pre-wrap wrap-anywhere font-mono text-xs"}>{children}</pre>,
          code: ({ className, children }) => <code className={className}>{/\blanguage-(diff|patch)\b/i.test(className ?? "")
            ? <PatchLines text={String(children)} /> : children}</code>,
          h1: ({ children }) => (
            <h3 className="text-lg font-semibold">{children}</h3>
          ),
          h2: ({ children }) => (
            <h3 className="text-base font-semibold">{children}</h3>
          ),
          h3: ({ children }) => (
            <h4 className="text-sm font-semibold">{children}</h4>
          ),
          ul: ({ children }) => (
            <ul className="list-disc space-y-1 pl-5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal space-y-1 pl-5">{children}</ol>
          ),
          img: ({ src, alt }) => {
            const localPreview = artifactPreviewUrl(
              typeof src === "string" ? src : "",
            );
            if (localPreview)
              return (
                <img
                  src={localPreview}
                  alt={alt ?? ""}
                  loading="lazy"
                  className="h-auto max-w-full"
                />
              );
            const href = artifactUrl(typeof src === "string" ? src : "");
            return href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4"
              >
                {alt || t("task-components:openImage_1b5fe596")}
              </a>
            ) : (
              <span>{alt}</span>
            );
          },
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4"
            >
              {children}
            </a>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

export interface DocumentCardProps extends ArtifactIdentity {
  patch?: boolean;
  filename: string;
  revision?: number | null;
  body: string;
  onOpen?: () => void;
  expanded?: boolean;
  actions?: ReactNode;
}
export function DocumentCard(props: DocumentCardProps) {
  useTranslation("task-components");
  const patch = props.patch ?? isPatchFile(props.filename);
  const content = (body: string, preview = false) => patch
    ? <pre className={preview
      ? "paperclip-patch-preview m-0 min-w-0 overflow-hidden whitespace-pre font-mono text-xs leading-5"
      : "m-0 min-w-0 whitespace-pre-wrap wrap-anywhere font-mono text-xs leading-5"}><code><PatchLines text={body} /></code></pre>
    : <Markdown body={body} preview={preview} />;
  return (
    <Card>
      {props.body && (
        <div
          className="max-h-52 overflow-hidden border-b border-border bg-muted/20 p-5"
          inert
        >
          {content(props.body.slice(0, 4000), true)}
        </div>
      )}
      <div className="flex flex-col gap-3 p-5">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <FileText className="size-4" /> {patch ? t("task-components:patchDocument") : "Markdown"}
          {props.revision != null && t("final-components-a:revisionRevision_2e30c066", { revision: props.revision })}
        </span>
        <Identity {...props} />
        <span className="break-all font-mono text-xs text-muted-foreground">
          {props.filename}
        </span>
      </div>
      <Footer
        {...props}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {props.actions}
            {props.onOpen ? (
              <Button
                size="sm"
                variant="outline"
                aria-expanded={props.expanded}
                onClick={props.onOpen}
              >
                {props.expanded ? t("task-components:closeDocument_9e0dfdc1") : t("task-components:readDocument_a6be85ca")}
              </Button>
            ) : (
              <Viewer
                title={props.title}
                description={props.filename}
                action={t("final-components-a:readDocument_a6be85ca")}
              >
                {content(props.body)}
              </Viewer>
            )}
          </div>
        }
      />
    </Card>
  );
}

export interface DataCardProps extends ArtifactIdentity {
  filename: string;
  columns: string[];
  rows: (string | number)[][];
  truncated?: boolean;
  downloadUrl?: string;
  actions?: ReactNode;
}
function DataTable({ columns, rows }: Pick<DataCardProps, "columns" | "rows">) {
  useTranslation("task-components");
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr>
            {columns.map((column, i) => (
              <th
                key={i}
                className="border-b border-border px-3 py-3 font-medium text-muted-foreground"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((_, j) => (
                <td key={j} className="border-b border-border/50 px-3 py-3">
                  {row[j] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && (
        <p className="p-4 text-xs text-muted-foreground">{t("task-components:noRows_1a715b4b")}</p>
      )}
    </div>
  );
}
export function DataCard(props: DataCardProps) {
  useTranslation("task-components");
  const csv = [props.columns, ...props.rows]
    .map((row) =>
      row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","),
    )
    .join("\n");
  return (
    <Card>
      <div className="border-b border-border bg-muted/20 px-2">
        <DataTable columns={props.columns} rows={props.rows.slice(0, 3)} />
      </div>
      <div className="flex flex-col gap-3 p-5">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Table2 className="size-4" /> {t(`final-components-a:csv_${props.truncated ? "first" : "all"}_${props.rows.length === 1 ? "row" : "rows"}_${props.columns.length === 1 ? "column" : "columns"}`, { rows: props.rows.length, columns: props.columns.length })}
        </span>
        <Identity {...props} />
        <span className="break-all font-mono text-xs text-muted-foreground">
          {props.filename}
        </span>
      </div>
      <Footer
        {...props}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {props.actions}
            <Viewer
              title={props.title}
              description={props.filename}
              action={t("final-components-a:viewData_249495a1")}
            >
              <DataTable {...props} />
              <Button asChild variant="outline" size="sm" className="w-fit">
                <a
                  download={props.filename}
                  href={
                    props.downloadUrl ||
                    `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`
                  }
                >{t("task-components:downloadCsv_a4023b89")}</a>
              </Button>
            </Viewer>
          </div>
        }
      />
    </Card>
  );
}

function ImageContent({ src, alt }: { src: string; alt: string }) {
  useTranslation("task-components");
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return src && failedUrl !== src ? (
    <img
      src={src}
      alt={alt}
      onError={() => setFailedUrl(src)}
      loading="lazy"
      className="aspect-video w-full object-contain"
    />
  ) : (
    <div className="flex aspect-video flex-col items-center justify-center gap-3 text-muted-foreground">
      <ImageIcon className="size-8" />
      <span className="text-xs">{t("task-components:noPreviewAvailable_e5c083cf")}</span>
    </div>
  );
}

export interface ImageCardProps extends ArtifactIdentity {
  filename: string;
  imageUrl: string;
  alt: string;
  width?: number | null;
  height?: number | null;
  onOpen?: () => void;
}
export function ImageCard(props: ImageCardProps) {
  useTranslation("task-components");
  return (
    <Card>
      <div className="border-b border-border bg-muted/20">
        <ImageContent src={props.imageUrl} alt={props.alt} />
      </div>
      <div className="flex flex-col gap-3 p-5">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <ImageIcon className="size-4" />{t("final-components-a:image_1aa4cb0b")}{props.width && props.height
            ? ` · ${props.width} × ${props.height}`
            : ""}
        </span>
        <Identity {...props} />
        <span className="break-all font-mono text-xs text-muted-foreground">
          {props.filename}
        </span>
      </div>
      <Footer
        {...props}
        action={
          props.onOpen ? (
            <Button
              size="sm"
              variant="outline"
              aria-label={t("task-components:viewImage_7eba81ff", { value1: props.title })}
              onClick={props.onOpen}
            >{t("task-components:viewImage_5bb55a4b")}</Button>
          ) : (
            <Viewer
              title={props.title}
              description={props.filename}
              action={t("final-components-a:viewImage_5bb55a4b")}
            >
              <ImageContent src={props.imageUrl} alt={props.alt} />
            </Viewer>
          )
        }
      />
    </Card>
  );
}

export interface VideoCardProps extends ArtifactIdentity {
  filename: string;
  videoUrl: string;
  posterUrl: string;
  duration: string;
  onOpen?: () => void;
}
export function VideoCard(props: VideoCardProps) {
  useTranslation("task-components");
  return (
    <Card>
      <video
        key={props.videoUrl}
        src={props.videoUrl || undefined}
        poster={props.posterUrl || undefined}
        controls
        preload="metadata"
        aria-label={props.title}
        className="aspect-video w-full border-b border-border bg-muted"
      />
      <div className="flex flex-col gap-3 p-5">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Film className="size-4" />{t("final-components-a:video_d534be82")}{props.duration && ` · ${props.duration}`}
        </span>
        <Identity {...props} />
        <span className="break-all font-mono text-xs text-muted-foreground">
          {props.filename}
        </span>
      </div>
      <Footer
        {...props}
        action={
          props.onOpen ? (
            <Button
              size="sm"
              variant="outline"
              aria-label={t("task-components:openVideo_88d41f60", { value1: props.title })}
              onClick={props.onOpen}
            >{t("task-components:openVideo_6ac7b387")}</Button>
          ) : (
            <SourceLink url={props.videoUrl}>{t("task-components:openVideo_6ac7b387")}</SourceLink>
          )
        }
      />
    </Card>
  );
}

export interface LinkPreviewCardProps extends ArtifactIdentity {
  url: string;
  imageUrl: string;
  imageAlt: string;
}
export function LinkPreviewCard(props: LinkPreviewCardProps) {
  useTranslation("task-components");
  return (
    <Card>
      {props.imageUrl && (
        <div className="border-b border-border bg-muted/20">
          <ImageContent src={props.imageUrl} alt={props.imageAlt} />
        </div>
      )}
      <div className="flex flex-col gap-4 p-5">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Globe className="size-4" />{" "}{t("task-components:linkPreview_165e9250")}</span>
        <Identity {...props} />
        <span className="break-all font-mono text-xs text-muted-foreground">
          {props.url}
        </span>
      </div>
      <Footer
        {...props}
        action={<SourceLink url={props.url}>{t("task-components:openLink_aab63f85")}</SourceLink>}
      />
    </Card>
  );
}

export interface FileCardProps extends ArtifactIdentity {
  filename: string;
  contentType: string;
  fileSize: string;
  entries: string[];
  downloadUrl: string;
  openUrl?: string;
  actions?: ReactNode;
}
export function FileCard(props: FileCardProps) {
  useTranslation("task-components");
  return (
    <Card>
      <div className="flex flex-col gap-4 p-5">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <File className="size-4" />{t("final-components-a:file_50009ce1")}{props.fileSize && ` · ${props.fileSize}`}
        </span>
        <Identity {...props} />
        <div className="flex flex-col gap-1">
          <span className="break-all font-mono text-xs">{props.filename}</span>
          <span className="break-all text-xs text-muted-foreground">
            {props.contentType}
          </span>
        </div>
        {props.entries.length > 0 && (
          <ul className="flex flex-col gap-2 border-t border-border pt-4">
            {props.entries.map((entry, i) => (
              <li
                key={i}
                className="flex items-center gap-2 font-mono text-xs text-muted-foreground"
              >
                <FileText className="size-3.5 shrink-0" />
                {entry}
              </li>
            ))}
          </ul>
        )}
      </div>
      <Footer
        {...props}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {props.actions}
            {props.openUrl && (
              <SourceLink url={props.openUrl}>{t("task-components:openFile_4190c0c7")}</SourceLink>
            )}
            {props.downloadUrl ? (
              <Button asChild size="sm" variant="outline">
                <a href={props.downloadUrl} download={props.filename}>{t("task-components:downloadFile_9de4149f")}</a>
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled>{t("task-components:downloadUnavailable_2f180e49")}</Button>
            )}
          </div>
        }
      />
    </Card>
  );
}
