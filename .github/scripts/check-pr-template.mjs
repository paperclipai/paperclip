#!/usr/bin/env node
/**
 * check-pr-template.mjs
 * Checks that a PR body contains all required sections from the PR template.
 * Export: checkTemplate(prBody: string) → { passed: boolean, failures: string[] }
 */
import { fileURLToPath } from 'node:url';

const REQUIRED_SECTIONS = [
  { heading: '## Thinking Path', minSentences: 3 },
  { heading: '## What Changed', minSentences: 1 },
  { heading: '## Verification', minSentences: 1 },
  { heading: '## Risks', minSentences: 1 },
  { heading: '## Model Used', minSentences: 1 },
];

const MODEL_PLACEHOLDERS = [
  'provider, model id',
  'your model',
  '<model>',
];

function extractSectionContent(body, heading) {
  const idx = body.indexOf(heading);
  if (idx === -1) return null;
  const after = body.slice(idx + heading.length);
  const nextHeading = after.search(/\n## /);
  return (nextHeading === -1 ? after : after.slice(0, nextHeading)).trim();
}

function countSentences(text) {
  // Split on terminal punctuation, bullet/quote line starts (`-`, `*`, `>`), or
  // blank lines so non-prose Thinking Paths (bullet lists, blockquotes) are
  // counted by item rather than as a single sentence.
  return text.split(/[.!?]+\s+|\n\s*[-*>]+\s+|\n{2,}/).filter(s => s.trim().length > 5).length;
}

export function checkTemplate(body) {
  const failures = [];

  if (!body || !body.trim()) {
    for (const { heading } of REQUIRED_SECTIONS) {
      failures.push(`Missing section: **${heading}**`);
    }
    return { passed: false, failures };
  }

  for (const { heading, minSentences } of REQUIRED_SECTIONS) {
    const content = extractSectionContent(body, heading);

    if (content === null) {
      failures.push(`Missing section: **${heading}**`);
      continue;
    }

    if (!content || content === '_No response_' || /^<!--/.test(content)) {
      failures.push(`Empty section: **${heading}**`);
      continue;
    }

    if (heading === '## Thinking Path') {
      const n = countSentences(content);
      if (n < minSentences) {
        failures.push(
          `**Thinking Path** needs more detail (${n} sentence${n === 1 ? '' : 's'} — aim for 3+)`
        );
      }
    }

    if (heading === '## Model Used') {
      const lower = content.toLowerCase();
      if (MODEL_PLACEHOLDERS.some(p => lower.includes(p.toLowerCase()))) {
        failures.push(
          '**Model Used** contains placeholder text — please specify the actual model used (or "None — human-authored")'
        );
      }
    }
  }

  return { passed: failures.length === 0, failures };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const body = process.env.PR_BODY ?? '';
  const result = checkTemplate(body);
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
