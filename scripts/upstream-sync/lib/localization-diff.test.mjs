import assert from 'node:assert/strict';
import test from 'node:test';

import {
  diffCopyResource,
  diffMarkdownPair,
  extractCopyEntries,
} from './localization-diff.mjs';

test('extractCopyEntries flattens en and zh-CN copy tables from helper source', () => {
  const sourceText = `
    const copy = {
      en: {
        title: 'Inbox',
        nested: {
          cta: 'Retry',
        },
      },
      'zh-CN': {
        title: '收件箱',
        nested: {
          cta: '重试',
        },
      },
    } as const;
  `;

  assert.deepEqual(extractCopyEntries(sourceText), {
    english: {
      title: 'Inbox',
      'nested.cta': 'Retry',
    },
    chinese: {
      title: '收件箱',
      'nested.cta': '重试',
    },
  });
});

test('extractCopyEntries skips unrelated object literals before the locale tables', () => {
  const sourceText = `
    const helper = {
      metadata: {
        owner: 'paperclip',
      },
    };

    export const copy = {
      en: {
        title: 'Inbox',
      },
      'zh-CN': {
        title: '收件箱',
      },
    } as const;
  `;

  assert.deepEqual(extractCopyEntries(sourceText), {
    english: {
      title: 'Inbox',
    },
    chinese: {
      title: '收件箱',
    },
  });
});

test('diffCopyResource reports missing and changed zh-CN entries for changed English copy', () => {
  const diff = diffCopyResource({
    resourcePath: 'ui/src/lib/inbox-copy.ts',
    baselineEnglish: {
      title: 'Inbox',
      description: 'Old description',
      cta: 'Retry',
    },
    english: {
      title: 'Inbox',
      description: 'New description',
      cta: 'Retry now',
      helper: 'Read more',
    },
    chinese: {
      title: '收件箱',
      description: '旧说明',
      cta: '重试',
    },
  });

  assert.deepEqual(diff, {
    resourcePath: 'ui/src/lib/inbox-copy.ts',
    missing: [
      {
        key: 'helper',
        english: 'Read more',
      },
    ],
    changed: [
      {
        key: 'cta',
        baselineEnglish: 'Retry',
        english: 'Retry now',
        chinese: '重试',
      },
      {
        key: 'description',
        baselineEnglish: 'Old description',
        english: 'New description',
        chinese: '旧说明',
      },
    ],
    stale: [],
    hasDiff: true,
  });
});

test('diffCopyResource reports stale zh-CN entries for deleted or renamed English keys', () => {
  const diff = diffCopyResource({
    resourcePath: 'ui/src/lib/inbox-copy.ts',
    baselineEnglish: {
      title: 'Inbox',
      cta: 'Retry',
      legacyCta: 'Learn more',
    },
    english: {
      title: 'Inbox',
      cta: 'Retry',
      helpCta: 'Learn more',
    },
    chinese: {
      title: '收件箱',
      cta: '重试',
      legacyCta: '了解更多',
    },
  });

  assert.deepEqual(diff, {
    resourcePath: 'ui/src/lib/inbox-copy.ts',
    missing: [
      {
        key: 'helpCta',
        english: 'Learn more',
      },
    ],
    changed: [],
    stale: [
      {
        key: 'legacyCta',
        chinese: '了解更多',
        baselineEnglish: 'Learn more',
      },
    ],
    hasDiff: true,
  });
});

test('diffMarkdownPair flags quickstart markdown drift for review', () => {
  const diff = diffMarkdownPair({
    englishPath: 'docs/start/quickstart.md',
    chinesePath: 'docs/start/quickstart-zh-cn.md',
    baselineEnglish: '# Quickstart\n\nUse `paperclipai run`.\n',
    english: '# Quickstart\n\nUse `paperclipai onboard --yes`.\n',
    chinese: '# 快速开始\n\n使用 `paperclipai run`。\n',
  });

  assert.deepEqual(diff, {
    englishPath: 'docs/start/quickstart.md',
    chinesePath: 'docs/start/quickstart-zh-cn.md',
    needsReview: true,
    reason: 'english-changed',
  });
});
