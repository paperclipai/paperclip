import { deriveAgentUrlKey } from "./agent-url-key.js";

export const PROJECT_MENTION_SCHEME = "project://";
export const AGENT_MENTION_SCHEME = "agent://";
export const USER_MENTION_SCHEME = "user://";
export const SKILL_MENTION_SCHEME = "skill://";
export const ROUTINE_MENTION_SCHEME = "routine://";
export const PIPELINE_MENTION_SCHEME = "pipeline://";

const HEX_COLOR_RE = /^[0-9a-f]{6}$/i;
const HEX_COLOR_SHORT_RE = /^[0-9a-f]{3}$/i;
const HEX_COLOR_WITH_HASH_RE = /^#[0-9a-f]{6}$/i;
const HEX_COLOR_SHORT_WITH_HASH_RE = /^#[0-9a-f]{3}$/i;
const PROJECT_MENTION_LINK_RE = /\[[^\]]*]\((project:\/\/[^)\s]+)\)/gi;
const AGENT_MENTION_LINK_RE = /\[[^\]]*]\((agent:\/\/[^)\s]+)\)/gi;
const USER_MENTION_LINK_RE = /\[[^\]]*]\((user:\/\/[^)\s]+)\)/gi;
const SKILL_MENTION_LINK_RE = /\[[^\]]*]\((skill:\/\/[^)\s]+)\)/gi;
const ROUTINE_MENTION_LINK_RE = /\[[^\]]*]\((routine:\/\/[^)\s]+)\)/gi;
const PIPELINE_MENTION_LINK_RE = /\[[^\]]*]\((pipeline:\/\/[^)\s]+)\)/gi;
const AGENT_ICON_NAME_RE = /^[a-z0-9-]+$/i;
const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;

export interface ParsedProjectMention {
  projectId: string;
  color: string | null;
}

export interface ParsedAgentMention {
  agentId: string;
  icon: string | null;
}

export interface ParsedUserMention {
  userId: string;
}

export interface ParsedSkillMention {
  skillId: string;
  slug: string | null;
}

export interface ParsedRoutineMention {
  routineId: string;
}

export interface ParsedPipelineMention {
  pipelineId: string;
  stageKey: string | null;
}

function normalizeHexColor(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (HEX_COLOR_WITH_HASH_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (HEX_COLOR_RE.test(trimmed)) {
    return `#${trimmed.toLowerCase()}`;
  }
  if (HEX_COLOR_SHORT_WITH_HASH_RE.test(trimmed)) {
    const raw = trimmed.slice(1).toLowerCase();
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
  }
  if (HEX_COLOR_SHORT_RE.test(trimmed)) {
    const raw = trimmed.toLowerCase();
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
  }
  return null;
}

export function buildProjectMentionHref(projectId: string, color?: string | null): string {
  const trimmedProjectId = projectId.trim();
  const normalizedColor = normalizeHexColor(color ?? null);
  if (!normalizedColor) {
    return `${PROJECT_MENTION_SCHEME}${trimmedProjectId}`;
  }
  return `${PROJECT_MENTION_SCHEME}${trimmedProjectId}?c=${encodeURIComponent(normalizedColor.slice(1))}`;
}

export function parseProjectMentionHref(href: string): ParsedProjectMention | null {
  if (!href.startsWith(PROJECT_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "project:") return null;

  const projectId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!projectId) return null;

  const color = normalizeHexColor(url.searchParams.get("c") ?? url.searchParams.get("color"));

  return {
    projectId,
    color,
  };
}

export function buildAgentMentionHref(agentId: string, icon?: string | null): string {
  const trimmedAgentId = agentId.trim();
  const normalizedIcon = normalizeAgentIcon(icon ?? null);
  if (!normalizedIcon) {
    return `${AGENT_MENTION_SCHEME}${trimmedAgentId}`;
  }
  return `${AGENT_MENTION_SCHEME}${trimmedAgentId}?i=${encodeURIComponent(normalizedIcon)}`;
}

export function parseAgentMentionHref(href: string): ParsedAgentMention | null {
  if (!href.startsWith(AGENT_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "agent:") return null;

  const agentId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!agentId) return null;

  return {
    agentId,
    icon: normalizeAgentIcon(url.searchParams.get("i") ?? url.searchParams.get("icon")),
  };
}

export function buildUserMentionHref(userId: string): string {
  return `${USER_MENTION_SCHEME}${userId.trim()}`;
}

export function parseUserMentionHref(href: string): ParsedUserMention | null {
  if (!href.startsWith(USER_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "user:") return null;

  const userId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!userId) return null;

  return { userId };
}

export function buildSkillMentionHref(skillId: string, slug?: string | null): string {
  const trimmedSkillId = skillId.trim();
  const normalizedSlug = normalizeSkillSlug(slug ?? null);
  if (!normalizedSlug) {
    return `${SKILL_MENTION_SCHEME}${trimmedSkillId}`;
  }
  return `${SKILL_MENTION_SCHEME}${trimmedSkillId}?s=${encodeURIComponent(normalizedSlug)}`;
}

export function parseSkillMentionHref(href: string): ParsedSkillMention | null {
  if (!href.startsWith(SKILL_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "skill:") return null;

  const skillId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!skillId) return null;

  return {
    skillId,
    slug: normalizeSkillSlug(url.searchParams.get("s") ?? url.searchParams.get("slug")),
  };
}

export function buildRoutineMentionHref(routineId: string): string {
  return `${ROUTINE_MENTION_SCHEME}${routineId.trim()}`;
}

export function parseRoutineMentionHref(href: string): ParsedRoutineMention | null {
  if (!href.startsWith(ROUTINE_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "routine:") return null;

  const routineId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!routineId) return null;

  return { routineId };
}

export function buildPipelineMentionHref(pipelineId: string, stageKey?: string | null): string {
  const trimmedPipelineId = pipelineId.trim();
  const normalizedStageKey = stageKey?.trim();
  if (!normalizedStageKey) return `${PIPELINE_MENTION_SCHEME}${trimmedPipelineId}`;
  return `${PIPELINE_MENTION_SCHEME}${trimmedPipelineId}?stage=${encodeURIComponent(normalizedStageKey)}`;
}

export function parsePipelineMentionHref(href: string): ParsedPipelineMention | null {
  if (!href.startsWith(PIPELINE_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "pipeline:") return null;

  const pipelineId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!pipelineId) return null;

  const stageKey = url.searchParams.get("stage")?.trim() || null;
  return { pipelineId, stageKey };
}

export function extractProjectMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(PROJECT_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseProjectMentionHref(match[1]);
    if (parsed) ids.add(parsed.projectId);
  }
  return [...ids];
}

export function extractAgentMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(AGENT_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseAgentMentionHref(match[1]);
    if (parsed) ids.add(parsed.agentId);
  }
  return [...ids];
}

export interface BareAgentMentionTarget {
  id: string;
  name: string;
}

type MarkdownContainerToken =
  | { kind: "blockquote" }
  | { kind: "list"; continuationWidth: number };

function stripFencedAndIndentedMarkdownCode(markdown: string) {
  let fenceCharacter: "`" | "~" | null = null;
  let fenceLength = 0;
  let fenceContainers: MarkdownContainerToken[] = [];
  return markdown.split(/\r\n?|\n/).map((line) => {
    const parsedLine = parseMarkdownContainerPrefix(line);
    const structuralLine = fenceCharacter
      ? stripExpectedMarkdownContainerPrefix(line, fenceContainers)
      : parsedLine.structuralLine;
    const fenceMatch = structuralLine == null
      ? null
      : /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(structuralLine);
    const fence = fenceMatch?.[1] ?? null;
    const fenceSuffix = fenceMatch?.[2] ?? "";
    if (fenceCharacter) {
      if (
        fence?.[0] === fenceCharacter
        && fence.length >= fenceLength
        && /^[ \t]*$/.test(fenceSuffix)
      ) {
        fenceCharacter = null;
        fenceLength = 0;
        fenceContainers = [];
      }
      return " ";
    }
    if (structuralLine == null) return " ";
    if (fence && !(fence[0] === "`" && fenceSuffix.includes("`"))) {
      fenceCharacter = fence[0] as "`" | "~";
      fenceLength = fence.length;
      fenceContainers = parsedLine.containers;
      return " ";
    }
    if (/^(?: {4}|\t)/.test(structuralLine)) return " ";
    if (/^ {0,3}(?:> ?)+(?: {4}|\t)/.test(line)) return " ";
    if (/^ {0,3}(?:[-+*]|\d+[.)])[ \t]{5,}/.test(line)) return " ";
    return line;
  }).join("\n");
}

function maskInlineCodeSpans(markdown: string) {
  const chars = markdown.split("");
  for (let start = 0; start < chars.length;) {
    if (chars[start] !== "`") {
      start += 1;
      continue;
    }
    let openerEnd = start;
    while (chars[openerEnd] === "`") openerEnd += 1;
    const delimiterLength = openerEnd - start;
    const lineStart = markdown.lastIndexOf("\n", start - 1) + 1;
    const structuralPrefix = stripMarkdownContainerPrefix(markdown.slice(lineStart, start));
    if (delimiterLength >= 3 && /^ {0,3}$/.test(structuralPrefix)) {
      start = openerEnd;
      continue;
    }
    let closeStart = openerEnd;
    let closeEnd = openerEnd;
    while (closeStart < chars.length) {
      if (chars[closeStart] !== "`") {
        closeStart += 1;
        continue;
      }
      closeEnd = closeStart;
      while (chars[closeEnd] === "`") closeEnd += 1;
      if (closeEnd - closeStart === delimiterLength) break;
      closeStart = closeEnd;
    }
    if (closeStart >= chars.length) {
      start = openerEnd;
      continue;
    }
    chars.fill(" ", start, closeEnd);
    start = closeEnd;
  }
  return chars.join("");
}

function maskRange(chars: string[], start: number, endExclusive: number) {
  for (let index = start; index < endExclusive; index += 1) {
    if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
  }
}

function findInlineLinkEnd(chars: string[], openParen: number) {
  let cursor = openParen + 1;
  while (/\s/.test(chars[cursor] ?? "")) cursor += 1;

  if (chars[cursor] === "<") {
    cursor += 1;
    let foundClosingAngle = false;
    for (; cursor < chars.length; cursor += 1) {
      if (chars[cursor] === "\\") {
        cursor += 1;
        continue;
      }
      if (chars[cursor] === ">") {
        cursor += 1;
        foundClosingAngle = true;
        break;
      }
    }
    if (!foundClosingAngle) return null;
    if (chars[cursor] !== ")" && !/\s/.test(chars[cursor] ?? "")) return null;
  } else {
    let nestedParens = 0;
    for (; cursor < chars.length; cursor += 1) {
      if (chars[cursor] === "\\") {
        cursor += 1;
        continue;
      }
      if (chars[cursor] === "(") {
        nestedParens += 1;
        continue;
      }
      if (chars[cursor] === ")") {
        if (nestedParens === 0) return cursor + 1;
        nestedParens -= 1;
        continue;
      }
      if (nestedParens === 0 && /\s/.test(chars[cursor] ?? "")) break;
    }
  }

  while (/\s/.test(chars[cursor] ?? "")) cursor += 1;
  if (chars[cursor] === ")") return cursor + 1;

  const titleOpener = chars[cursor];
  if (!(titleOpener === "\"" || titleOpener === "'" || titleOpener === "(")) return null;
  const titleCloser = titleOpener === "(" ? ")" : titleOpener;
  cursor += 1;
  let foundTitleCloser = false;
  for (; cursor < chars.length; cursor += 1) {
    if (chars[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (chars[cursor] === titleCloser) {
      cursor += 1;
      foundTitleCloser = true;
      break;
    }
  }
  if (!foundTitleCloser) return null;
  while (/\s/.test(chars[cursor] ?? "")) cursor += 1;
  return chars[cursor] === ")" ? cursor + 1 : null;
}

function normalizeReferenceLabel(label: string) {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function isEscapedAt(source: readonly string[], index: number) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function parseMarkdownContainerPrefix(line: string) {
  let structuralLine = line;
  const containers: MarkdownContainerToken[] = [];
  while (true) {
    const blockquote = /^ {0,3}> ?/.exec(structuralLine);
    if (blockquote) {
      containers.push({ kind: "blockquote" });
      structuralLine = structuralLine.slice(blockquote[0].length);
      continue;
    }
    const listItem = /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/.exec(structuralLine);
    if (listItem) {
      containers.push({ kind: "list", continuationWidth: listItem[0].length });
      structuralLine = structuralLine.slice(listItem[0].length);
      continue;
    }
    return { structuralLine, containers };
  }
}

function stripMarkdownContainerPrefix(line: string) {
  return parseMarkdownContainerPrefix(line).structuralLine;
}

function stripExpectedMarkdownContainerPrefix(
  line: string,
  containers: readonly MarkdownContainerToken[],
) {
  let structuralLine = line;
  for (const container of containers) {
    if (container.kind === "blockquote") {
      const blockquote = /^ {0,3}> ?/.exec(structuralLine);
      if (!blockquote) return null;
      structuralLine = structuralLine.slice(blockquote[0].length);
      continue;
    }
    const continuation = new RegExp(`^ {${container.continuationWidth}}`).exec(structuralLine);
    if (!continuation) return null;
    structuralLine = structuralLine.slice(continuation[0].length);
  }
  return structuralLine;
}

function parseMarkdownReferenceDefinition(line: string) {
  const leading = /^ {0,3}/.exec(line)?.[0].length ?? 0;
  if (line[leading] !== "[") return null;
  let label = "";
  for (let cursor = leading + 1; cursor < line.length; cursor += 1) {
    const character = line[cursor];
    if (character === "\\" && cursor + 1 < line.length) {
      label += `${character}${line[cursor + 1]}`;
      cursor += 1;
      continue;
    }
    if (character === "]" && line[cursor + 1] === ":") {
      return { label, remainder: line.slice(cursor + 2) };
    }
    label += character;
  }
  return null;
}

type ReferenceTitleCloser = "\"" | "'" | ")";

function findUnclosedReferenceTitle(value: string): ReferenceTitleCloser | null {
  for (let index = 0; index < value.length; index += 1) {
    const opener = value[index];
    if (!(opener === "\"" || opener === "'" || opener === "(")) continue;
    if (index > 0 && !/\s/.test(value[index - 1] ?? "")) continue;
    const closer: ReferenceTitleCloser = opener === "(" ? ")" : opener;
    for (let cursor = index + 1; cursor < value.length; cursor += 1) {
      if (value[cursor] === "\\") {
        cursor += 1;
        continue;
      }
      if (value[cursor] === closer) return null;
    }
    return closer;
  }
  return null;
}

function containsUnescapedReferenceTitleCloser(value: string, closer: ReferenceTitleCloser) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += 1;
      continue;
    }
    if (value[index] === closer) return true;
  }
  return false;
}

function stripMarkdownReferenceDefinitions(markdown: string) {
  const labels = new Set<string>();
  const lines = markdown.split(/\r\n?|\n/);
  const masked = [...lines];
  for (let index = 0; index < lines.length; index += 1) {
    const structuralLine = stripMarkdownContainerPrefix(lines[index] ?? "");
    const definition = parseMarkdownReferenceDefinition(structuralLine);
    if (!definition) continue;
    labels.add(normalizeReferenceLabel(definition.label));
    masked[index] = " ".repeat((lines[index] ?? "").length);

    let lastMasked = index;
    let openTitleCloser = findUnclosedReferenceTitle(definition.remainder);
    if (!definition.remainder.trim()) {
      const destinationIndex = index + 1;
      const destination = stripMarkdownContainerPrefix(lines[destinationIndex] ?? "");
      if (destination.trim() && !parseMarkdownReferenceDefinition(destination)) {
        masked[destinationIndex] = " ".repeat((lines[destinationIndex] ?? "").length);
        lastMasked = destinationIndex;
        openTitleCloser = findUnclosedReferenceTitle(destination);
      }
    }

    if (!openTitleCloser) {
      const titleIndex = lastMasked + 1;
      const title = stripMarkdownContainerPrefix(lines[titleIndex] ?? "").trimStart();
      if (/^["'(]/.test(title)) {
        masked[titleIndex] = " ".repeat((lines[titleIndex] ?? "").length);
        lastMasked = titleIndex;
        openTitleCloser = findUnclosedReferenceTitle(title);
      }
    }

    while (openTitleCloser && lastMasked + 1 < lines.length) {
      const continuationIndex = lastMasked + 1;
      const continuation = stripMarkdownContainerPrefix(lines[continuationIndex] ?? "");
      masked[continuationIndex] = " ".repeat((lines[continuationIndex] ?? "").length);
      lastMasked = continuationIndex;
      if (containsUnescapedReferenceTitleCloser(continuation, openTitleCloser)) {
        openTitleCloser = null;
      }
    }
    index = lastMasked;
  }
  return { markdown: masked.join("\n"), labels };
}

function maskMarkdownInlineLinks(markdown: string, referenceLabels: ReadonlySet<string>) {
  const chars = markdown.split("");
  for (let start = 0; start < chars.length; start += 1) {
    if (chars[start] !== "[" || isEscapedAt(chars, start)) continue;
    let bracketDepth = 1;
    let labelEnd = start + 1;
    for (; labelEnd < chars.length && bracketDepth > 0; labelEnd += 1) {
      if (chars[labelEnd] === "\\") {
        labelEnd += 1;
        continue;
      }
      if (chars[labelEnd] === "[") bracketDepth += 1;
      if (chars[labelEnd] === "]") bracketDepth -= 1;
    }
    if (bracketDepth !== 0) continue;

    const maskStart = start > 0 && chars[start - 1] === "!" ? start - 1 : start;
    if (chars[labelEnd] === "(") {
      const destinationEnd = findInlineLinkEnd(chars, labelEnd);
      if (destinationEnd !== null) {
        maskRange(chars, maskStart, destinationEnd);
        start = destinationEnd - 1;
        continue;
      }
    }

    if (chars[labelEnd] === "[") {
      let referenceEnd = labelEnd + 1;
      for (; referenceEnd < chars.length; referenceEnd += 1) {
        if (chars[referenceEnd] === "\\") {
          referenceEnd += 1;
          continue;
        }
        if (chars[referenceEnd] === "]") {
          referenceEnd += 1;
          break;
        }
      }
      maskRange(chars, maskStart, referenceEnd);
      start = referenceEnd - 1;
      continue;
    }

    const label = chars.slice(start + 1, labelEnd - 1).join("");
    if (referenceLabels.has(normalizeReferenceLabel(label))) {
      maskRange(chars, maskStart, labelEnd);
      start = labelEnd - 1;
    }
  }
  return chars.join("");
}

function findHtmlTagEnd(chars: string[], start: number) {
  let quote: "\"" | "'" | null = null;
  for (let end = start + 1; end < chars.length; end += 1) {
    const char = chars[end];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return end + 1;
  }
  return chars.length;
}

function maskRawHtmlBodies(markdown: string) {
  const chars = markdown.split("");
  const lower = markdown.toLowerCase();
  const openingTagRe = /<(script|style|textarea|title|code|pre)\b/gi;
  for (const match of markdown.matchAll(openingTagRe)) {
    const start = match.index ?? 0;
    const openingEnd = findHtmlTagEnd(chars, start);
    const tagName = (match[1] ?? "").toLowerCase();
    const closingTag = new RegExp(`</${tagName}(?=[\\s/>])`, "gi");
    closingTag.lastIndex = openingEnd;
    const closingStart = closingTag.exec(lower)?.index ?? -1;
    const end = closingStart >= 0 ? findHtmlTagEnd(chars, closingStart) : chars.length;
    maskRange(chars, start, end);
  }
  return chars.join("");
}

function maskHtmlLikeTags(markdown: string) {
  const chars = markdown.split("");
  for (let start = 0; start < chars.length; start += 1) {
    if (chars[start] !== "<") continue;
    const end = findHtmlTagEnd(chars, start);
    maskRange(chars, start, end);
    start = end - 1;
  }
  return chars.join("");
}

function stripEmailLookalikes(markdown: string) {
  return markdown.replace(
    /[\p{L}\p{N}!#$%&'*+\-/=?^_`{|}~.]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/gu,
    (candidate) => " ".repeat(candidate.length),
  );
}

function stripBareMentionIgnoredContexts(markdown: string) {
  const emailStripped = stripEmailLookalikes(markdown);
  const codeStripped = stripFencedAndIndentedMarkdownCode(maskInlineCodeSpans(emailStripped))
    .replace(/`[^\n]*$/gm, " ")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/gi, " ");
  const references = stripMarkdownReferenceDefinitions(codeStripped);
  const rawHtmlStripped = maskRawHtmlBodies(references.markdown);
  return maskHtmlLikeTags(maskMarkdownInlineLinks(rawHtmlStripped, references.labels))
    .replace(/\b[a-z][a-z0-9+.-]*:[^\s<]+/gi, " ")
    .replace(/\bwww\.[^\s<]+/gi, " ")
    .replace(/(?:^|[\s(])(?:\/|\.\/|\.\.\/)[^\s<]*/g, " ");
}

/**
 * Resolve visible `@handle` text to unique agent ids. Structured mention links
 * remain authoritative; callers should only use this as their fallback.
 */
export function extractBareAgentMentionIds(
  markdown: string,
  targets: readonly BareAgentMentionTarget[],
): string[] {
  if (!markdown || targets.length === 0) return [];
  const delimiterNormalized = markdown.replace(
    /(?<![\p{L}\p{N}_*~])(\*{1,2}|_{1,2}|~~)(@[A-Za-z0-9_][A-Za-z0-9_-]*?)\1(?=$|[\s)\]},.:;!?"'”’])(?![*_~])/gu,
    (_match, delimiter: string, mention: string) =>
      `${" ".repeat(delimiter.length)}${mention}${" ".repeat(delimiter.length)}`,
  );
  const source = stripBareMentionIgnoredContexts(delimiterNormalized);
  const idsByAlias = new Map<string, Set<string>>();
  for (const target of targets) {
    const aliases = new Set([
      target.name.trim().toLowerCase(),
      deriveAgentUrlKey(target.name, target.id),
    ].filter((alias): alias is string => Boolean(alias)));
    for (const alias of aliases) {
      const ids = idsByAlias.get(alias) ?? new Set<string>();
      ids.add(target.id);
      idsByAlias.set(alias, ids);
    }
  }
  const ids = new Set<string>();
  const bareMentionRe = /@([A-Za-z0-9_][A-Za-z0-9_-]*)/g;
  for (const match of source.matchAll(bareMentionRe)) {
    const mentionIndex = match.index ?? 0;
    const previous = source[mentionIndex - 1] ?? "";
    const beforePrevious = source[mentionIndex - 2] ?? "";
    const suffix = source.slice(mentionIndex + match[0].length);
    const next = suffix[0] ?? "";
    if (next && /[\p{L}\p{N}_\/@\\]/u.test(next)) continue;
    if (/^\.[\p{L}\p{N}]/u.test(suffix)) continue;
    const isSafePunctuation = (value: string) =>
      /[\p{P}\p{S}]/u.test(value) && !/[:./\\'@\-*_~]/.test(value);
    const isBasicBoundary = (value: string) =>
      /[\s([{,;!?]/.test(value) || isSafePunctuation(value);
    let hasSafeBoundary = mentionIndex === 0 || isBasicBoundary(previous);
    if (["*", "_", "~"].includes(previous)) {
      let delimiterStart = mentionIndex - 1;
      while (delimiterStart > 0 && source[delimiterStart - 1] === previous) delimiterStart -= 1;
      hasSafeBoundary = delimiterStart === 0 || isBasicBoundary(source[delimiterStart - 1] ?? "");
    }
    if (["\"", "'", "“", "‘"].includes(previous)) {
      hasSafeBoundary = mentionIndex === 1 || isBasicBoundary(beforePrevious);
    }
    if (!hasSafeBoundary) continue;
    const candidates = idsByAlias.get((match[1] ?? "").toLowerCase());
    if (candidates?.size === 1) {
      ids.add(candidates.values().next().value as string);
    }
  }
  return [...ids];
}

export function extractUserMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(USER_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseUserMentionHref(match[1]);
    if (parsed) ids.add(parsed.userId);
  }
  return [...ids];
}

export function extractSkillMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(SKILL_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseSkillMentionHref(match[1]);
    if (parsed) ids.add(parsed.skillId);
  }
  return [...ids];
}

export function extractRoutineMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(ROUTINE_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parseRoutineMentionHref(match[1]);
    if (parsed) ids.add(parsed.routineId);
  }
  return [...ids];
}

export function extractPipelineMentions(markdown: string): ParsedPipelineMention[] {
  if (!markdown) return [];
  const seen = new Set<string>();
  const mentions: ParsedPipelineMention[] = [];
  const re = new RegExp(PIPELINE_MENTION_LINK_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const parsed = parsePipelineMentionHref(match[1]);
    if (!parsed) continue;
    const key = `${parsed.pipelineId}:${parsed.stageKey ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push(parsed);
  }
  return mentions;
}

function normalizeAgentIcon(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || !AGENT_ICON_NAME_RE.test(trimmed)) return null;
  return trimmed;
}

function normalizeSkillSlug(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || !SKILL_SLUG_RE.test(trimmed)) return null;
  return trimmed;
}
