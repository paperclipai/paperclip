import { cloneElement, isValidElement, type CSSProperties, type ReactNode } from "react";
import { CircleDot, ExternalLink, GitPullRequest } from "lucide-react";
import { GithubIcon } from "./icons/github-icon";
import { parseGitHubLink } from "@/lib/github-link";

function isExternalHttpUrl(href: string | undefined): boolean {
  if (!href) return false;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return typeof window === "undefined" || url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

function renderLinkBody(children: ReactNode, leadingIcon: ReactNode, trailingIcon: ReactNode): ReactNode {
  if (!leadingIcon && !trailingIcon) return children;
  if (typeof children !== "string" || !children.length) return <>{leadingIcon}{children}{trailingIcon}</>;
  if (children.length === 1) {
    return <span style={{ whiteSpace: "nowrap" }}>{leadingIcon}{children}{trailingIcon}</span>;
  }
  return <>
    {leadingIcon ? <span style={{ whiteSpace: "nowrap" }}>{leadingIcon}{children[0]}</span> : children[0]}
    {children.slice(1, -1)}
    {trailingIcon ? <span style={{ whiteSpace: "nowrap" }}>{children.at(-1)}{trailingIcon}</span> : children.at(-1)}
  </>;
}

function compactUrlLabel(children: ReactNode, href: string | undefined, label: string): ReactNode {
  if (children === href) return label;
  const child = Array.isArray(children) && children.length === 1 ? children[0] : children;
  if (
    isValidElement<{ className?: string; children?: ReactNode }>(child)
    && child.type === "span"
    && child.props.className?.split(/\s+/).includes("conversation-stream-word")
    && child.props.children === href
  ) {
    return cloneElement(child, undefined, label);
  }
  return children;
}

export function MarkdownUrlLink({ href, children, title, style }: {
  href?: string;
  children: ReactNode;
  title?: string;
  style?: CSSProperties;
}) {
  const github = parseGitHubLink(href);
  const external = isExternalHttpUrl(href);
  const Icon = github?.kind === "pull_request" ? GitPullRequest : github?.kind === "issue" ? CircleDot : GithubIcon;
  const label = github?.label ? compactUrlLabel(children, href, github.label) : children;
  const leadingIcon = github ? <Icon aria-hidden="true" className="mr-1 inline h-3.5 w-3.5 align-(--va-0_125em)" /> : null;
  const trailingIcon = external && !github ? <ExternalLink aria-hidden="true" className="ml-1 inline h-3 w-3 align-(--va-0_125em)" /> : null;
  return <a
    href={href}
    {...(external ? { target: "_blank", rel: "noopener noreferrer" } : { rel: "noreferrer" })}
    data-github-link={github?.kind}
    title={title ?? (github ? `${github.description}\n${href}` : undefined)}
    style={style}
  >
    {github ? <span className="sr-only">{github.kind === "pull_request" ? "GitHub pull request: " : github.kind === "issue" ? "GitHub issue: " : "GitHub: "}</span> : null}
    {renderLinkBody(label, leadingIcon, trailingIcon)}
  </a>;
}
