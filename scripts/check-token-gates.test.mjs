import assert from "node:assert/strict";
import test from "node:test";

import {
  findColorLiteralIssues,
  isUiTestFile,
  lineNumberAt,
  prepareScanContent,
  stripJsCommentsPreservingNewlines,
} from "./check-token-gates.mjs";

const CATPPUCCIN_COMMENT = `/* The rendered code block used to be pinned to the Catppuccin literals
   #1e1e2e / #cdd6f4, in the normal AND the prose-invert variables. A code
   block therefore stayed dark in light mode. These tests fail if any of
   those surfaces is pinned to a literal again, rather than riding a token
   that carries a \`.dark\` override. */`;

test("isUiTestFile matches colocated UI tests and specs", () => {
  assert.equal(isUiTestFile("ui/src/components/MarkdownCodeBlockStyles.test.ts"), true);
  assert.equal(isUiTestFile("ui/src/pages/CompanySettings.test.tsx"), true);
  assert.equal(isUiTestFile("ui/src/components/Foo.spec.tsx"), true);
  assert.equal(isUiTestFile("ui/src/components/MarkdownCodeBlockStyles.ts"), false);
  assert.equal(isUiTestFile("ui/src/components/test-utils.ts"), false);
});

test("stripJsCommentsPreservingNewlines keeps length and line count", () => {
  const source = `${CATPPUCCIN_COMMENT}\nconst color = "#cdd6f4";\n`;
  const stripped = stripJsCommentsPreservingNewlines(source);
  assert.equal(stripped.length, source.length);
  assert.equal(stripped.split("\n").length, source.split("\n").length);
  assert.equal(stripped.includes("#1e1e2e"), false);
  assert.equal(stripped.includes("#cdd6f4"), true);
});

test("stripJsCommentsPreservingNewlines leaves string literals intact", () => {
  const source = `const url = "https://example.com/#1e1e2e"; // leftover #cdd6f4\n`;
  const stripped = stripJsCommentsPreservingNewlines(source);
  assert.match(stripped, /#1e1e2e/);
  assert.equal(stripped.includes("#cdd6f4"), false);
});

test("stripJsCommentsPreservingNewlines strips comments inside template interpolations", () => {
  const source = "const x = `bg ${/* was #1e1e2e */ \"var(--muted)\"}`;\n";
  const stripped = stripJsCommentsPreservingNewlines(source);
  assert.equal(stripped.includes("#1e1e2e"), false);
  assert.match(stripped, /var\(--muted\)/);
});

test("prepareScanContent ignores Catppuccin hexes in a test-file block comment", () => {
  const rel = "ui/src/components/MarkdownCodeBlockStyles.test.ts";
  const scan = prepareScanContent(rel, CATPPUCCIN_COMMENT);
  assert.deepEqual(findColorLiteralIssues(scan), []);
});

test("prepareScanContent still flags the same hexes in a non-test file comment", () => {
  const rel = "ui/src/components/MarkdownCodeBlockStyles.ts";
  const scan = prepareScanContent(rel, CATPPUCCIN_COMMENT);
  const issues = findColorLiteralIssues(scan);
  assert.equal(issues.length, 2);
  assert.deepEqual(
    issues.map((issue) => issue.snippet),
    ["#1e1e2e", "#cdd6f4"],
  );
});

test("prepareScanContent still flags executable hex literals in tests", () => {
  const source = `/* history #1e1e2e */\nconst color = "#cdd6f4";\n`;
  const scan = prepareScanContent("ui/src/components/Foo.test.ts", source);
  const issues = findColorLiteralIssues(scan);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].snippet, "#cdd6f4");
  assert.equal(lineNumberAt(scan, issues[0].index), 2);
});

test("prepareScanContent ignores a trailing line-comment hex in tests", () => {
  const source = `const x = 1; // leftover #cdd6f4 from the old pin\n`;
  const scan = prepareScanContent("ui/src/components/Foo.test.tsx", source);
  assert.deepEqual(findColorLiteralIssues(scan), []);
});

test("prepareScanContent ignores JSX block-comment hexes in tests", () => {
  const source = `render(<div>{/* was #1e1e2e */}</div>);\n`;
  const scan = prepareScanContent("ui/src/components/Foo.test.tsx", source);
  assert.deepEqual(findColorLiteralIssues(scan), []);
});

test("regex literals with escaped slashes do not swallow the rest of the line", () => {
  // Mirrors DocumentAnnotationLayer.test.tsx: `\/` plus the closing delimiter
  // looks like `//` if the stripper is not regex-aware.
  const source =
    '        || /^(dark:|hover:|dark:hover:)?bg-yellow-\\d+\\//.test(className); const color = "#cdd6f4";\n';
  const stripped = stripJsCommentsPreservingNewlines(source);
  assert.equal(stripped.includes(".test(className)"), true);
  assert.equal(stripped.includes("#cdd6f4"), true);
  const scan = prepareScanContent("ui/src/components/DocumentAnnotationLayer.test.tsx", source);
  const issues = findColorLiteralIssues(scan);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].snippet, "#cdd6f4");
});

test("line comments after a regex literal are still stripped", () => {
  const source = 'const ok = /\\d+\\//; // leftover #cdd6f4\n';
  const scan = prepareScanContent("ui/src/components/Foo.test.ts", source);
  assert.deepEqual(findColorLiteralIssues(scan), []);
});
