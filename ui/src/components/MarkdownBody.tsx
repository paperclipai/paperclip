import { isValidElement, useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Github } from "lucide-react";
import Markdown, { defaultUrlTransform, type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/utils";
import { Link } from "@/lib/router";
import { useTheme } from "../context/ThemeContext";
import { mentionChipInlineStyle, parseMentionChipHref } from "../lib/mention-chips";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { parseIssueReferenceFromHref, remarkLinkIssueReferences } from "../lib/issue-reference";
import { remarkSoftBreaks } from "../lib/remark-soft-breaks";
import { StatusIcon } from "./StatusIcon";

interface MarkdownBodyProps {
  children: string;
  className?: string;
  style?: React.CSSProperties;
  softBreaks?: boolean;
  linkIssueReferences?: boolean;
  /** Optional resolver for relative image paths (e.g. within export packages) */
  resolveImageSrc?: (src: string) => string | null;
  /** Called when a user clicks an inline image */
  onImageClick?: (src: string) => void;
}

let mermaidLoaderPromise: Promise<typeof import("mermaid").default> | null = null;

function MarkdownIssueLink({
  issuePathId,
  children,
}: {
  issuePathId: string;
  children: ReactNode;
}) {
  const { data } = useQuery({
    queryKey: queryKeys.issues.detail(issuePathId),
    queryFn: () => issuesApi.get(issuePathId),
    staleTime: 60_000,
  });

  const identifier = data?.identifier ?? issuePathId;
  const title = data?.title ?? identifier;
  const status = data?.status;
  const issueLabel = title !== identifier ? `Issue ${identifier}: ${title}` : `Issue ${identifier}`;

  return (
    <Link
      to={`/issues/${identifier}`}
      data-mention-kind="issue"
      className="paperclip-markdown-issue-ref"
      title={title}
      aria-label={issueLabel}
    >
      {status ? (
        <StatusIcon status={status} className="mr-1 h-3 w-3 align-[-0.125em]" />
      ) : null}
      {children}
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

function isGitHubUrl(href: string | null | undefined): boolean {
  if (!href) return false;
  try {
    const url = new URL(href);
    return url.protocol === "https:" && (url.hostname === "github.com" || url.hostname === "www.github.com");
  } catch {
    return false;
  }
}

function isExternalHttpUrl(href: string | null | undefined): boolean {
  if (!href) return false;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (typeof window === "undefined") return true;
    return url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

function renderLinkBody(
  children: ReactNode,
  leadingIcon: ReactNode,
  trailingIcon: ReactNode,
): ReactNode {
  if (!leadingIcon && !trailingIcon) return children;

  // React-markdown can pass arrays/elements for styled link text; the nowrap
  // splitting below is intentionally limited to plain text links.
  if (typeof children === "string" && children.length > 0) {
    if (children.length === 1) {
      return (
        <span style={{ whiteSpace: "nowrap" }}>
          {leadingIcon}
          {children}
          {trailingIcon}
        </span>
      );
    }
    const first = children[0];
    const last = children[children.length - 1];
    const middle = children.slice(1, -1);
    return (
      <>
        {leadingIcon ? (
          <span style={{ whiteSpace: "nowrap" }}>
            {leadingIcon}
            {first}
          </span>
        ) : first}
        {middle}
        {trailingIcon ? (
          <span style={{ whiteSpace: "nowrap" }}>
            {last}
            {trailingIcon}
          </span>
        ) : last}
      </>
    );
  }

  return (
    <>
      {leadingIcon}
      {children}
      {trailingIcon}
    </>
  );
}

function CodeBlock({
  children,
  preProps,
}: {
  children: ReactNode;
  preProps: React.HTMLAttributes<HTMLPreElement>;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = useCallback(async () => {
    const text = preRef.current?.innerText ?? flattenText(children);
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        try {
          textarea.select();
          const success = document.execCommand("copy");
          if (!success) throw new Error("execCommand copy failed");
        } finally {
          document.body.removeChild(textarea);
        }
      }
      setFailed(false);
      setCopied(true);
    } catch {
      setFailed(true);
      setCopied(true);
    }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 1500);
  }, [children]);

  const label = failed ? "Copy failed" : copied ? "Copied!" : "Copy";

  return (
    <div className="paperclip-markdown-codeblock">
      <pre
        {...preProps}
        ref={preRef}
        style={mergeScrollableBlockStyle(preProps.style as React.CSSProperties | undefined)}
      >
        {children}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        aria-label="Copy code"
        title={label}
        className="paperclip-markdown-codeblock-copy"
        data-copied={copied || undefined}
        data-failed={failed || undefined}
      >
        {copied && !failed ? (
          <Check aria-hidden="true" className="h-3.5 w-3.5" />
        ) : (
          <Copy aria-hidden="true" className="h-3.5 w-3.5" />
        )}
        <span className="paperclip-markdown-codeblock-copy-label">{label}</span>
      </button>
    </div>
  );
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
      return <CodeBlock preProps={preProps}>{preChildren}</CodeBlock>;
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
          <MarkdownIssueLink issuePathId={issueRef.issuePathId}>
            {linkChildren}
          </MarkdownIssueLink>
        );
      }

      const parsed = href ? parseMentionChipHref(href) : null;
      if (parsed) {
        const targetHref = parsed.kind === "project"
          ? `/projects/${parsed.projectId}`
          : parsed.kind === "issue"
            ? `/issues/${parsed.identifier}`
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
      const isGitHubLink = isGitHubUrl(href);
      const isExternal = isExternalHttpUrl(href);
      const leadingIcon = isGitHubLink ? (
        <Github aria-hidden="true" className="mr-1 inline h-3.5 w-3.5 align-[-0.125em]" />
      ) : null;
      const trailingIcon = isExternal && !isGitHubLink ? (
        <ExternalLink aria-hidden="true" className="ml-1 inline h-3 w-3 align-[-0.125em]" />
      ) : null;
      return (
        <a
          href={href}
          {...(isExternal
            ? { target: "_blank", rel: "noopener noreferrer" }
            : { rel: "noreferrer" })}
          style={mergeWrapStyle(linkStyle as React.CSSProperties | undefined)}
        >
          {renderLinkBody(linkChildren, leadingIcon, trailingIcon)}
        </a>
      );
    },
  };
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
