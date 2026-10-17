import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";

const FILE_EXTENSION = String.raw`\.(?:mdx?|txt|json|ya?ml|toml)`;
const HAS_FILE_EXTENSION = new RegExp(`${FILE_EXTENSION}$`, "i");
// [text](target), [text](<target with spaces>) and [text](target "title").
const LINK_TARGET_PATTERN = /\]\(\s*(?:<([^>\n]+)>|([^)\s][^)\n]*?))(?:\s+["'][^"'\n]*["'])?\s*\)/g;
// `path`, "path" and 'path', which may contain spaces.
const QUOTED_PATH_PATTERN = new RegExp(String.raw`([\x60"'])([^\x60"'\n]+?${FILE_EXTENSION})\1`, "giu");
// Bare paths in prose; letters and digits of any script. A path never starts
// mid-token or right after a URL scheme such as "mailto:".
const BARE_PATH_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_@./:-])[\p{L}\p{N}_@./-]+${FILE_EXTENSION}(?![\p{L}\p{N}_])`,
  "giu",
);
const MAX_REFERENCED_FILES = 50;
const MAX_REFERENCED_BYTES = 120_000;
const MAX_REPORTED_OMISSIONS = 20;

type ReferencedFile = { relativePath: string; text: string };
type Reference = { path: string; explicit: boolean };

function decodeLinkTarget(raw: string): string {
  const target = raw.trim().replace(/[?#].*$/, "");
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

/**
 * Finds the file paths a text references. Link targets and quoted paths are
 * read whole first, so a path with spaces or non-English letters is not cut
 * down to its last word; their text is then masked before the bare-path scan.
 */
export function extractInstructionReferences(text: string): Reference[] {
  const references = new Map<string, Reference>();
  const add = (candidate: string, explicit: boolean) => {
    const trimmed = candidate.trim();
    if (!trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || !HAS_FILE_EXTENSION.test(trimmed)) return;
    const existing = references.get(trimmed);
    if (!existing || (explicit && !existing.explicit)) references.set(trimmed, { path: trimmed, explicit });
  };
  let masked = text.replace(LINK_TARGET_PATTERN, (match, angled?: string, plain?: string) => {
    add(decodeLinkTarget(angled ?? plain ?? ""), true);
    return " ".repeat(match.length);
  });
  masked = masked.replace(QUOTED_PATH_PATTERN, (match, _quote: string, quoted: string) => {
    add(quoted, true);
    return " ".repeat(match.length);
  });
  for (const bare of masked.match(BARE_PATH_PATTERN) ?? []) add(bare, false);
  return [...references.values()];
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Collects the files the instructions name, starting from the entry file.
 *
 * Selecting one instructions file does not authorize sending its directory, so
 * a file is read only when the instructions reference it by relative path and
 * it resolves inside the entry file's directory. Sizes are checked before any
 * read, and nothing is read once the budget is spent.
 */
export async function readReferencedInstructionFiles(
  entryPath: string,
  entryText: string,
): Promise<{ files: ReferencedFile[]; omitted: string[]; missing: string[] }> {
  const root = await fs.realpath(path.dirname(entryPath)).catch(() => null);
  if (!root) return { files: [], omitted: [], missing: [] };
  const entryRealPath = await fs.realpath(entryPath).catch(() => path.resolve(entryPath));

  const files: ReferencedFile[] = [];
  const omitted: string[] = [];
  // Explicit link targets and quoted paths that match no file, reported instead of silently dropped.
  const missing: string[] = [];
  const seen = new Set<string>([entryRealPath]);
  const queue: Array<{ dir: string; text: string }> = [{ dir: root, text: entryText }];
  let bytes = 0;

  while (queue.length > 0) {
    const { dir, text } = queue.shift()!;
    for (const { path: reference, explicit } of extractInstructionReferences(text)) {
      const segments = reference.split("/");
      if (path.isAbsolute(reference) || segments.some((part) => part.startsWith(".") && part !== "." && part !== "..")) {
        continue;
      }
      let resolved = false;
      // A reference may be relative to the file that names it or to the bundle root.
      for (const base of dir === root ? [root] : [dir, root]) {
        const realPath = await fs.realpath(path.resolve(base, reference)).catch(() => null);
        if (!realPath || !isInside(root, realPath)) continue;
        resolved = true;
        if (seen.has(realPath)) break;
        const stat = await fs.stat(realPath).catch(() => null);
        if (!stat?.isFile()) {
          resolved = false;
          continue;
        }
        seen.add(realPath);
        const relativePath = path.relative(root, realPath).split(path.sep).join("/");
        if (files.length >= MAX_REFERENCED_FILES || bytes + stat.size > MAX_REFERENCED_BYTES) {
          if (omitted.length < MAX_REPORTED_OMISSIONS) omitted.push(relativePath);
          break;
        }
        const contents = await fs.readFile(realPath, "utf8").catch(() => null);
        if (contents === null) break;
        bytes += stat.size;
        files.push({ relativePath, text: contents });
        queue.push({ dir: path.dirname(realPath), text: contents });
        break;
      }
      if (!resolved && explicit && missing.length < MAX_REPORTED_OMISSIONS && !missing.includes(reference)) {
        missing.push(reference);
      }
    }
  }
  return { files, omitted, missing };
}

export async function buildInstructionsPrefix(
  config: Record<string, unknown>,
  onLog: AdapterExecutionContext["onLog"],
): Promise<{ prefix: string; notes: string[]; chars: number }> {
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  if (!instructionsFilePath) {
    return { prefix: "", notes: [], chars: 0 };
  }

  try {
    const contents = await fs.readFile(instructionsFilePath, "utf8");
    const entryName = path.basename(instructionsFilePath);
    // The remote container cannot read the Paperclip host, so the files the
    // instructions reference travel in the prompt instead of as a host path.
    const referenced = await readReferencedInstructionFiles(instructionsFilePath, contents);
    const sections = [
      contents.trim(),
      `The above agent instructions were loaded from ${entryName}. This session runs in a remote container that cannot read the Paperclip host filesystem.`,
    ];
    if (referenced.files.length > 0) {
      sections.push(
        "The files those instructions reference follow. Resolve relative file references against them.",
        ...referenced.files.map((file) => `<file path="${file.relativePath}">\n${file.text.trim()}\n</file>`),
      );
    }
    if (referenced.omitted.length > 0) {
      sections.push(`These referenced files were too large to include: ${referenced.omitted.join(", ")}.`);
    }
    if (referenced.missing.length > 0) {
      sections.push(`These referenced files were not found in the instructions directory: ${referenced.missing.join(", ")}.`);
    }
    const prefix = `${sections.join("\n\n")}\n`;
    return {
      prefix,
      chars: prefix.length,
      notes: [
        `Loaded agent instructions from ${instructionsFilePath}`,
        referenced.files.length > 0
          ? `Inlined ${referenced.files.length} referenced instructions file(s): ${referenced.files.map((file) => file.relativePath).join(", ")}`
          : "Prepended instructions to prompt.",
        ...(referenced.omitted.length > 0
          ? [`Referenced instructions files not inlined (size limit): ${referenced.omitted.join(", ")}`]
          : []),
        ...(referenced.missing.length > 0
          ? [`Referenced instructions files not found: ${referenced.missing.join(", ")}`]
          : []),
      ],
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await onLog(
      "stderr",
      `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
    );
    return {
      prefix: "",
      chars: 0,
      notes: [
        `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      ],
    };
  }
}
