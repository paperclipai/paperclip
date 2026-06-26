#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const DEFAULT_CBM = process.env.CODEBASE_MEMORY_MCP_BIN || '/root/.local/bin/codebase-memory-mcp';

function usage() {
  return `Usage: node scripts/generate-codebase-impact-pack.mjs [options]\n\nOptions:\n  --project <name>       codebase-memory-mcp project name (default: inferred from repo path)\n  --repo <path>          repository root (default: cwd)\n  --output <path>        markdown output path (default: .trust/impact-pack.md)\n  --max-symbols <n>      impacted symbol limit (default: 80)\n  --cbm <path>           codebase-memory-mcp binary path\n  --json                 print machine-readable summary JSON to stdout\n  --help                 show this help\n`;
}

export function parseArgs(argv) {
  const args = {
    repo: process.cwd(),
    output: '.trust/impact-pack.md',
    maxSymbols: 80,
    cbm: DEFAULT_CBM,
    json: false,
    project: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { ...args, help: true };
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (arg === '--project') args.project = next;
    else if (arg === '--repo') args.repo = next;
    else if (arg === '--output') args.output = next;
    else if (arg === '--max-symbols') args.maxSymbols = Number(next);
    else if (arg === '--cbm') args.cbm = next;
    else throw new Error(`Unknown argument: ${arg}`);
    i += 1;
  }
  if (!Number.isFinite(args.maxSymbols) || args.maxSymbols < 1) throw new Error('--max-symbols must be a positive number');
  return args;
}

export function extractLastJsonObject(output) {
  const lines = String(output).trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      return JSON.parse(line);
    } catch {
      // Keep scanning; codebase-memory-mcp logs can precede/follow JSON.
    }
  }
  throw new Error('No JSON object found in command output');
}

function runCommand(command, args, options = {}) {
  const res = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const combined = `${res.stdout || ''}${res.stderr || ''}`;
  if (res.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit ${res.status}:\n${combined}`);
  }
  return combined;
}

export function parseGitStatusShort(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2).trim() || line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const path = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() : rawPath;
      return { status, path };
    });
}

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

function inferProjectName(repo, cbm) {
  const output = runCommand(cbm, ['cli', 'list_projects', '{}'], { cwd: repo });
  const projects = extractLastJsonObject(output).projects || [];
  const resolvedRepo = resolve(repo);
  const match = projects.find((project) => resolve(project.root_path) === resolvedRepo);
  if (match) return match.name;
  throw new Error(`Could not infer codebase-memory-mcp project for ${resolvedRepo}. Run: ${cbm} cli index_repository '{"repo_path":"${resolvedRepo}"}' or pass --project.`);
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function classifyChangedFile(path) {
  if (path.startsWith('server/src/routes/')) return 'server route';
  if (path.startsWith('server/src/services/')) return 'server service';
  if (path.startsWith('server/src/__tests__/')) return 'server test';
  if (path.startsWith('ui/src/')) return 'ui';
  if (path.startsWith('packages/shared/')) return 'shared contract';
  if (path.startsWith('packages/adapters/')) return 'adapter';
  if (path.startsWith('scripts/')) return 'tooling';
  if (path.includes('/test.') || path.includes('.test.')) return 'test';
  if (path.startsWith('doc/') || path.endsWith('.md')) return 'docs';
  return 'other';
}

export function suggestVerification(changedFiles) {
  const suggestions = [];
  const has = (needle) => changedFiles.some((file) => file.includes(needle));
  const starts = (prefix) => changedFiles.some((file) => file.startsWith(prefix));

  if (has('ceo-control-room')) {
    suggestions.push('pnpm exec vitest run server/src/__tests__/ceo-control-room-classification.test.ts server/src/__tests__/ceo-control-room-service.test.ts --reporter=dot');
  }
  if (has('heartbeat.ts') || has('heartbeat-process-recovery')) {
    suggestions.push('pnpm exec vitest run server/src/__tests__/heartbeat-process-recovery.test.ts --reporter=dot');
  }
  if (starts('packages/adapters/claude-local/')) {
    suggestions.push('pnpm exec vitest run packages/adapters/claude-local/src/server/run-as.test.ts packages/adapters/claude-local/src/server/workspace-sync.test.ts --reporter=dot');
    suggestions.push('pnpm --filter @paperclipai/adapter-claude-local typecheck');
  }
  if (starts('packages/shared/') || starts('server/src/routes/') || starts('server/src/services/')) {
    suggestions.push('pnpm --filter @paperclipai/shared typecheck && pnpm --filter @paperclipai/server typecheck');
  }
  if (starts('ui/src/')) {
    suggestions.push('pnpm --filter @paperclipai/ui typecheck');
  }
  if (starts('scripts/')) {
    suggestions.push('node --test scripts/generate-codebase-impact-pack.test.mjs');
  }

  suggestions.push('~/.local/bin/codebase-memory-mcp cli detect_changes \'{"project":"root-paperclip"}\'');
  return [...new Set(suggestions)];
}

function summarizeSymbols(symbols, changedFiles, maxSymbols) {
  const unique = uniqueBy(symbols || [], (symbol) => `${symbol.qualified_name || symbol.name}|${symbol.file}`);
  const changedSet = new Set(changedFiles);
  const byFile = new Map();
  for (const symbol of unique) {
    if (!symbol.file || !changedSet.has(symbol.file)) continue;
    const bucket = byFile.get(symbol.file) || [];
    if (bucket.length < 8) bucket.push(symbol);
    byFile.set(symbol.file, bucket);
  }
  const prioritized = [];
  for (const file of changedFiles) {
    prioritized.push(...(byFile.get(file) || []));
  }
  const remaining = unique.filter((symbol) => !symbol.file || !changedSet.has(symbol.file));
  return [...prioritized, ...remaining]
    .slice(0, maxSymbols)
    .map((symbol) => ({
      name: symbol.name,
      label: symbol.label,
      file: symbol.file,
      qualified_name: symbol.qualified_name,
    }));
}

export function buildImpactSummary({ project, repo, detectChanges, gitStatus, maxSymbols = 80 }) {
  const changedFiles = uniqueBy([
    ...(detectChanges.changed_files || []),
    ...gitStatus.map((entry) => entry.path).filter(Boolean),
  ].map((path) => path.replace(/^\.\//, '')), (path) => path);

  const filesByClass = {};
  for (const file of changedFiles) {
    const klass = classifyChangedFile(file);
    filesByClass[klass] ||= [];
    filesByClass[klass].push(file);
  }

  const impactedSymbols = summarizeSymbols(detectChanges.impacted_symbols || [], changedFiles, maxSymbols);
  const changedSymbolFiles = new Set(impactedSymbols.map((symbol) => symbol.file).filter(Boolean));
  const changedFilesWithoutSymbols = changedFiles.filter((file) => !changedSymbolFiles.has(file));

  return {
    generatedAt: new Date().toISOString(),
    project,
    repo: resolve(repo),
    changedCount: changedFiles.length,
    changedFiles,
    filesByClass,
    gitStatus,
    impactedSymbols,
    changedFilesWithoutSymbols,
    verification: suggestVerification(changedFiles),
  };
}

function tableRows(rows, columns) {
  if (!rows.length) return '_None._\n';
  const header = `| ${columns.map((column) => column.label).join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((column) => String(column.value(row) ?? '').replace(/\|/g, '\\|')).join(' | ')} |`);
  return `${[header, sep, ...body].join('\n')}\n`;
}

export function renderImpactPack(summary) {
  const byClassRows = Object.entries(summary.filesByClass)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([klass, files]) => ({ klass, count: files.length, files: files.join('<br>') }));

  const symbolRows = summary.impactedSymbols.map((symbol) => ({
    label: symbol.label,
    name: symbol.qualified_name || symbol.name,
    file: symbol.file,
  }));

  const statusRows = summary.gitStatus.map((entry) => ({ status: entry.status, path: entry.path }));

  return `# Codebase Impact Pack\n\n` +
    `Generated: ${summary.generatedAt}\n\n` +
    `Project: \`${summary.project}\`\n\n` +
    `Repo: \`${summary.repo}\`\n\n` +
    `## Executive summary\n\n` +
    `- Changed files detected: **${summary.changedCount}**\n` +
    `- Impacted symbols listed: **${summary.impactedSymbols.length}**\n` +
    `- Primary surfaces: ${Object.keys(summary.filesByClass).sort().map((klass) => `\`${klass}\``).join(', ') || '_none_'}\n\n` +
    `## Changed files by surface\n\n` +
    tableRows(byClassRows, [
      { label: 'Surface', value: (row) => row.klass },
      { label: 'Count', value: (row) => row.count },
      { label: 'Files', value: (row) => row.files },
    ]) +
    `\n## Git status inputs\n\n` +
    tableRows(statusRows, [
      { label: 'Status', value: (row) => row.status },
      { label: 'Path', value: (row) => row.path },
    ]) +
    `\n## Impacted symbols from codebase-memory-mcp\n\n` +
    tableRows(symbolRows, [
      { label: 'Kind', value: (row) => row.label },
      { label: 'Symbol', value: (row) => row.name },
      { label: 'File', value: (row) => row.file },
    ]) +
    `\n## Changed files without symbol coverage\n\n` +
    (summary.changedFilesWithoutSymbols.length ? summary.changedFilesWithoutSymbols.map((file) => `- \`${file}\``).join('\n') : '_None._') +
    `\n\n## Focused verification commands\n\n` +
    summary.verification.map((command) => `- \`${command}\``).join('\n') +
    `\n\n## Operator acceptance checklist\n\n` +
    `- [ ] Reviewer checked that changed surfaces match the intended issue/patch group.\n` +
    `- [ ] Focused verification commands were run or explicitly waived with rationale.\n` +
    `- [ ] No broker orders, paid compute, secret values, or external side effects are implied by this pack.\n` +
    `- [ ] Commit/patch group is small enough to review independently.\n`;
}

export function writeImpactPack(markdown, outputPath, repo) {
  const absolute = resolve(repo, outputPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, markdown, 'utf8');
  return absolute;
}

export function generateImpactPack(args) {
  const repo = resolve(args.repo);
  if (!existsSync(repo)) throw new Error(`Repo path does not exist: ${repo}`);
  const project = args.project || inferProjectName(repo, args.cbm);
  const detectOutput = runCommand(args.cbm, ['cli', 'detect_changes', JSON.stringify({ project })], { cwd: repo });
  const detectChanges = extractLastJsonObject(detectOutput);
  const gitStatus = parseGitStatusShort(git(repo, ['status', '--short']));
  const summary = buildImpactSummary({ project, repo, detectChanges, gitStatus, maxSymbols: args.maxSymbols });
  const markdown = renderImpactPack(summary);
  const outputPath = writeImpactPack(markdown, args.output, repo);
  return { summary, outputPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      process.exit(0);
    }
    const result = generateImpactPack(args);
    if (args.json) {
      console.log(JSON.stringify({ outputPath: result.outputPath, summary: result.summary }, null, 2));
    } else {
      console.log(`Wrote ${relative(process.cwd(), result.outputPath)}`);
      console.log(`Changed files: ${result.summary.changedCount}`);
      console.log(`Impacted symbols: ${result.summary.impactedSymbols.length}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
