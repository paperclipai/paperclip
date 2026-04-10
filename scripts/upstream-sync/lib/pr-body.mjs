function formatConflictLine(diagnostics) {
  const conflictCount = diagnostics?.conflicts?.length ?? 0;
  if (conflictCount === 0) {
    return '- conflicts: none';
  }

  return `- conflicts: ${conflictCount} file(s)`;
}

function formatManualReviewItem(item) {
  if (item.type === 'markdown-review') {
    return `- markdown review: \`${item.path}\` ← \`${item.sourcePath}\` (${item.reason})`;
  }

  if (item.type === 'copy-stale') {
    return `- stale zh-CN key: \`${item.path}\` → \`${item.key}\``;
  }

  if (item.type === 'copy-missing') {
    return `- missing zh-CN key: \`${item.path}\` → \`${item.key}\``;
  }

  if (item.type === 'copy-changed') {
    return `- changed English copy: \`${item.path}\` → \`${item.key}\``;
  }

  return `- review: \`${item.path}\``;
}

function formatValidationLine(label, check, fallbackSummary) {
  return `- ${label}: \`${check?.status ?? 'not-run'}\` — ${check?.summary ?? fallbackSummary}`;
}

export function renderPrBody({
  branchName,
  status,
  upstreamRef,
  maintenanceRef,
  commits = [],
  diagnostics,
  translationSummary = {},
  validationSummary = {},
  localizationSummary = {},
}) {
  const translatedFiles = translationSummary.translatedFiles ?? [];
  const manualReviewItems = localizationSummary.manualReviewItems ?? [];
  const uiTypecheck = validationSummary.uiTypecheck ?? { status: 'not-run', summary: 'UI typecheck not run.' };
  const serverTypecheck = validationSummary.serverTypecheck ?? { status: 'not-run', summary: 'Server typecheck not run.' };
  const checkI18n = validationSummary.checkI18n ?? { status: 'not-run', summary: 'check:i18n not run.' };
  const validationReason = validationSummary.reason ? `- reason: \`${validationSummary.reason}\`` : null;
  const validationLogLine = validationSummary.logPath ? `- log artifact: \`${validationSummary.logPath}\`` : null;

  return [
    '# Upstream sync',
    '',
    `- replay status: \`${status}\``,
    `- branch: \`${branchName}\``,
    `- upstream ref/tag: \`${upstreamRef}\``,
    `- maintenance ref: \`${maintenanceRef}\``,
    formatConflictLine(diagnostics),
    '',
    '## Replayed commits',
    ...(commits.length > 0 ? commits.map((commit) => `- \`${commit}\``) : ['- none']),
    '',
    '## Auto-translated files',
    ...(translatedFiles.length > 0
      ? translatedFiles.map((filePath) => `- \`${filePath}\``)
      : [`- none (${translationSummary.mode ?? 'review-only'})`]),
    '',
    '## Validation',
    `- overall: \`${validationSummary.status ?? 'not-run'}\``,
    ...(validationReason ? [validationReason] : []),
    ...(validationLogLine ? [validationLogLine] : []),
    formatValidationLine('ui typecheck', uiTypecheck, 'UI typecheck not run.'),
    formatValidationLine('server typecheck', serverTypecheck, 'Server typecheck not run.'),
    formatValidationLine('check:i18n', checkI18n, 'check:i18n not run.'),
    '',
    '## Manual review items',
    ...(manualReviewItems.length > 0 ? manualReviewItems.map(formatManualReviewItem) : ['- none']),
    '',
  ].join('\n');
}
