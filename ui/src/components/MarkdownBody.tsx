import { isValidElement, memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Github, WrapText } from "lucide-react";
import Markdown, { defaultUrlTransform, type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/utils";
import { Link } from "@/lib/router";
import { useTheme } from "../context/ThemeContext";
import { useOptionalCompany } from "../context/CompanyContext";
import { mentionChipInlineStyle, parseMentionChipHref } from "../lib/mention-chips";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { parseIssueReferenceFromHref, remarkLinkIssueReferences } from "../lib/issue-reference";
import { parseWorkspaceFileHref, remarkWorkspaceFileRefs, WORKSPACE_FILE_HREF_PREFIX } from "../lib/remark-workspace-file-refs";
import { remarkSoftBreaks } from "../lib/remark-soft-breaks";
import { StatusIcon } from "./StatusIcon";
import { WorkspaceFileLink } from "./WorkspaceFileLink";

interface MarkdownBodyProps {
  children: string;
  className?: string;
  style?: React.CSSProperties;
  softBreaks?: boolean;
  linkIssueReferences?: boolean;
  /** Opt into Obsidian-style [[target]] / [[target|label]] wikilinks. */
  enableWikiLinks?: boolean;
  /** Base href used for wikilinks when no resolver is supplied. */
  wikiLinkRoot?: string;
  /** Optional href resolver for wikilinks. Return null to leave a token as plain text. */
  resolveWikiLinkHref?: (target: string, label: string) => string | null | undefined;
  /** Optional resolver for relative image paths (e.g. within export packages) */
  resolveImageSrc?: (src: string) => string | null;
  /** Called when a user clicks an inline image */
  onImageClick?: (src: string) => void;
  /** Link inline-code workspace file paths to the issue file viewer. */
  linkWorkspaceFileRefs?: boolean;
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

const codeBlockActionsStyle: React.CSSProperties = {
  position: "absolute",
  top: "0.4rem",
  right: "0.4rem",
  display: "inline-flex",
  alignItems: "center",
  gap: "0.25rem",
};

const codeBlockActionStyle: React.CSSProperties = {
  position: "static",
  opacity: 1,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.25rem",
  minHeight: "1.55rem",
  padding: "0.2rem 0.4rem",
  borderRadius: "calc(var(--radius) - 4px)",
  border: "1px solid color-mix(in oklab, var(--foreground) 14%, transparent)",
  backgroundColor: "color-mix(in oklab, var(--muted) 92%, var(--background) 8%)",
  color: "var(--muted-foreground)",
  fontSize: "0.7rem",
  lineHeight: 1,
  cursor: "pointer",
};

const codeBlockWrapActionStyle: React.CSSProperties = {
  ...codeBlockActionStyle,
  width: "1.55rem",
  paddingInline: 0,
};

const tableCellWrapStyle: React.CSSProperties = {
  overflowWrap: "anywhere",
  wordBreak: "normal",
};

function mergeWrapStyle(style?: React.CSSProperties): React.CSSProperties {
  return {
    ...wrapAnywhereStyle,
    ...style,
  };
}

function mergeTableCellStyle(style?: React.CSSProperties): React.CSSProperties {
  return {
    ...tableCellWrapStyle,
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
  if (url.startsWith(WORKSPACE_FILE_HREF_PREFIX)) return url;
  return parseMentionChipHref(url) ? url : defaultUrlTransform(url);
}

type MarkdownAstNode = {
  type?: string;
  value?: string;
  children?: MarkdownAstNode[];
  url?: string;
  title?: string | null;
  data?: {
    hProperties?: Record<string, string>;
  };
};

type ParsedWikiLink = {
  target: string;
  label: string;
};

const WIKI_LINK_PATTERN = /\[\[([^\]\r\n]+)\]\]/g;
const WIKI_LINK_SKIP_PARENT_TYPES = new Set([
  "definition",
  "image",
  "imageReference",
  "link",
  "linkReference",
]);

function parseWikiLinkBody(body: string): ParsedWikiLink | null {
  const [rawTarget, ...rawLabelParts] = body.split("|");
  const target = rawTarget?.trim() ?? "";
  const label = rawLabelParts.length > 0 ? rawLabelParts.join("|").trim() : target;
  if (!target || target.includes("[") || target.includes("]")) return null;
  return {
    target,
    label: label || target,
  };
}

function encodeWikiLinkTarget(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed || /^[a-z][a-z\d+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return null;

  const hashIndex = trimmed.indexOf("#");
  const rawPath = (hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed)
    .trim()
    .replace(/^\/+/, "");
  if (
    !rawPath ||
    rawPath.includes("\\") ||
    rawPath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }

  const encodedPath = rawPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const rawHash = hashIndex >= 0 ? trimmed.slice(hashIndex + 1).trim() : "";
  return rawHash ? `${encodedPath}#${encodeURIComponent(rawHash)}` : encodedPath;
}

function defaultWikiLinkHref(target: string, wikiLinkRoot?: string): string | null {
  const encodedTarget = encodeWikiLinkTarget(target);
  if (!encodedTarget) return null;
  const root = wikiLinkRoot?.trim().replace(/\/+$/, "") ?? "";
  return root ? `${root}/${encodedTarget}` : encodedTarget;
}

function createWikiLinkNode(href: string, wikiLink: ParsedWikiLink): MarkdownAstNode {
  return {
    type: "link",
    url: href,
    title: null,
    data: {
      hProperties: {
        "data-paperclip-wiki-link": "true",
        "data-paperclip-wiki-target": wikiLink.target,
      },
    },
    children: [{ type: "text", value: wikiLink.label }],
  };
}

function splitTextByWikiLinks(
  value: string,
  options: {
    wikiLinkRoot?: string;
    resolveWikiLinkHref?: (target: string, label: string) => string | null | undefined;
  },
): MarkdownAstNode[] {
  const nodes: MarkdownAstNode[] = [];
  let lastIndex = 0;

  for (const match of value.matchAll(WIKI_LINK_PATTERN)) {
    const raw = match[0] ?? "";
    const body = match[1] ?? "";
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push({ type: "text", value: value.slice(lastIndex, start) });
    }

    const wikiLink = parseWikiLinkBody(body);
    let resolvedHref: string | null = null;
    if (wikiLink) {
      if (options.resolveWikiLinkHref) {
        const customHref = options.resolveWikiLinkHref(wikiLink.target, wikiLink.label);
        resolvedHref = customHref === undefined
          ? defaultWikiLinkHref(wikiLink.target, options.wikiLinkRoot)
          : customHref;
      } else {
        resolvedHref = defaultWikiLinkHref(wikiLink.target, options.wikiLinkRoot);
      }
    }

    if (wikiLink && resolvedHref) {
      nodes.push(createWikiLinkNode(resolvedHref, wikiLink));
    } else {
      nodes.push({ type: "text", value: raw });
    }
    lastIndex = start + raw.length;
  }

  if (lastIndex < value.length) {
    nodes.push({ type: "text", value: value.slice(lastIndex) });
  }

  return nodes;
}

function transformWikiLinkChildren(
  node: MarkdownAstNode,
  options: {
    wikiLinkRoot?: string;
    resolveWikiLinkHref?: (target: string, label: string) => string | null | undefined;
  },
) {
  if (!node.children || WIKI_LINK_SKIP_PARENT_TYPES.has(node.type ?? "")) return;

  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && typeof child.value === "string" && child.value.includes("[[")) {
      return splitTextByWikiLinks(child.value, options);
    }
    transformWikiLinkChildren(child, options);
    return child;
  });
}

function createRemarkWikiLinks(options: {
  wikiLinkRoot?: string;
  resolveWikiLinkHref?: (target: string, label: string) => string | null | undefined;
}) {
  return function remarkWikiLinks() {
    return (tree: MarkdownAstNode) => {
      transformWikiLinkChildren(tree, options);
    };
  };
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
  const [wrapLines, setWrapLines] = useState(false);
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

  const copyLabel = failed ? "Copy failed" : copied ? "Copied!" : "Copy";
  const wrapLabel = wrapLines ? "Unwrap lines" : "Wrap lines";

  return (
    <div className="paperclip-markdown-codeblock" data-wrap-lines={wrapLines || undefined}>
      <pre
        {...preProps}
        ref={preRef}
        style={{
          ...mergeScrollableBlockStyle(preProps.style as React.CSSProperties | undefined),
          ...(wrapLines
            ? {
                overflowX: "hidden",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                wordBreak: "break-word",
              }
            : null),
        }}
      >
        {children}
      </pre>
      <div
        className="paperclip-markdown-codeblock-actions"
        style={codeBlockActionsStyle}
        data-active={copied || failed || wrapLines || undefined}
      >
        <button
          type="button"
          onClick={() => setWrapLines((value) => !value)}
          aria-label={wrapLabel}
          title={wrapLabel}
          className="paperclip-markdown-codeblock-action paperclip-markdown-codeblock-wrap"
          style={wrapLines
            ? {
                ...codeBlockWrapActionStyle,
                borderColor: "color-mix(in oklab, var(--primary) 38%, transparent)",
                color: "var(--primary)",
              }
            : codeBlockWrapActionStyle}
          aria-pressed={wrapLines}
          data-active={wrapLines || undefined}
        >
          <WrapText aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy code"
          title={copyLabel}
          className="paperclip-markdown-codeblock-action paperclip-markdown-codeblock-copy"
          style={codeBlockActionStyle}
          data-copied={copied || undefined}
          data-failed={failed || undefined}
        >
          {copied && !failed ? (
            <Check aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <Copy aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          <span className="paperclip-markdown-codeblock-action-label">{copyLabel}</span>
        </button>
      </div>
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

function MarkdownBodyImpl({
  children,
  className,
  style,
  softBreaks = true,
  linkIssueReferences = true,
  enableWikiLinks = false,
  wikiLinkRoot,
  resolveWikiLinkHref,
  resolveImageSrc,
  onImageClick,
  linkWorkspaceFileRefs = false,
}: MarkdownBodyProps) {
  const { theme } = useTheme();
  // Read company prefixes non-throwingly: MarkdownBody renders in surfaces that
  // may lack a CompanyProvider. A null context (or no companies yet) leaves
  // knownPrefixes undefined, which keeps issue auto-linking permissive.
  const company = useOptionalCompany();
  const companies = company?.companies;
  // Stable identity so it can feed the memoized remark plugins without
  // re-creating them (and forcing a full markdown re-parse) every render.
  const knownPrefixes = useMemo(
    () => (companies?.length ? companies.map((c) => c.issuePrefix) : undefined),
    [companies],
  );
  // react-markdown treats the values of `components` as component *types* and
  // the `remarkPlugins` array by identity. Rebuilding either on every render
  // forces react-markdown to unmount/remount the rendered tree, which discards
  // scroll position and text selection and causes visible flashing when a
  // parent re-renders frequently (see PAP-10767). Memoize both so re-renders
  // that don't change the inputs are cheap and non-destructive.
  const remarkPlugins = useMemo<NonNullable<Options["remarkPlugins"]>>(() => {
    const plugins: NonNullable<Options["remarkPlugins"]> = [remarkGfm];
    if (enableWikiLinks) {
      plugins.push(createRemarkWikiLinks({ wikiLinkRoot, resolveWikiLinkHref }));
    }
    if (linkWorkspaceFileRefs) {
      plugins.push(remarkWorkspaceFileRefs);
    }
    if (linkIssueReferences) {
      plugins.push([remarkLinkIssueReferences, { knownPrefixes }]);
    }
    if (softBreaks) {
      plugins.push(remarkSoftBreaks);
    }
    return plugins;
  }, [enableWikiLinks, wikiLinkRoot, resolveWikiLinkHref, linkWorkspaceFileRefs, linkIssueReferences, knownPrefixes, softBreaks]);
  const components = useMemo<Components>(() => {
    const map: Components = {
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
    table: ({ node: _node, style: tableStyle, children: tableChildren, ...tableProps }) => (
      <div className="paperclip-markdown-table-scroll" role="region" aria-label="Scrollable table" tabIndex={0}>
        <table {...tableProps} style={tableStyle as React.CSSProperties | undefined}>
          {tableChildren}
        </table>
      </div>
    ),
    td: ({ node: _node, style: tableCellStyle, children: tableCellChildren, ...tableCellProps }) => (
      <td {...tableCellProps} style={mergeTableCellStyle(tableCellStyle as React.CSSProperties | undefined)}>
        {tableCellChildren}
      </td>
    ),
    th: ({ node: _node, style: tableHeaderStyle, children: tableHeaderChildren, ...tableHeaderProps }) => (
      <th {...tableHeaderProps} style={mergeTableCellStyle(tableHeaderStyle as React.CSSProperties | undefined)}>
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
    a: ({ node: _node, href, style: linkStyle, children: linkChildren, ...anchorProps }) => {
      const workspaceFileRef = parseWorkspaceFileHref(href);
      if (workspaceFileRef) {
        return (
          <WorkspaceFileLink
            workspaceFileRef={workspaceFileRef}
            label={linkChildren}
            className={typeof anchorProps.className === "string" ? anchorProps.className : undefined}
          />
        );
      }

      const dataProps = anchorProps as Record<string, unknown>;
      const isWikiLink = dataProps["data-paperclip-wiki-link"] === "true";
      if (isWikiLink && href && !/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith("//")) {
        return (
          <Link
            to={href}
            {...anchorProps}
            rel="noreferrer"
            style={mergeWrapStyle(linkStyle as React.CSSProperties | undefined)}
          >
            {linkChildren}
          </Link>
        );
      }

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
              : parsed.kind === "routine"
                ? `/routines/${parsed.routineId}`
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
      map.img = ({ node: _node, src, alt, ...imgProps }) => {
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
    return map;
  }, [theme, linkIssueReferences, resolveImageSrc, onImageClick]);

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

export const MarkdownBody = memo(MarkdownBodyImpl);
