#!/usr/bin/env node

/**
 * Lints required documentation: existence, frontmatter markers, and local link integrity.
 * Usage: node scripts/docs-lint.mjs
 * Exit 0 on success, 1 on validation failure.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';

const ROOT = process.cwd();
const DOC_DIR = resolve(ROOT, 'doc');

const REQUIRED_DOCS = [
  'doc/ARCHITECTURE.md',
  'doc/QUALITY_SCORE.md',
  'doc/RELIABILITY.md',
  'doc/SECURITY.md',
  'doc/HARNESS_SCORECARD.md',
  'doc/HARNESS_RUNBOOK.md',
  'doc/DECISIONS/0001-harness-engineering-adoption.md',
];

const REQUIRED_FRONTMATTER_FIELDS = [
  'Owner',
  'Last Verified',
  'Applies To',
  'Links',
];

let errors = [];

// 1. Check required docs exist
for (const docPath of REQUIRED_DOCS) {
  const fullPath = resolve(ROOT, docPath);
  if (!existsSync(fullPath)) {
    errors.push(`Missing required doc: ${docPath}`);
  }
}

// 2. Check frontmatter markers in existing docs
for (const docPath of REQUIRED_DOCS) {
  const fullPath = resolve(ROOT, docPath);
  if (!existsSync(fullPath)) continue;

  let content;
  try {
    content = readFileSync(fullPath, 'utf-8');
  } catch {
    errors.push(`Cannot read: ${docPath}`);
    continue;
  }

  const lines = content.split('\n');
  const fmStart = lines.indexOf('---');
  const fmEnd = lines.indexOf('---', fmStart + 1);

  if (fmStart === -1 || fmEnd === -1 || fmStart === fmEnd) {
    errors.push(`${docPath}: Missing YAML frontmatter (--- delimiters)`);
    continue;
  }

  const frontmatter = lines.slice(fmStart + 1, fmEnd).join('\n');
  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (!frontmatter.includes(`${field}:`)) {
      errors.push(`${docPath}: Missing frontmatter field: ${field}`);
    }
  }
}

// 3. Check local link integrity for doc/* references
for (const docPath of REQUIRED_DOCS) {
  const fullPath = resolve(ROOT, docPath);
  if (!existsSync(fullPath)) continue;

  let content;
  try {
    content = readFileSync(fullPath, 'utf-8');
  } catch {
    continue;
  }

  // Find markdown links: [text](path)
  const linkPattern = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = linkPattern.exec(content)) !== null) {
    const linkTarget = match[2];

    // Skip external URLs, anchors, and absolute paths
    if (linkTarget.startsWith('http') || linkTarget.startsWith('#') || linkTarget.startsWith('/')) {
      continue;
    }

    // Resolve relative to the doc file's directory
    const docDir = dirname(fullPath);
    const targetPath = resolve(docDir, linkTarget.split('#')[0]); // strip anchor

    if (!existsSync(targetPath)) {
      errors.push(`${docPath}: Broken local link: [${match[1]}](${linkTarget})`);
    }
  }
}

// Report
if (errors.length > 0) {
  console.error('Documentation lint FAILED:\n');
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  console.error(`\n${errors.length} error(s) found.`);
  process.exit(1);
} else {
  console.log('Documentation lint PASSED');
  console.log(`  - ${REQUIRED_DOCS.length} required docs verified`);
  console.log(`  - All frontmatter fields present`);
  console.log(`  - All local links valid`);
  process.exit(0);
}
