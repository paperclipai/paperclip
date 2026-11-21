const MAX_EXCLUDE_PATHSPECS = 64;

function minimalExcludedPath(basePath: string, otherPath: string, protectedPaths: readonly string[]): string | null {
  const prefix = `${basePath}/`;
  if (!otherPath.startsWith(prefix)) return null;
  const segments = otherPath.slice(prefix.length).split("/");
  let candidate = basePath;
  for (const segment of segments) {
    candidate = `${candidate}/${segment}`;
    const collides = protectedPaths.some(
      (target) => target === candidate || target.startsWith(`${candidate}/`),
    );
    if (!collides) return candidate;
  }
  return null;
}

export function diffTargetPaths(filePath: string, oldPath: string | null | undefined, scopePaths: readonly string[]) {
  const basePaths = oldPath && oldPath !== filePath ? [oldPath, filePath] : [filePath];
  const excludes = new Set<string>();
  for (const basePath of basePaths) {
    for (const otherPath of scopePaths) {
      const excluded = minimalExcludedPath(basePath, otherPath, basePaths);
      if (excluded) {
        excludes.add(excluded);
        if (excludes.size >= MAX_EXCLUDE_PATHSPECS) break;
      }
    }
    if (excludes.size >= MAX_EXCLUDE_PATHSPECS) break;
  }
  return [
    ...basePaths.map((target) => `:(literal)${target}`),
    ...Array.from(excludes, (target) => `:(literal,exclude)${target}`),
  ];
}

export function parseNumstat(output: string, filePath: string, oldPath?: string | null) {
  const tokens = output.split("\0");
  const entries: Array<{
    path: string;
    oldPath: string | null;
    additions: number;
    deletions: number;
    binary: boolean;
  }> = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index++] ?? "";
    if (!token) continue;
    const parts = token.split("\t");
    if (parts.length < 3) continue;
    const additionsRaw = parts[0] ?? "";
    const deletionsRaw = parts[1] ?? "";
    const inlinePath = parts.slice(2).join("\t");
    const binary = additionsRaw === "-" || deletionsRaw === "-";
    const additions = binary ? 0 : Number.parseInt(additionsRaw, 10) || 0;
    const deletions = binary ? 0 : Number.parseInt(deletionsRaw, 10) || 0;
    if (inlinePath === "") {
      const entryOldPath = tokens[index++] ?? "";
      const entryNewPath = tokens[index++] ?? "";
      if (entryNewPath) {
        entries.push({ path: entryNewPath, oldPath: entryOldPath || null, additions, deletions, binary });
      }
      continue;
    }
    entries.push({ path: inlinePath, oldPath: null, additions, deletions, binary });
  }

  const normalizedOldPath = oldPath ?? null;
  const matched =
    entries.find((entry) => entry.path === filePath && entry.oldPath === normalizedOldPath) ??
    entries.find((entry) => entry.path === filePath);
  if (!matched) return { additions: 0, deletions: 0, binary: false };
  return {
    additions: matched.additions,
    deletions: matched.deletions,
    binary: matched.binary,
  };
}

function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const bytes: number[] = [];
  for (let i = 1; i < raw.length - 1; i += 1) {
    const ch = raw[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    if (next >= "0" && next <= "7") {
      const octal = raw.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(Number.parseInt(octal, 8));
        i += 3;
        continue;
      }
    }
    const escapes: Record<string, number> = {
      a: 7,
      b: 8,
      t: 9,
      n: 10,
      v: 11,
      f: 12,
      r: 13,
      '"': 34,
      "\\": 92,
    };
    const escaped = escapes[next];
    if (escaped !== undefined) {
      bytes.push(escaped);
    } else {
      bytes.push(...Buffer.from(next, "utf8"));
    }
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripDiffSidePrefix(rawPath: string, prefix: "a/" | "b/"): string | null {
  const cleaned = unquoteGitPath(rawPath.trim());
  if (cleaned === "/dev/null") return null;
  return cleaned.startsWith(prefix) ? cleaned.slice(prefix.length) : cleaned;
}

function splitGitDiffSections(output: string): string[] {
  if (!output) return [];
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      sections.push(`${current.join("\n")}\n`);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join("\n"));
  return sections.filter((section) => section.length > 0);
}

function readDiffSectionMeta(section: string) {
  let headerLine = "";
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let minusPath: string | null = null;
  let plusPath: string | null = null;
  for (const line of section.split(/\r?\n/)) {
    if (line.startsWith("@@ ")) break;
    if (!headerLine && line.startsWith("diff --git ")) {
      headerLine = line;
    } else if (line.startsWith("rename from ")) {
      renameFrom = unquoteGitPath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      renameTo = unquoteGitPath(line.slice("rename to ".length));
    } else if (line.startsWith("--- ")) {
      minusPath = stripDiffSidePrefix(line.slice("--- ".length), "a/");
    } else if (line.startsWith("+++ ")) {
      plusPath = stripDiffSidePrefix(line.slice("+++ ".length), "b/");
    }
  }
  let quotedLeft: string | null = null;
  let quotedRight: string | null = null;
  if (headerLine.startsWith('diff --git "')) {
    let i = 'diff --git "'.length;
    while (i < headerLine.length) {
      if (headerLine[i] === "\\") {
        i += 2;
        continue;
      }
      if (headerLine[i] === '"') break;
      i += 1;
    }
    if (i < headerLine.length) {
      quotedLeft = stripDiffSidePrefix(headerLine.slice("diff --git ".length, i + 1), "a/");
      quotedRight = stripDiffSidePrefix(headerLine.slice(i + 2), "b/");
    }
  }
  return { headerLine, renameFrom, renameTo, minusPath, plusPath, quotedLeft, quotedRight };
}

export function selectFilePatch(output: string, filePath: string, oldPath?: string | null): string {
  const sections = splitGitDiffSections(output);
  if (sections.length === 0) return "";
  const expectedLeft = oldPath ?? filePath;
  const exactHeader = `diff --git a/${expectedLeft} b/${filePath}`;
  const exactSamePathHeader = `diff --git a/${filePath} b/${filePath}`;

  if (oldPath) {
    const exactRename = sections.find((section) => {
      const meta = readDiffSectionMeta(section);
      return (
        (meta.renameFrom === oldPath && meta.renameTo === filePath) ||
        meta.headerLine === exactHeader ||
        (meta.quotedLeft === oldPath && meta.quotedRight === filePath)
      );
    });
    if (exactRename) return exactRename;
  }

  const matched = sections.find((section) => {
    const meta = readDiffSectionMeta(section);
    return (
      meta.headerLine === exactSamePathHeader ||
      (meta.quotedLeft === filePath && meta.quotedRight === filePath) ||
      meta.plusPath === filePath ||
      (meta.plusPath === null && meta.minusPath === filePath)
    );
  });
  return matched ?? "";
}
