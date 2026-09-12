/** Read-only, incremental review queue for text outside the locale catalogs. */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  isBinaryExpression, isConditionalExpression, isIdentifier, isJsxAttribute, isJsxElement, isJsxExpression, isJsxText,
  isNoSubstitutionTemplateLiteral, isPropertyAssignment, isStringLiteral,
  SyntaxKind, type Node,
} from "typescript/unstable/ast";

type Candidate = { file: string; line: number; kind: string; text: string };
const virtualRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".source-audit-virtual");
const displayFields = new Set([
  "alt", "aria-label", "aria-description", "title", "label", "description",
  "placeholder", "hint", "emptyMessage", "message", "summary", "tooltip",
]);
const excluded = /(?:^|\/)(?:__tests__|__mocks__|fixtures|__fixtures__|i18n)\/|\.(?:test|spec|stories)\.[^/]+$|\.d\.[cm]?ts$|(?:^|\/)(?:DesignGuide|UxLab|TaskChatLab|LongThreadPerf|preview-)[^/]*$/;

export function isUiSourcePath(file: string) {
  return file.startsWith("ui/src/") && /\.[cm]?[jt]sx?$/.test(file) && !excluded.test(file);
}

function propertyName(node: Node) {
  return isIdentifier(node) || isStringLiteral(node) ? node.text : undefined;
}

/** Heuristic only: a candidate can be a brand, protocol label, or example. */
export function collectUiText(sources: Record<string, string>): Candidate[] {
  const files = Object.fromEntries(Object.entries(sources).map(([name, text]) => [resolve(virtualRoot, name), text]));
  const configFile = join(virtualRoot, "tsconfig.json");
  const api = new API({ cwd: virtualRoot, fs: createVirtualFileSystem({
    ...files,
    [configFile]: JSON.stringify({ compilerOptions: { noLib: true, noResolve: true, allowJs: true, jsx: "preserve" }, files: Object.keys(files) }),
  }) });
  const findings: Candidate[] = [];
  try {
    const snapshot = api.updateSnapshot({ openProjects: [configFile] });
    try {
      const project = snapshot.getProject(configFile);
      if (!project) throw new Error("Could not open the read-only UI source audit project");
      if (project.program.getSyntacticDiagnostics().length) throw new Error("UI source audit stopped: source has syntax errors");
      for (const file of Object.keys(sources)) {
        const source = project.program.getSourceFile(resolve(virtualRoot, file));
        if (!source) throw new Error(`UI source audit could not parse ${file}`);
        const add = (node: Node, kind: string, value: string) => {
          const text = value.replace(/\s+/g, " ").trim();
          if (/[A-Za-z]/.test(text)) findings.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, kind, text });
        };
        function visit(node: Node, displayContext?: string, suppressed = false) {
          if (isJsxElement(node)) {
            const tag = node.openingElement.tagName.getText();
            suppressed ||= ["code", "pre", "Trans"].includes(tag);
          }
          let context = displayContext;
          if (isJsxExpression(node) && [SyntaxKind.JsxElement, SyntaxKind.JsxFragment].includes(node.parent.kind)) {
            context = "jsx-expression";
          }
          if (isJsxAttribute(node)) context = displayFields.has(node.name.getText()) ? `attribute:${node.name.getText()}` : undefined;
          if (isPropertyAssignment(node)) {
            const name = propertyName(node.name);
            context = name && displayFields.has(name) ? `property:${name}` : undefined;
          }
          if (!suppressed) {
            if (isJsxText(node)) add(node, "jsx-text", node.getText());
            else if ((isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) && context) {
              // Keys and translation calls are not untranslated display values.
              if (!(isPropertyAssignment(node.parent) && node.parent.name === node)) add(node, context, node.text);
            } else if (context && [SyntaxKind.TemplateHead, SyntaxKind.TemplateMiddle, SyntaxKind.TemplateTail].includes(node.kind)) {
              add(node, `${context}:template`, node.getText());
            }
          }
          // Calls may contain IDs or translated keys; resolving their output is
          // deliberately outside this source-only audit. Review changed files too.
          node.forEachChild((child) => {
            let childContext = node.kind === SyntaxKind.CallExpression ? undefined : context;
            if (isConditionalExpression(node) && child === node.condition) childContext = undefined;
            if (isBinaryExpression(node)) {
              const operator = node.operatorToken.kind;
              // +, || and ?? can render either operand. The left side of &&
              // is only a guard; comparisons and other operators produce a
              // computed value rather than displaying their string operands.
              const rendersChild = [SyntaxKind.PlusToken, SyntaxKind.BarBarToken, SyntaxKind.QuestionQuestionToken].includes(operator)
                || (operator === SyntaxKind.AmpersandAmpersandToken && child === node.right);
              if (!rendersChild) childContext = undefined;
            }
            visit(child, childContext, suppressed);
          });
        }
        visit(source);
      }
    } finally { snapshot.dispose(); }
  } finally { api.close(); }
  return findings;
}

export function collectUiSourceChanges(previous: Record<string, string>, current: Record<string, string>) {
  // Compare multisets per file: line shifts are not new copy, but a second
  // occurrence of an existing literal still enters the review queue.
  const signature = ({ file, kind, text }: Candidate) => JSON.stringify([file, kind, text]);
  const oldCounts = new Map<string, number>();
  for (const item of collectUiText(previous)) oldCounts.set(signature(item), (oldCounts.get(signature(item)) ?? 0) + 1);
  const candidates = collectUiText(current).filter((item) => {
    const key = signature(item), count = oldCounts.get(key) ?? 0;
    if (!count) return true;
    oldCounts.set(key, count - 1);
    return false;
  });
  return { files: Object.keys(current), removedFiles: Object.keys(previous).filter((file) => !(file in current)), candidates };
}

export function runUiSourceChanges(args = process.argv.slice(2)) {
  let base: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") json = true;
    else if (args[i] === "--base" && args[i + 1] && !args[i + 1]!.startsWith("--")) base = args[++i];
    else throw new Error(`Unknown or incomplete option: ${args[i]}`);
  }
  if (!base) throw new Error("Usage: pnpm --filter @paperclipai/ui exec node src/i18n/ui-source-changes.ts --base <reviewed-commit-or-tag> [--json]");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const baseCommit = git(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]).trim();
  const paths = [...new Set([
    ...git(["diff", "--name-only", "-z", baseCommit, "--", "ui/src/"]).split("\0"),
    ...git(["ls-files", "--others", "--exclude-standard", "-z", "--", "ui/src/"]).split("\0"),
  ])].filter(isUiSourcePath).sort();
  const oldPaths = new Set(git(["ls-tree", "-r", "--name-only", "-z", baseCommit, "--", "ui/src/"]).split("\0"));
  const previous: Record<string, string> = {}, current: Record<string, string> = {};
  for (const file of paths) {
    if (oldPaths.has(file)) previous[file] = git(["show", `${baseCommit}:${file}`]);
    const info = lstatSync(join(root, file), { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) throw new Error(`UI source audit refuses a symbolic link: ${file}`);
    if (info?.isFile()) current[file] = readFileSync(join(root, file), "utf8");
  }
  const report = { baseCommit, ...collectUiSourceChanges(previous, current),
    limitations: "Review candidates, not certified translation gaps. Covers literal JSX, display attributes and display object fields in changed UI source. Does not follow dynamic values, helper returns, imports, server catalogs, prompts or provider content. Review the changed-file list and runtime screens separately. No files are written.",
  };
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Changed UI files: ${report.files.length}; removed: ${report.removedFiles.length}; new text candidates: ${report.candidates.length}`);
    for (const item of report.candidates) console.log(`${item.file}:${item.line} [${item.kind}] ${item.text}`);
    console.log(report.limitations);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { runUiSourceChanges(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
