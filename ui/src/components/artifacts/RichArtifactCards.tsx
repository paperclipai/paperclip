import { i18n, t, useTranslation } from "@/i18n";
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
  useTranslation();
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
  useTranslation();
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
  useTranslation();
  return (
    <article className="w-full overflow-hidden rounded-lg border border-border bg-card text-card-foreground">
      {children}
    </article>
  );
}

function SourceLink({ url, children }: { url: string; children: ReactNode }) {
  useTranslation();
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
  useTranslation();
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
  useTranslation();
  return (
    <div className="flex flex-wrap gap-2 font-mono text-xs">
      {additions != null && (
        <span className="text-(--status-task-icon-done)">
          +{additions.toLocaleString(i18n.resolvedLanguage)}
        </span>
      )}
      {deletions != null && (
        <span className="text-(--status-task-icon-blocked)">
          −{deletions.toLocaleString(i18n.resolvedLanguage)}
        </span>
      )}
      {filesChanged != null && (
        <span className="text-muted-foreground">
          {t("oct5Core.files", { count: filesChanged })}
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
  get passed() { return t("oct5Core.s0218"); },
  get pending() { return t("oct5Core.s0219"); },
  get failed() { return t("oct5Core.s0220"); },
  get unknown() { return t("oct5Core.s0221"); },
};
const stateLabel = {
  get open() { return t("oct5Core.s0222"); },
  get draft() { return t("oct5Core.s0223"); },
  get merged() { return t("oct5Core.s0224"); },
  get closed() { return t("oct5Core.s0225"); },
  get unknown() { return t("oct5Core.s0226"); },
};

export function PullRequestCard(props: PullRequestCardProps) {
  useTranslation();
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
            <GitPullRequest className="size-4" /> {t("oct5Core.s0227")}{" "}
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
          <p className="text-xs text-muted-foreground">
            {t("oct5Core.s0228")} {evidenceSource}
          </p>
        )}
      </div>
      <Footer
        {...props}
        action={<SourceLink url={url}>{t("oct5Core.s0229")}</SourceLink>}
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
  useTranslation();
  return (
    <Card>
      <div className="flex flex-col gap-4 p-5">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <GitCommitHorizontal className="size-4" /> {t("oct5Core.s0230")}{" "}
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
        action={<SourceLink url={props.url}>{t("oct5Core.s0231")}</SourceLink>}
      />
    </Card>
  );
}

function Markdown({ body }: { body: string }) {
  useTranslation();
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed">
      <ReactMarkdown
        components={{
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
                {alt || t("oct5Core.s0232")}
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
  filename: string;
  revision?: number | null;
  body: string;
  onOpen?: () => void;
  expanded?: boolean;
  actions?: ReactNode;
}
export function DocumentCard(props: DocumentCardProps) {
  useTranslation();
  return (
    <Card>
      {props.body && (
        <div
          className="max-h-52 overflow-hidden border-b border-border bg-muted/20 p-5"
          inert
        >
          <Markdown body={props.body.slice(0, 4000)} />
        </div>
      )}
      <div className="flex flex-col gap-3 p-5">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <FileText className="size-4" /> Markdown
          {props.revision != null && t("oct5Core.artifactRevision", { revision: props.revision })}
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
                {props.expanded ? t("oct5Core.s0233") : t("oct5Core.s0234")}
              </Button>
            ) : (
              <Viewer
                title={props.title}
                description={props.filename}
                action={t("oct5Core.s0234")}
              >
                <Markdown body={props.body} />
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
  useTranslation();
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
        <p className="p-4 text-xs text-muted-foreground">{t("oct5Core.s0235")}</p>
      )}
    </div>
  );
}
export function DataCard(props: DataCardProps) {
  useTranslation();
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
          <Table2 className="size-4" /> CSV · {t(props.truncated ? "oct5Core.firstRows" : "oct5Core.rows", { count: props.rows.length })} ·{" "}
          {t("oct5Core.columns", { count: props.columns.length })}
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
              action={t("oct5Core.s0236")}
            >
              <DataTable {...props} />
              <Button asChild variant="outline" size="sm" className="w-fit">
                <a
                  download={props.filename}
                  href={
                    props.downloadUrl ||
                    `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`
                  }
                >
                  {t("oct5Core.s0237")}
                </a>
              </Button>
            </Viewer>
          </div>
        }
      />
    </Card>
  );
}

function ImageContent({ src, alt }: { src: string; alt: string }) {
  useTranslation();
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
      <span className="text-xs">{t("oct5Core.s0238")}</span>
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
  useTranslation();
  return (
    <Card>
      <div className="border-b border-border bg-muted/20">
        <ImageContent src={props.imageUrl} alt={props.alt} />
      </div>
      <div className="flex flex-col gap-3 p-5">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <ImageIcon className="size-4" /> {t("oct5Core.s0239")}
          {props.width && props.height
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
              aria-label={t("oct5Core.viewImageTitle", { title: props.title })}
              onClick={props.onOpen}
            >
              {t("oct5Core.s0240")}
            </Button>
          ) : (
            <Viewer
              title={props.title}
              description={props.filename}
              action={t("oct5Core.s0240")}
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
  useTranslation();
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
          <Film className="size-4" /> {t("oct5Core.s0241")}
          {props.duration && ` · ${props.duration}`}
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
              aria-label={t("oct5Core.openVideoTitle", { title: props.title })}
              onClick={props.onOpen}
            >
              {t("oct5Core.s0242")}
            </Button>
          ) : (
            <SourceLink url={props.videoUrl}>{t("oct5Core.s0242")}</SourceLink>
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
  useTranslation();
  return (
    <Card>
      {props.imageUrl && (
        <div className="border-b border-border bg-muted/20">
          <ImageContent src={props.imageUrl} alt={props.imageAlt} />
        </div>
      )}
      <div className="flex flex-col gap-4 p-5">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Globe className="size-4" /> {t("oct5Core.s0243")}
        </span>
        <Identity {...props} />
        <span className="break-all font-mono text-xs text-muted-foreground">
          {props.url}
        </span>
      </div>
      <Footer
        {...props}
        action={<SourceLink url={props.url}>{t("oct5Core.s0244")}</SourceLink>}
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
  useTranslation();
  return (
    <Card>
      <div className="flex flex-col gap-4 p-5">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <File className="size-4" /> {t("oct5Core.s0245")}
          {props.fileSize && ` · ${props.fileSize}`}
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
              <SourceLink url={props.openUrl}>{t("oct5Core.s0246")}</SourceLink>
            )}
            {props.downloadUrl ? (
              <Button asChild size="sm" variant="outline">
                <a href={props.downloadUrl} download={props.filename}>
                  {t("oct5Core.s0211")}
                </a>
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled>
                {t("oct5Core.s0247")}
              </Button>
            )}
          </div>
        }
      />
    </Card>
  );
}
