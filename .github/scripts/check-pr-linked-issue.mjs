#!/usr/bin/env node
/**
 * check-pr-linked-issue.mjs
 * Checks that a PR body either links an existing issue/PR or inlines an
 * issue-template-shaped description. Respects conventional commit prefixes —
 * skips check for docs/chore/build/ci/style/test/revert prefixed PRs.
 *
 * Exports:
 *   checkLinkedIssue(prBody, prTitle) → { passed, failures }
 *   hasInlineIssueDescription(prBody) → boolean
 */
import { fileURLToPath } from 'node:url';

const ISSUE_PATTERNS = [
  /(?:fixes|closes|resolves|refs)\s+#\d+/i,
  /(?:^|[\s(])https:\/\/github\.com\/paperclipai\/paperclip\/issues\/\d+(?=$|[\s),:;!?]|[.](?![\w-]))/i,
  /(?<!\w)#\d+/,
];

// Prefixes where neither a linked issue nor an inline description is required
const SKIP_ISSUE_PREFIXES = ['docs', 'chore', 'build', 'ci', 'style', 'test', 'revert'];

// Minimum number of template fields the PR body must match to count as an
// inline issue description.
const INLINE_DESCRIPTION_MIN_FIELDS = 3;

// Per-template field labels. Each field is an array of accepted variants; the
// field counts as "present" if any variant appears as a markdown heading
// (`## Label`) or as a bolded/plain label on its own line (`**Label**` /
// `Label:`). Matching is case-insensitive.
const TEMPLATE_FIELDS = {
  bug: [
    ['What happened', 'What happened?'],
    ['Expected behavior', 'Expected behaviour'],
    ['Steps to reproduce', 'Reproduction steps', 'Repro steps'],
    ['Paperclip version', 'Paperclip version or commit', 'Version or commit', 'Version/commit'],
    ['Deployment mode'],
  ],
  feature: [
    ['Problem or motivation', 'Problem', 'Motivation'],
    ['Proposed solution', 'Solution'],
    ['Alternatives considered', 'Alternatives'],
    ['Roadmap alignment', 'Roadmap'],
  ],
  adapter: [
    ['Agent or provider', 'Agent', 'Provider', 'Adapter'],
    ["Why this adapter is useful", "Why it's useful", 'Why useful', 'Use case'],
    ['How the agent is invoked', 'How it is invoked', "How it's invoked", 'Invocation'],
  ],
  // Labels below match .github/ISSUE_TEMPLATE/enhancement.yml exactly.
  enhancement: [
    ['What existing behavior does this improve?', 'What existing behavior does this improve'],
    ['Subsystem affected'],
    ['Current behavior'],
    ['Proposed behavior'],
    ['Reason and benefit'],
    ['Breaking changes'],
  ],
  // Labels below match .github/ISSUE_TEMPLATE/docs_issue.yml exactly. The
  // template has 4 distinct fields, so it meets the 3-field minimum. A
  // "docs"-prefixed PR skips this check; this set helps a non-"docs"-prefixed
  // PR that describes a documentation issue inline.
  docs: [
    ['Issue type'],
    ['Where is the issue?', 'Where is the issue'],
    ["What's wrong?", "What's wrong"],
    ['Suggested fix'],
  ],
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A generic "label line" is a markdown heading (`## Label`) or a bolded label on
// its own line (`**Label**`). The content scan stops at a label line, because
// that line starts a new field.
const LABEL_LINE = /^\s*(?:#{1,6}\s+\S|(?:\*\*|__)[^*_].*(?:\*\*|__)\s*[:?]?\s*$)/;

// Build the regex that matches one field label on its own line.
function labelLinePattern(label) {
  const esc = escapeRegExp(label);
  // Accept markdown headings or bolded/plain labels on their own line.
  // Examples: "## What happened?", "**Expected behavior**", "Problem:".
  return new RegExp(
    `^\\s*(?:#{1,6}\\s+|\\*\\*\\s*|__\\s*)?${esc}(?:\\s*[:?])?(?:\\s*\\*\\*|\\s*__)?\\s*$`,
    'i'
  );
}

// Every known field label from every template, precompiled. The generic
// LABEL_LINE regex sees a heading or a bold label as a field boundary, but not a
// plain "Label:" line. A skeleton of stacked plain labels needs each label to
// act as a boundary. Without this list the scan reads the next label as
// content, so it counts an empty field as filled.
const KNOWN_LABEL_PATTERNS = Object.values(TEMPLATE_FIELDS)
  .flat(2)
  .map(labelLinePattern);

// Return true if the line starts a new field. The line is a heading, a bold
// label, or a plain line that equals a known field label.
function isFieldBoundary(line) {
  return LABEL_LINE.test(line) || KNOWN_LABEL_PATTERNS.some(p => p.test(line));
}

// Return true if the line holds real content, not a bare placeholder. The
// default template skeleton puts a lone "-" under each label, so a label with
// only "-", blank lines, or a "[...]" placeholder does not count as filled.
function lineHasContent(line) {
  let text = line.trim();
  if (!text) return false;
  // Drop a leading list marker ("- ", "* ", "1. ") before the check.
  text = text.replace(/^[-*+]\s*/, '').replace(/^\d+[.)]\s*/, '').trim();
  if (!text) return false;
  // Treat a whole-line bracket placeholder ("[describe here]") as empty.
  if (/^\[.*\]$/.test(text)) return false;
  return true;
}

// Return true if a label variant appears on its own line AND at least one
// content line follows it before the next label line.
function isFieldFilled(lines, variants) {
  const patterns = variants.map(labelLinePattern);
  for (let i = 0; i < lines.length; i += 1) {
    if (!patterns.some(p => p.test(lines[i]))) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (isFieldBoundary(lines[j])) break; // next field starts here
      if (lineHasContent(lines[j])) return true;
    }
  }
  return false;
}

function countMatchedFields(lines, fieldSet) {
  let matched = 0;
  for (const variants of fieldSet) {
    if (isFieldFilled(lines, variants)) matched += 1;
  }
  return matched;
}

// Remove HTML comments. The PR template puts its guidance and its example
// issue links ("Fixes: #123") inside comments, so the gate must not read them
// as author content.
function stripHtmlComments(body) {
  return body.replace(/<!--[\s\S]*?-->/g, '');
}

export function hasInlineIssueDescription(body) {
  if (!body || !body.trim()) return false;
  // Strip the guidance comments, then scan the body line by line.
  const lines = stripHtmlComments(body).split(/\r?\n/);
  for (const fieldSet of Object.values(TEMPLATE_FIELDS)) {
    if (countMatchedFields(lines, fieldSet) >= INLINE_DESCRIPTION_MIN_FIELDS) {
      return true;
    }
  }
  return false;
}

function parsePrefix(title) {
  if (!title) return null;
  const match = title.match(/^([a-z]+)(?:\([^)]*\))?:/);
  return match ? match[1].toLowerCase() : null;
}

export function checkLinkedIssue(body, prTitle = '') {
  const prefix = parsePrefix(prTitle);

  if (prefix && SKIP_ISSUE_PREFIXES.includes(prefix)) {
    return { passed: true, failures: [] };
  }

  if (!body || !body.trim()) {
    return { passed: false, failures: ['PR body is empty — please fill out the PR template'] };
  }

  const linked = ISSUE_PATTERNS.some(p => p.test(stripHtmlComments(body)));
  const inlined = hasInlineIssueDescription(body);
  const passed = linked || inlined;

  return {
    passed,
    failures: passed ? [] : [
      'No linked issue or inline issue description found — either tag an existing issue ' +
      'with `Fixes #NNN` / `Closes #NNN` / `Refs #NNN`, or describe the underlying issue ' +
      'inline in the PR body following one of our issue templates ' +
      '(https://github.com/paperclipai/paperclip/tree/master/.github/ISSUE_TEMPLATE). ' +
      'See CONTRIBUTING.md → "Link Issues or Describe Them In-PR".',
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const body = process.env.PR_BODY ?? '';
  const title = process.env.PR_TITLE ?? '';
  const result = checkLinkedIssue(body, title);
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
