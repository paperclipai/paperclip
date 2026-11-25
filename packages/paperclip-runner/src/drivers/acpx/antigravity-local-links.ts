import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve, sep } from "node:path";
import type { AcpRuntimeEvent } from "acpx/runtime";
import { localTarget, workspaceRelativePath } from "../../live/workspace-file-reference.js";

/**
 * Google Antigravity (the registry ACP server and the CLI's swarm alike) links
 * the files it wrote as absolute local `file:///…/<company>/<task>/a.txt` URLs.
 * The person reads that reply in the task thread, where a local path and its
 * ids mean nothing and a file:// link opens nothing. Before the reply leaves
 * the Runner, a link to a file in the task folder becomes its folder-relative
 * path in code (`notes/a.txt`; the thread opens a nested path as a task-folder
 * file, while a root-level name stays plain text beside its deliverable link),
 * any other file:// link keeps only its label, and a bare task-folder path
 * loses its local prefix. Other text, including `/api/...` links, is unchanged.
 */
const LINK = /\[([^\]\n]{0,300})\]\((<[^>\n]+>|[^)\s]+)\)/g;
const FILE_URL = /file:\/\/[^\s)\]>"'`]+/g;
const UNFINISHED_LINK = /^\[[^\]\n]{0,300}(?:\]\((?:<[^>\n]*|[^)\s]*))?\]?$/;
const UNFINISHED_FILE_URL = /(?:f(?:i(?:l(?:e(?::(?:\/(?:\/[^\s)\]>"'`]*)?)?)?)?)?)?)$/;
const HOLD_MAX = 4_096;

/** A file:// or absolute link target, decoded with the shared workspace file-reference rules; null for anything else. */
function decodeTarget(raw: string): { path: string; fileUrl: boolean } | null {
  const fileUrl = /^<?file:\/\//i.test(raw.trim());
  const parsed = localTarget(raw);
  if (!parsed || (!fileUrl && !isAbsolute(parsed.target))) return null;
  return { path: parsed.target, fileUrl };
}

function insideRoot(roots: readonly string[], path: string): string | null {
  for (const root of roots) {
    const candidate = workspaceRelativePath(root, resolve(root, path));
    if (candidate) return candidate;
  }
  return null;
}

/** Punctuation that can close a sentence or Markdown emphasis right after a path. */
const CLOSING = ".,;:!?)\\]}\"'`*_";
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const code = (path: string) => `\`${path}\``;

export function neutralizeAntigravityLocalLinks(text: string, roots: readonly string[]): string {
  let value = text.replace(LINK, (whole, label: string, target: string) => {
    const decoded = decodeTarget(target);
    if (!decoded) return whole;
    const path = insideRoot(roots, decoded.path);
    if (path === null) return decoded.fileUrl ? label : whole;
    const name = label.replace(/^`|`$/g, "").trim();
    return name === path || name === basename(path) || !name ? code(path) : `${label} (${code(path)})`;
  });
  value = value.replace(FILE_URL, match => {
    // Sentence punctuation after a bare URL belongs to the sentence, not the file name.
    const url = match.replace(/[.,;:!?]+$/, "");
    const decoded = decodeTarget(url);
    if (!decoded) return match;
    return code(insideRoot(roots, decoded.path) ?? basename(decoded.path)) + match.slice(url.length);
  });
  for (const root of roots) {
    // The task folder itself: not followed by more of its own name, or by a slash and a child name
    // (a trailing slash counts only before the end, a break, or closing punctuation). Children are handled next.
    value = value.replace(new RegExp(`${escapeRegExp(root)}(?:/(?=$|\\s|[${CLOSING}]+(?:\\s|$))|(?![\\w/-]|\\.\\w))`, "g"), "the task folder");
    value = value.split(`${root}/`).join("");
  }
  return value;
}

/** Where text that could still become a local link or path starts, or -1. */
function holdFrom(value: string, roots: readonly string[]): number {
  const floor = Math.max(0, value.length - HOLD_MAX);
  let start = -1;
  const keep = (index: number) => { if (index >= floor && (start < 0 || index < start)) start = index; };
  const open = value.lastIndexOf("[");
  if (open >= 0 && UNFINISHED_LINK.test(value.slice(open))) keep(open);
  const url = UNFINISHED_FILE_URL.exec(value);
  if (url && url[0]) keep(url.index);
  for (const root of roots) {
    const prefix = `${root}/`;
    // Held down to a lone "/", and also when complete: what follows decides between a child path and the folder itself.
    for (let length = Math.min(prefix.length, value.length); length >= 1; length--) {
      if (value.endsWith(prefix.slice(0, length))) { keep(value.length - length); break; }
    }
    // The folder then punctuation at the very end: a sentence end, or the start of a dot-file name.
    const ending = new RegExp(`${escapeRegExp(root)}/?[${CLOSING}]+$`).exec(value);
    if (ending) keep(ending.index);
  }
  return start;
}

/** `workspaces`: the task folder as configured and as the provider was started in; each is also matched by its real path. */
export function createAntigravityLocalLinkFilter(workspaces: readonly string[]): { push(text: string): string; flush(): string } {
  const roots: string[] = [];
  for (const workspace of workspaces) {
    for (const root of [resolve(workspace), (() => { try { return realpathSync(workspace); } catch { return null; } })()]) {
      if (root && root !== sep && !roots.includes(root)) roots.push(root);
    }
  }
  let held = "";
  return {
    push(text) {
      const value = held + text;
      const start = holdFrom(value, roots);
      held = start < 0 ? "" : value.slice(start);
      return neutralizeAntigravityLocalLinks(start < 0 ? value : value.slice(0, start), roots);
    },
    flush() {
      const value = neutralizeAntigravityLocalLinks(held, roots);
      held = "";
      return value;
    },
  };
}

/** The turn's events with every assistant reply chunk passed through the filter, in order. */
export async function* antigravityLocalLinkEvents(events: AsyncIterable<AcpRuntimeEvent>, workspaces: readonly string[]): AsyncIterable<AcpRuntimeEvent> {
  const filter = createAntigravityLocalLinkFilter(workspaces);
  let template: Extract<AcpRuntimeEvent, { type: "text_delta" }> | null = null;
  const release = function* (): Generator<AcpRuntimeEvent> {
    const held = filter.flush();
    if (held && template) yield { ...template, text: held };
  };
  for await (const event of events) {
    if (event.type === "text_delta" && event.stream !== "thought") {
      template = event;
      const text = filter.push(event.text);
      if (text) yield { ...event, text };
      continue;
    }
    yield* release();
    yield event;
  }
  yield* release();
}
