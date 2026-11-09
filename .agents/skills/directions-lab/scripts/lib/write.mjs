import { existsSync, mkdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MAX_LINES = 600;
export const COMMENT_LINE = /^\s*(\/\/|\/\*|\{\/\*|<!--)/;
export const VITEST_PRAGMA = /^\/\/ @vitest-environment [a-z-]+$/;

export function commentLines(content) {
  const hits = [];
  content.split("\n").forEach((line, index) => {
    if (index === 0 && VITEST_PRAGMA.test(line)) return;
    if (COMMENT_LINE.test(line)) hits.push(index + 1);
  });
  return hits;
}

export function lineCount(content) {
  return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
}

export function checkRendered(files, { root }) {
  const errors = [];
  for (const [relative, content] of files) {
    if (typeof content !== "string" || !content.trim()) errors.push(`${relative}: rendered empty`);
    const comments = commentLines(content ?? "");
    if (comments.length) errors.push(`${relative}: comment line(s) at ${comments.slice(0, 5).join(", ")}; generated code carries no comments`);
    const lines = lineCount(content ?? "");
    if (lines >= MAX_LINES) errors.push(`${relative}: ${lines} lines reaches the ${MAX_LINES}-line limit`);
    if (existsSync(path.join(root, relative))) errors.push(`${relative}: already exists; refusing to overwrite`);
  }
  return errors;
}

export function newJournal() {
  return { files: [], dirs: [] };
}

export function writeFiles(files, { root, journal = newJournal() }) {
  for (const [relative] of files) {
    let dir = path.dirname(path.join(root, relative));
    const missing = [];
    while (!existsSync(dir)) {
      missing.unshift(dir);
      dir = path.dirname(dir);
    }
    for (const created of missing) {
      if (!journal.dirs.includes(created)) journal.dirs.push(created);
      mkdirSync(created);
    }
  }
  for (const [relative, content] of files) {
    const target = path.join(root, relative);
    writeFileSync(target, content);
    journal.files.push(target);
  }
  return journal;
}

export function rollback(journal) {
  for (const file of journal.files) if (existsSync(file)) unlinkSync(file);
  const dirs = [...journal.dirs].sort((a, b) => b.length - a.length);
  for (const dir of dirs) if (existsSync(dir) && statSync(dir).isDirectory()) rmSync(dir, { recursive: true, force: true });
}
