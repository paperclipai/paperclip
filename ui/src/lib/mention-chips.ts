import type { CSSProperties } from "react";
import { parseAgentMentionHref, parseProjectMentionHref, parseSkillMentionHref } from "@paperclipai/shared";
import { getAgentIcon } from "./agent-icons";
import { hexToRgb, pickTextColorForPillBg } from "./color-contrast";

export type ParsedMentionChip =
  | {
      kind: "agent";
      agentId: string;
      icon: string | null;
    }
  | {
      kind: "project";
      projectId: string;
      color: string | null;
    }
  | {
      kind: "skill";
      skillId: string;
      slug: string | null;
    };

const iconMaskCache = new Map<string, string>();

export function parseMentionChipHref(href: string): ParsedMentionChip | null {
  const agent = parseAgentMentionHref(href);
  if (agent) {
    return {
      kind: "agent",
      agentId: agent.agentId,
      icon: agent.icon,
    };
  }

  const project = parseProjectMentionHref(href);
  if (project) {
    return {
      kind: "project",
      projectId: project.projectId,
      color: project.color,
    };
  }

  const skill = parseSkillMentionHref(href);
  if (skill) {
    return {
      kind: "skill",
      skillId: skill.skillId,
      slug: skill.slug,
    };
  }

  return null;
}

export function mentionChipInlineStyle(mention: ParsedMentionChip): CSSProperties | undefined {
  const style: CSSProperties & Record<string, string> = {};

  if (mention.kind === "project" && mention.color) {
    const projectStyle = projectMentionColors(mention.color);
    Object.assign(style, projectStyle);
    style["--paperclip-mention-project-color"] = mention.color;
  }

  if (mention.kind === "agent") {
    const iconMask = buildAgentIconMask(mention.icon);
    if (iconMask) {
      style["--paperclip-mention-icon-mask"] = iconMask;
    }
  }

  return Object.keys(style).length > 0 ? (style as CSSProperties) : undefined;
}

export function applyMentionChipDecoration(element: HTMLElement, mention: ParsedMentionChip) {
  clearMentionChipDecoration(element);
  element.dataset.mentionKind = mention.kind;
  element.setAttribute("contenteditable", "false");
  element.classList.add("paperclip-mention-chip", `paperclip-mention-chip--${mention.kind}`);
  if (mention.kind === "project") {
    element.classList.add("paperclip-project-mention-chip");
  }

  const style = mentionChipInlineStyle(mention);
  if (!style) return;
  for (const [key, value] of Object.entries(style)) {
    if (typeof value === "string") {
      if (key.startsWith("--")) {
        element.style.setProperty(key, value);
      } else {
        (element.style as CSSStyleDeclaration & Record<string, string>)[key] = value;
      }
    }
  }
}

export function clearMentionChipDecoration(element: HTMLElement) {
  delete element.dataset.mentionKind;
  element.classList.remove(
    "paperclip-mention-chip",
    "paperclip-mention-chip--agent",
    "paperclip-mention-chip--project",
    "paperclip-mention-chip--skill",
    "paperclip-project-mention-chip",
  );
  element.removeAttribute("contenteditable");
  element.style.removeProperty("border-color");
  element.style.removeProperty("background-color");
  element.style.removeProperty("color");
  element.style.removeProperty("--paperclip-mention-project-color");
  element.style.removeProperty("--paperclip-mention-icon-mask");
}

function projectMentionColors(color: string): Pick<CSSProperties, "borderColor" | "backgroundColor" | "color"> {
  const rgb = hexToRgb(color);
  if (!rgb) return {};
  return {
    borderColor: color,
    backgroundColor: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.22)`,
    color: pickTextColorForPillBg(color),
  };
}

function buildAgentIconMask(iconName: string | null): string | null {
  const cacheKey = iconName ?? "__default__";
  const cached = iconMaskCache.get(cacheKey);
  if (cached) return cached;

  const Icon = getAgentIcon(iconName);
  const iconNode = resolveLucideIconNode(Icon);
  if (!Array.isArray(iconNode) || iconNode.length === 0) return null;

  const body = iconNode.map(([tag, attrs]) => {
    const attrString = Object.entries(attrs)
      .filter(([key]) => key !== "key")
      .map(([key, value]) => `${key}="${escapeAttribute(String(value))}"`)
      .join(" ");
    return `<${tag}${attrString ? ` ${attrString}` : ""}></${tag}>`;
  }).join("");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ` +
    `fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round">${body}</svg>`;
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  iconMaskCache.set(cacheKey, url);
  return url;
}

function resolveLucideIconNode(
  icon: unknown,
): Array<[string, Record<string, string>]> | null {
  const staticIconNode = (
    icon as {
      iconNode?: Array<[string, Record<string, string>]>;
    }
  ).iconNode;
  if (Array.isArray(staticIconNode) && staticIconNode.length > 0) {
    return staticIconNode;
  }

  const render = (
    icon as {
      render?: (props: Record<string, unknown>, ref: unknown) => {
        props?: { iconNode?: Array<[string, Record<string, string>]> };
      } | null;
    }
  ).render;
  const rendered = typeof render === "function" ? render({}, null) : null;
  const renderedIconNode = rendered?.props?.iconNode;
  return Array.isArray(renderedIconNode) && renderedIconNode.length > 0
    ? renderedIconNode
    : null;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
