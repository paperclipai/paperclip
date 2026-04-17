import { isValidElement, useEffect, useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import Markdown, { defaultUrlTransform, type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/utils";
import { useTheme } from "../context/ThemeContext";
import { mentionChipInlineStyle, parseMentionChipHref } from "../lib/mention-chips";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Link } from "@/lib/router";
import { parseIssueReferenceFromHref, remarkLinkIssueReferences } from "../lib/issue-reference";
import { remarkSoftBreaks } from "../lib/remark-soft-breaks";
import { StatusIcon } from "./StatusIcon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Detects whether a string looks like a workspace file path.
 * Conservative: requires at least one `/` or a recognized file extension.
 * Excludes URLs, `..` traversals, and bare package-like names.
 */
function isLikelyFilePath(text: string): boolean {
  const trimmed = text.trim();
  // Reject empty, URLs, bare words without path separators or extensions
  if (!trimmed) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  // Reject paths with `..` segments (defense-in-depth)
  if (/(^|\/)\.\.($|\/)/.test(trimmed)) return false;
  // Must start with a word char, `.`, or `/`
  if (!/^[\w./]/.test(trimmed)) return false;
  // Must contain at least one `/` OR end with a recognized file extension
  const hasSlash = trimmed.includes("/");
  const hasExtension = /\.\w{1,10}$/.test(trimmed);
  if (!hasSlash && !hasExtension) return false;
  // If no slash, require a dot-extension to avoid matching plain words like "foo.bar"
  // Require the extension to be a common code/doc file type when there's no slash
  if (!hasSlash) {
    if (!/\.(ts|tsx|js|jsx|json|md|mdx|yml|yaml|toml|txt|css|scss|html|xml|svg|sql|sh|bash|py|rb|go|rs|env|graphql|gql|prisma|lock|log|cfg|ini|conf|dockerfile)$/i.test(trimmed)) {
      return false;
    }
  }
  // Reject if it looks like a scoped npm package (@scope/name with no further path)
  if (/^@[\w-]+\/[\w-]+$/.test(trimmed)) return false;
  return true;
}

function isDirectoryPath(text: string): boolean {
  return text.trim().endsWith("/");
}

interface MarkdownBodyProps {
  children: string;
  className?: string;
  style?: React.CSSProperties;
  softBreaks?: boolean;
  linkIssueReferences?: boolean;
  /** Optional resolver for relative image paths (e.g. within export packages) */
  resolveImageSrc?: (src: string) => string | null;
  /** When provided, inline code that looks like a file path becomes clickable. */
  onFilePathClick?: (path: string) => void;
  /** When provided, inline code that looks like a directory path opens the browser to that directory. */
  onDirPathClick?: (dirPath: string) => void;
  /** Called when a user clicks an inline image */
  onImageClick?: (src: string) => void;
}

let mermaidLoaderPromise: Promise<typeof import("mermaid").default> | null = null;

function MarkdownIssueLink({
  issuePathId,
  href,
  children,
}: {
  issuePathId: string;
  href: string;
  children: ReactNode;
}) {
  const { data } = useQuery({
    queryKey: queryKeys.issues.detail(issuePathId),
    queryFn: () => issuesApi.get(issuePathId),
    staleTime: 60_000,
  });

  return (
    <Link to={href} className="inline-flex items-center gap-1.5 align-baseline">
      {data ? <StatusIcon status={data.status} className="h-3.5 w-3.5" /> : null}
      <span>{children}</span>
    </Link>
  );
}

function loadMermaid() {
  if (!mermaidLoaderPromise) {
    mermaidLoaderPromise = import("mermaid").then((module) => module.default);
  }
  return mermaidLoaderPromise;
}

const wrapAnywhereStyle: React.CSSProperties = {
  overflowWrap: "anywhere",
  wordBreak: "break-word",
};

const scrollableBlockStyle: React.CSSProperties = {
  maxWidth: "100%",
  overflowX: "auto",
};

function mergeWrapStyle(style?: React.CSSProperties): React.CSSProperties {
  return {
    ...wrapAnywhereStyle,
    ...style,
  };
}

function mergeScrollableBlockStyle(style?: React.CSSProperties): React.CSSProperties {
  return {
    ...scrollableBlockStyle,
    ...style,
  };
}

function flattenText(value: ReactNode): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item) => flattenText(item)).join("");
  return "";
}

function extractMermaidSource(children: ReactNode): string | null {
  if (!isValidElement(children)) return null;
  const childProps = children.props as { className?: unknown; children?: ReactNode };
  if (typeof childProps.className !== "string") return null;
  if (!/\blanguage-mermaid\b/i.test(childProps.className)) return null;
  return flattenText(childProps.children).replace(/\n$/, "");
}

function safeMarkdownUrlTransform(url: string): string {
  return parseMentionChipHref(url) ? url : defaultUrlTransform(url);
}

function MermaidDiagramBlock({ source, darkMode }: { source: string; darkMode: boolean }) {
  const renderId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSvg(null);
    setError(null);

    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: darkMode ? "dark" : "default",
          fontFamily: "inherit",
          suppressErrorRendering: true,
        });
        const rendered = await mermaid.render(`paperclip-mermaid-${renderId}`, source);
        if (!active) return;
        setSvg(rendered.svg);
      })
      .catch((err) => {
        if (!active) return;
        const message =
          err instanceof Error && err.message
            ? err.message
            : "Failed to render Mermaid diagram.";
        setError(message);
      });

    return () => {
      active = false;
    };
  }, [darkMode, renderId, source]);

  return (
    <div className="paperclip-mermaid">
      {svg ? (
        <div dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <>
          <p className={cn("paperclip-mermaid-status", error && "paperclip-mermaid-status-error")}>
            {error ? `Unable to render Mermaid diagram: ${error}` : "Rendering Mermaid diagram..."}
          </p>
          <pre className="paperclip-mermaid-source">
            <code className="language-mermaid">{source}</code>
          </pre>
        </>
      )}
    </div>
  );
}

export function MarkdownBody({
  children,
  className,
  style,
  softBreaks = true,
  linkIssueReferences = true,
  resolveImageSrc,
  onFilePathClick,
  onDirPathClick,
  onImageClick,
}: MarkdownBodyProps) {
  const { theme } = useTheme();
  const remarkPlugins: NonNullable<Options["remarkPlugins"]> = [remarkGfm];
  if (linkIssueReferences) {
    remarkPlugins.push(remarkLinkIssueReferences);
  }
  if (softBreaks) {
    remarkPlugins.push(remarkSoftBreaks);
  }
  const components: Components = {
    p: ({ node: _node, style: paragraphStyle, children: paragraphChildren, ...paragraphProps }) => (
      <p {...paragraphProps} style={mergeWrapStyle(paragraphStyle as React.CSSProperties | undefined)}>
        {paragraphChildren}
      </p>
    ),
    li: ({ node: _node, style: listItemStyle, children: listItemChildren, ...listItemProps }) => (
      <li {...listItemProps} style={mergeWrapStyle(listItemStyle as React.CSSProperties | undefined)}>
        {listItemChildren}
      </li>
    ),
    blockquote: ({ node: _node, style: blockquoteStyle, children: blockquoteChildren, ...blockquoteProps }) => (
      <blockquote {...blockquoteProps} style={mergeWrapStyle(blockquoteStyle as React.CSSProperties | undefined)}>
        {blockquoteChildren}
      </blockquote>
    ),
    td: ({ node: _node, style: tableCellStyle, children: tableCellChildren, ...tableCellProps }) => (
      <td {...tableCellProps} style={mergeWrapStyle(tableCellStyle as React.CSSProperties | undefined)}>
        {tableCellChildren}
      </td>
    ),
    th: ({ node: _node, style: tableHeaderStyle, children: tableHeaderChildren, ...tableHeaderProps }) => (
      <th {...tableHeaderProps} style={mergeWrapStyle(tableHeaderStyle as React.CSSProperties | undefined)}>
        {tableHeaderChildren}
      </th>
    ),
    pre: ({ node: _node, children: preChildren, ...preProps }) => {
      const mermaidSource = extractMermaidSource(preChildren);
      if (mermaidSource) {
        return <MermaidDiagramBlock source={mermaidSource} darkMode={theme === "dark"} />;
      }
      return <pre {...preProps} style={mergeScrollableBlockStyle(preProps.style as React.CSSProperties | undefined)}>{preChildren}</pre>;
    },
    code: ({ node: _node, style: codeStyle, children: codeChildren, ...codeProps }) => (
      <code {...codeProps} style={mergeWrapStyle(codeStyle as React.CSSProperties | undefined)}>
        {codeChildren}
      </code>
    ),
    a: ({ href, style: linkStyle, children: linkChildren }) => {
      const issueRef = linkIssueReferences ? parseIssueReferenceFromHref(href) : null;
      if (issueRef) {
        return (
          <MarkdownIssueLink issuePathId={issueRef.issuePathId} href={issueRef.href}>
            {linkChildren}
          </MarkdownIssueLink>
        );
      }

      const parsed = href ? parseMentionChipHref(href) : null;
      if (parsed) {
        const targetHref = parsed.kind === "project"
          ? `/projects/${parsed.projectId}`
          : parsed.kind === "skill"
            ? `/skills/${parsed.skillId}`
            : parsed.kind === "user"
              ? "/company/settings/access"
            : `/agents/${parsed.agentId}`;
        return (
          <a
            href={targetHref}
            className={cn(
              "paperclip-mention-chip",
              `paperclip-mention-chip--${parsed.kind}`,
              parsed.kind === "project" && "paperclip-project-mention-chip",
            )}
            data-mention-kind={parsed.kind}
            style={{ ...mergeWrapStyle(linkStyle as React.CSSProperties | undefined), ...mentionChipInlineStyle(parsed) }}
          >
            {linkChildren}
          </a>
        );
      }
      if (href?.startsWith("issue://")) {
        const issueId = href.slice("issue://".length);
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(issueId)) {
          return (
            <a
              href={`/issues/${issueId}`}
              className="text-primary underline underline-offset-2 hover:text-primary/80 transition-colors"
            >
              {linkChildren}
            </a>
          );
        }
        return <span>{linkChildren}</span>;
      }
      return (
        <a href={href} rel="noreferrer" style={mergeWrapStyle(linkStyle as React.CSSProperties | undefined)}>
          {linkChildren}
        </a>
      );
    },
  };
  // When a file-path click handler is provided, make inline code that looks
  // like file paths clickable. Only applies to inline `code` — not code blocks
  // (those are wrapped in `pre > code` and won't hit this override because the
  // `pre` override handles them).
  if (onFilePathClick || onDirPathClick) {
    components.code = ({ node: _node, children: codeChildren, className: codeClassName, ...codeProps }) => {
      if (codeClassName) {
        return <code className={codeClassName} {...codeProps}>{codeChildren}</code>;
      }
      const text = flattenText(codeChildren);
      if (isLikelyFilePath(text)) {
        const isDir = isDirectoryPath(text);
        const handler = isDir ? onDirPathClick : onFilePathClick;
        if (!handler) return <code {...codeProps}>{codeChildren}</code>;
        const label = isDir ? `Browse ${text}` : `Open ${text}`;
        return (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <code
                {...codeProps}
                role="button"
                tabIndex={0}
                className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-primary transition-colors"
                onClick={() => handler(text)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handler(text);
                  }
                }}
              >
                {codeChildren}
              </code>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {label}
            </TooltipContent>
          </Tooltip>
        );
      }
      return <code {...codeProps}>{codeChildren}</code>;
    };
  }
  if (resolveImageSrc || onImageClick) {
    components.img = ({ node: _node, src, alt, ...imgProps }) => {
      const resolved = resolveImageSrc && src ? resolveImageSrc(src) : null;
      const finalSrc = resolved ?? src;
      return (
        <img
          {...imgProps}
          src={finalSrc}
          alt={alt ?? ""}
          onClick={onImageClick && finalSrc ? (e) => { e.preventDefault(); onImageClick(finalSrc); } : undefined}
          style={onImageClick ? { cursor: "pointer", ...(imgProps.style as React.CSSProperties | undefined) } : imgProps.style as React.CSSProperties | undefined}
        />
      );
    };
  }

  return (
    <div
      className={cn(
        "paperclip-markdown prose prose-sm min-w-0 max-w-full break-words overflow-hidden",
        theme === "dark" && "prose-invert",
        className,
      )}
      style={mergeWrapStyle(style)}
    >
      <Markdown
        remarkPlugins={remarkPlugins}
        components={components}
        urlTransform={safeMarkdownUrlTransform}
      >
        {children}
      </Markdown>
    </div>
  );
}
