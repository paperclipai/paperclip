import { resolveUiMessage, type UiMessageDescriptor } from "@/lib/localized-ui-error";
import { t, useTranslation, i18n, Trans } from "@/i18n";
import { PatchLines } from "./PatchLines";
import { MarkdownWordStreaming, rehypeStreamingWords } from "./MarkdownWordStreaming";
import { isValidElement, memo, useContext, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, MessageCircle, WrapText } from "lucide-react";
import { useCoordinatorPresentation } from "./coordinator/CoordinatorPresentation";
import { useCoordinatorChatReference } from "./coordinator/CoordinatorChatReferences";
import { SidebarDocumentLink } from "./SidebarDocumentLink";
import { parseDocumentAnnotationHash } from "@/lib/document-annotation-hash";
import Markdown, { defaultUrlTransform, type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/utils";
import { MarkdownUrlLink } from "./MarkdownUrlLink";
import { Link, useCaseHref } from "@/lib/router";
import { useTheme } from "../context/ThemeContext";
import { useOptionalCompany } from "../context/CompanyContext";
import { mentionChipInlineStyle, parseMentionChipHref } from "../lib/mention-chips";
import { issuesApi } from "../api/issues";
import { ApiError } from "../api/client";
import { LockedIssueChip } from "./LockedIssueChip";
import { agentsApi } from "../api/agents";
import { getCachedIssueDetail } from "../lib/issueDetailCache";
import { queryKeys } from "../lib/queryKeys";
import { parseIssueReferenceFromHref, remarkLinkIssueReferences } from "../lib/issue-reference";
import { remarkLinkCaseReferences } from "../lib/case-reference";

const CASE_HREF_RE = /^\/cases\/([A-Z][A-Z0-9]*-C\d+)$/i;

/** Recover the case identifier from a `/cases/PAP-C7` href produced by the plugin. */
function caseIdentifierFromHref(href: string | undefined): string | null {
  if (!href) return null;
  const match = decodeURIComponent(href.trim()).match(CASE_HREF_RE);
  return match ? match[1]!.toUpperCase() : null;
}
import {
  createRemarkWorkspaceFileRefs,
  parseWorkspaceFileHref,
  WORKSPACE_FILE_HREF_PREFIX,
  type WorkspaceFileRefResolver,
} from "../lib/remark-workspace-file-refs";
import { remarkSoftBreaks } from "../lib/remark-soft-breaks";
import { StatusIcon } from "./StatusIcon";
import { taskStatusIconProps } from "../lib/task-status-presentation";
import { WorkspaceFileLink } from "./WorkspaceFileLink";
import { ExternalObjectStatusIcon } from "./ExternalObjectStatusIcon";
import {
  externalObjectDisplayStatusLabel,
  externalObjectLivenessLabel,
  externalObjectProviderLabel,
} from "../lib/external-objects";
import { normalizeExternalObjectHref } from "../lib/external-object-href";
import { copyTextToClipboard } from "../lib/clipboard";
import type {
  Agent,
  ExternalObjectLivenessState,
  ExternalObjectStatusCategory,
} from "@paperclipai/shared";

function MarkdownAgentMention({ agentId, children, style }: {
  agentId: string;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  useTranslation("task-components");
  const companyId = useOptionalCompany()?.selectedCompanyId;
  // All mentions share the company list cache; never fetch one agent per chip.
  const { data: agents } = useQuery<Agent[]>({
    queryKey: queryKeys.agents.list(companyId ?? "__none__"),
    queryFn: () => agentsApi.list(companyId!),
    enabled: Boolean(companyId),
    staleTime: 60_000,
  });
  const appearance = agents?.find((agent) => agent.id === agentId)?.appearance;
  return (
    <a
      href={`/agents/${agentId}`}
      className="paperclip-mention-chip paperclip-mention-chip--agent"
      data-mention-kind="agent"
      style={{ ...mergeWrapStyle(style), ...mentionChipInlineStyle({ kind: "agent", agentId, icon: null, appearance }) }}
    >
      {children}
    </a>
  );
}

/**
 * Host-resolved external-object metadata for inline markdown decoration.
 * The renderer only consumes the host normalized fields here — plugin React
 * is never mounted inline (Phase 1B security review).
 */
export interface MarkdownExternalReference {
  providerKey: string | null;
  objectType: string | null;
  displayKey?: string | null;
  iconKey?: string | null;
  statusCategory: ExternalObjectStatusCategory;
  liveness: ExternalObjectLivenessState;
  statusLabel?: string | null;
  statusIconKey?: string | null;
  displayTitle?: string | null;
}

export type MarkdownExternalReferenceMap = Record<string, MarkdownExternalReference>;

interface MarkdownBodyProps {
  children: string;
  className?: string;
  style?: React.CSSProperties;
  softBreaks?: boolean;
  linkIssueReferences?: boolean;
  /**
   * Linkify bare case identifiers (`PAP-C7`) to the case detail page. Off by
   * default; enabled on surfaces behind the experimental Cases flag (PAP-12969).
   */
  linkCaseReferences?: boolean;
  /** Opt into Obsidian-style [[target]] / [[target|label]] wikilinks. */
  enableWikiLinks?: boolean;
  /** Base href used for wikilinks when no resolver is supplied. */
  wikiLinkRoot?: string;
  /** Optional href resolver for wikilinks. Return null to leave a token as plain text. */
  resolveWikiLinkHref?: (target: string, label: string) => string | null | undefined;
  /**
   * Optional map of `normalizeExternalObjectHref(href)` → host-resolved metadata.
   * Hrefs in the markdown that resolve to one of these keys get the inline
   * status icon prefix used by §2 of the UX spec.
   */
  externalReferences?: MarkdownExternalReferenceMap;
  /** Optional resolver for relative image paths (e.g. within export packages) */
  resolveImageSrc?: (src: string) => string | null;
  /** Resolve file links to app routes; null leaves the label without a link. */
  resolveLinkHref?: (href: string) => string | null;
  /** Called when a user clicks an inline image */
  onImageClick?: (src: string, image: HTMLImageElement) => void;
  /** Keep untrusted decision media inert: image references and diagram source only. */
  mediaMode?: "render" | "reference";
  /**
   * Resolver that decides which inline-code workspace file paths may be linked
   * to the issue file viewer. Omitting it (or returning null) leaves every
   * path-shaped code span as ordinary inline code — the fail-closed default.
   *
   * Its identity must change when previously-pending references become
   * openable, so the markdown re-parses with the new answers.
   */
  resolveWorkspaceFileRef?: WorkspaceFileRefResolver;
}

let mermaidLoaderPromise: Promise<typeof import("mermaid").default> | null = null;

function MarkdownIssueLink({
  issuePathId,
  href,
  children,
  documentLink = false,
}: {
  issuePathId: string;
  href: string;
  children: ReactNode;
  documentLink?: boolean;
}) {
  useTranslation("task-components");
  const queryClient = useQueryClient();
  const chatReference = useCoordinatorChatReference(issuePathId);
  const [engaged, setEngaged] = useState(false);
  const { data, error } = useQuery({
    queryKey: queryKeys.issues.detail(issuePathId),
    // A transcript can mention dozens of tasks. Their full detail projections
    // are hover information, not prerequisites for reading this conversation.
    enabled: engaged && (!chatReference || documentLink),
    placeholderData: getCachedIssueDetail(queryClient, issuePathId),
    queryFn: () => issuesApi.get(issuePathId),
    staleTime: 60_000,
    // A private issue 404s on direct fetch (indistinguishable from deleted, by
    // design). Don't burn retries on it — settle straight to the locked chip.
    retry: (failureCount, err) =>
      !(err instanceof ApiError && err.status === 404) && failureCount < 3,
  });

  if (chatReference && !documentLink) {
    const suffix = href.match(/[?#].*$/)?.[0] ?? "";
    return <Link to={`${chatReference.href}${suffix}`} disableIssueQuicklook
      className="font-normal underline" data-mention-kind="chat" aria-label={chatReference.label}>
      <MessageCircle aria-hidden className="relative -top-px mr-1 inline-block size-4 align-middle" />{chatReference.label}
    </Link>;
  }
  // Mention of an issue this viewer can't read → existence-only locked chip
  // (never a title or a link), matching the locked-stub treatment on edges.
  if (error instanceof ApiError && error.status === 404) {
    return <LockedIssueChip identifier={issuePathId} unavailable />;
  }

  if (documentLink) {
    return <SidebarDocumentLink href={href} variant="inline" onPointerEnter={() => setEngaged(true)} onFocus={() => setEngaged(true)}>
      <span className="underline underline-offset-4">{children}</span>
    </SidebarDocumentLink>;
  }

  const identifier = data?.identifier ?? issuePathId;
  const title = data?.title ?? identifier;
  const status = data?.status;
  // Same presentation inputs as every task view, so a covered blocked task is
  // the blue in-queue glyph here too, not the red blocked one (BUG-07).
  const statusIconProps = data && status ? taskStatusIconProps({ ...data, status }) : null;
  const issueLabel = title !== identifier ? t("final-components-a:issueIdentifierTitle_d7985502", { identifier: identifier, title: title }) : t("final-components-a:issueIdentifier_2a6ea444", { identifier: identifier });

  // Until the fetch settles we don't yet know whether this viewer can read the
  // issue. Keep the mention a plain link (clickable, styled as today) but hold
  // off mounting the IssueLinkQuicklook hover preview — a Radix Popover portal —
  // until `data` confirms the issue is readable.
  //   - Correctness (PAP-16070): a private mention 404s straight to the locked
  //     chip. Mounting the quicklook popover during the loading `<Link>` only to
  //     tear the portal down and swap in a plain `<span>` chip on the 404 is the
  //     element churn that crashed the chat transcript's primary renderer (it
  //     fell through to the safe fallback). Loading link → chip stays portal-free.
  //   - Privacy: don't prefetch / hover-preview an issue of unconfirmed
  //     readability. `data-mention-pending` marks the transient state for tests.
  const pending = !data;

  return (
    <Link
      to={href}
      data-mention-kind="issue"
      disableIssueQuicklook={pending}
      data-mention-pending={pending ? "true" : undefined}
      onPointerEnter={() => setEngaged(true)}
      onFocus={() => setEngaged(true)}
      // Boxless inline mention: the unified status glyph + a regular-weight
      // underlined link, optically centered with the body text.
      className={cn("paperclip-markdown-issue-ref", "font-normal underline")}
      title={title}
      aria-label={issueLabel}
    >
      {statusIconProps ? (
        <StatusIcon {...statusIconProps} size="md" className="relative -top-px mr-1 inline-block h-4 w-4 align-middle" />
      ) : null}
      {children}
    </Link>
  );
}

function MarkdownCaseLink({
  identifier,
  children,
}: {
  identifier: string;
  children: ReactNode;
}) {
  useTranslation("task-components");
  // Cases resolve via the get-by-identifier route; navigate there on click.
  // Kept boxless/underlined to match the issue mention treatment.
  const caseHref = useCaseHref();
  return (
    <Link
      to={caseHref(identifier)}
      data-mention-kind="case"
      className={cn("paperclip-markdown-case-ref", "font-normal underline")}
      aria-label={t("task-components:case_f868de0f", { value1: identifier })}
    >
      {children}
    </Link>
  );
}

function MarkdownExternalLink({
  href,
  reference,
  children,
}: {
  href: string;
  reference: MarkdownExternalReference;
  children: ReactNode;
}) {
  useTranslation("task-components");
  const provider = externalObjectProviderLabel(reference.providerKey);
  const displayKey = reference.displayKey?.trim() || provider;
  const statusLabel = externalObjectDisplayStatusLabel(reference);
  const livenessLabel = externalObjectLivenessLabel(reference.liveness);
  const livenessSuffix = reference.liveness === "fresh" || reference.liveness === "unknown"
    || livenessLabel.toLowerCase() === statusLabel.toLowerCase()
    ? ""
    : ` (${livenessLabel})`;
  const titleParts = [
    reference.displayTitle ?? `${displayKey} ${statusLabel}`,
    `${displayKey} — ${statusLabel}${livenessSuffix}`,
  ];
  const title = titleParts.filter(Boolean).join(" · ");
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-external-link="resolved"
      data-external-status={reference.statusCategory}
      data-external-liveness={reference.liveness}
      title={title}
      aria-label={`${displayKey} ${statusLabel}${livenessSuffix}: ${reference.displayTitle ?? href}`}
      className="paperclip-markdown-external-ref"
    >
      <ExternalObjectStatusIcon
        category={reference.statusCategory}
        liveness={reference.liveness}
        statusIconKey={reference.statusIconKey}
        label={`${displayKey}: ${statusLabel}`}
        inline
      />
      {children}
    </a>
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

export const codeBlockActionStyle: React.CSSProperties = {
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
  backgroundColor: "var(--background)",
  color: "var(--muted-foreground)",
  fontSize: "var(--text-micro)",
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

function isHtmlCommentNode(node: MarkdownAstNode) {
  return node.type === "html" && typeof node.value === "string" && /^<!--[\s\S]*-->$/.test(node.value.trim());
}

function isEscapedHtmlCommentPlaceholder(node: MarkdownAstNode) {
  if (node.type !== "text" || typeof node.value !== "string") return false;
  const value = node.value.trim();
  return /^\\?<!--(?:\s*-{0,2}>?)?$/.test(value) || /^&lt;!--(?:\s*-{0,2}(?:&gt;)?)?$/.test(value);
}

function remarkDropHtmlComments() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      const children = node.children;
      if (!children) return;
      node.children = children.filter((child) => !isHtmlCommentNode(child) && !isEscapedHtmlCommentPlaceholder(child));
      for (const child of node.children) {
        visit(child);
      }
    };
    visit(tree);
  };
}

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

function CodeBlock({
  children,
  preProps,
}: {
  children: ReactNode;
  preProps: React.HTMLAttributes<HTMLPreElement>;
}) {
  useTranslation("task-components");
  const code = Array.isArray(children) ? children.find(isValidElement) : children;
  const patchCode = isValidElement<{ className?: string; children?: ReactNode }>(code)
    && /\blanguage-(diff|patch)\b/i.test(code.props.className ?? "");
  const patchText = patchCode ? flattenText(code.props.children) : null;
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = useCallback(async () => {
    const text = patchText ?? preRef.current?.innerText ?? flattenText(children);
    try {
      await copyTextToClipboard(text);
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
  }, [children, patchText]);

  const copyLabel = failed ? t("task-components:copyFailed_5b50e7a6") : copied ? t("task-components:copied_ea61bc15") : t("task-components:copy_e21f935f");
  const wrapLabel = wrapLines ? t("final-components-a:unwrapLines_6de95a89") : t("final-components-a:wrapLines_6727132a");

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
        {patchText !== null ? <code className="language-diff"><PatchLines text={patchText} /></code> : children}
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
          aria-label={t("task-components:copyCode_49a0053f")}
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
  useTranslation("task-components");
  const renderId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | UiMessageDescriptor | null>(null);

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
            : { key: "final-components-a:failedToRenderMermaidDiagram_ce8bc46c" };
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
            {error ? t("task-components:unableToRenderMermaidDiagram_c64fb7c0", { value1: typeof error === "string" ? error : resolveUiMessage(error) }) : t("task-components:renderingMermaidDiagram_1cecfea4")}
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
  linkCaseReferences = false,
  enableWikiLinks = false,
  wikiLinkRoot,
  resolveWikiLinkHref,
  externalReferences,
  resolveImageSrc,
  resolveLinkHref,
  onImageClick,
  mediaMode = "render",
  resolveWorkspaceFileRef,
}: MarkdownBodyProps) {
  useTranslation("task-components");
  const { theme } = useTheme();
  const coordinator = useCoordinatorPresentation();
  const streamWords = useContext(MarkdownWordStreaming);
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
  const externalReferenceLookup = useMemo<MarkdownExternalReferenceMap | null>(() => {
    if (!externalReferences) return null;
    const lookup: MarkdownExternalReferenceMap = {};
    for (const [key, value] of Object.entries(externalReferences)) {
      const normalized = normalizeExternalObjectHref(key) ?? key;
      lookup[normalized] = value;
    }
    return lookup;
  }, [externalReferences]);
  // react-markdown treats the values of `components` as component *types* and
  // the `remarkPlugins` array by identity. Rebuilding either on every render
  // forces react-markdown to unmount/remount the rendered tree, which discards
  // scroll position and text selection and causes visible flashing when a
  // parent re-renders frequently (see PAP-10767). Memoize both so re-renders
  // that don't change the inputs are cheap and non-destructive.
  const remarkPlugins = useMemo<NonNullable<Options["remarkPlugins"]>>(() => {
    const plugins: NonNullable<Options["remarkPlugins"]> = [remarkGfm, remarkDropHtmlComments];
    if (enableWikiLinks) {
      plugins.push(createRemarkWikiLinks({ wikiLinkRoot, resolveWikiLinkHref }));
    }
    if (resolveWorkspaceFileRef) {
      plugins.push(createRemarkWorkspaceFileRefs(resolveWorkspaceFileRef));
    }
    if (linkIssueReferences) {
      plugins.push([remarkLinkIssueReferences, { knownPrefixes }]);
    }
    if (linkCaseReferences) {
      plugins.push([remarkLinkCaseReferences, { knownPrefixes }]);
    }
    if (softBreaks) {
      plugins.push(remarkSoftBreaks);
    }
    return plugins;
  }, [enableWikiLinks, wikiLinkRoot, resolveWikiLinkHref, resolveWorkspaceFileRef, linkIssueReferences, linkCaseReferences, knownPrefixes, softBreaks]);
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
      <div className="paperclip-markdown-table-scroll" role="region" aria-label={t("task-components:scrollableTable_92d78d88")} tabIndex={0}>
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
      if (mermaidSource && mediaMode === "render") {
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
      const documentHash = href?.includes("#") ? href.slice(href.indexOf("#")) : null;
      const documentLink = Boolean(coordinator && documentHash && parseDocumentAnnotationHash(documentHash));
      if (documentLink && href?.startsWith("#")) {
        return <SidebarDocumentLink href={href} variant="inline">
          <span className="underline underline-offset-4">{linkChildren}</span>
        </SidebarDocumentLink>;
      }
      if (issueRef) {
        return (
          <MarkdownIssueLink issuePathId={issueRef.issuePathId} href={issueRef.href} documentLink={documentLink}>
            {linkChildren}
          </MarkdownIssueLink>
        );
      }

      const caseIdentifier = linkCaseReferences ? caseIdentifierFromHref(href) : null;
      if (caseIdentifier) {
        return <MarkdownCaseLink identifier={caseIdentifier}>{linkChildren}</MarkdownCaseLink>;
      }

      const parsed = href ? parseMentionChipHref(href) : null;
      if (parsed) {
        if (parsed.kind === "agent") {
          return (
            <MarkdownAgentMention agentId={parsed.agentId} style={linkStyle as React.CSSProperties | undefined}>
              {linkChildren}
            </MarkdownAgentMention>
          );
        }
        const targetHref = parsed.kind === "project"
          ? `/projects/${parsed.projectId}`
          : parsed.kind === "issue"
            ? `/issues/${parsed.identifier}`
            : parsed.kind === "skill"
              ? `/skills/${parsed.skillId}`
              : parsed.kind === "routine"
                ? `/routines/${parsed.routineId}`
                : "/company/settings/access";
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
      const externalReference = href && externalReferenceLookup
        ? externalReferenceLookup[normalizeExternalObjectHref(href) ?? ""] ?? null
        : null;
      if (externalReference && href) {
        return (
          <MarkdownExternalLink href={href} reference={externalReference}>
            {linkChildren}
          </MarkdownExternalLink>
        );
      }

      const resolvedHref = href && resolveLinkHref ? resolveLinkHref(href) : href;
      if (resolveLinkHref && resolvedHref !== href) {
        return resolvedHref ? (
          <Link to={resolvedHref} style={mergeWrapStyle(linkStyle as React.CSSProperties | undefined)}>
            {linkChildren}
          </Link>
        ) : <>{linkChildren}</>;
      }
      return (
        <MarkdownUrlLink href={href} title={anchorProps.title} style={mergeWrapStyle(linkStyle as React.CSSProperties | undefined)}>
          {linkChildren}
        </MarkdownUrlLink>
      );
    },
    };
    if (mediaMode === "reference") {
      map.img = ({ src, alt, title }) => (
        <span data-markdown-image-reference title={title}><Trans ns="task-components" i18nKey="sentence_a93cc049cd58" components={{ part1: <>{alt || t("task-components:untitledImage_f0b95d1b")}</>, part2: <>{src ? ` (${src})` : ""}</> }} /></span>
      );
    } else if (resolveImageSrc || onImageClick) {
      map.img = ({ node: _node, src, alt, ...imgProps }) => {
        const resolved = resolveImageSrc && src ? resolveImageSrc(src) : null;
        const finalSrc = resolved ?? src;
        return (
          <img
            {...imgProps}
            src={finalSrc}
            alt={alt ?? ""}
            role={onImageClick && finalSrc ? "button" : undefined}
            tabIndex={onImageClick && finalSrc ? 0 : undefined}
            aria-label={onImageClick && finalSrc ? t("final-components-a:openImageName_67535003", { name: alt || t("final-components-a:untitledImage_f0b95d1b") }) : undefined}
            onClick={onImageClick && finalSrc ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onImageClick(finalSrc, e.currentTarget);
            } : undefined}
            onKeyDown={onImageClick && finalSrc ? (e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              e.stopPropagation();
              onImageClick(finalSrc, e.currentTarget);
            } : undefined}
            className={cn(imgProps.className, onImageClick && "cursor-pointer")}
          />
        );
      };
    }
    return map;
  }, [theme, coordinator, linkIssueReferences, linkCaseReferences, externalReferenceLookup, resolveImageSrc, resolveLinkHref, onImageClick, mediaMode, i18n.language]);

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
        rehypePlugins={streamWords ? [rehypeStreamingWords] : undefined}
        components={components}
        urlTransform={safeMarkdownUrlTransform}
      >
        {children}
      </Markdown>
    </div>
  );
}

export const MarkdownBody = memo(MarkdownBodyImpl);
