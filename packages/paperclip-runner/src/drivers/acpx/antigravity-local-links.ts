import { realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { AcpRuntimeEvent } from "acpx/runtime";

/**
 * Google Antigravity (the registry ACP server and the CLI's swarm alike) links
 * the files it wrote as absolute local `file:///…/<company>/<task>/a.txt` URLs.
 * The person reads that reply in the task thread, where a local path and its
 * ids mean nothing and a file:// link opens nothing. Before the reply leaves
 * the Runner, a link to a file in the task folder becomes its folder-relative
 * path in code (`a.txt`, which the thread already opens as a task-folder file),
 * any other file:// link keeps only its label, and a bare task-folder path
 * loses its local prefix. Other text, including `/api/...` links, is unchanged.
 */
const LINK = /\[([^\]\n]{0,300})\]\((<[^>\n]+>|[^)\s]+)\)/g;
const FILE_URL = /file:\/\/[^\s)\]>"'`]+/g;
const UNFINISHED_LINK = /^\[[^\]\n]{0,300}(?:\]\((?:<[^>\n]*|[^)\s]*))?\]?$/;
const UNFINISHED_FILE_URL = /(?:f(?:i(?:l(?:e(?::(?:\/(?:\/[^\s)\]>"'`]*)?)?)?)?)?)?)$/;
const HOLD_MAX = 4_096;

function decodeTarget(raw: string): { path: string; fileUrl: boolean } | null {
  let target = raw.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  const fileUrl = /^file:\/\//i.test(target);
  if (fileUrl) {
    try { target = decodeURIComponent(new URL(target).pathname); } catch { return null; }
  } else if (!target.startsWith("/")) {
    return null;
  }
  target = target.replace(/#L\d+(?:C\d+)?$/i, "").replace(/:\d+(?::\d+)?$/, "");
  return target ? { path: target, fileUrl } : null;
}

function insideRoot(roots: readonly string[], path: string): string | null {
  for (const root of roots) {
    const candidate = relative(root, resolve(root, path));
    if (candidate && candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate)) return candidate.split(sep).join("/");
  }
  return null;
}

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
  value = value.replace(FILE_URL, url => {
    const decoded = decodeTarget(url);
    if (!decoded) return url;
    return code(insideRoot(roots, decoded.path) ?? basename(decoded.path));
  });
  for (const root of roots) value = value.split(`${root}/`).join("");
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
    for (let length = Math.min(prefix.length - 1, value.length); length >= 2; length--) {
      if (value.endsWith(prefix.slice(0, length))) { keep(value.length - length); break; }
    }
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
